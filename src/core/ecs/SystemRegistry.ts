import type { Scene } from './Scene';
import type { EventBus } from '../events/EventBus';
import type { SystemEntry } from '../Engine';

/**
 * Ambient frame state passed to every System.update(). Contains only engine
 * mechanisms — no concrete system types. Cross-system references go through
 * `getSystem(name)` with structural typing at the call site, and opaque
 * plugin-published objects travel in `attachments`. This keeps the engine
 * free of compile-time dependencies on any system implementation (systems
 * are plugin-provided).
 */
export interface FrameContext {
    scene: Scene;
    time: number;
    dt: number;
    aspect: number;
    cw: number;
    ch: number;
    canvas: HTMLCanvasElement;
    device: GPUDevice;
    context: GPUCanvasContext;
    format: GPUTextureFormat;
    eventBus: EventBus;
    /** Opaque objects published by plugins via ctx.registerAttachment
     *  (e.g. 'particles', 'physics', 'splats'). */
    attachments: Record<string, unknown>;
    /** Cross-system lookup. Declare a local structural interface for the
     *  fields you consume; missing system → null (caller decides severity). */
    getSystem<T = System>(name: string): T | null;

    /* ── Script-system GPU access ──────────────────────────────────────
     * The following helpers expose BufferRegistry + compute dispatch to
     * script-loaded systems (`source: "scripts/x.js"`). They let a user
     * write a JS system that writes to declared UBOs/storage buffers and
     * dispatches compute pipelines — no TypeScript changes required to
     * add a new GPU-driven simulation system. */

    /** Look up a named GPU buffer (UBO or storage) declared by a system.json
     *  `ubos` / `buffers` field. The buffer is allocated by BufferRegistry. */
    getBuffer(name: string): GPUBuffer;
    /** Write data into a named buffer (queue.writeBuffer wrapper). */
    writeBuffer(name: string, data: BufferSource): void;
    /** Dispatch a compute pipeline by its name (must be preloaded in render.json
     *  `renderScripts` or referenced by an enabled pipeline's `aux`). `count`
     *  is the logical item count; the workgroup count is derived from the
     *  pipeline's declared workgroupSize (in computeTgs). Optional `entries`
     *  build a fresh bind group against @group(0) for this dispatch.
     *  Dispatches are batched into one compute pass per frame and submitted
     *  together by `flushCompute()` (called by the renderer before recording
     *  render passes, and again at end of frame as a safety net). */
    dispatchCompute(pipelineName: string, count: number, entries?: GPUBindGroupEntry[]): void;
    /** Submit any compute dispatches batched since the last flush. Called by
     *  the renderer at the start of execute() so compute results are visible
     *  to the render passes that follow in the same frame. */
    flushCompute(): void;
}

/** Uniform interface every system — builtin or script-loaded — must satisfy. */
export interface System {
    update(ctx: FrameContext): void;
    dispose?(): void;
}

/** Loaded JSON of a system def (`common/systems/<name>.json` or app override). */
export interface SystemDef {
    name: string;
    /** "builtin:<id>" → builtin registry lookup; "<path>.js" → script-loaded system. */
    source: string;
    components?: string[];
    ubos?: string[];
    buffers?: SystemBufferDecl[];
    needs?: string[];
    requires?: string[];
    /** Auto-insert ordering: insert this system AFTER these systems (only when
     *  the app uses the default common/systems.json, not a custom override). */
    after?: string[];
    /** Auto-insert ordering: insert this system BEFORE these systems. */
    before?: string[];
}

/** A buffer declared in a system def's `ubos` or `buffers` array.
 *  - For UBOs: `name` matches a uniform-layouts.json entry; size = layout.byteSize.
 *  - For storage buffers: explicit `size`, OR `layout` + optional `count`
 *    (size = layout.byteSize * count), OR `layout` alone (size = layout.byteSize).
 *  - `scope`: "app" (default) = destroyed on app switch; "common" = engine-lifetime.
 *  - `usage`: array of GPUBufferUsage flag names (default ['storage','copy_dst']
 *    for storage, ['uniform','copy_dst'] for UBOs). */
export interface SystemBufferDecl {
    name: string;
    layout?: string;
    size?: number;
    count?: number;
    scope?: 'app' | 'common';
    usage?: string[];
}

