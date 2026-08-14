import { meshEdges, type MeshData, type PbrMeshData } from './Primitives';
import type { GltfSkinData, GltfAnimationData } from '../gltf/GltfTypes';
import { uniformLayouts } from './UniformLayout';
import { bufferRegistry } from './BufferRegistry';
import { gpuResourceRegistry, type GpuResourceKind } from './GpuResourceRegistry';
import type { SlotName } from './vertexSlots';
import type { PipelineEntry, BindLayoutDecls, BindEntryDecl, SamplerDecls } from './types';
import type { RenderTargetDecls, RenderTargetSize } from './rendererDecl';

export interface MeshGpu {
    slots: Partial<Record<SlotName, GPUBuffer>>;
    slotHandles: Partial<Record<SlotName, number>>;
    index?: GPUBuffer;
    indexHandle: number;
    indexFormat: GPUIndexFormat;
    indexCount: number;
    vertexCount: number;
    edgeBuffer?: GPUBuffer;
    edgeCount: number;
    pointBuffer?: GPUBuffer;
    pointCount: number;
}

interface ColorTarget {
    tex: GPUTexture;
    w: number;
    h: number;
    format: GPUTextureFormat;
}

const VISIBILITY_BITS: Record<string, number> = {
    vertex: GPUShaderStage.VERTEX,
    fragment: GPUShaderStage.FRAGMENT,
    compute: GPUShaderStage.COMPUTE,
};

export class ResourceManager {
    device!: GPUDevice;

    private uniformBuffers = new Map<string, GPUBuffer>();
    private storageBuffers = new Map<string, { buffer: GPUBuffer; size: number }>();
    private meshData = new Map<string, MeshData>();
    private pbrMeshData = new Map<string, PbrMeshData>();
    private meshGpu = new Map<string, MeshGpu>();
    /** CPU-side skin data (joints + inverse-bind matrices) from glTF; the
     *  animation plugin reads these to compute joint matrices (Phase 4). */
    private skinData = new Map<string, GltfSkinData>();
    /** CPU-side animation clips from glTF (channels + samplers). */
    private animationData = new Map<string, GltfAnimationData>();
    /** CPU-side shared material assets (PbrMaterial field bundle). Entities
     *  reference these by name via PbrMaterial.material; the `materials`
     *  plugin's value atoms resolve `material.*` against this registry. */
    private materialData = new Map<string, Record<string, unknown>>();
    private colorTargets = new Map<string, ColorTarget>();
    private depthTargets = new Map<string, { tex: GPUTexture; w: number; h: number; format: GPUTextureFormat }>();

    /* owner bookkeeping: which app owns each cached resource. 'common' = persistent. */
    private currentOwner = 'common';
    private meshDataOwner = new Map<string, string>();
    private pbrMeshDataOwner = new Map<string, string>();
    private meshGpuOwner = new Map<string, string>();
    private skinDataOwner = new Map<string, string>();
    private animationDataOwner = new Map<string, string>();
    private materialDataOwner = new Map<string, string>();
    private uniformOwner = new Map<string, string>();
    private storageOwner = new Map<string, string>();
    private textureOwner = new Map<string, string>();
    private colorTargetOwner = new Map<string, string>();
    private depthTargetOwner = new Map<string, string>();

    /* handle tables: index 0 reserved as invalid/default */
    private bufferList: (GPUBuffer | null)[] = [null];
    private textureList: (GPUTexture | null)[] = [null];
    private textureKeyToHandle = new Map<string, number>();
    private textures = new Map<string, GPUTexture>();
    /** Free lists for handle recycling: destroyed resources' indices are
     *  pushed here and reused on the next allocation, keeping the handle
     *  tables proportional to live resource count rather than append-only. */
    private bufferFreeList: number[] = [];
    private textureFreeList: number[] = [];

    /* mesh handle table: a stable numeric id per mesh NAME (not per GPU
     * resource — there is no meshList array because meshes are not indexed
     * GPU-side like textures). Handles are assigned lazily by getMeshHandle
     * for known mesh names and used by the editor/preview as a cache key and
     * a protocol-stable id. Index 0 reserved as invalid. */
    private meshKeyToHandle = new Map<string, number>();
    private meshHandleCounter = 0;

    private bindLayoutDecls = new Map<string, BindEntryDecl[]>();
    private bindLayouts = new Map<string, GPUBindGroupLayout>();
    private samplers = new Map<string, GPUSampler>();
    private renderTargetDecls: RenderTargetDecls = {};
    private namedVbos = new Map<string, GPUBuffer>();
    private fallbackTextures = new Map<string, GPUTexture>();
    /* owner maps for named declaration registries (plugin sweep support) */
    private bindLayoutOwner = new Map<string, string>();
    private samplerOwner = new Map<string, string>();
    private renderTargetOwner = new Map<string, string>();
    private namedVboOwner = new Map<string, string>();
    private fallbackTextureOwner = new Map<string, string>();
    /** Cached default (full) views per GPUTexture. GPUTexture objects are stable
     *  (cached by URL/handle/name and only destroyed on app-switch/resize, which
     *  produces a NEW GPUTexture object), so a WeakMap keyed by the texture yields
     *  the correct cache behaviour: a recreated texture misses the cache and gets
     *  a fresh view, while a stable texture reuses one view across all frames.
     *  Without this, every `tex.createView()` in the per-entity / per-pass paths
     *  would allocate a new GPUTextureView each frame — a severe object leak. */
    private textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

