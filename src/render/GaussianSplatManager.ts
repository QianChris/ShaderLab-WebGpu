import { resourceManager } from './ResourceManager';
import { mat4Mul } from '../math';
import { loadSplatPly, type SplatData } from '../gs/SplatLoader';
import type { FrameContext, System } from '../ecs/SystemRegistry';

const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Owns the GPU splat data ("SplatBuffer") for the current app: the parsed PLY
 * arrays uploaded to WebGPU storage buffers plus a per-frame sort index buffer,
 * plus a model UBO carrying the active GsEntity's world transform.
 *
 * The storage buffers are the data a compute shader can subsequently cache or
 * rewrite in-place (compute pipeline binds them as `storage`). The render
 * hook (common/scripts/render/splat.js) reads them as `read-only-storage`
 * via the named "splat" bind group layout; the model UBO at binding 4 carries
 * the GsEntity Transform (position/rotation/scale) so splats move with it.
 *
 * Wired to RenderGraph.splats (mirrors RenderGraph.physics). The Engine loads
 * the splat referenced by a GsComponent entity via load() and disposes on app
 * switch.
 */
export class GaussianSplatManager implements System {
    count = 0;
    ready = false;
    splatScale = 1.0;
    /** Active GsComponent entity (the splat's Transform source). Null until
     *  loadFromScene finds one. Was previously Engine.gsEntityEid. */
    entityEid: number | null = null;

    private centersBuf: GPUBuffer | null = null;
    private colorsBuf: GPUBuffer | null = null;
    private covBuf: GPUBuffer | null = null;
    private sortBuf: GPUBuffer | null = null;
    private modelUBO: GPUBuffer | null = null;
    private cachedBindGroup: GPUBindGroup | null = null;
    /** Scratch for the SplatUniform struct: model(16) + viewport(2) + splatScale(1) + pad(1). */
    private uniformData: Float32Array = new Float32Array(20);

    private sortKeys: Float32Array = new Float32Array(0);
    private sortIndex: Uint32Array<ArrayBuffer> = new Uint32Array(0);
    private radixScratch: Uint32Array<ArrayBuffer> = new Uint32Array(0);
    private cpuCenters: Float32Array | null = null;
    private cpuModel: Float32Array = IDENTITY_MAT4;
    private lastViewPos: Float32Array | null = null;

    /** Load and upload a 3DGS PLY. Replaces any previously loaded splat data. */
    async load(url: string): Promise<void> {
        this.dispose();
        const device = resourceManager.device;
        const data: SplatData = await loadSplatPly(url);
        const n = data.count;
        this.count = n;

        this.centersBuf = resourceManager.getStorageBuffer('gsCenters', n * 16);
        this.colorsBuf = resourceManager.getStorageBuffer('gsColors', n * 16);
        this.covBuf = resourceManager.getStorageBuffer('gsCov', n * 24);
        this.sortBuf = resourceManager.getStorageBuffer('gsSortIdx', n * 4);

        device.queue.writeBuffer(this.centersBuf, 0, data.centers.buffer, data.centers.byteOffset, data.centers.byteLength);
        device.queue.writeBuffer(this.colorsBuf, 0, data.colors.buffer, data.colors.byteOffset, data.colors.byteLength);
        device.queue.writeBuffer(this.covBuf, 0, data.covariances.buffer, data.covariances.byteOffset, data.covariances.byteLength);

        this.cpuCenters = data.centers;
        this.sortIndex = new Uint32Array(n);
        for (let i = 0; i < n; i++) this.sortIndex[i] = i;
        device.queue.writeBuffer(this.sortBuf, 0, this.sortIndex.buffer, this.sortIndex.byteOffset, this.sortIndex.byteLength);

        this.sortKeys = new Float32Array(n);
        this.radixScratch = new Uint32Array(n);
        this.lastViewPos = null;
        this.cachedBindGroup = null;
        // SplatUniform starts at identity model + zero viewport; the Engine writes
        // the GsEntity transform + viewport each frame via setModel().
        this.uniformData.set(IDENTITY_MAT4, 0);
        this.uniformData[16] = 0; this.uniformData[17] = 0;
        this.uniformData[18] = this.splatScale; this.uniformData[19] = 0;
        this.modelUBO = resourceManager.getUniform('gsSplatUniform', this.uniformData, 80);
        this.cpuModel = IDENTITY_MAT4;
        this.ready = true;
    }

    /** System interface: refresh model UBO + re-sort splats against the active camera. */
    update(ctx: FrameContext): void {
        if (this.entityEid === null) return;
        this.setModel(ctx.scene.getModelMatrix(this.entityEid), ctx.cw, ctx.ch);
        this.sort(ctx.camera.lastView, ctx.camera.lastPos);
    }

    /** Scan the scene for GsComponent entities and load each one's PLY asset.
     *  Sets `entityEid` to the (last) found entity; multiple splat entities
     *  are not currently supported by the manager. The previous Engine.loadApp
     *  special-case branch is now this single manager method — keeps splat
     *  loading logic next to the splat manager instead of in the Engine. */
    async loadFromScene(scene: import('../ecs/Scene').Scene, appBase: string): Promise<void> {
        this.entityEid = null;
        for (const [, eid] of scene.entityKeyMap) {
            if (!scene.hasComponent(eid, 'GsComponent')) continue;
            const ply = scene.getField(eid, 'GsComponent', 'ply') as string;
            if (!ply) continue;
            const url = ply.startsWith('/') ? ply : `${appBase}/${ply}`;
            await this.load(url);
            scene.setField(eid, 'GsComponent', 'count', this.count);
            if (this.entityEid !== null) {
                console.warn('[GaussianSplatManager] multiple GsComponent entities; manager serves one — using the last');
            }
            this.entityEid = eid;
        }
    }