/** Lifecycle hooks a script system may export. All optional; missing hooks are skipped. */
export interface SystemScriptModule {
    init?: (ctx: FrameContext) => void;
    update?: (ctx: FrameContext) => void;
    dispose?: () => void;
    [key: string]: unknown;
}

/**
 * Wraps a script module in the System interface. `init` is called lazily on
 * the first `update` (mirrors ScriptSystem's lazy-init pattern), so the
 * FrameContext is available — script systems don't need a separate init phase.
 */
class ScriptSystemAdapter implements System {
    private initialized = false;
    private mod: SystemScriptModule;

    constructor(mod: SystemScriptModule) {
        this.mod = mod;
    }

    update(ctx: FrameContext): void {
        if (!this.initialized) {
            this.initialized = true;
            this.mod.init?.(ctx);
        }
        this.mod.update?.(ctx);
    }

    dispose(): void {
        this.mod.dispose?.();
    }
}

/**
 * Resolves a `SystemEntry` (from systems.json) to a runnable System instance.
 *
 * Builtins are registered at engine init via `registerBuiltin(name, instance)`.
 * Script systems (`source: "<path>.js"` in the system def) are loaded lazily
 * by `loadDefs` (fetch text → Blob URL → dynamic import, mirroring ScriptSystem).
 * `resolve()` is synchronous and uses the pre-loaded maps populated by loadDefs.
 */
class SystemRegistry {
    private builtins = new Map<string, System>();
    /** Registered system name → owner tag ('engine' | 'plugin:<id>'). */
    private builtinOwners = new Map<string, string>();
    /** system name → def JSON. Populated by loadDefs; cleared on app switch. */
    private defs = new Map<string, SystemDef>();
    /** Defs injected programmatically by plugins (owner-tagged, swept on plugin unload). */
    private injectedDefs = new Map<string, { def: SystemDef; owner: string }>();
    /** script source path → loaded adapter. Persists for the app's lifetime. */
    private scripts = new Map<string, System>();
    private appBase = '';

    /** Register a system instance under `name` (matches systems.json `name`).
     *  Cross-owner duplicate names throw (fail-loud). */
    registerBuiltin(name: string, sys: System, owner = 'engine'): void {
        const existing = this.builtinOwners.get(name);
        if (existing !== undefined && existing !== owner && this.builtins.has(name)) {
            throw new Error(`System '${name}' already registered by ${existing} (attempted by ${owner})`);
        }
        this.builtins.set(name, sys);
        this.builtinOwners.set(name, owner);
    }

    /** Drop a builtin registration (used when an app-opted-in system is torn down). */
    unregisterBuiltin(name: string): void {
        this.builtins.delete(name);
        this.builtinOwners.delete(name);
    }

    /** Dispose + drop every system instance registered by `owner` (plugin unload). */
    removeSystemsByOwner(owner: string): void {
        for (const [name, o] of [...this.builtinOwners]) {
            if (o !== owner) continue;
            this.builtins.get(name)?.dispose?.();
            this.builtins.delete(name);
            this.builtinOwners.delete(name);
        }
    }

    /** Look up a loaded system def by system name (or undefined if not loaded). */
    getDef(name: string): SystemDef | undefined {
        return this.defs.get(name) ?? this.injectedDefs.get(name)?.def;
    }

    /** Hot-reload a script-loaded system by its entry name with new source code.
     *  The previous adapter is disposed (so its event handlers / GPU buffers
     *  release) and replaced with a fresh adapter wrapping the new module.
     *  `init()` is re-invoked lazily on the next update(). Throws for builtins. */
    async reloadScriptByEntry(entryName: string, sourceCode: string): Promise<void> {
        const def = this.getDef(entryName);
        if (!def?.source || def.source.startsWith('builtin:')) {
            throw new Error(`System '${entryName}' is not a script-loaded system`);
        }
        const old = this.scripts.get(def.source);
        old?.dispose?.();
        this.scripts.set(def.source, await this.loadScriptSystemFromText(def.source, sourceCode));
    }

    /** True for a source that names a real script file ('<path>.js') — i.e.
     *  NOT a builtin registration and NOT a plugin-injected system (whose
     *  `source` is 'plugin:<id>', not a fetchable path). */
    private isFileScriptSource(source: string): boolean {
        return !source.startsWith('builtin:') && !source.startsWith('plugin:') && source.includes('.');
    }

