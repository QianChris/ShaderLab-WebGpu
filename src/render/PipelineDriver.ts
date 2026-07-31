import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { uniformLayouts } from './UniformLayout';
import { resolveHandle, compileValue, compileString, type ValueContext, type CompiledValue, type CompiledString } from './valueResolver';
import type { Scene } from '../ecs/Scene';
import type { RendererDecl, BindGroupDecl } from './rendererDecl';

/** A geometry hook: escape-hatch that records its own draw calls. */
export type GeometryHook = (pass: GPURenderPassEncoder, ctx: GeometryHookContext) => void;

/** A compute hook: escape-hatch that records its own compute passes. */
export type ComputeHook = (encoder: GPUCommandEncoder, ctx: ComputeHookContext) => void;

export interface GeometryHookContext {
    scene: Scene;
    entities: readonly number[];
    pipeline: GPURenderPipeline;
    time: number;
    dt: number;
    cw: number;
    ch: number;
    /** Opaque plugin-published objects (registerAttachment): particles/physics/splats/…. */
    attachments: Record<string, unknown>;
    computePipelines: Map<string, GPUComputePipeline>;
}

export interface ComputeHookContext {
    scene: Scene;
    entities: readonly number[];
    time: number;
    dt: number;
    computePipelines: Map<string, GPUComputePipeline>;
    /** Opaque plugin-published objects (registerAttachment). */
    attachments: Record<string, unknown>;
    /** Extra pipeline names declared on the entry (e.g. particle emit/sim). */
    aux: Record<string, string | undefined>;
    /** Look up compute pipeline metadata (workgroupSize, bindings) by config path. */
    getComputeMeta?: (path: string) => import('./types').ComputeMeta | undefined;
}

/**
 * Executes one JSON-declared render pipeline: iterate matching entities, fill
 * each declared bind group from component fields (value mini-language), then
 * emit geometry per the geometry declaration. No per-pipeline TypeScript.
 */
export class PipelineDriver {
    readonly path: string;
    readonly decl: RendererDecl;
    /** The manifest entry that referenced this pipeline (params, name, etc). */
    readonly entry: import('./types').PipelineEntry;
    dataBase = '/common';
    /** Auxiliary resources declared in `renderer.aux`, passed through to hooks
     *  via `ctx.aux`. Open container: pipeline-defined keys, no TS change needed. */
    aux: Record<string, string | undefined> = {};
    /** Entity query (built from `renderer.query` component names). */
    query?: (w: import('bitecs').World) => readonly number[];
    /** Named value scripts (script:file.fn), shared registry. */
    valueScripts: Map<string, (ctx: ValueContext) => number[] | number>;
    /** Named geometry scripts (geometry.source="script"). */
    geometryHooks: Map<string, GeometryHook>;
    /** Named compute scripts (compute stage). */
    computeHooks: Map<string, ComputeHook>;
    /** Per-entity bind-group cache keyed `${group}_${eid}`. Entries are rebuilt
     *  only when a bound resource changes identity (e.g. a sprite texture
     *  finishing async load flips the view from fallback to the real one);
     *  otherwise the same GPUBindGroup is reused across frames. Uniform
     *  buffers (getUniform, cached by key), samplers (namedSampler, cached by
     *  name) and texture views (ResourceManager.textureView, cached per tex)
     *  are all stable objects, so the signature comparison is cheap and exact. */
    private bgCache = new Map<string, { bg: GPUBindGroup; sig: unknown[] }>();
    /** Precompiled uniform write values: compiledWrites[bgIndex][writeIndex].
     *  Built once at construction — eliminates per-entity string parsing. */
    private compiledWrites: CompiledValue[][] = [];
    /** Precompiled texture handle sources (for non-static texture bindings).
     *  Null entries = the texture uses a static source (renderTarget:/asset:). */
    private compiledTextureHandles: Array<Array<((ctx: ValueContext) => number) | null>> = [];
    /** Precompiled draw count fields per geometry step. */
    private compiledCounts: Array<{ count?: CompiledValue; instance?: CompiledValue }> = [];
    /** Precompiled mesh-name resolvers per geometry step (index buffer /
     *  vertex buffer mesh field). Null = default 'MeshComponent.mesh'. */
    private compiledMeshNames: Array<CompiledString | null> = [];
    /** Reusable scratch model matrix for distance computation during render-sort. */
    private sortScratch = new Float32Array(16);
    /** Reusable sort entries (eid + squared distance to camera). The buffer
     *  grows as needed; only the first `n` entries are sorted/iterated. */
    private sortBuffer: Array<{ eid: number; dist: number }> = [];
    /** Storage buffer for instanced model matrices (array<mat4x4f>).
     *  Grows as needed; reused across frames. */
    private instanceBuffer: GPUBuffer | null = null;
    /** Reusable CPU-side matrix staging array for instanced writes. */
    private instanceMatrices: Float32Array = new Float32Array(0);

