import { resourceManager, uniformLayouts } from '@shaderlab/api';
import type { Scene } from '@shaderlab/api';

const COLOR_COUNT = 8;

interface SysGpu {
    eid: number;
    particleCount: number;
    surfaceVertexCount: number;
    positions: GPUBuffer;
    predicted: GPUBuffer;
    velocities: GPUBuffer;
    surfaceIndices: GPUBuffer;
    constraintBuffers: GPUBuffer[];
    colorCounts: number[];
    ubo: GPUBuffer;
    predictBind: GPUBindGroup;
    integrateBind: GPUBindGroup;
    solveBind: GPUBindGroup[];
    drawBind: GPUBindGroup;
    seeded: boolean;
}

/**
 * GPU PBD (Position-Based Dynamics) soft-body manager. Owns per-soft-body
 * particle pools, constraint buffers, and bind groups; drives the
 * predict -> solve (iterations x colors) -> integrate compute pipeline.
 *
 * Constraint buffers are split by edge color (greedy 8-coloring on CPU) so
 * each color batch is conflict-free — within one color, no two constraints
 * share a particle, so parallel writes to `predicted` are safe. Colors run
 * as separate compute passes (barriers between them); iterations repeat the
 * whole 8-color sweep.
 *
 * Surface mesh rendering: no vertex buffer — the vertex shader reads
 * surfaceIndices[vertex_index] (a u32 particle index) then positions[idx].
 * Flat per-triangle normals are computed from the 3 triangle corners.
 */
export class PbdManager {
    private systems = new Map<number, SysGpu>();
    private frameLog = 0;

    clear(): void {
        for (const sys of this.systems.values()) {
            sys.positions.destroy();
            sys.predicted.destroy();
            sys.velocities.destroy();
            sys.surfaceIndices.destroy();
            sys.ubo.destroy();
            for (const cb of sys.constraintBuffers) cb.destroy();
        }
        this.systems.clear();
        this.frameLog = 0;
    }

    simulate(
        encoder: GPUCommandEncoder,
        scene: Scene,
        predictPipeline: GPUComputePipeline,
        solvePipeline: GPUComputePipeline,
        integratePipeline: GPUComputePipeline,
        entities: readonly number[],
        dt: number,
        time: number,
        predictTgs: number,
        solveTgs: number,
        integrateTgs: number,
    ): void {
        const dev = resourceManager.device;
        // Clamp dt to avoid solver blow-up on tab-switch / GC stalls / clock jumps.
        const safeDt = Math.min(Math.max(dt, 0.0), 1.0 / 30.0);
        if (this.frameLog < 5) {
            console.log(`[pbd] frame ${this.frameLog}: dt=${dt.toFixed(4)}s safeDt=${safeDt.toFixed(4)}s entities=${entities.length}`);
            this.frameLog++;
        }
        for (const eid of entities) {
            const sys = this.ensure(scene, eid);
            this.writeUbo(dev, sys, scene, eid, safeDt, time);

            // Predict
            const passP = encoder.beginComputePass();
            passP.setPipeline(predictPipeline);
            passP.setBindGroup(0, sys.predictBind);
            passP.dispatchWorkgroups(Math.ceil(sys.particleCount / predictTgs));
            passP.end();

            // Solve — iterations × colors
            const iters = this.numField(scene, eid, 'solverIterations') ?? 8;
            for (let iter = 0; iter < iters; iter++) {
                for (let c = 0; c < COLOR_COUNT; c++) {
                    const count = sys.colorCounts[c];
                    if (count === 0) continue;
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(solvePipeline);
                    pass.setBindGroup(0, sys.solveBind[c]);
                    pass.dispatchWorkgroups(Math.ceil(count / solveTgs));
                    pass.end();
                }
            }

            // Integrate
            const passI = encoder.beginComputePass();
            passI.setPipeline(integratePipeline);
            passI.setBindGroup(0, sys.integrateBind);
            passI.dispatchWorkgroups(Math.ceil(sys.particleCount / integrateTgs));
            passI.end();
        }
    }

    draw(
        pass: GPURenderPassEncoder,
        scene: Scene,
        pipeline: GPURenderPipeline,
        entities: readonly number[],
    ): void {
        for (const eid of entities) {
            const sys = this.systems.get(eid);
            if (!sys) continue;
            pass.setPipeline(pipeline);
            pass.setBindGroup(1, sys.drawBind);
            pass.draw(sys.surfaceVertexCount);
        }
    }

