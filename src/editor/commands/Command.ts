import type { Engine } from '../../Engine';

export interface Command {
    readonly type: string;
    readonly description: string;
    execute(ctx: CommandContext): boolean;
    undo(ctx: CommandContext): boolean;
}

export interface CommandContext {
    engine: Engine;
}
