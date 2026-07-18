// Gaussian splat geometry hook (script:splat.draw).
// Binds the splat data bind group at @group(1) and draws one instanced quad
// per splat. Group 0 (frame / camera UBO) is already bound by the render graph.
// Splats render into the shared "scene" color + "sceneDepth" depth target, so
// opaque meshes (Opaque phase) correctly occlude / are occluded by splats.
import type { GeometryHookContext } from '@shaderlab/api';
import type { GaussianSplatManager } from '../GaussianSplatManager.ts';

export function draw(pass: GPURenderPassEncoder, ctx: GeometryHookContext): void {
    const splats = ctx.attachments.splats as GaussianSplatManager | undefined;
    if (!splats || !splats.ready || splats.count === 0) return;
    const bg = splats.bindGroup();
    if (!bg) return;
    pass.setPipeline(ctx.pipeline);
    pass.setBindGroup(1, bg);
    pass.draw(6, splats.count);
}
