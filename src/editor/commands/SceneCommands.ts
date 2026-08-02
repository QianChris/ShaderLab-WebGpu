import { schemaRegistry } from '../../core/ecs/SchemaRegistry';
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