    constructor(
        path: string,
        decl: RendererDecl,
        entry: import('./types').PipelineEntry,
        valueScripts: Map<string, (ctx: ValueContext) => number[] | number>,
        geometryHooks: Map<string, GeometryHook>,
        computeHooks: Map<string, ComputeHook>,
    ) {
        this.path = path;
        this.decl = decl;
        this.entry = entry;
        this.valueScripts = valueScripts;
        this.geometryHooks = geometryHooks;
        this.computeHooks = computeHooks;
        this.precompile();
    }

    /** Precompile value-source strings into closures at construction time so
     *  the per-entity hot path only invokes closures — no string parsing. */
    private precompile(): void {
        const bgs = this.decl.bindGroups ?? [];
        this.compiledWrites = bgs.map(bg =>
            (bg.uniform?.writes ?? []).map(w => compileValue(w.value)),
        );
        this.compiledTextureHandles = bgs.map(bg =>
            (bg.textures ?? []).map(t => {
                const s = t.source;
                if (s.startsWith('renderTarget:') || s.startsWith('asset:')) return null;
                return (ctx: ValueContext) => resolveHandle(s, ctx);
            }),
        );
        const steps = this.decl.geometry.steps ?? [];
        this.compiledCounts = steps.map(step => ({
            count: step.draw?.countField ? compileValue(step.draw.countField) : undefined,
            instance: step.draw?.instanceCountField ? compileValue(step.draw.instanceCountField) : undefined,
        }));
        this.compiledMeshNames = steps.map(step => {
            const meshSrc = step.indexBuffer?.mesh
                ?? step.vertexBuffers?.find(vb => vb.source === 'meshSlots' || vb.source === 'meshField')?.mesh;
            if (!meshSrc) return null;
            return compileString(meshSrc);
        });
    }

    /** Release cached GPU objects so they are GC-eligible immediately on app
     *  unload, rather than waiting for this driver (and its bgCache Map) to be
     *  collected. GPUBindGroup has no destroy(); dereferencing is the only lever. */
    dispose(): void {
        this.bgCache.clear();
        this.instanceBuffer?.destroy();
        this.instanceBuffer = null;
    }

    /** Encode compute work declared by this pipeline (script hook), before the render pass. */
    compute(encoder: GPUCommandEncoder, ctx: Omit<ComputeHookContext, 'entities' | 'aux'> & { scene: Scene }): void {
        const decl = this.decl.compute as { script?: string } | undefined;
        if (!decl?.script) return;
        const hook = this.computeHooks.get(decl.script);
        if (!hook) {
            throw new Error(
                `Pipeline '${this.path}': compute hook '${decl.script}' not found — ` +
                `is its script listed in render.json "renderScripts" and does it export that function?`,
            );
        }
        hook(encoder, {
            ...ctx,
            entities: this.query ? this.query(ctx.scene.world) : [],
            aux: this.aux,
            getComputeMeta: (path: string) => PipelineLoader.getComputeMeta(path),
        });
    }

