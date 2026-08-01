import type { Command, CommandContext } from './Command';
import type { RenderGraphData } from '../../render/types';

export class MutateRenderGraphCommand implements Command {
    readonly type = 'mutateRenderGraph';
    readonly description = 'mutateRenderGraph';
    private prevData: string;
    constructor(private nextData: object, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(nextData);
    }

    execute(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.fromData(this.nextData as RenderGraphData);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.fromData(JSON.parse(this.prevData));
        return true;
    }
}