    /* ── per-system GPU resources ───────────────────── */

    private ensure(scene: Scene, eid: number): SysGpu {
        const existing = this.systems.get(eid);
        if (existing && existing.seeded) return existing;

        const dev = resourceManager.device;
        const N = this.numField(scene, eid, 'gridN') ?? 5;
        const gridN = Math.max(2, N);
        const particleCount = gridN * gridN * gridN;
        const cellSize = this.numField(scene, eid, 'cellSize') ?? 0.4;
        const compliance = this.numField(scene, eid, 'compliance') ?? 0;

        // Positions: vec4(xyz, invMass). Seed a cube centered at the entity's transform.
        const tr = scene.getField(eid, 'Transform', 'position') as number[] | undefined;
        const cx = tr?.[0] ?? 0;
        const cy = tr?.[1] ?? 4;
        const cz = tr?.[2] ?? 0;
        const totalMass = this.numField(scene, eid, 'mass') ?? 1.0;
        const perParticleMass = totalMass / particleCount;
        const invMass = 1.0 / perParticleMass;

        const stride = 16; // vec4
        const posInit = new Float32Array(particleCount * 4);
        const velInit = new Float32Array(particleCount * 4);

        for (let i = 0; i < gridN; i++) {
            for (let j = 0; j < gridN; j++) {
                for (let k = 0; k < gridN; k++) {
                    const id = i + j * gridN + k * gridN * gridN;
                    const x = cx + (i - (gridN - 1) / 2) * cellSize;
                    const y = cy + (j - (gridN - 1) / 2) * cellSize;
                    const z = cz + (k - (gridN - 1) / 2) * cellSize;
                    posInit[id * 4 + 0] = x;
                    posInit[id * 4 + 1] = y;
                    posInit[id * 4 + 2] = z;
                    posInit[id * 4 + 3] = invMass;
                }
            }
        }

        // Build constraint list (structural only — 3 axes).
        type C = { a: number, b: number, rest: number, comp: number };
        const all: C[] = [];
        const idxAt = (i: number, j: number, k: number) => i + j * gridN + k * gridN * gridN;
        for (let i = 0; i < gridN; i++) {
            for (let j = 0; j < gridN; j++) {
                for (let k = 0; k < gridN; k++) {
                    const a = idxAt(i, j, k);
                    if (i + 1 < gridN) all.push({ a, b: idxAt(i + 1, j, k), rest: cellSize, comp: compliance });
                    if (j + 1 < gridN) all.push({ a, b: idxAt(i, j + 1, k), rest: cellSize, comp: compliance });
                    if (k + 1 < gridN) all.push({ a, b: idxAt(i, j, k + 1), rest: cellSize, comp: compliance });
                }
            }
        }

        // Greedy edge coloring — assign each constraint a color in [0..COLOR_COUNT-1]
        // such that no two constraints sharing a particle reuse the same color.
        const adjColor: Map<number, Set<number>> = new Map();
        const colored: C[][] = Array.from({ length: COLOR_COUNT }, () => []);
        for (const c of all) {
            const sa = adjColor.get(c.a) ?? new Set();
            const sb = adjColor.get(c.b) ?? new Set();
            let chosen = -1;
            for (let col = 0; col < COLOR_COUNT; col++) {
                if (!sa.has(col) && !sb.has(col)) { chosen = col; break; }
            }
            if (chosen < 0) chosen = 0;
            sa.add(chosen); sb.add(chosen);
            adjColor.set(c.a, sa);
            adjColor.set(c.b, sb);
            colored[chosen].push(c);
        }

        const colorCounts: number[] = colored.map(arr => arr.length);
        // Verify: no two constraints in the same color share a particle.
        for (let c = 0; c < COLOR_COUNT; c++) {
            const seen = new Set<number>();
            for (const con of colored[c]) {
                if (seen.has(con.a)) console.error(`[pbd] COLORING BUG color=${c} particle a=${con.a} duplicated`);
                if (seen.has(con.b)) console.error(`[pbd] COLORING BUG color=${c} particle b=${con.b} duplicated`);
                seen.add(con.a); seen.add(con.b);
            }
        }
        console.log(`[pbd] gridN=${gridN} particles=${particleCount} invMass=${invMass.toFixed(1)} constraints: total=${all.length}, perColor=[${colorCounts.join(',')}]`);
        console.log(`[pbd] first 5 constraints:`, all.slice(0, 5).map(c => `(a=${c.a},b=${c.b},rest=${c.rest.toFixed(3)})`));
        console.log(`[pbd] first 4 positions:`, [0,1,2,3].map(p => `[${posInit[p*4].toFixed(3)},${posInit[p*4+1].toFixed(3)},${posInit[p*4+2].toFixed(3)},w=${posInit[p*4+3].toFixed(1)}]`));
        const constraintBuffers: GPUBuffer[] = [];
        for (let c = 0; c < COLOR_COUNT; c++) {
            const count = colored[c].length;
            const bufSize = (1 + count) * 16;
            // Use a shared ArrayBuffer with u32 + f32 views: indices stored as
            // raw u32 (read via bitcast<u32> in WGSL), floats stored normally.
            const ab = new ArrayBuffer(bufSize);
            const u32 = new Uint32Array(ab);
            const f32 = new Float32Array(ab);
            u32[0] = count;
            for (let i = 0; i < count; i++) {
                const con = colored[c][i];
                const base = (1 + i) * 4;
                u32[base + 0] = con.a;
                u32[base + 1] = con.b;
                f32[base + 2] = con.rest;
                f32[base + 3] = con.comp;
            }
            const buf = dev.createBuffer({
                size: bufSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Uint8Array(buf.getMappedRange()).set(new Uint8Array(ab));
            buf.unmap();
            constraintBuffers.push(buf);
        }

        // Surface index list — 6 faces × (gridN-1)² quads × 2 triangles × 3 verts
        const surfaceIdx = this.buildSurfaceIndices(gridN);
        const surfaceVertexCount = surfaceIdx.length;
        const surfBytes = surfaceIdx.length * 4;
        const surfaceIndicesBuf = dev.createBuffer({
            size: surfBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint32Array(surfaceIndicesBuf.getMappedRange()).set(surfaceIdx);
        surfaceIndicesBuf.unmap();

        // Particle buffers — use mappedAtCreation to avoid queue.writeBuffer
        // racing with the compute encoder (writeBuffer enqueued inside the
        // compute hook may not land before the encoder's passes execute).
        const positions = dev.createBuffer({
            size: particleCount * stride,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(positions.getMappedRange()).set(posInit);
        positions.unmap();

        const predicted = dev.createBuffer({
            size: particleCount * stride,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(predicted.getMappedRange()).set(posInit); // seed = positions
        predicted.unmap();

        const velocities = dev.createBuffer({
            size: particleCount * stride,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(velocities.getMappedRange()).set(velInit);
        velocities.unmap();

        // UBO (pbdParams layout) — init with correct values so the first frame's
        // compute passes see valid params even if writeUbo's writeBuffer races.
        const layout = uniformLayouts.get('pbdParams');
        const uboBytes = layout.byteSize;
        const ubo = dev.createBuffer({
            size: uboBytes,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        {
            const uboAb = new ArrayBuffer(uboBytes);
            const uf = new Float32Array(uboAb);
            const uu = new Uint32Array(uboAb);
            const gravity = this.numField(scene, eid, 'gravity') ?? -9.81;
            const damping = this.numField(scene, eid, 'damping') ?? 0.995;
            const iters = this.numField(scene, eid, 'solverIterations') ?? 8;
            const restitution = this.numField(scene, eid, 'restitution') ?? 0.3;
            layout.write(uf, 'dt', 0.016);
            layout.write(uf, 'time', 0);
            layout.write(uf, 'gravityY', gravity);
            layout.write(uf, 'damping', damping);
            layout.writeU32(uu, 'solverIterations', iters);
            layout.writeU32(uu, 'particleCount', particleCount);
            layout.write(uf, 'restitution', restitution);
            new Uint8Array(ubo.getMappedRange()).set(new Uint8Array(uboAb));
            ubo.unmap();
        }

        // Bind groups
        const predictBind = dev.createBindGroup({
            layout: resourceManager.namedLayout('pbdPredict'),
            entries: [
                { binding: 0, resource: { buffer: positions } },
                { binding: 1, resource: { buffer: predicted } },
                { binding: 2, resource: { buffer: velocities } },
                { binding: 3, resource: { buffer: ubo } },
            ],
        });
        const integrateBind = dev.createBindGroup({
            layout: resourceManager.namedLayout('pbdIntegrate'),
            entries: [
                { binding: 0, resource: { buffer: positions } },
                { binding: 1, resource: { buffer: predicted } },
                { binding: 2, resource: { buffer: velocities } },
                { binding: 3, resource: { buffer: ubo } },
            ],
        });
        const solveBind: GPUBindGroup[] = [];
        for (let c = 0; c < COLOR_COUNT; c++) {
            solveBind.push(dev.createBindGroup({
                layout: resourceManager.namedLayout('pbdSolve'),
                entries: [
                    { binding: 0, resource: { buffer: predicted } },
                    { binding: 1, resource: { buffer: constraintBuffers[c] } },
                    { binding: 2, resource: { buffer: ubo } },
                ],
            }));
        }
        const drawBind = dev.createBindGroup({
            layout: resourceManager.namedLayout('pbdDraw'),
            entries: [
                { binding: 0, resource: { buffer: positions } },
                { binding: 1, resource: { buffer: surfaceIndicesBuf } },
            ],
        });

        const sys: SysGpu = {
            eid, particleCount, surfaceVertexCount,
            positions, predicted, velocities, surfaceIndices: surfaceIndicesBuf,
            constraintBuffers, colorCounts, ubo,
            predictBind, integrateBind, solveBind, drawBind,
            seeded: true,
        };
        this.systems.set(eid, sys);
        return sys;
    }

    private writeUbo(dev: GPUDevice, sys: SysGpu, scene: Scene, eid: number, dt: number, time: number): void {
        const layout = uniformLayouts.get('pbdParams');
        const ab = new ArrayBuffer(layout.byteSize);
        const f = new Float32Array(ab);
        const u = new Uint32Array(ab);

        const gravity = this.numField(scene, eid, 'gravity') ?? -9.81;
        const damping = this.numField(scene, eid, 'damping') ?? 0.995;
        const iters = this.numField(scene, eid, 'solverIterations') ?? 8;
        const restitution = this.numField(scene, eid, 'restitution') ?? 0.3;

        layout.write(f, 'dt', dt);
        layout.write(f, 'time', time);
        layout.write(f, 'gravityY', gravity);
        layout.write(f, 'damping', damping);
        layout.writeU32(u, 'solverIterations', iters);
        layout.writeU32(u, 'particleCount', sys.particleCount);
        layout.write(f, 'restitution', restitution);

        dev.queue.writeBuffer(sys.ubo, 0, ab);
    }

    private buildSurfaceIndices(n: number): number[] {
        const out: number[] = [];
        const at = (i: number, j: number, k: number) => i + j * n + k * n * n;

        // -X & +X faces
        for (let j = 0; j < n - 1; j++) {
            for (let k = 0; k < n - 1; k++) {
                const a = at(0, j, k), b = at(0, j + 1, k), c = at(0, j + 1, k + 1), d = at(0, j, k + 1);
                out.push(a, b, c, a, c, d);
                const a2 = at(n - 1, j, k), b2 = at(n - 1, j + 1, k), c2 = at(n - 1, j + 1, k + 1), d2 = at(n - 1, j, k + 1);
                out.push(a2, c2, b2, a2, d2, c2);
            }
        }
        // -Y & +Y faces
        for (let i = 0; i < n - 1; i++) {
            for (let k = 0; k < n - 1; k++) {
                const a = at(i, 0, k), b = at(i + 1, 0, k), c = at(i + 1, 0, k + 1), d = at(i, 0, k + 1);
                out.push(a, c, b, a, d, c);
                const a2 = at(i, n - 1, k), b2 = at(i + 1, n - 1, k), c2 = at(i + 1, n - 1, k + 1), d2 = at(i, n - 1, k + 1);
                out.push(a2, b2, c2, a2, c2, d2);
            }
        }
        // -Z & +Z faces
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < n - 1; j++) {
                const a = at(i, j, 0), b = at(i + 1, j, 0), c = at(i + 1, j + 1, 0), d = at(i, j + 1, 0);
                out.push(a, b, c, a, c, d);
                const a2 = at(i, j, n - 1), b2 = at(i + 1, j, n - 1), c2 = at(i + 1, j + 1, n - 1), d2 = at(i, j + 1, n - 1);
                out.push(a2, c2, b2, a2, d2, c2);
            }
        }
        return out;
    }

    private numField(scene: Scene, eid: number, field: string): number | undefined {
        const v = scene.getField(eid, 'PbdSoftBodyComponent', field);
        return typeof v === 'number' ? v : undefined;
    }
}
