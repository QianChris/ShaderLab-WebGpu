import type { EnginePlugin, PluginContext } from './Plugin';

/**
 * Loads plugins from `public/plugins/<id>/` at runtime. The engine has zero
 * compile-time knowledge of any plugin: discovery is by id (engine-config.json
 * `plugins` + app.json `plugins`), invocation is through the virtual interfaces
 * (System / PhaseBehavior / hooks / lifecycle) that plugins register.
 *
 * Loading chain per module file:
 *   fetch → (`.ts`? sucrase type-strip) → es-module-lexer import scan →
 *   rewrite specifiers:
 *     '@shaderlab/api'   → the engine API module URL (dev: /src/api.ts served
 *                          transformed by Vite; prod: /assets/engine-api.js)
 *     './x' | '../x'     → recursively loaded sibling file → its blob URL
 *     '/abs' | 'http…'   → left as-is (must be plain JS)
 *     other bare imports → throw (plugins may only use the API + relative files)
 *   → Blob URL → dynamic import.
 *
 * Dependencies (`meta.dependencies`) load recursively before the dependent's
 * declarations/setup run; cycles and missing plugins throw. Scope:
 *   'engine' — listed in engine-config.json, lives for the session
 *   'app'    — listed in app.json, unloaded (reverse topo order) on app switch
 */

const API_SPECIFIER = '@shaderlab/api';

export interface LoadedPlugin {
    id: string;
    instance: EnginePlugin;
    scope: 'engine' | 'app';
    baseUrl: string;
    ctx: PluginContext;
}

interface PluginHost {
    pluginsRoot: string;
    makeCtx(id: string, baseUrl: string): PluginContext;
    applyDeclarations(id: string, plugin: EnginePlugin): void;
    sweepOwner(owner: string): void;
    /** Scope GPU-resource ownership to `owner` for the duration of a plugin's
     *  init/declarations/setup; returns the previous owner to restore. */
    beginOwner(owner: string): string;
    endOwner(previous: string): void;
}

/** Registry owner tag for a plugin id (shared convention across registries). */
export function pluginOwner(id: string): string {
    return `plugin:${id}`;
}

export function apiModuleUrl(): string {
    return import.meta.env.DEV ? '/src/api.ts' : '/assets/engine-api.js';
}

class PluginManager {
    private host: PluginHost | null = null;
    private loaded = new Map<string, LoadedPlugin>();
    /** Topological load order (dependencies before dependents). */
    private order: string[] = [];

    configure(host: PluginHost): void {
        this.host = host;
    }

    has(id: string): boolean {
        return this.loaded.has(id);
    }

    get(id: string): LoadedPlugin | undefined {
        return this.loaded.get(id);
    }

    /** All loaded plugins in topological load order. */
    all(): LoadedPlugin[] {
        return this.order.map(id => this.loaded.get(id)!);
    }

    async loadMany(ids: string[], scope: 'engine' | 'app'): Promise<void> {
        for (const id of ids) {
            await this.loadOne(id, scope, []);
        }
    }

    /** Broadcast app-loaded to every plugin in topological order. */
    async broadcastAppLoaded(appBase: string): Promise<void> {
        for (const p of this.all()) {
            await p.instance.appLoaded?.(p.ctx, appBase);
        }
    }

    /** Broadcast app-unloading to every plugin in reverse topological order. */
    broadcastAppUnloading(): void {
        for (const p of this.all().reverse()) {
            p.instance.appUnloading?.(p.ctx);
        }
    }

    /** Unload every app-scoped plugin (reverse topological order): teardown,
     *  then sweep its registry owner. Engine-scoped plugins never depend on
     *  app-scoped ones (dependencies inherit the requesting scope), so the
     *  reverse-order sweep cannot leave dangling dependents. */
    unloadAppPlugins(): void {
        for (const p of this.all().reverse()) {
            if (p.scope !== 'app') continue;
            p.instance.teardown?.(p.ctx);
            this.host!.sweepOwner(pluginOwner(p.id));
            this.loaded.delete(p.id);
            this.order.splice(this.order.indexOf(p.id), 1);
        }
    }

