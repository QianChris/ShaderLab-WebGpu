import { resourceManager, mat4Mul } from '@shaderlab/api';
import type { FrameContext, System, Scene } from '@shaderlab/api';
import { loadSplatPly, type SplatData } from './SplatLoader.ts';

const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Structural contract for the camera system fields the splat sort consumes. */
interface CameraFeed {
    lastView: Float32Array | null;
    lastPos: Float32Array | null;
}

/**
 * Per-entity splat instance: holds the GPU buffers, sort state, and model UBO
 * for one GsComponent entity. Each instance loads its own PLY, maintains its
 * own radix sort index, and exposes a bind group for the render hook.
 */
class SplatInstance {
    readonly eid: number;
    count = 0;
    ready = false;
    splatScale = 1.0;

    private centersBuf: GPUBuffer | null = null;
    private colorsBuf: GPUBuffer | null = null;
    private covBuf: GPUBuffer | null = null;
    private sortBuf: GPUBuffer | null = null;
    private modelUBO: GPUBuffer | null = null;
    private cachedBindGroup: GPUBindGroup | null = null;
    /** Scratch for the SplatUniform struct: model(16) + viewport(2) + splatScale(1) + pad(1). */
    private uniformData: Float32Array = new Float32Array(20);

    private sortKeys: Float32Array = new Float32Array(0);
    private sortIndex: Uint32Array = new Uint32Array(0);
    private radixScratch: Uint32Array = new Uint32Array(0);
    private cpuCenters: Float32Array | null = null;
    private cpuModel: Float32Array = IDENTITY_MAT4;
    private lastViewPos: Float32Array | null = null;

    constructor(eid: number) {
        this.eid = eid;
    }

    /** Load and upload a 3DGS PLY into this instance's buffers. */
    async load(url: string): Promise<void> {
        this.disposeInternal();
        const device = resourceManager.device;
        const data: SplatData = await loadSplatPly(url);
        const n = data.count;
        this.count = n;

        const tag = `_${this.eid}`;
        this.centersBuf = resourceManager.getStorageBuffer(`gsCenters${tag}`, n * 16);
        this.colorsBuf = resourceManager.getStorageBuffer(`gsColors${tag}`, n * 16);
        this.covBuf = resourceManager.getStorageBuffer(`gsCov${tag}`, n * 24);
        this.sortBuf = resourceManager.getStorageBuffer(`gsSortIdx${tag}`, n * 4);

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
        this.uniformData.set(IDENTITY_MAT4, 0);
        this.uniformData[16] = 0; this.uniformData[17] = 0;
        this.uniformData[18] = this.splatScale; this.uniformData[19] = 0;
        this.modelUBO = resourceManager.getUniform(`gsSplatUniform${tag}`, this.uniformData, 80);
        this.cpuModel = IDENTITY_MAT4;
        this.ready = true;
    }

    /** Upload the entity's world model matrix + viewport, invalidate sort throttle. */
    setModel(model: Float32Array, viewportW: number, viewportH: number): void {
        if (!this.ready) return;
        const u = this.uniformData;
        u.set(model, 0);
        u[16] = viewportW; u[17] = viewportH;
        u[18] = this.splatScale; u[19] = 0;
        this.modelUBO = resourceManager.getUniform(`gsSplatUniform_${this.eid}`, u, 80);
        this.cpuModel = model;
        this.lastViewPos = null;
    }

    /** Re-sort splats back-to-front against the active camera. LSD radix sort, O(N). */
    sort(view: Float32Array | null, camPos: Float32Array | null): void {
        if (!this.ready || this.count === 0 || !view || !camPos || !this.sortBuf) return;
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

    /** Bind group for @group(1) against the named "splat" layout. Cached per-instance. */
    bindGroup(): GPUBindGroup | null {
        if (!this.ready || !this.centersBuf || !this.colorsBuf || !this.covBuf || !this.sortBuf || !this.modelUBO) return null;
        if (!this.cachedBindGroup) {
            this.cachedBindGroup = resourceManager.device.createBindGroup({
                label: `splatBindGroup_${this.eid}`,
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

    dispose(): void {
        this.disposeInternal();
    }

    private disposeInternal(): void {
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

    private radixSortAscending(indices: Uint32Array, keys: Float32Array, n: number): void {
        if (n <= 1) return;
        const u32keys = new Uint32Array(keys.buffer, keys.byteOffset, n);
        const radix = this.radixScratch;
        for (let i = 0; i < n; i++) {
            const u = u32keys[i];
            radix[i] = (u & 0x80000000) ? ((~u) >>> 0) : (u ^ 0x80000000);
        }

        const tmp: Uint32Array = new Uint32Array(n);
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
        if (src !== indices) indices.set(src);
    }
}

/**
 * Owns the GPU splat data for all GsComponent entities in the current app.
 * Each entity gets its own SplatInstance (buffers, sort state, model UBO).
 *
 * Wired to RenderGraph.splats (mirrors RenderGraph.physics). The Engine loads
 * each GsComponent entity's PLY via loadFromScene and disposes on app switch.
 * The render hook (script:splat.draw) iterates all ready instances via
 * forEachReady() and draws each one's instanced quads.
 */
export class GaussianSplatManager implements System {
    private instances = new Map<number, SplatInstance>();

    /** Legacy: whether any instance is ready. */
    get ready(): boolean {
        for (const inst of this.instances.values()) {
            if (inst.ready) return true;
        }
        return false;
    }

    /** Total splat count across all instances. */
    get count(): number {
        let total = 0;
        for (const inst of this.instances.values()) total += inst.count;
        return total;
    }

    /** Iterate all ready instances (for the render hook). */
    forEachReady(cb: (inst: { count: number; bindGroup(): GPUBindGroup | null }) => void): void {
        for (const inst of this.instances.values()) {
            if (inst.ready && inst.count > 0) cb(inst);
        }
    }

    /** System interface: refresh model UBOs + re-sort all instances. */
    update(ctx: FrameContext): void {
        if (this.instances.size === 0) return;
        const camera = ctx.getSystem<CameraFeed>('camera');
        if (!camera) throw new Error(`gaussianSplat requires the 'camera' system (splat sort reads its view matrix)`);
        for (const inst of this.instances.values()) {
            if (!inst.ready) continue;
            inst.setModel(ctx.scene.getModelMatrix(inst.eid), ctx.cw, ctx.ch);
            inst.sort(camera.lastView, camera.lastPos);
        }
    }

    /** Scan the scene for GsComponent entities and load each one's PLY asset
     *  into its own SplatInstance. Supports multiple splat entities. */
    async loadFromScene(scene: Scene, appBase: string): Promise<void> {
        this.instances.clear();
        for (const [, eid] of scene.entityKeyMap) {
            if (!scene.hasComponent(eid, 'GsComponent')) continue;
            const ply = scene.getField(eid, 'GsComponent', 'ply') as string;
            if (!ply) continue;
            const url = ply.startsWith('/') ? ply : `${appBase}/${ply}`;
            const inst = new SplatInstance(eid);
            await inst.load(url);
            scene.setField(eid, 'GsComponent', 'count', inst.count);
            this.instances.set(eid, inst);
        }
    }

    /** Release all instances (called on app switch). */
    dispose(): void {
        for (const inst of this.instances.values()) inst.dispose();
        this.instances.clear();
    }
}