    private _shadow2D: GPUTexture | null = null;
    private _shadow2DW = 0;
    private _shadow2DH = 0;
    private _shadow2DLayers = 0;
    private _shadowPoint: GPUTexture | null = null;
    private _shadowPointW = 0;
    private _shadowPointH = 0;
    private _shadowPointLayers = 0;
    /** Cached 2d-array views of the shadow maps (invalidated when the
     *  underlying textures are recreated by ensureShadowTextures). */
    private _shadow2DArrayView: GPUTextureView | null = null;
    private _shadowPoint2DArrayView: GPUTextureView | null = null;
    /** Cached per-layer / per-face views of the shadow maps (used by the
     *  shadow render passes). Lazily filled by index, invalidated alongside
     *  the array views when the shadow textures are recreated. */
    private _shadow2DLayerViews: (GPUTextureView | null)[] = [];
    private _shadowPointFaceViews: (GPUTextureView | null)[] = [];
    /** Cached frame bind groups. Content-stable across frames (UBOs are
     *  updated in place via writeBuffer; shadow textures only change on
     *  resize), so rebuild only when shadow textures are recreated. Without
     *  this cache, every entity×driver×frame would create a new GPUBindGroup
     *  plus two new shadow TextureViews — a severe GPU-object leak. */
    private _frameBg: GPUBindGroup | null = null;
    private _frameShadowBg: GPUBindGroup | null = null;
    /** Cached per-face shadow bind groups (@group(2) selector UBO wrapper).
     *  Each wraps a stable `shadowPass_${i}` UBO buffer (contents updated in
     *  place each frame); the bind group object itself never changes, so it
     *  is cached per passIndex. Cleared on app switch (the UBO buffers are
     *  app-owned and destroyed in exitApp). */
    private _shadowPassBindGroups = new Map<number, GPUBindGroup>();
    private _shadowPassScratch: Uint32Array = new Uint32Array(4);

    init(device: GPUDevice): void {
        this.device = device;
    }

    /* ── App scope ──────────────────────────────────── */

    /** Mark subsequent resource registrations as owned by `appId` ('common' = persistent). */
    enterApp(appId: string): void {
        this.currentOwner = appId;
    }

    /** Current owner tag for resource registrations. */
    get currentOwnerId(): string {
        return this.currentOwner;
    }

    /** Resource counts for diagnostics / stress testing (all scopes). */
    getStats(): { meshes: number; pbrMeshes: number; meshGpu: number; textures: number; colorTargets: number; depthTargets: number; uniforms: number; storageBuffers: number; gpuResources: number } {
        return {
            meshes: this.meshData.size,
            pbrMeshes: this.pbrMeshData.size,
            meshGpu: this.meshGpu.size,
            textures: this.textures.size,
            colorTargets: this.colorTargets.size,
            depthTargets: this.depthTargets.size,
            uniforms: this.uniformBuffers.size,
            storageBuffers: this.storageBuffers.size,
            gpuResources: gpuResourceRegistry.names().length,
        };
    }

    /* ── Read-only enumeration (editor asset view) ─────────────── */

    /** Names of all registered meshes (simple + PBR). */
    getMeshNames(): string[] { return [...new Set([...this.meshData.keys(), ...this.pbrMeshData.keys()])]; }
    /** Texture keys currently cached on the GPU. */
    getTextureNames(): string[] { return [...this.textures.keys()]; }
    /** Named offscreen color target names (render-targets.json + runtime). */
    getColorTargetNames(): string[] { return [...this.colorTargets.keys()]; }
    /** Named depth target names (render-targets.json + runtime). */
    getDepthTargetNames(): string[] { return [...this.depthTargets.keys()]; }
    /** Uniform buffer cache keys. */
    getUniformNames(): string[] { return [...this.uniformBuffers.keys()]; }
    /** Storage buffer cache keys. */
    getStorageNames(): string[] { return [...this.storageBuffers.keys()]; }
    /** Named bind-layout declaration names. */
    getBindLayoutNames(): string[] { return [...this.bindLayouts.keys()]; }
    /** Named sampler declaration names. */
    getSamplerNames(): string[] { return [...this.samplers.keys()]; }
    /** Named VBO preset names. */
    getNamedVboNames(): string[] { return [...this.namedVbos.keys()]; }
    /** Named render-target declaration names (render-targets.json). */
    getRenderTargetNames(): string[] { return Object.keys(this.renderTargetDecls); }
    /** Shared owner-aware GPU resources published by engine systems and plugins. */
    getGpuResourceNames(): string[] { return gpuResourceRegistry.names(); }

    /** Claim a name in a named-decl registry for the current owner.
     *  Cross-owner duplicates throw (fail-loud); same-owner reloads pass. */
    private claimName(owners: Map<string, string>, name: string, kind: string): void {
        const existing = owners.get(name);
        if (existing !== undefined && existing !== this.currentOwner) {
            throw new Error(`${kind} '${name}' already declared by ${existing} (attempted by ${this.currentOwner})`);
        }
        owners.set(name, this.currentOwner);
    }

