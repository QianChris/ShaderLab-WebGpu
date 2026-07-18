import type { Scene } from '../ecs/Scene';
import type { EventBus } from '../events/EventBus';
import type { PhysicsSystem } from '../ecs/PhysicsSystem';
import type { SceneTool, ToolConfig, ToolContext, ToolScriptModule } from './SceneTool';
import { PickTool } from './PickTool';

type ToolFactory = (config: ToolConfig, ctx: ToolContext) => SceneTool;

/** Registry of builtin tool factories, keyed by config `type`. New builtins
 *  can be added here without touching the dispatch logic. */
const TOOL_REGISTRY: Record<string, ToolFactory> = {
    pick: (config, ctx) => new PickTool(config, ctx),
};

/** Wraps a script-loaded tool module in the SceneTool interface. */
class ScriptToolAdapter implements SceneTool {
    private mod: ToolScriptModule;
    private ctx: ToolContext;

    constructor(mod: ToolScriptModule, ctx: ToolContext) {
        this.mod = mod;
        this.ctx = ctx;
    }

    attach(): void { this.mod.attach?.(this.ctx); }
    detach(): void { this.mod.detach?.(); }
}

/**
 * Loads optional interaction tools from tools.json and wires each to the scene,
 * event bus and physics system. Absent/empty config means no tools are active,
 * so picking (and future tools) stay fully opt-in.
 *
 * Two source kinds:
 *   - `type: "pick"` — builtin (looked up in TOOL_REGISTRY)
 *   - `source: "scripts/myTool.js"` — script-loaded (fetch → Blob URL → import)
 * Both produce a SceneTool that gets attached/detached with the app lifecycle.
 */
export class ToolSystem {
    private tools: SceneTool[] = [];
    private ctx: ToolContext;
    /** App base for resolving relative script paths. Set by setBase(). */
    private appBase = '';

    constructor(scene: Scene, bus: EventBus, physics: PhysicsSystem, getAspect: () => number) {
        this.ctx = { scene, bus, physics, getAspect };
    }

    /** Set the app base path (for resolving relative tool script sources).
     *  Called by Engine.loadApp before loadFromFile. */
    setBase(appBase: string): void {
        this.appBase = appBase;
    }

    async loadFromFile(url: string): Promise<void> {
        // The manifest explicitly declared this tools file — missing or
        // malformed is a config bug, not a "no tools" situation.
        const resp = await fetch(url);
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || !(ct.includes('json') || ct.includes('application'))) {
            throw new Error(`Tools config not found: ${url} (declared in app.json "tools")`);
        }
        const configs = await resp.json() as ToolConfig[];
        await this.load(configs);
    }

    async load(configs: ToolConfig[]): Promise<void> {
        this.dispose();
        for (const config of configs) {
            if (config.enabled === false) continue;
            const tool = await this.resolveTool(config);
            tool.attach();
            this.tools.push(tool);
        }
    }

    private async resolveTool(config: ToolConfig): Promise<SceneTool> {
        // Script source: fetch → Blob URL → dynamic import → wrap in adapter.
        if (config.source) {
            const mod = await this.loadScript(config.source);
            return new ScriptToolAdapter(mod, this.ctx);
        }
        // Builtin: lookup by `type` in the registry.
        if (config.type) {
            const factory = TOOL_REGISTRY[config.type];
            if (!factory) {
                throw new Error(
                    `Unknown tool type '${config.type}' in tools.json ` +
                    `(builtins: ${Object.keys(TOOL_REGISTRY).join(', ')}; or use "source" for a script tool)`,
                );
            }
            return factory(config, this.ctx);
        }
        throw new Error('tools.json entry has neither `type` nor `source`');
    }

    /** Fetch → Blob URL → dynamic import a tool script (mirrors ScriptSystem).
     *  Path resolution: absolute (leading /) → as-is; relative → appBase.
     *  Throws on any failure — a declared tool that cannot load is a config bug. */
    private async loadScript(source: string): Promise<ToolScriptModule> {
        const url = source.startsWith('/') ? source : `${this.appBase}/${source}`;
        const cacheBust = `${url}?t=${Date.now()}`;
        const resp = await fetch(cacheBust);
        if (!resp.ok) {
            throw new Error(`Tool script '${source}' not found (HTTP ${resp.status} for ${url})`);
        }
        const src = await resp.text();
        const blob = new Blob([src], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            return (mod.default ?? mod) as ToolScriptModule;
        } catch (err) {
            throw new Error(`Tool script '${source}' failed to import: ${err}`);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    dispose(): void {
        for (const tool of this.tools) tool.detach();
        this.tools = [];
    }
}
