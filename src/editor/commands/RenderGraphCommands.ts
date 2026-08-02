import type { Command, CommandContext } from './Command';
import type { RenderGraphData, PipelineConfig } from '../../core/render/types';
import { PipelineLoader } from '../../core/render/PipelineLoader';

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

/**
 * Live-sync structural render-graph edits (entry.enabled / entry.params) onto
 * the EXISTING entry objects so PipelineDriver references stay valid — a plain
 * fromData() would replace entries with clones and silently detach drivers.
 * Prev state is stored as JSON for undo. Used by the pipeline panel.
 */
export class PatchRenderGraphCommand implements Command {
    readonly type = 'patchRenderGraph';
    readonly description = 'patchRenderGraph';
    private prevData: string;
    constructor(private nextData: RenderGraphData, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(nextData);
    }

    execute(ctx: CommandContext): boolean {
        this.patch(ctx, this.nextData);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        this.patch(ctx, JSON.parse(this.prevData) as RenderGraphData);
        return true;
    }

    private patch(ctx: CommandContext, data: RenderGraphData): void {
        for (const [phaseName, entries] of Object.entries(data.phases)) {
            if (!entries) continue;
            const live = ctx.engine.renderGraph.phases[phaseName] ?? [];
            for (const next of entries) {
                const target = live.find(e => e.name === next.name);
                if (!target) continue;
                target.enabled = next.enabled ?? true;
                if (next.params) target.params = next.params;
            }
        }
    }
}

/** Apply a full pipeline config (topology/blend/cull/depth) to a named
 *  pipeline and recompile its GPU pipeline. Undo restores the prior config. */
export class MutatePipelineConfigCommand implements Command {
    readonly type = 'mutatePipelineConfig';
    readonly description = 'mutatePipelineConfig';
    private prevJson: string;
    constructor(
        private pipeline: string,
        private nextJson: string,
        prevJson?: string,
    ) {
        this.prevJson = prevJson ?? nextJson;
    }

    execute(ctx: CommandContext): boolean {
        const config = PipelineLoader.getConfig(this.pipeline);
        if (!config) return false;
        this.apply(config, this.nextJson);
        ctx.engine.renderGraph.rebuildPipeline(ctx.engine.device, this.pipeline);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const config = PipelineLoader.getConfig(this.pipeline);
        if (!config) return false;
        this.apply(config, this.prevJson);
        ctx.engine.renderGraph.rebuildPipeline(ctx.engine.device, this.pipeline);
        return true;
    }

    private apply(config: PipelineConfig, json: string): void {
        const parsed = JSON.parse(json) as PipelineConfig;
        // Replace top-level fields wholesale so nested objects (primitive /
        // depthStencil) are swapped in, keeping any runtime references coherent.
        const cfg = config as unknown as Record<string, unknown>;
        for (const key of Object.keys(config)) delete cfg[key];
        Object.assign(config, parsed);
    }
}