    private async loadOne(id: string, scope: 'engine' | 'app', stack: string[]): Promise<void> {
        if (!this.host) throw new Error('PluginManager not configured');
        if (this.loaded.has(id)) return;
        if (stack.includes(id)) {
            throw new Error(`Plugin dependency cycle: ${[...stack, id].join(' → ')}`);
        }
        const baseUrl = `${this.host.pluginsRoot}/${id}`;
        const mod = await this.importPluginModule(baseUrl) as { default?: new () => EnginePlugin };
        if (typeof mod.default !== 'function') {
            throw new Error(`Plugin '${id}': index module must default-export a class extending EnginePlugin`);
        }
        const instance = new mod.default();
        if (!instance.meta || instance.meta.id !== id) {
            throw new Error(`Plugin '${id}': meta.id ('${instance.meta?.id}') must equal its folder name`);
        }
        for (const dep of instance.meta.dependencies ?? []) {
            await this.loadOne(dep, scope, [...stack, id]);
        }
        const ctx = this.host.makeCtx(id, baseUrl);
        const prevOwner = this.host.beginOwner(pluginOwner(id));
        try {
            await instance.init?.(ctx);
            this.host.applyDeclarations(id, instance);
            await instance.setup?.(ctx);
        } finally {
            this.host.endOwner(prevOwner);
        }
        this.loaded.set(id, { id, instance, scope, baseUrl, ctx });
        this.order.push(id);
    }

    /* ── module loading chain ─────────────────────────────────────── */

    private async importPluginModule(baseUrl: string): Promise<unknown> {
        const entryUrl = await this.resolveEntry(baseUrl);
        const files = new Map<string, string>();     // source URL → blob URL
        const inFlight = new Set<string>();
        const blobUrl = await this.moduleFor(entryUrl, files, inFlight);
        try {
            return await import(/* @vite-ignore */ blobUrl);
        } catch (err) {
            throw new Error(`Plugin module '${entryUrl}' failed to import: ${err}`);
        }
    }

    private async resolveEntry(baseUrl: string): Promise<string> {
        for (const candidate of ['index.ts', 'index.js']) {
            const url = `${baseUrl}/${candidate}`;
            const resp = await fetch(`${url}?probe=${Date.now()}`);
            const ct = resp.headers.get('content-type') ?? '';
            if (resp.ok && !ct.includes('text/html')) return url;
        }
        throw new Error(`Plugin entry not found: ${baseUrl}/index.ts (or index.js)`);
    }

    /** Load one plugin source file: transpile, rewrite imports, blobify. */
    private async moduleFor(url: string, files: Map<string, string>, inFlight: Set<string>): Promise<string> {
        const cached = files.get(url);
        if (cached) return cached;
        if (inFlight.has(url)) {
            throw new Error(`Circular relative import detected at ${url} — not supported in runtime plugins`);
        }
        inFlight.add(url);

        let code = await this.fetchText(url);
        if (url.endsWith('.ts')) {
            const { transform } = await import('sucrase');
            code = transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;
        }

        const lexer = await import('es-module-lexer');
        await lexer.init;
        const [imports] = lexer.parse(code, url);

        // Rewrite from the last import to the first so indices stay valid.
        for (let i = imports.length - 1; i >= 0; i--) {
            const imp = imports[i];
            if (imp.d === -2) continue;                          // import.meta
            const raw = code.slice(imp.s, imp.e);
            const quoted = raw[0] === '"' || raw[0] === '\'';
            const spec = imp.n ?? (quoted ? raw.slice(1, -1) : undefined);
            if (spec === undefined) {
                // Non-literal dynamic import (runtime-computed URL, e.g. Blob
                // imports inside a system) — nothing to rewrite, leave as-is.
                if (imp.d > -1) continue;
                throw new Error(`${url}: unresolvable import specifier`);
            }
            let target: string | null = null;
            if (spec === API_SPECIFIER) {
                target = apiModuleUrl();
            } else if (spec.startsWith('./') || spec.startsWith('../')) {
                const child = new URL(spec, new URL(url, location.origin)).pathname;
                target = await this.moduleFor(child, files, inFlight);
            } else if (spec.startsWith('/') || spec.startsWith('http://') || spec.startsWith('https://')) {
                target = null;                                    // absolute: leave as-is (plain JS)
            } else {
                throw new Error(
                    `${url}: bare import '${spec}' is not allowed in plugins — ` +
                    `import '${API_SPECIFIER}' or relative files only`,
                );
            }
            if (target !== null) {
                const replacement = quoted ? `'${target}'` : target;
                code = code.slice(0, imp.s) + replacement + code.slice(imp.e);
            }
        }

        code += `\n//# sourceURL=shaderlab-plugin:${url}`;
        const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        files.set(url, blobUrl);
        inFlight.delete(url);
        return blobUrl;
    }

    private async fetchText(url: string): Promise<string> {
        const resp = await fetch(`${url}?t=${Date.now()}`);
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || ct.includes('text/html')) {
            throw new Error(`Plugin file not found: ${url}`);
        }
        return await resp.text();
    }
}

export const pluginManager = new PluginManager();
