import { normalMatrix as computeNormalMatrix } from '../math';
import { schemaRegistry } from '../ecs/SchemaRegistry';
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

/** A resolver for a single field within a namespace (e.g. builtin.time, transform.model). */
export type AtomResolver = (ctx: ValueContext) => number | number[];

/** Resolver tables for each namespace prefix (builtin, transform, tag). */
export const atomNamespaces: Record<string, Record<string, AtomResolver>> = {
    builtin: {},
    transform: {},
    tag: {},
};

// ── Register known builtins ──
atomNamespaces.builtin = {
    entityId: (ctx) => ctx.eid,
    time:     (ctx) => ctx.time,
    dt:       (ctx) => ctx.dt,
    aspect:   (ctx) => ctx.aspect,
    screenW:  (ctx) => ctx.screenW,
    screenH:  (ctx) => ctx.screenH,
};

// ── Register known transform values ──
atomNamespaces.transform = {
    model:        (ctx) => Array.from(ctx.model()),
    normalMatrix: (ctx) => Array.from(computeNormalMatrix(ctx.model())),
};

// ── Register known tag resolvers ──
atomNamespaces.tag = {
    color: (ctx) => ctx.scene.getTagColor(ctx.eid, ctx.tag),
    extra: (ctx) => ctx.scene.getTagExtra(ctx.eid, ctx.tag),
};

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
            if (!fn) {
                throw new Error(
                    `Value script '${rest}' not found — is its file listed in render.json "renderScripts" ` +
                    `and does it export that function?`,
                );
            }
            return fn(ctx);
        }
        default:
            return resolveAtom(src, ctx);
    }
}

/** Resolve a single (non-prefixed) atom: numeric literal, dotted path, builtin, or tag. */
function resolveAtom(src: string, ctx: ValueContext): number | number[] {
    // Numeric literal first, so values like '0.5' never parse as Comp.field.
    const asNum = Number(src);
    if (!Number.isNaN(asNum)) return asNum;

    const dot = src.indexOf('.');
    if (dot < 0) {
        throw new Error(`Cannot resolve value atom '${src}' (expected number, Comp.field, builtin.*, transform.* or tag.*)`);
    }

    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);

    // Namespaced resolvers (builtin.*, transform.*, tag.*)
    const ns = atomNamespaces[head];
    if (ns) {
        const fn = ns[field];
        if (!fn) {
            throw new Error(`Unknown value atom '${src}' (known ${head}.*: ${Object.keys(ns).join(', ')})`);
        }
        return fn(ctx);
    }

    // Comp.field — an unregistered component name is a config typo (fail loud);
    // an entity merely lacking the component resolves to 0 (legitimate absence).
    if (!schemaRegistry.get(head)) {
        throw new Error(`Value source '${src}' references unknown component '${head}'`);
    }
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
