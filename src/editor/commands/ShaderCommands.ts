import type { Command, CommandContext } from './Command';

/** Hot-reload a WGSL shader module by its cache key. The module is swapped and
 *  every referencing pipeline is rebuilt. Rejects interface changes via the
 *  panel's guard before dispatch. */
export class HotReloadShaderCommand implements Command {
    readonly type = 'hotReloadShader';
    readonly description = 'hotReloadShader';
    constructor(
        private shaderKey: string,
        private nextSource: string,
        private prevSource: string,
    ) {}

    execute(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.rebuildPipelineByShader(ctx.engine.device, this.shaderKey, this.nextSource);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.rebuildPipelineByShader(ctx.engine.device, this.shaderKey, this.prevSource);
        return true;
    }
}
