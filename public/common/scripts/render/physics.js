// Physics debug geometry hook (script:physics.debug).
// Draws the Rapier debug line buffers straight from the physics system.
// Group 0 (frame) is already bound by the render graph.

export function debug(pass, ctx) {
    const physics = ctx.attachments.physics;
    if (!physics) return;
    const count = physics.debugVertexCount;
    if (count === 0 || !physics.debugPosBuffer || !physics.debugColBuffer) return;
    pass.setPipeline(ctx.pipeline);
    pass.setVertexBuffer(0, physics.debugPosBuffer);
    pass.setVertexBuffer(1, physics.debugColBuffer);
    pass.draw(count);
}
