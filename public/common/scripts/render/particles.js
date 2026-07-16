// GPU-driven particle system hooks.
//   script:particles.simulate  — compute stage (emit + simulate)
//   script:particles.draw      — geometry stage (indirect instanced billboards)
// aux keys (declared in ParticlePipeline.json renderer.aux):
//   emit       → ParticleEmitPipeline.json
//   simulate   → ParticleSimPipeline.json

export function simulate(encoder, ctx) {
    const emit = ctx.computePipelines.get(ctx.aux.emit);
    const sim = ctx.computePipelines.get(ctx.aux.simulate);
    if (!emit || !sim) return;
    const emitTgs = ctx.getComputeMeta?.(ctx.aux.emit)?.workgroupSize ?? 64;
    const simTgs = ctx.getComputeMeta?.(ctx.aux.simulate)?.workgroupSize ?? 64;
    ctx.particles.simulate(encoder, ctx.scene, emit, sim, ctx.entities, ctx.dt, ctx.time, emitTgs, simTgs);
}

export function draw(pass, ctx) {
    pass.setPipeline(ctx.pipeline);
    ctx.particles.draw(pass, ctx.scene, ctx.pipeline, ctx.entities);
}
