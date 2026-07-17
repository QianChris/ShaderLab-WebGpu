// Custom system script: orbits the "Cube" entity around the world origin.
// Demonstrates a JS-driven system (source: "scripts/orbit.js" in orbit.json)
// with zero TypeScript changes to the engine. The system's update(ctx) is
// dispatched by SystemRegistry each frame; ctx is the same FrameContext the
// builtin systems receive (scene/time/dt/...).

export function init() {
    console.log('[orbit system] initialized');
}

export function update(ctx) {
    const eid = ctx.scene.entityKeyMap.get('Cube');
    if (eid === undefined) return;
    const t = ctx.time;
    const radius = 2.5;
    const speed = 0.8;
    const x = Math.cos(t * speed) * radius;
    const z = Math.sin(t * speed) * radius;
    ctx.scene.setField(eid, 'Transform', 'position', [x, 0, z]);

    // Spin the cube on its Y axis too, just to show we own the Transform fully.
    const angle = t * 1.5;
    const half = Math.sin(angle * 0.5);
    const w = Math.cos(angle * 0.5);
    ctx.scene.setField(eid, 'Transform', 'rotation', [0, half, 0, w]);
}
