import { resourceManager } from './ResourceManager';
import { bufferRegistry } from './BufferRegistry';
import { uniformLayouts } from './UniformLayout';
import type { ComputeBindingDecl } from './types';
import type { Scene } from '../ecs/Scene';

/**
 * Per-dispatch context for declarative compute bind-group resolution.
 * The Engine assembles this from the FrameContext + the caller-supplied
 * `eid`/`count` when a compute pipeline's `bindings` are resolved.
 */
export interface ComputeResolveContext {
    scene: Scene;
    eid: number;
    /** Logical item count (drives storage-buffer sizing + `$count`). */
    count: number;
    time: number;
    dt: number;
    aspect: number;
    screenW: number;
    screenH: number;
    /** dataBase (engine-config.dataRoot) — for `asset:<path>` texture refs. */
    dataBase: string;
}

/**
 * Build @group(0) bind-group entries from a compute pipeline's declarative
 * `bindings` array. Resolves each source against the per-entity context:
 *
 *   storage        → SSBO sized stride×count, keyed `${key}_${eid}`
 *   uniform        → packed UBO (component fields / $time / $count), keyed `${key}_${eid}`
 *   timeInput      → the global TimeInput UBO (BufferRegistry)
 *   storageTexture → a storage texture view (write-only by default)
 *   texture        → a read-only sampled texture view
 *
 * Texture reference forms (storageTexture + texture):
 *   "renderTarget:<name>"   texture only — render targets lack STORAGE_BINDING,
 *                            so a storageTexture ref to one throws (fail-loud)
 *   "asset:<path>"          relative to `ctx.dataBase`
 *   "<Component>.<field>"   u32 handle resolved per-eid via scene.getField
 *   "<namedKey>"            resourceManager.getTexture key
 *
 * The shader queries a storage texture's dimensions in-shader via
 * `textureDimensions()` — no extra UBO is needed for size.
 */
export function resolveComputeBindings(
    bindings: ComputeBindingDecl[],
    ctx: ComputeResolveContext,
): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [];
    for (const b of bindings) {
        switch (b.source) {
            case 'storage':
                entries.push({ binding: b.binding, resource: { buffer: resolveStorage(b, ctx) } });
                break;
            case 'uniform':
                entries.push({ binding: b.binding, resource: { buffer: resolveUniform(b, ctx) } });
                break;
            case 'timeInput':
                entries.push({ binding: b.binding, resource: { buffer: bufferRegistry.get('timeInput') } });
                break;
            case 'storageTexture':
                entries.push({ binding: b.binding, resource: resolveTextureView(b, ctx, /*storage*/ true) });
                break;
            case 'texture':
                entries.push({ binding: b.binding, resource: resolveTextureView(b, ctx, /*storage*/ false) });
                break;
        }
    }
    return entries;
}

function resolveStorage(b: ComputeBindingDecl, ctx: ComputeResolveContext): GPUBuffer {
    const stride = b.strideLayout
        ? uniformLayouts.get(b.strideLayout).byteSize
        : (b.stride ?? 4);
    const size = Math.max(4, stride * Math.max(1, ctx.count));
    const key = `${b.key ?? 'compute'}_${ctx.eid}`;
    return resourceManager.getStorageBuffer(key, size);
}

function resolveUniform(b: ComputeBindingDecl, ctx: ComputeResolveContext): GPUBuffer {
    const pack = b.pack ?? [];
    const data: number[] = [];
    for (const tok of pack) {
        if (tok === '$time') { data.push(ctx.time); continue; }
        if (tok === '$count') { data.push(ctx.count); continue; }
        const asNum = Number(tok);
        if (!Number.isNaN(asNum)) { data.push(asNum); continue; }
        const dot = tok.indexOf('.');
        if (dot < 0) { data.push(0); continue; }
        const v = ctx.scene.getField(ctx.eid, tok.slice(0, dot), tok.slice(dot + 1));
        if (Array.isArray(v)) data.push(...v.map(Number));
        else data.push(Number(v ?? 0));
    }
    // WebGPU UBO size must be a multiple of 16 (min 16).
    const byteSize = Math.max(16, Math.ceil((data.length * 4) / 16) * 16);
    const key = `${b.key ?? 'computeU'}_${ctx.eid}`;
    return resourceManager.getUniform(key, data, byteSize);
}

function resolveTextureView(
    b: ComputeBindingDecl,
    ctx: ComputeResolveContext,
    storage: boolean,
): GPUTextureView {
    const ref = b.texture ?? '';
    if (!ref) {
        throw new Error(`compute binding ${b.binding}: 'texture' field required for '${b.source}' source`);
    }
    if (ref.startsWith('renderTarget:')) {
        if (storage) {
            throw new Error(
                `compute binding ${b.binding}: storageTexture cannot bind a renderTarget ` +
                `(render targets lack STORAGE_BINDING usage) — use a texture created with STORAGE_BINDING`,
            );
        }
        return resourceManager.renderTargetView(ref.slice('renderTarget:'.length), ctx.screenW, ctx.screenH);
    }
    let tex: GPUTexture | undefined;
    if (ref.startsWith('asset:')) {
        tex = resourceManager.getTexture(`${ctx.dataBase}/${ref.slice(6)}`);
    } else if (ref.indexOf('.') > 0) {
        // Component.field → u32 handle (per-eid).
        const dot = ref.indexOf('.');
        const v = ctx.scene.getField(ctx.eid, ref.slice(0, dot), ref.slice(dot + 1));
        const handle = typeof v === 'number' ? v : (Array.isArray(v) ? (v[0] ?? 0) : 0);
        tex = resourceManager.getTextureByHandle(handle);
    } else {
        tex = resourceManager.getTexture(ref);
    }
    if (!tex) {
        throw new Error(`compute binding ${b.binding}: texture '${ref}' not found`);
    }
    if (storage) {
        // Storage textures need an explicit view (cached default view is fine
        // for 2d; storage views can't share the sampled-texture cache because
        // the bind layout declares a storageTexture entry, not a texture one).
        const dim = b.viewDimension ?? '2d';
        return tex.createView({ dimension: dim });
    }
    return resourceManager.textureView(tex);
}
