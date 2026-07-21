// PBD Step 2 — solve distance constraints (one color batch per dispatch).
// constraints[0].x = count for this color (u32 bitcast);
// constraints[1 + i] = vec4(a: u32 bitcast, b: u32 bitcast, rest: f32, compliance: f32).
// Each invocation projects one constraint toward rest length, weighted by
// inverse mass (w = particle.w). Floor collision clamps predicted.y >= 0.

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

@group(0) @binding(0) var<storage, read_write> predicted: array<vec4f>;
@group(0) @binding(1) var<storage, read> constraints: array<vec4f>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    let count = bitcast<u32>(constraints[0].x);
    if (i >= count) { return; }

    let c = constraints[1u + i];
    let a = bitcast<u32>(c.x);
    let b = bitcast<u32>(c.y);
    let rest = c.z;
    let compliance = c.w;

    var pa = predicted[a];
    var pb = predicted[b];

    let wa = pa.w;
    let wb = pb.w;
    let wsum = wa + wb;
    if (wsum < 1e-6) { return; }

    let delta = pb.xyz - pa.xyz;
    let dist = max(length(delta), 1e-6);
    let diff = (dist - rest) / dist;
    let stiffness = 1.0 - clamp(compliance, 0.0, 0.95);
    let correction = delta * 0.5 * diff * stiffness;

    let corrA = correction * (wa / wsum);
    let corrB = correction * (wb / wsum);
    pa = vec4f(pa.xyz - corrA, pa.w);
    pb = vec4f(pb.xyz + corrB, pb.w);

    if (pa.y < 0.0) { pa.y = 0.0; }
    if (pb.y < 0.0) { pb.y = 0.0; }

    predicted[a] = pa;
    predicted[b] = pb;
}