    /** Record draws into an already-open render pass. */
    record(
        pass: GPURenderPassEncoder,
        scene: Scene,
        pipeline: GPURenderPipeline,
        frame: import('./types').DriverFrame,
    ): void {
        const geom = this.decl.geometry;
        const entities = this.query ? this.query(scene.world) : [];

        const vctx: ValueContext = {
            scene, eid: 0, tag: this.decl.tag ?? '',
            time: frame.time, dt: frame.dt,
            aspect: frame.cw / frame.ch, screenW: frame.cw, screenH: frame.ch,
            model: () => scene.getModelMatrix(vctx.eid),
            scripts: this.valueScripts,
        };

        // Script hook: escape hatch that records its own draws.
        // Bind groups (including frame @group(0)) are set first so the hook
        // has access to the same frame/object/material resources.
        if (geom.hook) {
            this.bindGroups(pass, vctx);
            const hook = this.geometryHooks.get(geom.hook);
            if (!hook) {
                throw new Error(
                    `Pipeline '${this.path}': geometry hook '${geom.hook}' not found — ` +
                    `is its script listed in render.json "renderScripts" and does it export that function?`,
                );
            }
            hook(pass, {
                scene, entities, pipeline,
                time: frame.time, dt: frame.dt, cw: frame.cw, ch: frame.ch,
                attachments: frame.attachments,
                computePipelines: frame.computePipelines,
            });
            return;
        }

        // No query: single draw with static (non-per-entity) bind groups.
        if (!this.query) {
            pass.setPipeline(pipeline);
            this.bindGroups(pass, vctx);
            this.emitGeometry(pass, vctx);
            return;
        }

        // GPU instancing path: batch all matching entities into one draw call.
        // Model matrices go into a storage buffer; the shader indexes via
        // @builtin(instance_index). Requires the object bind group layout to
        // declare a storage buffer. Incompatible with transparent (no per-instance
        // sort). Falls through to per-entity path when <2 entities or no query.
        const filter = this.decl.filter;
        if (this.decl.instanced && entities.length > 1) {
            this.recordInstanced(pass, scene, pipeline, frame, vctx, entities, filter);
            return;
        }

        // Render-sort: order entities by distance to the active camera.
        // Transparent → far→near (painter's); opaque → near→far (early-z).
        const camPos = frame.cameraPos;
        if (camPos && entities.length > 1) {
            const transparent = this.decl.transparent ?? false;
            // Grow the reusable buffer (objects are reused, not reallocated).
            while (this.sortBuffer.length < entities.length) {
                this.sortBuffer.push({ eid: 0, dist: 0 });
            }
            let count = 0;
            for (const eid of entities) {
                if (filter) {
                    const v = scene.getField(eid, filter.component, filter.field);
                    if ((Number(v) ?? 0) !== filter.value) continue;
                }
                const model = scene.getModelMatrix(eid, this.sortScratch);
                const dx = model[12] - camPos[0];
                const dy = model[13] - camPos[1];
                const dz = model[14] - camPos[2];
                this.sortBuffer[count] = {
                    eid,
                    dist: dx * dx + dy * dy + dz * dz,
                };
                count++;
            }
            const sorted = this.sortBuffer.slice(0, count);
            sorted.sort((a, b) => transparent ? b.dist - a.dist : a.dist - b.dist);
            for (let i = 0; i < count; i++) {
                vctx.eid = sorted[i].eid;
                pass.setPipeline(pipeline);
                this.bindGroups(pass, vctx);
                this.emitGeometry(pass, vctx);
            }
            return;
        }

        // No camera or single entity: use query order (no sort).
        for (const eid of entities) {
            if (filter) {
                const v = scene.getField(eid, filter.component, filter.field);
                if ((Number(v) ?? 0) !== filter.value) continue;
            }
            vctx.eid = eid;
            pass.setPipeline(pipeline);
            this.bindGroups(pass, vctx);
            this.emitGeometry(pass, vctx);
        }
    }

    /* ── bind group assembly ──────────────────────── */

