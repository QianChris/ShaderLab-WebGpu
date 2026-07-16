import type { ValueContext } from './valueResolver';
import type { GeometryHook, ComputeHook } from './PipelineDriver';

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Loads render escape-hatch scripts (common/scripts/render/*.js) the same
 * way ScriptSystem loads gameplay scripts: fetch → Blob → dynamic import. Each
 * exported function `fn` in file `foo.js` is registered under the name
 * `foo.fn`, addressable from JSON as `script:foo.fn`.
 *
 * A script may export three flavours of hook; which registry it lands in is
 * decided by the caller (value / geometry / compute) via the register* API on
 * the RenderGraph, since JSON already declares intent by where the name is used.
 */
export class RenderScriptLoader {
    private baseDir: string;
    private scriptsSubdir: string;
    private loaded = new Map<string, Record<string, AnyFn>>();

    constructor(baseDir = '/common', scriptsSubdir = 'scripts') {
        this.baseDir = baseDir;
        this.scriptsSubdir = scriptsSubdir;
    }

    /** Fetch and import a render script file (e.g. "render/pbr.js"). */
    async load(file: string): Promise<Record<string, AnyFn>> {
        const cached = this.loaded.get(file);
        if (cached) return cached;

        const url = `${this.baseDir}/${this.scriptsSubdir}/${file}?t=${Date.now()}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`render script '${file}': HTTP ${resp.status}`);
        const src = await resp.text();
        const blob = new Blob([src], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            const exports = (mod.default ?? mod) as Record<string, AnyFn>;
            this.loaded.set(file, exports);
            return exports;
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    /** Load a set of files and return flat name→fn maps keyed as `<baseName>.<export>`. */
    async loadAll(files: string[]): Promise<{
        value: Map<string, (ctx: ValueContext) => number[] | number>;
        geometry: Map<string, GeometryHook>;
        compute: Map<string, ComputeHook>;
    }> {
        const value = new Map<string, (ctx: ValueContext) => number[] | number>();
        const geometry = new Map<string, GeometryHook>();
        const compute = new Map<string, ComputeHook>();

        for (const file of files) {
            let exports: Record<string, AnyFn>;
            try {
                exports = await this.load(file);
            } catch (err) {
                console.error(`[RenderScriptLoader] ${err}`);
                continue;
            }
            const prefix = `${this.scriptsSubdir}/`;
            const baseName = file.startsWith(prefix) ? file.slice(prefix.length).replace(/\.js$/, '') : file.replace(/\.js$/, '');
            for (const [name, fn] of Object.entries(exports)) {
                if (typeof fn !== 'function') continue;
                const key = `${baseName}.${name}`;
                value.set(key, fn as (ctx: ValueContext) => number[] | number);
                geometry.set(key, fn as unknown as GeometryHook);
                compute.set(key, fn as unknown as ComputeHook);
            }
        }
        return { value, geometry, compute };
    }
}
