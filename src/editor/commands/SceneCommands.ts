import { schemaRegistry } from '../../core/ecs/SchemaRegistry';
import type { Scene, SceneData } from '../../core/ecs/Scene';
import { mat4ToQuat, mat4InverseInto, mat4MulInto } from '../../core/math';
import type { Command, CommandContext } from './Command';

export class SetFieldCommand implements Command {
    readonly type = 'setField';
    get description(): string { return `setField ${this.compName}.${this.field} = ${this.newValue}`; }
    private oldValue: unknown;
    constructor(
        private entityKey: string,
        private compName: string,
        private field: string,
        private newValue: unknown,
    ) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        this.oldValue = ctx.engine.scene.getField(eid, this.compName, this.field);
        ctx.engine.scene.setField(eid, this.compName, this.field, this.newValue);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        ctx.engine.scene.setField(eid, this.compName, this.field, this.oldValue);
        return true;
    }
}

export class CreateEntityCommand implements Command {
    readonly type = 'createEntity';
    get description(): string { return `createEntity ${this.key}`; }
    private createdKey: string;
    constructor(
        private key: string,
        private data: Record<string, Record<string, unknown>>,
    ) {
        this.createdKey = key;
    }

    execute(ctx: CommandContext): boolean {
        ctx.engine.scene.createEntity(this.createdKey, this.data);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.scene.removeEntity(this.createdKey);
        return true;
    }
}

export class RemoveEntityCommand implements Command {
    readonly type = 'removeEntity';
    get description(): string { return `removeEntity ${this.key}`; }
    private backupData: Record<string, Record<string, unknown>> | null = null;
    constructor(private key: string) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.key);
        if (eid == null) return false;
        this.backupData = this.serializeEntity(ctx, eid);
        ctx.engine.scene.removeEntity(this.key);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        if (!this.backupData) return false;
        ctx.engine.scene.createEntity(this.key, this.backupData);
        return true;
    }

    private serializeEntity(ctx: CommandContext, eid: number): Record<string, Record<string, unknown>> {
        const result: Record<string, Record<string, unknown>> = {};
        const comps = ctx.engine.scene.getEntityComponentNames(eid);
        for (const compName of comps) {
            const comp = schemaRegistry.get(compName);
            if (comp && ctx.engine.scene.hasComponent(eid, compName)) {
                result[compName] = schemaRegistry.readAllFields(compName, comp, eid);
            }
        }
        return result;
    }
}

/** Replace the whole scene (clear + load entity data), e.g. editor "Load JSON"
 *  of a plain scene-entities file. Snapshot is the previous scene data. */
export class LoadSceneDataCommand implements Command {
    readonly type = 'loadSceneData';
    readonly description = 'loadSceneData';
    private prevData: string;
    constructor(private data: SceneData, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(data);
    }

    execute(ctx: CommandContext): boolean {
        this.replaceScene(ctx, this.data);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        this.replaceScene(ctx, JSON.parse(this.prevData) as SceneData);
        return true;
    }

    private replaceScene(ctx: CommandContext, data: SceneData): void {
        const scene = ctx.engine.scene;
        for (const k of [...scene.entityKeyMap.keys()]) scene.removeEntity(k);
        ctx.engine.loadSceneData(data);
    }
}

/** Add/remove a component on an entity (undo restores prior field values when
 *  the component was removed). Used by the editor's component checkboxes. */
export class ToggleComponentCommand implements Command {
    readonly type = 'toggleComponent';
    get description(): string { return `toggleComponent ${this.compName}`; }
    private backup: Record<string, Record<string, unknown>> | null = null;
    private added = false;
    constructor(
        private entityKey: string,
        private compName: string,
        private enabled: boolean,
    ) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        const wasEnabled = ctx.engine.scene.hasComponent(eid, this.compName);
        if (wasEnabled === this.enabled) return false;
        if (!this.enabled) {
            const comp = schemaRegistry.get(this.compName);
            if (comp) {
                this.backup = { [this.compName]: schemaRegistry.readAllFields(this.compName, comp, eid) };
            }
        }
        ctx.engine.scene.toggleComponent(eid, this.compName, this.enabled);
        this.added = this.enabled;
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        if (this.added) {
            ctx.engine.scene.toggleComponent(eid, this.compName, false);
        } else if (this.backup) {
            ctx.engine.scene.toggleComponent(eid, this.compName, true);
            for (const [field, value] of Object.entries(this.backup[this.compName] ?? {})) {
                ctx.engine.scene.setField(eid, this.compName, field, value);
            }
        }
        return true;
    }
}

/** Reparent an entity (Hierarchy panel drag-and-drop). The entity's WORLD
 *  transform is preserved: before reparent we snapshot its world matrix, then
 *  recompute Local TRS = parentWorldInverse × oldWorld so the object stays
 *  put visually. Undo restores the previous parent (also world-stays). */
export class SetParentCommand implements Command {
    readonly type = 'setParent';
    get description(): string { return `setParent ${this.childKey} → ${this.newParent || '(root)'}`; }
    private oldParent = '';
    constructor(private childKey: string, private newParent: string) {}

    execute(ctx: CommandContext): boolean {
        const scene = ctx.engine.scene;
        const eid = scene.entityKeyMap.get(this.childKey);
        if (eid == null) return false;
        this.oldParent = scene.getParent(eid);
        reparentKeepWorld(scene, this.childKey, this.newParent);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        reparentKeepWorld(ctx.engine.scene, this.childKey, this.oldParent);
        return true;
    }
}

/** Reparent `childKey` under `parentKey` (or detach to root if ''), keeping
 *  the child's world transform. Decomposes the new local matrix into TRS so
 *  Scene's Transform (local TRS + parent) reproduces the same world. */
function reparentKeepWorld(scene: Scene, childKey: string, parentKey: string): void {
    const childEid = scene.entityKeyMap.get(childKey);
    if (childEid == null) return;
    // Snapshot world before reparent (uses current parent chain).
    const oldWorld = scene.getModelMatrix(childEid, new Float32Array(16));
    if (parentKey) {
        // setParent throws on cycles; the HierarchyPanel catches that.
        scene.setParent(childKey, parentKey);
        const parentEid = scene.entityKeyMap.get(parentKey);
        if (parentEid != null) {
            const parentWorld = scene.getModelMatrix(parentEid, new Float32Array(16));
            const parentInv = new Float32Array(16);
            mat4InverseInto(parentWorld, parentInv);
            const newLocal = new Float32Array(16);
            mat4MulInto(parentInv, oldWorld, newLocal);
            writeLocalTRS(scene, childEid, newLocal);
        }
    } else {
        // Detach to root: local = world (no parent to undo).
        scene.setField(childEid, 'Transform', 'parent', '');
        writeLocalTRS(scene, childEid, oldWorld);
    }
}

function writeLocalTRS(scene: Scene, eid: number, m: Float32Array): void {
    scene.setField(eid, 'Transform', 'position', [m[12], m[13], m[14]]);
    scene.setField(eid, 'Transform', 'scale', [
        Math.hypot(m[0], m[1], m[2]),
        Math.hypot(m[4], m[5], m[6]),
        Math.hypot(m[8], m[9], m[10]),
    ]);
    scene.setField(eid, 'Transform', 'rotation', mat4ToQuat(m));
}
