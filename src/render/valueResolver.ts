import { normalMatrix as computeNormalMatrix } from '../math';
import type { Scene } from '../ecs/Scene';

/** Runtime context passed to value sources when resolving a bind-group write. */
export interface ValueContext {
    scene: Scene;
    eid: number;
    tag: string;
    time: number;
    dt: number;
    aspect: number;
    screenW: number;
    screenH: number;
    /** Lazily-computed model matrix for the current entity. */
    model(): Float32Array;
    /** Named value scripts (script:file.fn) resolved at compile time. */
    scripts: Map<string, (ctx: ValueContext) => number[] | number>;
}

/**
 * Resolve a value-source string into a number or number[] for a uniform write.
 *
 *   Comp.field                 component field (scalar or vector, as stored)
 *   pack:a,b,c,0               concatenate fields / numeric constants
 *   transform.model            entity model matrix (16 floats)
 *   transform.normalMatrix     normal matrix (12 floats, mat3x3f padded)
 *   builtin.entityId|time|dt|aspect|screenW|screenH
 *   tag.color | tag.extra      role-tagged fields (getTagColor / getTagExtra)
 *   const:1,2,3                numeric literal
 *   script:file.fn             escape-hatch script returning number|number[]
 */
export function resolveValue(src: string, ctx: ValueContext): number | number[] {
    const colon = src.indexOf(':');
    const prefix = colon >= 0 ? src.slice(0, colon) : '';
    const rest = colon >= 0 ? src.slice(colon + 1) : src;

    switch (prefix) {
        case 'pack':
            return packValues(rest, ctx);
        case 'const':
            return rest.split(',').map(s => Number(s.trim()));
        case 'script': {
            const fn = ctx.scripts.get(rest);
            return fn ? fn(ctx) : 0;
        }
        default:
            return resolveAtom(src, ctx);
    }
}

/** Resolve a single (non-prefixed) atom: dotted path, builtin, tag, or const. */
function resolveAtom(src: string, ctx: ValueContext): number | number[] {
    const dot = src.indexOf('.');
    if (dot < 0) return Number(src) || 0;

    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);

    if (head === 'transform') {
        if (field === 'model') return Array.from(ctx.model());
        if (field === 'normalMatrix') return Array.from(computeNormalMatrix(ctx.model()));
        return 0;
    }
    if (head === 'builtin') {
        switch (field) {
            case 'entityId': return ctx.eid;
            case 'time':     return ctx.time;
            case 'dt':       return ctx.dt;
            case 'aspect':   return ctx.aspect;
            case 'screenW':  return ctx.screenW;
            case 'screenH':  return ctx.screenH;
            default:         return 0;
        }
    }
    if (head === 'tag') {
        if (field === 'color') return ctx.scene.getTagColor(ctx.eid, ctx.tag);
        if (field === 'extra') return ctx.scene.getTagExtra(ctx.eid, ctx.tag);
        return 0;
    }

    // Comp.field
    const v = ctx.scene.getField(ctx.eid, head, field);
    if (Array.isArray(v)) return v.map(Number);
    return Number(v ?? 0);
}

/** pack:a,b,c → flat number[] by concatenating each resolved atom. */
function packValues(list: string, ctx: ValueContext): number[] {
    const out: number[] = [];
    for (const raw of list.split(',')) {
        const token = raw.trim();
        if (token === '') continue;
        if (/^-?\d*\.?\d+$/.test(token)) { out.push(Number(token)); continue; }
        const v = resolveAtom(token, ctx);
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
    }
    return out;
}

/** Resolve a value-source expected to be a single integer handle (textures, etc). */
export function resolveHandle(src: string, ctx: ValueContext): number {
    const v = resolveValue(src, ctx);
    return Array.isArray(v) ? (v[0] ?? 0) : v;
}

/** Resolve a value-source expected to be a string (mesh names). */
export function resolveString(src: string, ctx: ValueContext): string {
    const dot = src.indexOf('.');
    if (dot < 0) return src;
    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);
    if (head === 'builtin' || head === 'transform' || head === 'tag') return src;
    const v = ctx.scene.getField(ctx.eid, head, field);
    return typeof v === 'string' ? v : String(v ?? '');
}