    /** Release and forget every resource owned by `appId`. 'common' is never released. */
    exitApp(appId: string): void {
        if (appId === 'common') return;
        for (const [name, owner] of this.meshDataOwner) {
            if (owner !== appId) continue;
            this.meshData.delete(name);
            this.meshDataOwner.delete(name);
            this.meshKeyToHandle.delete(name);
        }
        for (const [name, owner] of this.pbrMeshDataOwner) {
            if (owner !== appId) continue;
            this.pbrMeshData.delete(name);
            this.pbrMeshDataOwner.delete(name);
            this.meshKeyToHandle.delete(name);
        }
        for (const [name, owner] of this.skinDataOwner) {
            if (owner !== appId) continue;
            this.skinData.delete(name);
            this.skinDataOwner.delete(name);
        }
        for (const [name, owner] of this.animationDataOwner) {
            if (owner !== appId) continue;
            this.animationData.delete(name);
            this.animationDataOwner.delete(name);
        }
        for (const [name, owner] of this.materialDataOwner) {
            if (owner !== appId) continue;
            this.materialData.delete(name);
            this.materialDataOwner.delete(name);
        }
        for (const [name, owner] of this.meshGpuOwner) {
            if (owner !== appId) continue;
            const gpu = this.meshGpu.get(name);
            if (gpu) this.destroyMeshGpu(gpu);
            this.meshGpu.delete(name);
            this.meshGpuOwner.delete(name);
            this.meshKeyToHandle.delete(name);
        }
        for (const [key, owner] of this.uniformOwner) {
            if (owner !== appId) continue;
            this.uniformBuffers.get(key)?.destroy();
            this.uniformBuffers.delete(key);
            this.uniformOwner.delete(key);
        }
        for (const [key, owner] of this.storageOwner) {
            if (owner !== appId) continue;
            this.storageBuffers.get(key)?.buffer.destroy();
            this.storageBuffers.delete(key);
            this.storageOwner.delete(key);
        }
        for (const [key, owner] of this.textureOwner) {
            if (owner !== appId) continue;
            const tex = this.textures.get(key);
            if (tex) {
                // Drop the cached view promptly so it is GC-eligible without
                // waiting for the destroyed GPUTexture to be collected.
                this.textureViewCache.delete(tex);
                tex.destroy();
            }
            this.textures.delete(key);
            this.textureOwner.delete(key);
            const handle = this.textureKeyToHandle.get(key);
            if (handle !== undefined) {
                this.textureList[handle] = null;
                this.textureFreeList.push(handle);
                this.textureKeyToHandle.delete(key);
            }
        }
        for (const [key, owner] of this.colorTargetOwner) {
            if (owner !== appId) continue;
            const entry = this.colorTargets.get(key);
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            this.colorTargets.delete(key);
            this.colorTargetOwner.delete(key);
        }
        for (const [key, owner] of this.depthTargetOwner) {
            if (owner !== appId) continue;
            const entry = this.depthTargets.get(key);
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            this.depthTargets.delete(key);
            this.depthTargetOwner.delete(key);
        }
        /* named-decl registries (populated by common init or plugins) */
        for (const [name, owner] of this.bindLayoutOwner) {
            if (owner !== appId) continue;
            this.bindLayoutDecls.delete(name);
            this.bindLayouts.delete(name);
            this.bindLayoutOwner.delete(name);
        }
        for (const [name, owner] of this.samplerOwner) {
            if (owner !== appId) continue;
            this.samplers.delete(name);
            this.samplerOwner.delete(name);
        }
        for (const [name, owner] of this.namedVboOwner) {
            if (owner !== appId) continue;
            this.namedVbos.get(name)?.destroy();
            this.namedVbos.delete(name);
            this.namedVboOwner.delete(name);
        }
        for (const [name, owner] of this.fallbackTextureOwner) {
            if (owner !== appId) continue;
            const tex = this.fallbackTextures.get(name);
            if (tex) { this.textureViewCache.delete(tex); tex.destroy(); }
            this.fallbackTextures.delete(name);
            this.fallbackTextureOwner.delete(name);
        }
        for (const [name, owner] of this.renderTargetOwner) {
            if (owner !== appId) continue;
            delete this.renderTargetDecls[name];
            this.renderTargetOwner.delete(name);
        }
        // Invalidate cached frame bind groups: future user-declared app-scoped
        // UBOs (referenced via `resource: "myAppUbo"` in bind-layouts.json) would
        // leave _frameBg/_frameShadowBg pointing at destroyed buffers. The four
        // legacy engine UBOs are common-scoped so this is a no-op for them today,
        // but invalidating eagerly keeps the cache correct under app-scoped growth.
        this._frameBg = null;
        this._frameShadowBg = null;
        // Note: shadow-pass selector UBOs + bind groups are common-owned (not
        // app-scoped) so they survive reload — do not clear _shadowPassBindGroups.
        this.currentOwner = 'common';
    }

    private destroyMeshGpu(gpu: MeshGpu): void {
        for (const buf of Object.values(gpu.slots)) buf?.destroy();
        gpu.index?.destroy();
        gpu.edgeBuffer?.destroy();
        gpu.pointBuffer?.destroy();
        // Recycle registered handles so the handle tables stay proportional
        // to live resources rather than growing without bound.
        for (const handle of Object.values(gpu.slotHandles)) {
            if (handle !== undefined) {
                this.bufferList[handle] = null;
                this.bufferFreeList.push(handle);
            }
        }
        this.bufferList[gpu.indexHandle] = null;
        this.bufferFreeList.push(gpu.indexHandle);
    }

    /* ── Named bind group layouts (bind-layouts.json) ─────── */

