// Demo shader-graph compute stage: each workgroup invocation writes a running
// counter into the output buffer. Demonstrates data→shader binding via
// Component BufferHandle + compute dispatch driven by a component field.

@group(0) @binding(0) var<storage, read_write> outData: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    outData[i] = i + 1u;
}