    /** GPU-instanced draw: write all matching entities' model matrices into a
     *  storage buffer, set bind groups once, and draw all instances in a single
     *  drawIndexed(indexCount, instanceCount) call. The shader must use
     *  @builtin(instance_index) to index into the matrix array. */
    private recordInstanced(
        pass: GPURenderPassEncoder,
        scene: Scene,
        pipeline: GPURenderPipeline,
        frame: import('./types').DriverFrame,
        vctx: ValueContext,
        entities: readonly number[],
        filter: { component: string; field: string; value: number } | undefined,
    ): void {
        // Collect matching entities (apply filter if declared).
        const matching: number[] = [];
        for (const eid of entities) {
            if (filter) {
                const v = scene.getField(eid, filter.component, filter.field);
                if ((Number(v) ?? 0) !== filter.value) continue;
            }
            matching.push(eid);
        }
        if (matching.length === 0) return;

        const n = matching.length;
        const matFloats = 16;
        const requiredBytes = n * matFloats * 4;

        // Grow the storage buffer if needed (reused across frames).
        if (!this.instanceBuffer || this.instanceBuffer.size < requiredBytes) {
            this.instanceBuffer?.destroy();
            this.instanceBuffer = resourceManager.device.createBuffer({
                label: `instanced:${this.path}`,
                size: requiredBytes,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }
        // Grow the CPU staging array if needed.
        if (this.instanceMatrices.length < n * matFloats) {
            this.instanceMatrices = new Float32Array(n * matFloats);
        }
        for (let i = 0; i < n; i++) {
            const model = scene.getModelMatrix(matching[i], this.sortScratch);
            this.instanceMatrices.set(model, i * matFloats);
        }
        resourceManager.device.queue.writeBuffer(
            this.instanceBuffer, 0,
            this.instanceMatrices.buffer,
            this.instanceMatrices.byteOffset,
            n * matFloats * 4,
        );

        // Set the pipeline + frame bind group (group 0) as usual.
        pass.setPipeline(pipeline);
        const names = PipelineLoader.getConfig(this.path)?.bindLayout ?? [];
        if (names[0] === 'frame') {
            pass.setBindGroup(0, resourceManager.frameBindGroup());
        } else if (names[0] === 'frameShadow') {
            pass.setBindGroup(0, resourceManager.frameShadowBindGroup());
        }

        // Set the instanced object bind group: storage buffer of model matrices.
        // Uses the layout declared for the object group (must declare a storage
        // buffer entry). The binding index comes from the bind group's uniform
        // binding (or 0). Material bind groups are set normally.
        for (const bg of this.decl.bindGroups ?? []) {
            if (bg.uniform) {
                const layoutName = this.layoutNameFor(bg.group);
                const binding = bg.uniform.binding ?? 0;
                const bgObj = resourceManager.genericBindGroup(layoutName, [
                    { binding, resource: { buffer: this.instanceBuffer } },
                ]);
                pass.setBindGroup(bg.group, bgObj);
            } else {
                // Non-uniform bind groups (samplers, textures, static) set normally.
                vctx.eid = 0;
                const entries = this.buildEntries(bg, vctx, this.layoutNameFor(bg.group), this.indexOfBindGroup(bg));
                pass.setBindGroup(bg.group, resourceManager.genericBindGroup(this.layoutNameFor(bg.group), entries));
            }
        }

        // Emit geometry once (vertex buffers + index buffer) then draw all instances.
        this.emitGeometryInstanced(pass, vctx, n);
    }

    /** Find the array index of a BindGroupDecl in this.decl.bindGroups. */
    private indexOfBindGroup(bg: BindGroupDecl): number {
        return (this.decl.bindGroups ?? []).indexOf(bg);
    }

    /** Emit vertex buffers + index buffer + a single instanced draw call. */
    private emitGeometryInstanced(pass: GPURenderPassEncoder, vctx: ValueContext, instanceCount: number): void {
        const steps = this.decl.geometry.steps ?? [];
        for (let si = 0; si < steps.length; si++) {
            const step = steps[si];
            const meshNameFn = this.compiledMeshNames[si];
            const meshName = meshNameFn ? meshNameFn(vctx) : 'MeshComponent.mesh';
            const mesh = meshName && resourceManager.hasMesh(meshName)
                ? resourceManager.getMesh(meshName) : null;

            for (const vb of step.vertexBuffers ?? []) {
                this.bindVertexBuffer(pass, vb, vctx, meshName);
            }
            if (step.indexBuffer && mesh?.index) {
                pass.setIndexBuffer(mesh.index, mesh.indexFormat);
            }
            const draw = step.draw;
            if (!draw) continue;
            if (draw.type === 'drawIndexed') {
                const count = mesh?.indexCount ?? 0;
                if (count > 0) pass.drawIndexed(count, instanceCount);
            } else {
                const vCount = draw.vertexCount ?? 3;
                pass.draw(vCount, instanceCount);
            }
        }
    }

    private bindGroups(pass: GPURenderPassEncoder, vctx: ValueContext): void {
        // Auto-bind the frame group at @group(0) based on the pipeline's first layout name.
        const names = PipelineLoader.getConfig(this.path)?.bindLayout ?? [];
        if (names[0] === 'frame') {
            pass.setBindGroup(0, resourceManager.frameBindGroup());
        } else if (names[0] === 'frameShadow') {
            pass.setBindGroup(0, resourceManager.frameShadowBindGroup());
        } else if (names.length > 0 && !(this.decl.bindGroups ?? []).some(bg => bg.group === 0)) {
            // A named @group(0) layout that is neither a known frame layout nor
            // covered by a renderer.bindGroups entry would silently stay unbound.
            throw new Error(
                `Pipeline '${this.path}': bindLayout[0] '${names[0]}' is not a known frame layout ` +
                `('frame' | 'frameShadow') and no renderer.bindGroups entry declares group 0`,
            );
        }

        const bgs = this.decl.bindGroups ?? [];
        for (let bgIndex = 0; bgIndex < bgs.length; bgIndex++) {
            const bg = bgs[bgIndex];
            const layoutName = this.layoutNameFor(bg.group);
            const entries = this.buildEntries(bg, vctx, layoutName, bgIndex);
            // Per-entity bind-group reuse: only rebuild when a bound resource
            // changes identity (uniform buffer/sampler/view are all cached +
            // stable, so the common case is a cache hit → no new GPUBindGroup).
            const sig = entries.map(e => (e.resource as GPUBufferBinding).buffer ?? e.resource);
            const key = `${bg.group}_${vctx.eid}`;
            const cached = this.bgCache.get(key);
            let bgObj: GPUBindGroup;
            if (cached && sig.length === cached.sig.length
                && sig.every((r, i) => r === cached.sig[i])) {
                bgObj = cached.bg;
            } else {
                bgObj = resourceManager.genericBindGroup(layoutName, entries);
                this.bgCache.set(key, { bg: bgObj, sig });
            }
            pass.setBindGroup(bg.group, bgObj);
        }
    }

    private buildEntries(bg: BindGroupDecl, vctx: ValueContext, layoutName: string, bgIndex: number): GPUBindGroupEntry[] {
        const entries: GPUBindGroupEntry[] = [];

        if (bg.uniform) {
            const layout = uniformLayouts.get(bg.uniform.layoutRef);
            const buf = layout.createBuffer();
            const writes = bg.uniform.writes;
            const compiled = this.compiledWrites[bgIndex];
            for (let i = 0; i < writes.length; i++) {
                layout.write(buf, writes[i].member, compiled[i](vctx));
            }
            const key = `bg_${this.path}_${bg.group}_${vctx.eid}`;
            entries.push({ binding: bg.uniform.binding ?? 0, resource: { buffer: resourceManager.getUniform(key, buf, layout.byteSize) } });
        }

        for (const s of bg.samplers ?? []) {
            entries.push({ binding: s.binding, resource: resourceManager.namedSampler(s.name ?? 'default') });
        }

        const compiledTex = this.compiledTextureHandles[bgIndex] ?? [];
        const textures = bg.textures ?? [];
        for (let ti = 0; ti < textures.length; ti++) {
            const t = textures[ti];
            // Static sources (renderTarget:/asset:) — no per-entity resolution.
            if (t.source.startsWith('renderTarget:')) {
                const rtName = t.source.slice('renderTarget:'.length);
                entries.push({
                    binding: t.binding,
                    resource: resourceManager.renderTargetView(rtName, vctx.screenW, vctx.screenH),
                });
                continue;
            }
            if (t.source.startsWith('asset:')) {
                const url = `${this.dataBase}/${t.source.slice(6)}`;
                const tex = resourceManager.getTexture(url);
                entries.push({
                    binding: t.binding,
                    resource: tex ? resourceManager.textureView(tex) : resourceManager.fallbackTextureView(t.fallback),
                });
                continue;
            }
            // Per-entity handle source — use precompiled closure.
            const handleFn = compiledTex[ti];
            const handle = handleFn ? handleFn(vctx) : 0;
            const tex = resourceManager.getTextureByHandle(handle);
            entries.push({
                binding: t.binding,
                resource: tex ? resourceManager.textureView(tex) : resourceManager.fallbackTextureView(t.fallback),
            });
        }

        void layoutName;
        return entries;
    }

    private layoutNameFor(group: number): string {
        const config = PipelineLoader.getConfig(this.path);
        const names = config?.bindLayout;
        return names?.[group] ?? '';
    }

    /* ── geometry ─────────────────────────────────── */

    private emitGeometry(
        pass: GPURenderPassEncoder,
        vctx: ValueContext,
    ): void {
        const steps = this.decl.geometry.steps ?? [];
        for (let si = 0; si < steps.length; si++) {
            const step = steps[si];
            // Resolve mesh name via precompiled closure (avoids per-entity string parsing).
            const meshNameFn = this.compiledMeshNames[si];
            const meshName = meshNameFn ? meshNameFn(vctx) : 'MeshComponent.mesh';
            const mesh = meshName && resourceManager.hasMesh(meshName)
                ? resourceManager.getMesh(meshName) : null;

            for (const vb of step.vertexBuffers ?? []) {
                this.bindVertexBuffer(pass, vb, vctx, meshName);
            }
            if (step.indexBuffer && mesh?.index) {
                pass.setIndexBuffer(mesh.index, mesh.indexFormat);
            }
            const draw = step.draw;
            if (!draw) continue;
            const compiled = this.compiledCounts[si];
            if (draw.type === 'drawIndexed') {
                let count = compiled.count ? (Number(compiled.count(vctx)) || 0) : 0;
                if (count === 0 && mesh) count = mesh.indexCount;
                if (count > 0) pass.drawIndexed(count);
            } else {
                const vCount = draw.vertexCount ?? 3;
                let iCount = compiled.instance ? (Number(compiled.instance(vctx)) || 1) : (draw.instanceCount ?? 1);
                // Fall back to mesh's edgeCount/pointCount for instanced-quad.
                if (iCount <= 1 && mesh && draw.instanceCountField) {
                    const field = draw.instanceCountField.split('.').pop();
                    if (field === 'edgeCount' && mesh.edgeCount) iCount = mesh.edgeCount;
                    else if (field === 'pointCount' && mesh.pointCount) iCount = mesh.pointCount;
                }
                pass.draw(vCount, iCount);
            }
        }
    }

    private bindVertexBuffer(
        pass: GPURenderPassEncoder,
        vb: import('./rendererDecl').VertexBufferBinding,
        vctx: ValueContext,
        meshName: string,
    ): void {
        if (vb.source === 'vbo') {
            const vboName = vb.vbo ?? 'quad';
            const buf = resourceManager.getNamedVBO(vboName);
            if (!buf) {
                throw new Error(`Pipeline '${this.path}': VBO '${vboName}' not declared in vbo-presets.json`);
            }
            pass.setVertexBuffer(vb.slot, buf);
            return;
        }
        // Use the mesh name already resolved by emitGeometry (avoids re-parsing).
        if (!meshName || !resourceManager.hasMesh(meshName)) return;
        const mesh = resourceManager.getMesh(meshName);

        if (vb.source === 'meshSlots') {
            const slots = PipelineLoader.getSlots(this.path);
            if (slots) {
                let slotIdx = vb.slot;
                for (const slotName of slots) {
                    const buf = mesh.slots[slotName];
                    if (buf) pass.setVertexBuffer(slotIdx++, buf);
                }
            } else if (mesh.slots.Pos) {
                pass.setVertexBuffer(vb.slot, mesh.slots.Pos);
            }
        } else if (vb.source === 'meshField') {
            const field = vb.field as 'edgeBuffer' | 'pointBuffer';
            const buf = mesh[field];
            if (buf) pass.setVertexBuffer(vb.slot, buf);
        }
    }
}