    /**
     * Upload the GsEntity's world model matrix + current viewport to the splat
     * uniform, and invalidate the sort throttle so the splat order refreshes
     * when the gaussian object moves/rotates.
     */
    setModel(model: Float32Array, viewportW: number, viewportH: number): void {
        if (!this.ready) return;
        const u = this.uniformData;
        u.set(model, 0);
        u[16] = viewportW; u[17] = viewportH;
        u[18] = this.splatScale; u[19] = 0;
        this.modelUBO = resourceManager.getUniform('gsSplatUniform', u, 80);
        this.cpuModel = model;
        this.lastViewPos = null;  // force re-sort against the new transform
    }

    /**
     * Re-sort splats back-to-front against the active camera's view matrix.
     * Called each frame by the Engine (after CameraSystem updates). Sort key
     * is view-space z of the MODEL-transformed center (row 2 of the
     * column-major model-view matrix): more-negative = farther = drawn first.
     * LSD radix sort on the f32 bit pattern, O(N).
     */
    sort(view: Float32Array | null, camPos: Float32Array | null): void {
        if (!this.ready || this.count === 0 || !view || !camPos || !this.sortBuf) return;
        // Throttle: skip when the camera barely moved AND the model didn't change.
        if (this.lastViewPos
            && Math.abs(camPos[0] - this.lastViewPos[0]) < 0.01
            && Math.abs(camPos[1] - this.lastViewPos[1]) < 0.01
            && Math.abs(camPos[2] - this.lastViewPos[2]) < 0.01) {
            return;
        }
        this.lastViewPos = new Float32Array([camPos[0], camPos[1], camPos[2]]);

        const n = this.count;
        if (this.cpuCenters === null) return;
        const cc = this.cpuCenters;
        // model-view: apply the GsEntity transform before computing view-space z.
        const mv = mat4Mul(view, this.cpuModel);
        const m2 = mv[2], m6 = mv[6], m10 = mv[10], m14 = mv[14];
        const keys = this.sortKeys;
        for (let i = 0; i < n; i++) {
            const b = i * 4;
            keys[i] = m2 * cc[b] + m6 * cc[b + 1] + m10 * cc[b + 2] + m14;
        }

        this.radixSortAscending(this.sortIndex, keys, n);
        resourceManager.device.queue.writeBuffer(this.sortBuf, 0, this.sortIndex.buffer, this.sortIndex.byteOffset, this.sortIndex.byteLength);
    }

    /** Bind group for @group(1) against the named "splat" layout. Cached. */
    bindGroup(): GPUBindGroup | null {
        if (!this.ready || !this.centersBuf || !this.colorsBuf || !this.covBuf || !this.sortBuf || !this.modelUBO) return null;
        if (!this.cachedBindGroup) {
            this.cachedBindGroup = resourceManager.device.createBindGroup({
                label: 'splatBindGroup',
                layout: resourceManager.namedLayout('splat'),
                entries: [
                    { binding: 0, resource: { buffer: this.centersBuf } },
                    { binding: 1, resource: { buffer: this.colorsBuf } },
                    { binding: 2, resource: { buffer: this.covBuf } },
                    { binding: 3, resource: { buffer: this.sortBuf } },
                    { binding: 4, resource: { buffer: this.modelUBO } },
                ],
            });
        }
        return this.cachedBindGroup;
    }

    /** Release GPU buffers (called on app switch). */
    dispose(): void {
        // Storage / uniform buffers are owned by resourceManager (owner = current
        // app); they are released automatically on exitApp. We just drop refs.
        this.centersBuf = null;
        this.colorsBuf = null;
        this.covBuf = null;
        this.sortBuf = null;
        this.modelUBO = null;
        this.cachedBindGroup = null;
        this.count = 0;
        this.ready = false;
        this.sortKeys = new Float32Array(0);
        this.sortIndex = new Uint32Array(0);
        this.radixScratch = new Uint32Array(0);
        this.cpuCenters = null;
        this.cpuModel = IDENTITY_MAT4;
        this.lastViewPos = null;
    }

    /** LSD radix sort of `indices` (length n) ascending by `keys` (f32). In-place. */
    private radixSortAscending(indices: Uint32Array<ArrayBuffer>, keys: Float32Array, n: number): void {
        if (n <= 1) return;
        const u32keys = new Uint32Array(keys.buffer, keys.byteOffset, n);
        const radix = this.radixScratch; // length n: the sortable bit-cast keys
        for (let i = 0; i < n; i++) {
            const u = u32keys[i];
            // Map f32 to a monotonically-ascending u32: flip all bits if
            // negative (sign bit set), else flip just the sign bit.
            radix[i] = (u & 0x80000000) ? ((~u) >>> 0) : (u ^ 0x80000000);
        }

        const tmp: Uint32Array<ArrayBuffer> = new Uint32Array(n);
        let src = indices;
        let dst = tmp;
        const count = new Uint32Array(256);
        for (let shift = 0; shift < 32; shift += 8) {
            count.fill(0);
            for (let i = 0; i < n; i++) count[(radix[src[i]] >>> shift) & 0xff]++;
            let sum = 0;
            for (let b = 0; b < 256; b++) { const c = count[b]; count[b] = sum; sum += c; }
            for (let i = 0; i < n; i++) {
                const idx = src[i];
                dst[count[(radix[idx] >>> shift) & 0xff]++] = idx;
            }
            const t = src; src = dst; dst = t;
        }
        // src now holds the sorted indices ascending. Copy back into `indices`.
        if (src !== indices) indices.set(src);
    }
}
