import type { Scene } from './Scene';
import type { EventBus } from '../events/EventBus';
import type { InputSystem } from './InputSystem';
import type { ScriptSystem } from './ScriptSystem';
import type { PhysicsSystem } from './PhysicsSystem';
import type { CameraSystem } from './CameraSystem';
import type { LightSystem } from './LightSystem';
import type { AnimationSystem } from './AnimationSystem';
import type { RenderGraph } from '../render/RenderGraph';
import type { GaussianSplatManager } from '../render/GaussianSplatManager';
import type { SystemEntry } from '../Engine';

/**
 * Ambient frame state passed to every System.update(). Built-in systems pull
 * what they need from this single context object; cross-system references
 * (camera/light/physics/…) are exposed transitively for systems that read
 * another system's output (e.g. gaussianSplat reads camera.lastView).
 *
 * The cross-system fields are transitional — once a script system can register
 * itself and be looked up by name, the hard-typed fields will be replaced by
 * `systemRegistry.get(name)`.
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
    physics: PhysicsSystem;
    camera: CameraSystem;
    light: LightSystem;
    animation: AnimationSystem;
    input: InputSystem;
    script: ScriptSystem;
    splats: GaussianSplatManager | null;
    renderGraph: RenderGraph;

    /* ── Script-system GPU access ──────────────────────────────────────
     * The following helpers expose BufferRegistry + compute dispatch to
     * script-loaded systems (`source: "scripts/x.js"`). They let a user
     * write a JS system that writes to declared UBOs/storage buffers and
     * dispatches compute pipelines — no TypeScript changes required to
     * add a new GPU-driven simulation system.
     *
     * Limitations (Step 6 minimal):
     *   - dispatchCompute opens its own command encoder + submit (slow path);
     *     lifting the encoder to frame scope for batched compute is a future
     *     refactor (see PLAN.md Step 6).
     *   - bind groups for dispatched compute must be passed in by the script
     *     (no auto-assembly from a layout). */

    /** Look up a named GPU buffer (UBO or storage) declared by a system.json
     *  `ubos` / `buffers` field. The buffer is allocated by BufferRegistry. */
    getBuffer(name: string): GPUBuffer;
    /** Write data into a named buffer (queue.writeBuffer wrapper). */
    writeBuffer(name: string, data: BufferSource): void;
    /** Dispatch a compute pipeline by its name (must be preloaded in render.json
     *  `renderScripts` or referenced by an enabled pipeline's `aux`). `count`
     *  is the logical item count; the workgroup count is derived from the
     *  pipeline's declared workgroupSize (in computeTgs). Optional `entries`
     *  build a fresh bind group against @group(0) for this dispatch. */
    dispatchCompute(pipelineName: string, count: number, entries?: GPUBindGroupEntry[]): void;
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
    /** system name → def JSON. Populated by loadDefs; cleared on app switch. */
    private defs = new Map<string, SystemDef>();
    /** script source path → loaded adapter. Persists for the app's lifetime. */
    private scripts = new Map<string, System>();
    private appBase = '';

    /** Register a builtin system instance under `name` (matches systems.json `name`). */
    registerBuiltin(name: string, sys: System): void {
        this.builtins.set(name, sys);
    }

    /** Drop a builtin registration (used when an app-opted-in system is torn down). */
    unregisterBuiltin(name: string): void {
        this.builtins.delete(name);
    }

    /** Look up a loaded system def by system name (or undefined if not loaded). */
    getDef(name: string): SystemDef | undefined {
        return this.defs.get(name);
    }

    /** All currently-loaded system defs (for BufferRegistry to scan). */
    allDefs(): Iterable<[string, SystemDef]> {
        return this.defs.entries();
    }

    /** Pre-load system def JSON files + any script systems for the given
     *  systems list. Call from Engine.loadApp after activeSystems is resolved.
     *  - commonBase: e.g. '/common'
     *  - appBase: e.g. '/apps/demo8'
     *  Defs are looked up in common first, then app (app can override). */
    async loadDefs(systems: SystemEntry[], commonBase: string, appBase: string): Promise<void> {
        this.appBase = appBase;
        for (const entry of systems) {
            if (this.defs.has(entry.name)) continue;
            const defPath = entry.def ?? `systems/${entry.name}.json`;
            let resp = await fetch(`${commonBase}/${defPath}`);
            if (!resp.ok && appBase) {
                resp = await fetch(`${appBase}/${defPath}`);
            }
            if (!resp.ok) continue;  // no def → resolve() falls back to builtin-by-name
            const def = await resp.json() as SystemDef;
            this.defs.set(entry.name, def);

            // Pre-load script systems (builtin: needs no async work).
            if (def.source && !def.source.startsWith('builtin:')) {
                if (!this.scripts.has(def.source)) {
                    const adapter = await this.loadScriptSystem(def.source);
                    if (adapter) this.scripts.set(def.source, adapter);
                }
            }
        }
    }

    /** Fetch → Blob URL → dynamic import a JS system script (mirrors ScriptSystem).
     *  Path resolution: absolute (leading /) → as-is; relative → appBase. */
    private async loadScriptSystem(source: string): Promise<ScriptSystemAdapter | null> {
        const url = source.startsWith('/') ? source : `${this.appBase}/${source}`;
        // Cache-bust so dev-server edits to the system script reload cleanly.
        const cacheBust = `${url}?t=${Date.now()}`;
        try {
            const resp = await fetch(cacheBust);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const src = await resp.text();
            const blob = new Blob([src], { type: 'text/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            const mod = await import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
            const systemMod = (mod.default ?? mod) as SystemScriptModule;
            return new ScriptSystemAdapter(systemMod);
        } catch (err) {
            console.error(`[SystemRegistry] failed to load system script '${source}':`, err);
            return null;
        }
    }

    /** Synchronous resolution: returns System or null.
     *  Uses pre-loaded defs (loadDefs must have been called for script systems
     *  to be resolvable). Builtin systems work without loadDefs (by-name fallback). */
    resolve(entry: SystemEntry): System | null {
        const def = this.defs.get(entry.name);
        if (def) {
            if (def.source.startsWith('builtin:')) {
                const id = def.source.slice('builtin:'.length);
                return this.builtins.get(id) ?? null;
            }
            return this.scripts.get(def.source) ?? null;
        }
        // No def file → fall back to builtin-by-name (backward compat).
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

export const systemRegistry = new SystemRegistry();
