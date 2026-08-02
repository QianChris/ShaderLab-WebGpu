import type { Command, CommandContext } from './Command';
import type { ShaderGraph } from '../../core/render/shaderGraph';

/**
 * Structural edits to a shader graph (the per-pipeline data→shader node graph).
 *
 * Shader graphs are stored as plain JSON data in the registry. These commands
 * replace the whole graph JSON and hot-recompile the executor, snapshotting the
 * prior JSON for undo. This is a *data* edit (like scene.json), not a
 * render-graph-phase edit — the node order IS the binding + shader execution
 * order, so a full-data replace is the correct granularity for undo.
 */
export class MutateShaderGraphCommand implements Command {
    readonly type = 'mutateShaderGraph';
    readonly description = 'mutateShaderGraph';
    private prevJson: string;
    constructor(
        private name: string,
        private nextGraph: ShaderGraph,
        prevJson?: string,
    ) {
        this.prevJson = prevJson ?? JSON.stringify(nextGraph);
    }

    execute(ctx: CommandContext): boolean {
        return this.apply(ctx, this.nextGraph);
    }

    undo(ctx: CommandContext): boolean {
        const prev = JSON.parse(this.prevJson) as ShaderGraph;
        return this.apply(ctx, prev);
    }

    private apply(ctx: CommandContext, graph: ShaderGraph): boolean {
        void this.rebuild(ctx, graph);
        return true;
    }

    private async rebuild(ctx: CommandContext, graph: ShaderGraph): Promise<void> {
        const { ShaderGraphExecutor } = await import('../../core/render/shaderGraph');
        const executor = new ShaderGraphExecutor(graph, '/common');
        await executor.compile(ctx.engine.device);
        ctx.engine.shaderGraphRegistry.register(executor, 'app');
    }
}

/** Register a brand-new shader graph (or replace an existing one by name).
 *  Creates + compiles the executor. Undo re-registers the previous graph (or
 *  removes the graph when it did not exist before). */
export class RegisterShaderGraphCommand implements Command {
    readonly type = 'registerShaderGraph';
    readonly description = 'registerShaderGraph';
    private prevJson?: string;
    constructor(
        private graph: ShaderGraph,
        prevJson?: string,
    ) {
        this.prevJson = prevJson;
    }

    execute(ctx: CommandContext): boolean {
        const existing = ctx.engine.shaderGraphRegistry.get(this.graph.name);
        if (this.prevJson === undefined) {
            this.prevJson = existing ? JSON.stringify(existing.toData()) : undefined;
        }
        void this.compileAndRegister(ctx, this.graph);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        if (this.prevJson) {
            const prev = JSON.parse(this.prevJson) as ShaderGraph;
            void this.compileAndRegister(ctx, prev);
        } else {
            ctx.engine.shaderGraphRegistry.removeByOwner('app');
        }
        return true;
    }

    private async compileAndRegister(ctx: CommandContext, graph: ShaderGraph): Promise<void> {
        const { ShaderGraphExecutor } = await import('../../core/render/shaderGraph');
        const executor = new ShaderGraphExecutor(graph, '/common');
        await executor.compile(ctx.engine.device);
        ctx.engine.shaderGraphRegistry.register(executor, 'app');
    }
}
