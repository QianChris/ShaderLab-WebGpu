// PBD Step 3 — integrate velocity from position delta.
// v = (predicted - position) / dt, then global damping. Pinned particles
// stay frozen. On floor contact (particle at floor level with downward speed
// above threshold), reflect Y velocity with restitution to prevent sticking.

struct Params {
    dt: f32,
    time: f32,
    gravityY: f32,
    damping: f32,
    solverIterations: u32,
    particleCount: u32,
    restitution: f32,
    _pad0: f32,
};

@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= params.particleCount) { return; }

    let p = positions[i];
    let pred = predicted[i];
    let v = velocities[i];

    if (v.w > 0.5) {
        positions[i] = pred;
        return;
    }

    var newVel = (pred.xyz - p.xyz) / max(params.dt, 1e-6);

    if (pred.y < 0.001 && newVel.y < -0.3) {
        newVel.y = -newVel.y * params.restitution;
        newVel.x = newVel.x * 0.8;
        newVel.z = newVel.z * 0.8;
    }

    newVel *= params.damping;

    positions[i] = pred;
    velocities[i] = vec4f(newVel, v.w);
}