    loadBindLayouts(decls: BindLayoutDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.bindLayoutOwner, name, 'Bind layout');
            this.bindLayoutDecls.set(name, decl.entries);
            this.bindLayouts.set(name, this.buildBindLayout(name, decl.entries));
        }
    }

    private buildBindLayout(label: string, entries: BindEntryDecl[]): GPUBindGroupLayout {
        const gpuEntries: GPUBindGroupLayoutEntry[] = entries.map(e => {
            let visibility = 0;
            for (const stage of e.visibility) visibility |= VISIBILITY_BITS[stage] ?? 0;
            const entry: GPUBindGroupLayoutEntry = { binding: e.binding, visibility };
            if (e.buffer) {
                entry.buffer = { type: e.buffer };
            } else if (e.sampler) {
                entry.sampler = { type: e.sampler };
            } else if (e.texture) {
                entry.texture = { sampleType: e.texture };
                if (e.viewDimension) (entry.texture as GPUTextureBindingLayout).viewDimension = e.viewDimension;
            } else if (e.storageTexture) {
                entry.storageTexture = {
                    format: e.storageTexture.format,
                    access: e.storageTexture.access ?? 'write-only',
                };
            }
            return entry;
        });
        return this.device.createBindGroupLayout({ label, entries: gpuEntries });
    }

    namedLayout(name: string): GPUBindGroupLayout {
        const layout = this.bindLayouts.get(name);
        if (!layout) throw new Error(`Bind layout '${name}' not found`);
        return layout;
    }

    pipelineLayout(names: string[]): GPUPipelineLayout {
        return this.device.createPipelineLayout({
            bindGroupLayouts: names.map(n => this.namedLayout(n)),
        });
    }

    /* ── Handle tables ────────────────────────────── */

    private registerBuffer(buffer: GPUBuffer): number {
        const free = this.bufferFreeList.pop();
        if (free !== undefined) {
            this.bufferList[free] = buffer;
            return free;
        }
        this.bufferList.push(buffer);
        return this.bufferList.length - 1;
    }

    getBuffer(handle: number): GPUBuffer | undefined {
        return this.bufferList[handle] ?? undefined;
    }

    getTextureByHandle(handle: number): GPUTexture | undefined {
        return this.textureList[handle] ?? undefined;
    }

    /* ── Mesh registration (SoA) ──────────────────── */

    registerMesh(name: string, data: MeshData): void {
        this.meshData.set(name, data);
        this.meshDataOwner.set(name, this.currentOwner);
    }

    registerPbrMesh(name: string, data: PbrMeshData): void {
        this.pbrMeshData.set(name, data);
        this.pbrMeshDataOwner.set(name, this.currentOwner);
    }

    getMesh(name: string): MeshGpu {
        let gpu = this.meshGpu.get(name);
        if (gpu) return gpu;

        const pbr = this.pbrMeshData.get(name);
        let owner = this.pbrMeshDataOwner.get(name);
        if (pbr) {
            gpu = this.buildPbrMesh(pbr);
        } else {
            const simple = this.meshData.get(name);
            if (!simple) throw new Error(`Mesh '${name}' not registered`);
            gpu = this.buildSimpleMesh(simple);
            owner = this.meshDataOwner.get(name);
        }
        this.meshGpu.set(name, gpu);
        this.meshGpuOwner.set(name, owner ?? this.currentOwner);
        return gpu;
    }

    hasMesh(name: string): boolean {
        return this.meshData.has(name) || this.pbrMeshData.has(name) || this.meshGpu.has(name);
    }

    /** CPU-side simple mesh data (positions/indices). Read-only accessor for
     *  the editor's mesh wireframe preview. */
    getMeshData(name: string): MeshData | undefined {
        return this.meshData.get(name);
    }

    /** CPU-side PBR mesh data (positions/normals/uvs/...). Read-only accessor
     *  for the editor's mesh wireframe preview. */
    getPbrMeshData(name: string): PbrMeshData | undefined {
        return this.pbrMeshData.get(name);
    }

    /* ── Skin / animation assets (CPU-side, owner-tagged) ──────────── */

    registerSkin(name: string, data: GltfSkinData): void {
        this.skinData.set(name, data);
        this.skinDataOwner.set(name, this.currentOwner);
    }
    registerAnimation(name: string, data: GltfAnimationData): void {
        this.animationData.set(name, data);
        this.animationDataOwner.set(name, this.currentOwner);
    }
    getSkin(name: string): GltfSkinData | undefined { return this.skinData.get(name); }
    getAnimation(name: string): GltfAnimationData | undefined { return this.animationData.get(name); }
    getSkinNames(): string[] { return [...this.skinData.keys()]; }
    getAnimationNames(): string[] { return [...this.animationData.keys()]; }

    /* ── Shared material assets (CPU-side, owner-tagged) ──────────── */

    registerMaterial(name: string, data: Record<string, unknown>): void {
        this.materialData.set(name, data);
        this.materialDataOwner.set(name, this.currentOwner);
    }
    getMaterial(name: string): Record<string, unknown> | undefined { return this.materialData.get(name); }
    getMaterialNames(): string[] { return [...this.materialData.keys()]; }

    private makeVertexBuffer(src: ArrayLike<number>): GPUBuffer {
        const arr = Float32Array.from(src);
        const buf = this.device.createBuffer({
            size: Math.max(arr.byteLength, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        if (arr.byteLength > 0) {
            this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        }
        return buf;
    }

    private makeIndexBuffer(indices: number[]): { buffer: GPUBuffer; format: GPUIndexFormat } {
        const count = indices.length;
        const maxIndex = count > 0 ? Math.max(...indices) : 0;
        const use32 = maxIndex > 65535 || count > 65535;
        if (use32) {
            const idx = new Uint32Array(Math.ceil(count / 2) * 2);
            idx.set(indices);
            const buffer = this.device.createBuffer({
                size: Math.max(idx.byteLength, 4),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, idx.buffer, idx.byteOffset, idx.byteLength);
            return { buffer, format: 'uint32' };
        }
        const idx = new Uint16Array(Math.ceil(count / 2) * 2);
        idx.set(indices);
        const buffer = this.device.createBuffer({
            size: Math.max(idx.byteLength, 4),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, 0, idx.buffer, idx.byteOffset, idx.byteLength);
        return { buffer, format: 'uint16' };
    }

    private buildSimpleMesh(data: MeshData): MeshGpu {
        const posBuf = this.makeVertexBuffer(data.positions);
        const { buffer: index, format } = this.makeIndexBuffer(data.indices);

        const edges = new Float32Array(meshEdges(data));
        const edgeBuffer = this.device.createBuffer({
            size: Math.max(edges.byteLength, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        if (edges.byteLength > 0) {
            this.device.queue.writeBuffer(edgeBuffer, 0, edges.buffer, edges.byteOffset, edges.byteLength);
        }
        const pointBuffer = this.makeVertexBuffer(data.positions);

        const posHandle = this.registerBuffer(posBuf);
        const indexHandle = this.registerBuffer(index);

        return {
            slots: { Pos: posBuf },
            slotHandles: { Pos: posHandle },
            index,
            indexHandle,
            indexFormat: format,
            indexCount: data.indices.length,
            vertexCount: data.positions.length / 3,
            edgeBuffer,
            edgeCount: edges.length / 6,
            pointBuffer,
            pointCount: data.positions.length / 3,
        };
    }

    private buildPbrMesh(data: PbrMeshData): MeshGpu {
        const posBuf = this.makeVertexBuffer(data.positions);
        const nrmBuf = this.makeVertexBuffer(data.normals);
        const uvBuf = this.makeVertexBuffer(data.uvs);
        const tanBuf = this.makeVertexBuffer(data.tangents);
        const { buffer: index, format } = this.makeIndexBuffer(data.indices);

        const slots: Partial<Record<SlotName, GPUBuffer>> = {
            Pos: posBuf, Normal: nrmBuf, UV: uvBuf, Tangent: tanBuf,
        };
        const slotHandles: Partial<Record<SlotName, number>> = {
            Pos: this.registerBuffer(posBuf),
            Normal: this.registerBuffer(nrmBuf),
            UV: this.registerBuffer(uvBuf),
            Tangent: this.registerBuffer(tanBuf),
        };
        // Skinning vertex buffers (only when the mesh carries JOINTS_0/WEIGHTS_0).
        if (data.joints && data.weights) {
            const jArr = new Uint16Array(data.joints);
            const jointBuf = this.device.createBuffer({
                size: Math.max(jArr.byteLength, 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(jointBuf, 0, jArr);
            slots.JointIndex = jointBuf;
            slotHandles.JointIndex = this.registerBuffer(jointBuf);
            const wArr = new Float32Array(data.weights);
            const weightBuf = this.device.createBuffer({
                size: Math.max(wArr.byteLength, 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(weightBuf, 0, wArr);
            slots.JointWeight = weightBuf;
            slotHandles.JointWeight = this.registerBuffer(weightBuf);
        }

        return {
            slots,
            slotHandles,
            index,
            indexHandle: this.registerBuffer(index),
            indexFormat: format,
            indexCount: data.indices.length,
            vertexCount: data.positions.length / 3,
            edgeCount: 0,
            pointCount: 0,
        };
    }

    /* ── Shared GPU resources ─────────────────────── */

    loadVboPresets(decls: Record<string, { data: number[]; format: string; stride: number }>): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.namedVboOwner, name, 'VBO preset');
            const arr = Float32Array.from(decl.data);
            const buf = this.device.createBuffer({
                label: `vbo:${name}`,
                size: arr.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
            this.namedVbos.set(name, buf);
        }
    }

    getNamedVBO(name: string): GPUBuffer | undefined {
        return this.namedVbos.get(name);
    }

    get quadVBO(): GPUBuffer {
        const buf = this.namedVbos.get('quad');
        if (!buf) throw new Error(`VBO 'quad' not declared in vbo-presets.json`);
        return buf;
    }

    /** Camera UBO. Backed by BufferRegistry (declared in camera.json `ubos`). */
    get cameraUBO(): GPUBuffer {
        return bufferRegistry.get('camera');
    }

    /** Light UBO. Backed by BufferRegistry (declared in light.json `ubos`). */
    get lightUBO(): GPUBuffer {
        return bufferRegistry.get('light');
    }

    /** Per-point-light cube-face view-projection array (6 faces × up to 4 point lights).
     *  Written by LightSystem; read by the shadow-depth pass (vertex) and PBR (fragment).
     *  Backed by BufferRegistry (declared in light.json `ubos`). */
    get pointShadowFaceUBO(): GPUBuffer {
        return bufferRegistry.get('pointShadowFaces');
    }

    /** TimeInput UBO. Backed by BufferRegistry (declared in input.json `ubos`). */
    get timeInputUBO(): GPUBuffer {
        return bufferRegistry.get('timeInput');
    }

    /** Create (or reuse) the two shadow depth textures from render-targets.json:
     *  shadowDepth2D (one 2d-array layer per directional shadow light) and
     *  shadowPoint2D (a 2d-array with 6 layers per point shadow light, i.e. up to
     *  24 face layers). Point shadows use a 2d-array rather than a cube texture so
     *  face selection is controlled end-to-end (no WebGPU cube-face convention to match). */
    private ensureShadowTextures(): void {
        const decl2D = this.renderTargetDecls['shadowDepth2D'];
        const s2D = this.resolveTargetSize('shadowDepth2D', 1, 1);
        const layers2D = decl2D?.arrayLayers ?? 4;
        if (!this._shadow2D || this._shadow2DW !== s2D.w || this._shadow2DH !== s2D.h || this._shadow2DLayers !== layers2D) {
            this._shadow2D?.destroy();
            this._shadow2D = this.device.createTexture({
                label: 'depth:shadowDepth2D',
                size: { width: s2D.w, height: s2D.h, depthOrArrayLayers: layers2D },
                format: (decl2D?.format as GPUTextureFormat) ?? 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._shadow2DW = s2D.w; this._shadow2DH = s2D.h; this._shadow2DLayers = layers2D;
            // Invalidate caches that reference the old texture's views.
            this._shadow2DArrayView = null;
            this._shadow2DLayerViews.length = 0;
            this._frameBg = null;
            this._frameShadowBg = null;
        }
        const declPoint = this.renderTargetDecls['shadowPoint2D'];
        const sPoint = this.resolveTargetSize('shadowPoint2D', 1, 1);
        const layersPoint = declPoint?.arrayLayers ?? 24;
        if (!this._shadowPoint || this._shadowPointW !== sPoint.w || this._shadowPointH !== sPoint.h || this._shadowPointLayers !== layersPoint) {
            this._shadowPoint?.destroy();
            this._shadowPoint = this.device.createTexture({
                label: 'depth:shadowPoint2D',
                size: { width: sPoint.w, height: sPoint.h, depthOrArrayLayers: layersPoint },
                format: (declPoint?.format as GPUTextureFormat) ?? 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._shadowPointW = sPoint.w; this._shadowPointH = sPoint.h; this._shadowPointLayers = layersPoint;
            // Invalidate caches that reference the old texture's views.
            this._shadowPoint2DArrayView = null;
            this._shadowPointFaceViews.length = 0;
            this._frameBg = null;
            this._frameShadowBg = null;
        }
    }

    /** Full 2d-array view of the directional shadow map (for PBR sampling). */
    shadowDepth2DArrayView(): GPUTextureView {
        this.ensureShadowTextures();
        if (!this._shadow2DArrayView) {
            this._shadow2DArrayView = this._shadow2D!.createView({ dimension: '2d-array' });
        }
        return this._shadow2DArrayView;
    }

    /** Single-layer 2D view of one directional shadow map (for the shadow render pass). */
    shadowDepth2DLayerView(layer: number): GPUTextureView {
        this.ensureShadowTextures();
        let v = this._shadow2DLayerViews[layer];
        if (!v) {
            v = this._shadow2D!.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 });
            this._shadow2DLayerViews[layer] = v;
        }
        return v;
    }

    /** Full 2d-array view of the point-light shadow map (for PBR sampling). */
    shadowPoint2DArrayView(): GPUTextureView {
        this.ensureShadowTextures();
        if (!this._shadowPoint2DArrayView) {
            this._shadowPoint2DArrayView = this._shadowPoint!.createView({ dimension: '2d-array' });
        }
        return this._shadowPoint2DArrayView;
    }

    /** Single 2D face view of one point-light shadow face (for the shadow render pass).
     *  `faceSlot` = pointShadowMapIndex * 6 + face (0..23). */
    shadowPoint2DFaceView(faceSlot: number): GPUTextureView {
        this.ensureShadowTextures();
        let v = this._shadowPointFaceViews[faceSlot];
        if (!v) {
            v = this._shadowPoint!.createView({ dimension: '2d', baseArrayLayer: faceSlot, arrayLayerCount: 1 });
            this._shadowPointFaceViews[faceSlot] = v;
        }
        return v;
    }

    /** Named depth target view; distinct depth textures keyed by name (data-driven targets).
     *  Format comes from render-targets.json if declared; falls back to 'depth24plus'.
     *
     *  Note: WebGPU requires the depth attachment's size to exactly match the color
     *  attachment's base plane size, so a viewport-sized depth target MUST be
     *  reallocated on every canvas resize. The old GPUTextureView cannot be freed
     *  eagerly (no destroy()), so each resize leaves one stale view until GC — this
     *  is a WebGPU/browser limitation, not an engine bug. */
    namedDepthTargetView(name: string, viewportW: number, viewportH: number): GPUTextureView {
        const { w, h } = this.resolveTargetSize(name, viewportW, viewportH);
        const decl = this.renderTargetDecls[name];
        const format = (decl?.format && decl.format !== 'default'
            ? decl.format : 'depth24plus') as GPUTextureFormat;
        let entry = this.depthTargets.get(name);
        if (!entry || entry.w !== w || entry.h !== h || entry.format !== format) {
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            const tex = this.device.createTexture({
                label: `depth:${name}`,
                size: { width: w, height: h },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            entry = { tex, w, h, format };
            this.depthTargets.set(name, entry);
            this.depthTargetOwner.set(name, this.currentOwner);
        }
        return this.textureView(entry.tex);
    }

    getUniform(key: string, data: number[] | Float32Array, byteSize: number): GPUBuffer {
        let buf = this.uniformBuffers.get(key);
        if (!buf) {
            buf = this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.uniformBuffers.set(key, buf);
            this.uniformOwner.set(key, this.currentOwner);
        }
        const arr = Float32Array.from(data);
        this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        return buf;
    }

    getStorageBuffer(key: string, byteSize: number): GPUBuffer {
        let entry = this.storageBuffers.get(key);
        if (!entry || entry.size < byteSize) {
            entry?.buffer.destroy();
            const buffer = this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            entry = { buffer, size: byteSize };
            this.storageBuffers.set(key, entry);
            this.storageOwner.set(key, this.currentOwner);
        }
        return entry.buffer;
    }

    /* ── Textures ─────────────────────────────────── */

    async loadTexture(url: string): Promise<GPUTexture> {
        let tex = this.textures.get(url);
        if (tex) return tex;

        const resp = await fetch(url);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });

        tex = this.device.createTexture({
            size: { width: bitmap.width, height: bitmap.height },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: tex },
            { width: bitmap.width, height: bitmap.height },
        );
        bitmap.close();

        this.textures.set(url, tex);
        this.textureOwner.set(url, this.currentOwner);
        this.registerTextureHandle(url, tex);
        return tex;
    }

    getTexture(url: string): GPUTexture | undefined {
        return this.textures.get(url);
    }

    private registerTextureHandle(key: string, tex: GPUTexture): number {
        const existing = this.textureKeyToHandle.get(key);
        if (existing) { this.textureList[existing] = tex; return existing; }
        const free = this.textureFreeList.pop();
        let handle: number;
        if (free !== undefined) {
            this.textureList[free] = tex;
            handle = free;
        } else {
            this.textureList.push(tex);
            handle = this.textureList.length - 1;
        }
        this.textureKeyToHandle.set(key, handle);
        return handle;
    }

    textureHandle(key: string): number {
        return this.textureKeyToHandle.get(key) ?? 0;
    }

    /** Reverse lookup: a texture handle (u32 stored on an entity field) → the
     *  resource key/name. Returns undefined for handle 0 or unknown handles.
     *  Used by the editor's asset-reference field to display the name backing
     *  a stored handle. */
    textureKeyFromHandle(handle: number): string | undefined {
        if (!handle) return undefined;
        for (const [key, h] of this.textureKeyToHandle) {
            if (h === handle) return key;
        }
        return undefined;
    }

    /** A stable numeric handle for a mesh NAME. Assigned lazily for known
     *  meshes only (hasMesh must be true); returns 0 for unknown names. The
     *  handle is NOT stored on MeshComponent.mesh (which keeps its string
     *  name) — it exists for editor/preview cache keys and a protocol-stable
     *  id. Parallel to textureHandle but without a GPU-resource list. */
    getMeshHandle(name: string): number {
        let h = this.meshKeyToHandle.get(name);
        if (h === undefined) {
            if (!this.hasMesh(name)) return 0;
            h = ++this.meshHandleCounter;
            this.meshKeyToHandle.set(name, h);
        }
        return h;
    }

    /** Reverse lookup: mesh handle → name. */
    meshKeyFromHandle(handle: number): string | undefined {
        if (!handle) return undefined;
        for (const [name, h] of this.meshKeyToHandle) {
            if (h === handle) return name;
        }
        return undefined;
    }

    async uploadTextureFromImage(key: string, img: ImageBitmap | HTMLImageElement | HTMLCanvasElement, sRGB = false): Promise<GPUTexture> {
        if (this.textures.has(key)) return this.textures.get(key)!;

        const bitmap = img instanceof ImageBitmap ? img : await createImageBitmap(img, { colorSpaceConversion: 'none' });
        const format: GPUTextureFormat = sRGB ? 'rgba8unorm-srgb' : 'rgba8unorm';

        const tex = this.device.createTexture({
            size: { width: bitmap.width, height: bitmap.height },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: tex },
            { width: bitmap.width, height: bitmap.height },
        );
        if (bitmap !== img) bitmap.close();

        this.textures.set(key, tex);
        this.textureOwner.set(key, this.currentOwner);
        this.registerTextureHandle(key, tex);
        return tex;
    }

    colorTarget(key: string, w: number, h: number, format: GPUTextureFormat): GPUTexture {
        const prev = this.colorTargets.get(key);
        if (!prev || prev.w !== w || prev.h !== h || prev.format !== format) {
            if (prev) { this.textureViewCache.delete(prev.tex); prev.tex.destroy(); }
            const tex = this.device.createTexture({
                size: { width: w, height: h },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this.colorTargets.set(key, { tex, w, h, format });
            this.colorTargetOwner.set(key, this.currentOwner);
            return tex;
        }
        return prev.tex;
    }

    get sampler(): GPUSampler {
        return this.namedSampler('default');
    }

    /* ── Named samplers (samplers.json) ───────────── */

    loadSamplers(decls: SamplerDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.samplerOwner, name, 'Sampler');
            this.samplers.set(name, this.device.createSampler({ label: name, ...decl }));
        }
    }

    /* ── Named render targets (render-targets.json) ──── */

    loadRenderTargets(decls: RenderTargetDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.renderTargetOwner, name, 'Render target');
            this.renderTargetDecls[name] = decl;
        }
    }

    /** Resolve a target's actual pixel size from its declaration. */
    private resolveTargetSize(name: string, viewportW: number, viewportH: number): { w: number; h: number } {
        const decl = this.renderTargetDecls[name];
        if (!decl?.size) return { w: viewportW, h: viewportH };
        const size = decl.size;
        if (size.type === 'fixed') {
            return { w: size.w ?? viewportW, h: size.h ?? viewportH };
        }
        const scale = size.scale ?? 1;
        return { w: Math.max(1, Math.round(viewportW * scale)), h: Math.max(1, Math.round(viewportH * scale)) };
    }

    namedSampler(name: string): GPUSampler {
        const s = this.samplers.get(name);
        if (!s) throw new Error(`Sampler '${name}' not declared in samplers.json`);
        return s;
    }

    loadFallbackTextures(decls: Record<string, { pixel: number[]; format: GPUTextureFormat }>): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.fallbackTextureOwner, name, 'Fallback texture');
            const tex = this.device.createTexture({
                label: `fallback:${name}`,
                size: { width: 1, height: 1 },
                format: decl.format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.device.queue.writeTexture(
                { texture: tex },
                new Uint8Array(decl.pixel),
                { bytesPerRow: 4, rowsPerImage: 1 },
                { width: 1, height: 1 },
            );
            this.fallbackTextures.set(name, tex);
        }
    }

    get defaultWhite(): GPUTexture {
        const tex = this.fallbackTextures.get('white');
        if (!tex) throw new Error(`Fallback texture 'white' not declared in fallback-textures.json`);
        return tex;
    }

    get defaultNormal(): GPUTexture {
        const tex = this.fallbackTextures.get('normal');
        if (!tex) throw new Error(`Fallback texture 'normal' not declared in fallback-textures.json`);
        return tex;
    }

    /* ── Bind groups (built against named layouts) ── */

    /** Resolve a single resource entry for a frame bind group. */
    private resolveFrameResource(entry: BindEntryDecl): GPUBindingResource {
        const name = entry.resource ?? '';
        if (name.startsWith('sampler:')) {
            return this.namedSampler(name.slice(8));
        }
        // Buffer resources (UBOs + storage buffers) — registered by name in
        // BufferRegistry (declared via system.json `ubos`/`buffers` fields).
        // The name matches the uniform-layouts.json layout name (for UBOs) or
        // the explicit `name` field (for storage buffers).
        if (bufferRegistry.has(name)) {
            return { buffer: bufferRegistry.get(name) };
        }
        // Shadow texture resources — still special-cased here pending a
        // TextureViewRegistry (Step 9 cleanup).
        switch (name) {
            case 'shadowDepth2DArray':  return this.shadowDepth2DArrayView();
            case 'shadowPoint2DArray':  return this.shadowPoint2DArrayView();
            default: throw new Error(`Unknown frame resource '${name}' in bind-layouts.json`);
        }
    }

    /** Resolve a plugin-published resource against the declared layout binding type. */
    namedGpuResource(layoutName: string, binding: number, name: string): GPUBindingResource {
        const entries = this.bindLayoutDecls.get(layoutName);
        if (!entries) throw new Error(`Bind layout '${layoutName}' not declared`);
        const entry = entries.find(candidate => candidate.binding === binding);
        if (!entry) {
            throw new Error(`Bind layout '${layoutName}' has no @binding(${binding})`);
        }
        return gpuResourceRegistry.resolve(name, this.resourceKind(entry));
    }

    private resourceKind(entry: BindEntryDecl): GpuResourceKind {
        if (entry.buffer) return 'buffer';
        if (entry.sampler) return 'sampler';
        if (entry.texture || entry.storageTexture) return 'texture';
        throw new Error(`Bind layout entry @binding(${entry.binding}) has no resource type`);
    }

    /** Build a frame bind group from the named layout's entry declarations. */
    private buildFrameBindGroup(layoutName: string): GPUBindGroup {
        const entries = this.bindLayoutDecls.get(layoutName);
        if (!entries) throw new Error(`Bind layout '${layoutName}' not declared`);
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries: entries.map(e => ({
                binding: e.binding,
                resource: this.resolveFrameResource(e),
            })),
        });
    }

    frameBindGroup(): GPUBindGroup {
        if (!this._frameBg) this._frameBg = this.buildFrameBindGroup('frame');
        return this._frameBg;
    }

    /** Frame bind group for the shadow render pass: UBOs only (camera/light/time +
     *  pointShadowFaces), no shadow textures (they are the render targets). */
    frameShadowBindGroup(): GPUBindGroup {
        if (!this._frameShadowBg) this._frameShadowBg = this.buildFrameBindGroup('frameShadow');
        return this._frameShadowBg;
    }

    /** Per-face shadow-pass bind group: {lightIdx, face} selecting the current shadow
     *  light and (for point lights) the cube face. Distinct tiny UBOs per pass index
     *  (each written once per frame) avoid the write-after-write hazard of updating a
     *  single shared UBO between render passes in one command buffer.
     *  The bind group wraps the per-passIndex UBO buffer (stable object; its
     *  {lightIdx, face} contents are rewritten each frame via writeBuffer), so the
     *  bind group object is cached per passIndex — only built once, then reused.
     *
     *  The UBO + bind group are common-owned (not app-scoped): the passIndex →
     *  lightIdx/face mapping is rewritten every frame, so they survive app reload
     *  without going stale. This avoids recreating them on every reload (the
     *  browser does not promptly GC GPUBindGroup). */
    shadowPassBindGroup(passIndex: number, lightIdx: number, face: number): GPUBindGroup {
        const key = `shadowPass_${passIndex}`;
        let buf = this.uniformBuffers.get(key);
        if (!buf) {
            buf = this.device.createBuffer({
                size: uniformLayouts.get('shadowPass').byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.uniformBuffers.set(key, buf);
            this.uniformOwner.set(key, 'common');
        }
        const layout = uniformLayouts.get('shadowPass');
        const scratch = this._shadowPassScratch;
        scratch.fill(0);
        layout.writeU32(scratch, 'lightIdx', lightIdx);
        layout.writeU32(scratch, 'face', face);
        this.device.queue.writeBuffer(buf, 0, scratch.buffer, scratch.byteOffset, scratch.byteLength);
        let bg = this._shadowPassBindGroups.get(passIndex);
        if (!bg) {
            bg = this.device.createBindGroup({
                layout: this.namedLayout('shadowPass'),
                entries: [{ binding: 0, resource: { buffer: buf } }],
            });
            this._shadowPassBindGroups.set(passIndex, bg);
        }
        return bg;
    }

    objectBindGroup(uniformBuffer: GPUBuffer): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout('object'),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });
    }

    pbrMaterialBindGroup(
        uniformBuffer: GPUBuffer,
        tex: {
            baseColor?: GPUTexture;
            metallicRoughness?: GPUTexture;
            occlusion?: GPUTexture;
            emissive?: GPUTexture;
            normal?: GPUTexture;
        },
    ): GPUBindGroup {
        const white = this.defaultWhite;
        return this.device.createBindGroup({
            layout: this.namedLayout('materialPbr'),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: (tex.baseColor ?? white).createView() },
                { binding: 3, resource: (tex.metallicRoughness ?? white).createView() },
                { binding: 4, resource: (tex.occlusion ?? white).createView() },
                { binding: 5, resource: (tex.emissive ?? white).createView() },
                { binding: 6, resource: (tex.normal ?? this.defaultNormal).createView() },
            ],
        });
    }

    skyboxMaterialBindGroup(texture: GPUTexture): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout('materialSkybox'),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: texture.createView() },
            ],
        });
    }

    computeBindGroup(layoutName: string, entries: GPUBindGroupEntry[]): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries,
        });
    }

    /** Build a bind group against a named layout from arbitrary entries (data-driven). */
    genericBindGroup(layoutName: string, entries: GPUBindGroupEntry[]): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries,
        });
    }

    /** Cached default view of a GPUTexture. Reused across frames for stable
     *  textures (UBO buffers, shadow maps, render targets, fallback 1x1
     *  textures, loaded asset textures); a fresh view is created only when the
     *  underlying GPUTexture object changes (recreate-on-resize / app switch). */
    textureView(tex: GPUTexture): GPUTextureView {
        let v = this.textureViewCache.get(tex);
        if (!v) {
            v = tex.createView();
            this.textureViewCache.set(tex, v);
        }
        return v;
    }

    /** Fallback 1x1 texture view by name (from fallback-textures.json); no name → white. */
    fallbackTextureView(name?: string): GPUTextureView {
        if (name && !this.fallbackTextures.has(name)) {
            throw new Error(`Fallback texture '${name}' not declared in fallback-textures.json`);
        }
        const tex = name ? this.fallbackTextures.get(name)! : this.defaultWhite;
        return this.textureView(tex);
    }

    /** Named color render target view (offscreen). Size resolved from render-targets.json.
     *  The texture format is taken from the target's declaration (render-targets.json)
     *  when set, so float GBuffer targets keep their format regardless of the caller's
     *  fallback (e.g. the swapchain format passed for the 'scene' target). */
    namedColorTargetView(name: string, viewportW: number, viewportH: number, fallbackFormat: GPUTextureFormat): GPUTextureView {
        const decl = this.renderTargetDecls[name];
        const format = decl?.format && decl.format !== 'default'
            ? (decl.format as GPUTextureFormat)
            : fallbackFormat;
        const { w, h } = this.resolveTargetSize(name, viewportW, viewportH);
        return this.textureView(this.colorTarget(name, w, h, format));
    }

    /** Sampleable view of a named render target for a pipeline that READS it (e.g. a
     *  deferred lighting pass reading the GBuffer). Shares the same underlying texture
     *  as the write-side namedColorTargetView (cached by name in this.colorTargets). */
    renderTargetView(name: string, viewportW: number, viewportH: number): GPUTextureView {
        const decl = this.renderTargetDecls[name];
        const format: GPUTextureFormat = (decl?.format && decl.format !== 'default')
            ? (decl.format as GPUTextureFormat)
            : 'bgra8unorm';
        return this.namedColorTargetView(name, viewportW, viewportH, format);
    }

    fullscreenBindGroup(srcView: GPUTextureView, entry: PipelineEntry): GPUBindGroup {
        if (entry.params) {
            const data: number[] = [];
            for (const values of Object.values(entry.params)) data.push(...values);
            const buf = this.getUniform(`pp_${entry.name}`, data, Math.max(256, data.length * 4));
            return this.device.createBindGroup({
                layout: this.namedLayout('fullscreenParam'),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: srcView },
                    { binding: 2, resource: { buffer: buf } },
                ],
            });
        }
        return this.device.createBindGroup({
            layout: this.namedLayout('fullscreen'),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: srcView },
            ],
        });
    }
}

export const resourceManager = new ResourceManager();