    /** Get the script source path for a system entry (for display / fetch). */
    getScriptSource(entryName: string): string | undefined {
        const def = this.getDef(entryName);
        return def?.source && this.isFileScriptSource(def.source) ? def.source : undefined;
    }

    /** List all script-loaded system entries (the ones editable in the editor).
     *  Excludes plugin-injected systems (source: 'plugin:<id>') — those are not
     *  file-backed and cannot be hot-reloaded from source text. */
    getScriptSystemEntries(): string[] {
        return [...this.defs.values(), ...[...this.injectedDefs.values()].map(e => e.def)]
            .filter(d => d.source && this.isFileScriptSource(d.source))
            .map(d => d.name);
    }

    /** Build a ScriptSystemAdapter from in-memory source (editor hot-reload). */
    private async loadScriptSystemFromText(source: string, text: string): Promise<ScriptSystemAdapter> {
        const blob = new Blob([text], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            const systemMod = (mod.default ?? mod) as SystemScriptModule;
            return new ScriptSystemAdapter(systemMod);
        } catch (err) {
            throw new Error(`System script '${source}' failed to import: ${err}`);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    /** Inject a system def programmatically (plugins). Cross-owner duplicates throw. */
    addDef(def: SystemDef, owner: string): void {
        const existing = this.injectedDefs.get(def.name);
        if (existing && existing.owner !== owner) {
            throw new Error(`System def '${def.name}' already declared by ${existing.owner} (attempted by ${owner})`);
        }
        this.injectedDefs.set(def.name, { def, owner });
    }

    /** Drop every injected def owned by `owner` (plugin unload). */
    removeDefsByOwner(owner: string): void {
        for (const [name, entry] of this.injectedDefs) {
            if (entry.owner === owner) this.injectedDefs.delete(name);
        }
    }

    /** All currently-loaded system defs (for BufferRegistry to scan). */
    allDefs(): Iterable<[string, SystemDef]> {
        return this.defs.entries();
    }

    /** Auto-insert systems that declared after/before deps but aren't in the
     *  active list. Only called when the app uses the default common/systems.json
     *  (no custom override). Systems without after/before declarations are NOT
     *  auto-inserted — they must be explicitly listed in systems.json. */
    autoInsert(activeList: SystemEntry[]): SystemEntry[] {
        const listed = new Set(activeList.map(s => s.name));
        const toInsert: SystemDef[] = [];
        for (const [, entry] of this.injectedDefs) {
            const def = entry.def;
            if (listed.has(def.name)) continue;
            if ((def.after?.length ?? 0) > 0 || (def.before?.length ?? 0) > 0) {
                toInsert.push(def);
            }
        }
        if (toInsert.length === 0) return activeList;

        const result = [...activeList];
        for (const def of toInsert) {
            let afterIdx = -1;
            for (const n of def.after ?? []) {
                const idx = result.findIndex(s => s.name === n);
                if (idx > afterIdx) afterIdx = idx;
            }
            let beforeIdx = result.length;
            for (const n of def.before ?? []) {
                const idx = result.findIndex(s => s.name === n);
                if (idx >= 0 && idx < beforeIdx) beforeIdx = idx;
            }
            const insertAt = Math.max(0, Math.min(afterIdx + 1, beforeIdx));
            result.splice(insertAt, 0, { name: def.name });
        }
        return result;
    }

    /** Pre-load system def JSON files + any script systems for the given
     *  systems list. Call from Engine.loadApp after activeSystems is resolved.
     *  - commonBase: e.g. '/common'
     *  - appBase: e.g. '/apps/demo8'
     *  Defs are looked up in common first, then app (app can override).
     *  Also validates `needs` (a system whose `needs` aren't in the active
     *  list logs a warning — running order is the responsibility of systems.json,
     *  but missing dependencies usually indicate a config bug). */
    async loadDefs(systems: SystemEntry[], commonBase: string, appBase: string): Promise<void> {
        this.appBase = appBase;
        for (const entry of systems) {
            if (this.defs.has(entry.name)) continue;
            // Plugin-injected defs already cover this system — no def file fetch.
            if (this.injectedDefs.has(entry.name)) continue;
            const defPath = entry.def ?? `systems/${entry.name}.json`;
            let resp = await fetch(`${commonBase}/${defPath}`);
            if (!isJsonResp(resp) && appBase) {
                resp = await fetch(`${appBase}/${defPath}`);
            }
            if (!isJsonResp(resp)) continue;  // no def → resolve() falls back to builtin-by-name
            const def = await resp.json() as SystemDef;
            this.defs.set(entry.name, def);

            // Pre-load script systems (builtin: needs no async work).
            if (def.source && !def.source.startsWith('builtin:')) {
                if (!this.scripts.has(def.source)) {
                    this.scripts.set(def.source, await this.loadScriptSystem(def.source));
                }
            }
        }

        // Validate `needs`: a `needs` entry is a SOFT ordering constraint —
        // "if this system is in the active list, it must run before me". A
        // missing need (e.g. `gaussianSplat` declared in render.json's needs
        // but absent from an app's systems.json) is fine; an out-of-order need
        // (the needed system runs AFTER the needing one) is a real bug.
        const activeOrder = new Map<string, number>();
        for (let i = 0; i < systems.length; i++) activeOrder.set(systems[i].name, i);
        for (const entry of systems) {
            const def = this.defs.get(entry.name);
            if (!def?.needs) continue;
            const myIdx = activeOrder.get(entry.name);
            if (myIdx === undefined) continue;
            for (const need of def.needs) {
                const needIdx = activeOrder.get(need);
                if (needIdx === undefined) continue;  // not active → no constraint
                if (needIdx > myIdx) {
                    console.warn(
                        `[SystemRegistry] system '${entry.name}' (idx ${myIdx}) declares needs=['${need}'] ` +
                        `but '${need}' is ordered after it (idx ${needIdx}) — fix the order in systems.json`,
                    );
                }
            }
        }
    }

    /** Fetch → Blob URL → dynamic import a JS system script (mirrors ScriptSystem).
     *  Path resolution: absolute (leading /) → as-is; relative → appBase.
     *  Throws on any failure (missing file, syntax error) — a system declared in
     *  systems.json that cannot load is a config bug, not a skippable condition. */
    private async loadScriptSystem(source: string): Promise<ScriptSystemAdapter> {
        const url = source.startsWith('/') ? source : `${this.appBase}/${source}`;
        // Cache-bust so dev-server edits to the system script reload cleanly.
        const cacheBust = `${url}?t=${Date.now()}`;
        const resp = await fetch(cacheBust);
        if (!resp.ok) {
            throw new Error(`System script '${source}' not found (HTTP ${resp.status} for ${url})`);
        }
        const src = await resp.text();
        const blob = new Blob([src], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            const systemMod = (mod.default ?? mod) as SystemScriptModule;
            return new ScriptSystemAdapter(systemMod);
        } catch (err) {
            throw new Error(`System script '${source}' failed to import: ${err}`);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    /** Synchronous resolution: returns System or null.
     *  Registered instances (plugins' ctx.registerSystem) resolve by name; a
     *  def file with a script `source` resolves to its loaded script adapter
     *  (the no-build escape hatch). The legacy 'builtin:' source prefix is
     *  ignored — all implementations register through the same registry. */
    resolve(entry: SystemEntry): System | null {
        const def = this.defs.get(entry.name);
        if (def?.source && !def.source.startsWith('builtin:')) {
            return this.scripts.get(def.source) ?? null;
        }
        return this.builtins.get(entry.name) ?? null;
    }

    /** Drop script systems + defs for the current app (call on app unload).
     *  Disposes each script system so it can release event handlers, etc.
     *  Builtins stay (engine-lifetime). */
    clearScripts(): void {
        for (const sys of this.scripts.values()) sys.dispose?.();
        this.scripts.clear();
        this.defs.clear();
        this.appBase = '';
    }
}

/** True if the response is a fetch-able JSON document. Guards against the
 *  Vite SPA fallback (200 + text/html for unknown paths). */
function isJsonResp(resp: Response): boolean {
    const ct = resp.headers.get('content-type') ?? '';
    return resp.ok && (ct.includes('json') || ct.includes('application'));
}

export const systemRegistry = new SystemRegistry();
