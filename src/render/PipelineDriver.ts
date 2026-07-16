import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { uniformLayouts } from './UniformLayout';
import { resolveValue, resolveString, resolveHandle, type ValueContext } from './valueResolver';
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
    physics: import('../ecs/PhysicsSystem').PhysicsSystem | null;
    particles: import('./ParticleManager').ParticleManager;
    splats: import('./GaussianSplatManager').GaussianSplatManager | null;
    computePipelines: Map<string, GPUComputePipeline>;
}

export interface ComputeHookContext {
    scene: Scene;
    entities: readonly number[];
    time: number;
    dt: number;
    computePipelines: Map<string, GPUComputePipeline>;
    particles: import('./ParticleManager').ParticleManager;
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
    }

    /** Encode compute work declared by this pipeline (script hook), before the render pass. */
    compute(encoder: GPUCommandEncoder, ctx: Omit<ComputeHookContext, 'entities' | 'aux'> & { scene: Scene }): void {
        const decl = this.decl.compute as { script?: string } | undefined;
        if (!decl?.script) return;
        const hook = this.computeHooks.get(decl.script);
        if (!hook) return;
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
        frame: {
            time: number; dt: number; cw: number; ch: number;
            physics: import('../ecs/PhysicsSystem').PhysicsSystem | null;
            particles: import('./ParticleManager').ParticleManager;
            splats: import('./GaussianSplatManager').GaussianSplatManager | null;
            computePipelines: Map<string, GPUComputePipeline>;
        },
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
            if (hook) {
                hook(pass, {
                    scene, entities, pipeline,
                    time: frame.time, dt: frame.dt, cw: frame.cw, ch: frame.ch,
                    physics: frame.physics, particles: frame.particles,
                    splats: frame.splats,
                    computePipelines: frame.computePipelines,
                });
            }
            return;
        }

        // No query: single draw with static (non-per-entity) bind groups.
        if (!this.query) {
            pass.setPipeline(pipeline);
            this.bindGroups(pass, vctx);
            this.emitGeometry(pass, vctx);
            return;
        }

        for (const eid of entities) {
            if (this.decl.filter) {
                const v = scene.getField(eid, this.decl.filter.component, this.decl.filter.field);
                if ((Number(v) ?? 0) !== this.decl.filter.value) continue;
            }
            vctx.eid = eid;
            pass.setPipeline(pipeline);
            this.bindGroups(pass, vctx);
            this.emitGeometry(pass, vctx);
        }
    }

    /* ── bind group assembly ──────────────────────── */

    private bindGroups(pass: GPURenderPassEncoder, vctx: ValueContext): void {
        // Auto-bind the frame group at @group(0) based on the pipeline's first layout name.
        const names = PipelineLoader.getConfig(this.path)?.bindLayout ?? [];
        if (names[0] === 'frame') {
            pass.setBindGroup(0, resourceManager.frameBindGroup());
        } else if (names[0] === 'frameShadow') {
            pass.setBindGroup(0, resourceManager.frameShadowBindGroup());
        }

        for (const bg of this.decl.bindGroups ?? []) {
            const layoutName = this.layoutNameFor(bg.group);
            const entries = this.buildEntries(bg, vctx, layoutName);
            pass.setBindGroup(bg.group, resourceManager.genericBindGroup(layoutName, entries));
        }
    }

    private buildEntries(bg: BindGroupDecl, vctx: ValueContext, layoutName: string): GPUBindGroupEntry[] {
        const entries: GPUBindGroupEntry[] = [];

        if (bg.uniform) {
            const layout = uniformLayouts.get(bg.uniform.layoutRef);
            const buf = layout.createBuffer();
            for (const w of bg.uniform.writes) {
                layout.write(buf, w.member, resolveValue(w.value, vctx));
            }
            const key = `bg_${this.path}_${bg.group}_${vctx.eid}`;
            entries.push({ binding: bg.uniform.binding ?? 0, resource: { buffer: resourceManager.getUniform(key, buf) } });
        }

        for (const s of bg.samplers ?? []) {
            entries.push({ binding: s.binding, resource: resourceManager.namedSampler(s.name ?? 'default') });
        }

        for (const t of bg.textures ?? []) {
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
                    resource: tex ? tex.createView() : resourceManager.fallbackTextureView(t.fallback),
                });
                continue;
            }
            const handle = resolveHandle(t.source, vctx);
            const tex = resourceManager.getTextureByHandle(handle);
            entries.push({
                binding: t.binding,
                resource: tex ? tex.createView() : resourceManager.fallbackTextureView(t.fallback),
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
        for (const step of steps) {
            // Resolve the mesh once per step (used by vertex buffers, index buffer, draw counts).
            const meshName = resolveString(
                step.indexBuffer?.mesh
                ?? step.vertexBuffers?.find(vb => vb.source === 'meshSlots' || vb.source === 'meshField')?.mesh
                ?? 'MeshComponent.mesh',
                vctx,
            );
            const mesh = meshName && resourceManager.hasMesh(meshName)
                ? resourceManager.getMesh(meshName) : null;

            for (const vb of step.vertexBuffers ?? []) {
                this.bindVertexBuffer(pass, vb, vctx);
            }
            if (step.indexBuffer && mesh?.index) {
                pass.setIndexBuffer(mesh.index, mesh.indexFormat);
            }
            const draw = step.draw;
            if (!draw) continue;
            if (draw.type === 'drawIndexed') {
                let count = draw.countField
                    ? Number(resolveValue(draw.countField, vctx)) || 0
                    : 0;
                if (count === 0 && mesh) count = mesh.indexCount;
                if (count > 0) pass.drawIndexed(count);
            } else {
                const vCount = draw.vertexCount ?? 3;
                let iCount = draw.instanceCountField
                    ? Number(resolveValue(draw.instanceCountField, vctx)) || 1
                    : (draw.instanceCount ?? 1);
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
    ): void {
        if (vb.source === 'vbo') {
            const buf = resourceManager.getNamedVBO(vb.vbo ?? 'quad');
            if (buf) pass.setVertexBuffer(vb.slot, buf);
            return;
        }
        const meshName = resolveString(vb.mesh ?? 'MeshComponent.mesh', vctx);
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
