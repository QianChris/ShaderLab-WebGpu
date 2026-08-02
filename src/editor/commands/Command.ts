import type { Engine } from '../../core/Engine';

export interface Command {
    readonly type: string;
    readonly description: string;
    execute(ctx: CommandContext): boolean;
    undo(ctx: CommandContext): boolean;
}

export interface CommandContext {
    engine: Engine;
}
