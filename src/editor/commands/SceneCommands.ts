import { schemaRegistry } from '../../core/ecs/SchemaRegistry';
import type { SceneData } from '../../core/ecs/Scene';
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
