import { resourceManager } from './ResourceManager';
import type { PhaseBehavior, PhaseBehaviorContext } from './types';

/**
 * Default pass-execution strategies shipped with the engine, registered through
 * the same public registry plugins use (RenderGraph.registerPhaseBehavior) —
 * no special-cased dispatch. Their sources move into the owning plugins in
 * migration Phase C; the registry keeps working unchanged.
 */

/** Structural contract for the shadow behavior's light-system dependency. */
interface ShadowPassProvider {
    shadowPassList: Array<{ view: GPUTextureView; lightIdx: number; face: number }>;
}

/** 'normal': merge enabled drivers by (color,depth) target and record. */
export const normalBehavior: PhaseBehavior = {
    perCamera: true,
    run: (ctx: PhaseBehaviorContext): void => ctx.runDefault(),
};

/** 'shadow-clear': one depth-only pass per (light, face) from the light
 *  system's shadowPassList. Faces are cleared even when the shadow pipeline
 *  is disabled, so stale depth never leaks into lighting. */
export const shadowClearBehavior: PhaseBehavior = {
    perCamera: false,
    run(ctx: PhaseBehaviorContext): void {
        const light = ctx.getSystem<ShadowPassProvider>('light');
        const passes = light?.shadowPassList ?? [];
        if (passes.length === 0) return;
        const driver = ctx.drivers.find(d => d.entry.enabled);
        const pipeline = driver ? ctx.pipelineFor(driver) : undefined;
        if (driver && !pipeline) {
            throw new Error(`Shadow pipeline '${driver.path}' was not compiled`);
        }
        for (let i = 0; i < passes.length; i++) {
            const p = passes[i];
            const pass = ctx.encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: p.view,
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                },
            });
            if (pipeline && driver) {
                // Per-face selector {lightIdx, face} for the shadow-depth vertex shader.
                pass.setBindGroup(2, resourceManager.shadowPassBindGroup(i, p.lightIdx, p.face));
                driver.record(pass, ctx.scene, pipeline, ctx.frame);
            }
            pass.end();
        }
    },
};

/** 'postprocess-chain': fullscreen ping-pong chain. First enabled pass reads
 *  'scene', last writes 'screen', middle passes alternate transient targets. */
export const postProcessChainBehavior: PhaseBehavior = {
    perCamera: false,
    run(ctx: PhaseBehaviorContext): void {
        const drivers = ctx.drivers.filter(d => d.entry.enabled);
        if (drivers.length === 0) return;
        const transients = ctx.transientTargets();
        let prevOutput = 'scene';
        for (let i = 0; i < drivers.length; i++) {
            const last = i === drivers.length - 1;
            const entry = drivers[i].entry;
            const input = prevOutput;
            const output = last
                ? 'screen'
                : transients.find(t => t !== input) ?? 'ppB';
            const srcView = input === 'scene' && ctx.sceneIsScreen
                ? ctx.swapView
                : resourceManager.namedColorTargetView(input, ctx.cw, ctx.ch, ctx.format);
            const dstView = output === 'screen'
                ? ctx.swapView
                : resourceManager.namedColorTargetView(output, ctx.cw, ctx.ch, ctx.format);
            const pipeline = ctx.pipelineFor(drivers[i]);
            if (!pipeline) throw new Error(`Post-process pipeline '${drivers[i].path}' was not compiled`);

            const pass = ctx.encoder.beginRenderPass({
                colorAttachments: [{ view: dstView, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, resourceManager.fullscreenBindGroup(srcView, entry));
            pass.draw(3);
            pass.end();
            prevOutput = output;
        }
    },
};
