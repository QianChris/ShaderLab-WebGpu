## api.ts

```ts
/**
 * @shaderlab/api — the single public surface between the engine and plugins.
 *
 * Plugins (public/plugins/<id>/index.ts) may import ONLY this module (plus
 * their own relative files). The PluginManager rewrites the bare specifier
 * '@shaderlab/api' to this module's URL at load time:
 *   dev:  /src/api.ts          (transformed on the fly by the Vite dev server)
 *   prod: /assets/engine-api.js (stable-named secondary Rollup entry; shares
 *          chunks with the main bundle, so singletons are the same instances)
 *
 * Surface stability: UNSTABLE until the plugin migration (PLAN_Plugin.md
 * Phase C) is complete, after which this file is the frozen contract.
 *
 * What belongs here:
 *   - the plugin base class + lifecycle/context types (src/core/plugins/Plugin.ts)
 *   - engine mechanism singletons (usage surface: scene field access, uniform
 *     layouts, GPU resources, buffers, events, math)
 *   - declaration types consumed by plugin declaration fields
 *   - third-party re-exports plugins are allowed to use (RAPIER, bitecs query API)
 * What does NOT belong here:
 *   - anything importing from public/plugins (the engine must never depend on
 *     a plugin; all engine→plugin calls go through the interfaces below)
 */

/* ── Plugin system ─────────────────────────────────────────────── */
export { EnginePlugin } from './core/plugins/Plugin';
export type {
    PluginMeta,
    PluginContext,
    ValueHook,
    MeshCatalogEntry,
    FallbackTextureDecls,
    VboPresetDecls,
} from './core/plugins/Plugin';
export type { ToolFactory } from './core/tools/ToolRegistry';

/* ── ECS mechanisms ────────────────────────────────────────────── */
export { Scene } from './core/ecs/Scene';
export type { SceneData, CameraView } from './core/ecs/Scene';
export { schemaRegistry, SchemaRegistry } from './core/ecs/SchemaRegistry';
export type { ComponentDef, FieldDef } from './core/ecs/SchemaRegistry';
export { systemRegistry } from './core/ecs/SystemRegistry';
export type {
    System,
    FrameContext,
    SystemDef,
    SystemBufferDecl,
} from './core/ecs/SystemRegistry';

/* ── Render mechanisms (usage surface) ─────────────────────────── */
export { resourceManager } from './core/render/ResourceManager';
export { bufferRegistry } from './core/render/BufferRegistry';
export { uniformLayouts, UniformLayout } from './core/render/UniformLayout';
export type { UniformLayoutDecls, UniformMemberDecl, UniformMemberType } from './core/render/UniformLayout';
export { PipelineLoader } from './core/render/PipelineLoader';
export { VERTEX_SLOTS, SLOT_ORDER, isSlotName } from './core/render/vertexSlots';
export type { SlotName, SlotDef, VertexSlotDecls } from './core/render/vertexSlots';
export { meshEdges, isPbrMeshData } from './core/render/Primitives';
export type { MeshData, PbrMeshData, MeshGenerator } from './core/render/Primitives';
export { resolveValue, resolveString, resolveHandle } from './core/render/valueResolver';
export type { ValueContext, AtomResolver } from './core/render/valueResolver';
export type {
    PipelineConfig,
    ComputePipelineConfig,
    ComputeMeta,
    PhaseDecl,
    PhaseBehavior,
    PhaseBehaviorContext,
    DriverFrame,
    ViewportRect,
    IRenderer,
    PipelineEntry,
    RenderGraphData,
    VertexInputDecls,
    BindLayoutDecls,
    BindEntryDecl,
    SamplerDecls,
} from './core/render/types';
export type { RendererDecl, RenderTargetDecls, RenderTargetSize } from './core/render/rendererDecl';
export type {
    GeometryHook,
    ComputeHook,
    GeometryHookContext,
    ComputeHookContext,
} from './core/render/PipelineDriver';

/* ── Events ────────────────────────────────────────────────────── */
export { EventBus } from './core/events/EventBus';
export type { EventHandler } from './core/events/EventBus';
export { EVENT_TYPES } from './core/events/eventTypes';
export type { EventType } from './core/events/eventTypes';

/* ── Tools ─────────────────────────────────────────────────────── */
export type { ToolConfig, ToolContext, SceneTool } from './editor/input/SceneTool';

/* ── Math ──────────────────────────────────────────────────────── */
export {
    buildCameraMatrices,
    buildCameraMatricesInto,
    mat4FromTRS,
    mat4FromTRSInto,
    mat4OrthographicSym,
    mat4OrthographicSymInto,
    mat4LookAt,
    mat4LookAtInto,
    mat4Perspective,
    mat4PerspectiveInto,
    mat4Mul,
    mat4MulInto,
    mat4Inverse,
    mat4InverseInto,
    mat4TransformVec4,
    quatRotateVec3,
    normalMatrix,
    normalMatrixInto,
} from './core/math';
export type { TRS } from './core/math';

/* ── Engine config type (read-only view for plugins) ──────────── */
export type { EngineConfig, SystemEntry, AppManifest } from './core/Engine';

/* ── Third-party re-exports (the only non-relative imports allowed
 *    in plugins go through here so the engine controls the version) ── */
export { default as RAPIER } from '@dimforge/rapier3d-compat';
export { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs/legacy';
export type { World, EntityId } from 'bitecs';

```

## main.ts

```ts
import { AppHost } from './host/AppHost';
import { EditorUILayer } from './ui/layers/EditorUILayer';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errorEl = document.getElementById('error')!;
const uiContainer = document.getElementById('ui-container')!;
const sidebar = document.getElementById('sidebar')!;

async function main(): Promise<void> {
    if (!navigator.gpu) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'WebGPU is not supported.\nUse Chrome 113+ or Edge 113+.';
        return;
    }

    try {
        const host = new AppHost(canvas, uiContainer);
        await host.init();

        const appName = new URLSearchParams(location.search).get('app') ?? host.engineConfig.defaultApp;
        await host.loadApp(appName);

        // Editor layer: tab shell, command bus, input manager (tools) and panels.
        const editorLayer = new EditorUILayer();
        host.mountLayer(editorLayer, sidebar);

        // Load the App's custom UI (ui-config.json).
        await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

        window.addEventListener('resize', () => host.resize());
        host.startLoop();

        // Devtools back-compat: switchApp reloads app + refreshes the editor.
        (window as unknown as { switchApp: (name: string) => Promise<void> }).switchApp = (name: string) => editorLayer.switchApp(name);
        (window as unknown as { engine: unknown }).engine = host.engine;
        (window as unknown as { host: unknown }).host = host;

        console.log('[ShaderLab] editor mode initialized');
        console.log('[ShaderLab] scene:', JSON.stringify(host.engine.exportScene(), null, 2));
    } catch (err) {
        console.error(err);
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err}`;
    }
}

main();

```

## player.ts

```ts
import { AppHost } from './host/AppHost';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errorEl = document.getElementById('error')!;
const uiContainer = document.getElementById('ui-container')!;

/**
 * Runtime entry (player.html): engine + app UI only. No editor UI, no input
 * manager / tools, no undo — the AppHost dispatches commands directly to the
 * engine (unstacked) and no editor layer intercepts them.
 */
async function main(): Promise<void> {
    if (!navigator.gpu) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'WebGPU is not supported.\nUse Chrome 113+ or Edge 113+.';
        return;
    }

    try {
        const host = new AppHost(canvas, uiContainer);
        await host.init();

        const appName = new URLSearchParams(location.search).get('app') ?? host.engineConfig.defaultApp;
        await host.loadApp(appName);

        // ❌ No editor layer / input manager in player mode.
        // ✅ Load the App's custom UI only.
        await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

        window.addEventListener('resize', () => host.resize());
        host.startLoop();

        (window as unknown as { host: unknown }).host = host;

        console.log('[ShaderLab] player mode initialized');
    } catch (err) {
        console.error(err);
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err}`;
    }
}

main();

```

## core\Engine.ts

```ts
import { Scene, type SceneData } from './ecs/Scene';
import { registerToolType } from './tools/ToolRegistry';
import { EventBus } from './events/EventBus';
import { RenderGraph } from './render/RenderGraph';
import { resourceManager } from './render/ResourceManager';
import { PipelineLoader } from './render/PipelineLoader';
import { uniformLayouts } from './render/UniformLayout';
import { schemaRegistry } from './ecs/SchemaRegistry';
import { systemRegistry, type FrameContext, type System } from './ecs/SystemRegistry';
import { bufferRegistry } from './render/BufferRegistry';
import { PRESET_MESHES, PRESET_PBR_MESHES, registerMeshGenerator, unregisterMeshGenerator } from './render/Primitives';
import { loadVertexSlots, removeVertexSlotsByOwner, SLOT_ORDER } from './render/vertexSlots';
import { atomNamespaces } from './render/valueResolver';
import { GltfLoader } from './gltf/GltfLoader';
import { pluginManager, pluginOwner } from './plugins/PluginManager';
import { PluginHostHelper, type PluginLedger } from './PluginHost';
import type { EnginePlugin, PluginContext, MeshCatalogEntry } from './plugins/Plugin';
import type { RenderGraphData, IRenderer } from './render/types';

interface GltfMapping {
    transform: { component: string; fields: Record<string, string> };
    mesh: { component: string; field: string };
    material: {
        component: string;
        fields: Record<string, string>;
        textures: Record<string, string>;
    };
}

/** App manifest (/apps/<name>/app.json): declares app-specific assets to load. */
export interface AppManifest {
    name?: string;
    /** App-scoped plugins to load (unloaded on app switch). */
    plugins?: string[];
    /** Extra component definition files (merged after common components). */
    components?: string[];
    /** Scene entity data file (default "scene.json"). */
    scene?: string;
    /** Render graph file (default "render.json"). */
    render?: string;
    /** App system order override file (default "systems.json"); absent = use common/systems.json. */
    systems?: string;
    /** Interaction tools config. */
    tools?: string;
    /** glTF models to load into the scene. */
    gltf?: string[];
}

/** One entry in a systems.json list: a system name + optional def path. */
export interface SystemEntry {
    name: string;
    /** Path to the system definition JSON; omitted = common systems/<name>.json. */
    def?: string;
}

/** Engine-level configuration loaded from /common/engine-config.json. */
export interface EngineConfig {
    dataRoot: string;
    appsRoot: string;
    defaultApp: string;
    renderScriptsSubdir: string;
    computeTgs: number;
    alphaMode: GPUCanvasAlphaMode;
    systemOrder: string[];
    scriptHooks: string[];
    /** Root URL of runtime plugins (default '/plugins'). */
    pluginsRoot?: string;
    /** Engine-level plugins loaded at init (session lifetime). */
    plugins?: string[];
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    dataRoot: '/common',
    appsRoot: '/apps',
    defaultApp: 'demo1',
    renderScriptsSubdir: 'scripts',
    computeTgs: 64,
    alphaMode: 'premultiplied',
    systemOrder: ['input', 'script', 'physics', 'camera', 'light', 'animation', 'render'],
    scriptHooks: ['init', 'update'],
    pluginsRoot: '/plugins',
    plugins: [],
};

/** Tracks what a plugin registered through its ctx / declarations, so the
 *  open registries (tools, generators, atoms, phases) can be swept on unload.
 *  Re-exported from PluginHost for back-compat with any internal consumers. */
export type { PluginLedger } from './PluginHost';

export class Engine {
    device!: GPUDevice;
    context!: GPUCanvasContext;
    format!: GPUTextureFormat;
    scene!: Scene;
    renderGraph!: RenderGraph;
    eventBus!: EventBus;
    /** Engine-level config (paths, default app) loaded from engine-config.json. */
    engineConfig: EngineConfig = DEFAULT_ENGINE_CONFIG;
    /** Default system list from common/systems.json (the engine-wide baseline). */
    commonSystems: SystemEntry[] = [];
    /** Systems actually run each frame for the current app (= commonSystems until an app overrides). */
    activeSystems: SystemEntry[] = [];
    /** glTF → component field mapping (from gltf-mapping.json). */
    gltfMapping: GltfMapping | null = null;
    /** Currently loaded app id, or null before first load / after unload. */
    currentApp: string | null = null;
    /** Opaque objects published by plugins (owner-tagged), consumed by hooks. */
    attachments = new Map<string, { obj: unknown; owner: string }>();
    /** Plain-object view of attachments handed to FrameContext / hooks. */
    private attachmentsView: Record<string, unknown> = {};
    /** Per-plugin registration ledger (for owner sweeps of open registries). */
    pluginLedgers = new Map<string, PluginLedger>();
    /** Replacement renderer installed via ctx.replaceRenderer (null = built-in). */
    customRenderer: IRenderer | null = null;
    customRendererOwner: string | null = null;
    /** Extracted plugin declaration/sweep logic (reduces Engine God Class). */
    private pluginHost!: PluginHostHelper;

    private dpr: number;
    private _canvas: HTMLCanvasElement;
    private startTime = 0;
    private lastTime = 0;
    /** True while loadApp is in flight — frame() skips system updates. */
    private appLoading = false;
    /** Pooled FrameContext — built once in init(), only mutable fields
     *  (time/dt/aspect/cw/ch) are updated per frame. Closures bind to `this`
     *  and module singletons, so they stay valid for the engine's lifetime. */
    private frameCtx!: FrameContext;
    /** Batched compute pass: dispatches from ctx.dispatchCompute accumulate
     *  here, submitted together by flushCompute(). Null when no pass is open. */
    private pendingComputeEncoder: GPUCommandEncoder | null = null;
    private pendingComputePass: GPUComputePassEncoder | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
        this.dpr = window.devicePixelRatio || 1;
    }

    /* ── Read-only accessors (UI layer may query these; writes must go
     *    through the AppHost command channel) ──────────────────────── */
    get schemaRegistry() { return schemaRegistry; }
    get systemRegistry() { return systemRegistry; }
    get uniformLayouts() { return uniformLayouts; }
    get resourceManager() { return resourceManager; }
    get canvas(): HTMLCanvasElement { return this._canvas; }

    /** Render canvas aspect ratio (width/height). */
    aspect(): number {
        return this._canvas.width / Math.max(1, this._canvas.height);
    }

    async init(): Promise<void> {
        // Missing engine-config.json is a documented fallback (built-in defaults),
        // but a present-yet-malformed file must fail loud (json() throws below).
        const configResp = await fetch('/common/engine-config.json');
        if (this.isJson(configResp)) {
            this.engineConfig = await configResp.json() as EngineConfig;
        } else {
            console.warn('[Engine] /common/engine-config.json not found — using built-in defaults');
        }

        const root = this.engineConfig.dataRoot;
        // Load the default system order (common/systems.json). Falls back to
        // engine-config.systemOrder for back-compat when the file is absent;
        // a malformed file throws (fail loud) instead of silently falling back.
        const sysResp = await fetch(`${root}/systems.json`);
        if (this.isJson(sysResp)) {
            this.commonSystems = await sysResp.json() as SystemEntry[];
        } else {
            console.warn(`[Engine] ${root}/systems.json not found — falling back to engine-config systemOrder`);
        }
        if (this.commonSystems.length === 0) {
            this.commonSystems = this.engineConfig.systemOrder.map(name => ({ name }));
        }
        this.activeSystems = this.commonSystems;

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter');
        this.device = await adapter.requestDevice();
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context = this._canvas.getContext('webgpu')!;

        this.resize();
        this.context.configure({ device: this.device, format: this.format, alphaMode: this.engineConfig.alphaMode });

        resourceManager.init(this.device);
        PipelineLoader.defaultWorkgroupSize = this.engineConfig.computeTgs;

        for (const [name, data] of Object.entries(PRESET_MESHES)) {
            resourceManager.registerMesh(name, data);
        }
        for (const [name, data] of Object.entries(PRESET_PBR_MESHES)) {
            resourceManager.registerPbrMesh(name, data);
        }

        // gltf-mapping.json is only required by apps that declare glTF assets;
        // loadGltf() throws when it is needed but missing. Malformed → json() throws here.
        const gltfMapResp = await fetch(`${root}/gltf-mapping.json`);
        this.gltfMapping = this.isJson(gltfMapResp) ? await gltfMapResp.json() as GltfMapping : null;

        this.scene = new Scene();
        this.renderGraph = new RenderGraph();
        this.eventBus = new EventBus();

        // Engine-level plugins (session lifetime). The engine has no compile-time
        // knowledge of any plugin: ids come from engine-config.json, invocation
        // goes through the registries populated below. All capability systems
        // (input/script/camera/light/animation/render/physics/…) come from here.
        PipelineLoader.pluginsRoot = this.engineConfig.pluginsRoot ?? '/plugins';
        this.pluginHost = new PluginHostHelper(this);
        pluginManager.configure({
            pluginsRoot: this.engineConfig.pluginsRoot ?? '/plugins',
            makeCtx: (id, baseUrl) => this.makePluginContext(id, baseUrl),
            applyDeclarations: (id, plugin) => this.pluginHost.applyDeclarations(id, plugin, pluginOwner(id)),
            sweepOwner: (owner) => this.pluginHost.sweepOwner(owner),
            beginOwner: (owner) => {
                const prev = resourceManager.currentOwnerId;
                resourceManager.enterApp(owner);
                return prev;
            },
            endOwner: (previous) => resourceManager.enterApp(previous),
        });
        await pluginManager.loadMany(this.engineConfig.plugins ?? [], 'engine');

        // System defs (ubos/buffers/needs) now come from plugin `systemDefs`;
        // loadDefs only resolves legacy def files / app script systems.
        await systemRegistry.loadDefs(this.commonSystems, root, '');
        // Allocate every common-scoped buffer declared by the baseline systems
        // (camera / light / timeInput / pointShadowFaces UBOs from core's defs).
        bufferRegistry.allocateFor(this.commonSystems, 'common', this.device);

        // Build the pooled FrameContext once — closures bind to `this` and
        // module singletons, so only mutable fields update per frame.
        this.frameCtx = this.buildFrameContext();

        this.assertSystemsResolve();
    }

    /** Build the per-plugin context: identity (baseUrl) + owner-tracked registration surface. */
    private makePluginContext(id: string, baseUrl: string): PluginContext {
        const owner = pluginOwner(id);
        const ledger = this.pluginHost.ledgerFor(owner);
        return {
            device: this.device,
            scene: this.scene,
            eventBus: this.eventBus,
            engineConfig: this.engineConfig,
            canvas: this._canvas,
            baseUrl,
            renderer: this.renderer,
            registerSystem: (name, sys) => systemRegistry.registerBuiltin(name, sys, owner),
            registerAttachment: (name, obj) => this.setAttachment(name, obj, owner),
            registerRenderHook: (name, fn) => this.pluginHost.registerRenderHook(name, fn, owner),
            registerPhaseBehavior: (name, behavior) => this.renderGraph.registerPhaseBehavior(name, behavior, owner),
            replaceRenderer: (r) => {
                // Renderer seam: swap the 'render' system dispatch target. The
                // built-in graph stays idle; data-plane calls (loadRenderGraphData,
                // editor) keep targeting the replacement via Engine.renderer.
                this.customRenderer = r;
                this.customRendererOwner = owner;
                systemRegistry.unregisterBuiltin('render');
                systemRegistry.registerBuiltin('render', r, owner);
            },
            registerMeshGenerator: (name, fn) => {
                registerMeshGenerator(name, fn);
                ledger.generators.push(name);
            },
            registerToolType: (name, factory) => {
                registerToolType(name, factory);
                ledger.tools.push(name);
            },
            registerValueAtoms: (ns, atoms) => {
                atomNamespaces[ns] = { ...(atomNamespaces[ns] ?? {}), ...atoms };
                for (const name of Object.keys(atoms)) ledger.atoms.push([ns, name]);
            },
            getSystem: <T,>(name: string) => systemRegistry.resolve({ name }) as T | null,
            getPlugin: <T extends EnginePlugin,>(pid: string) => (pluginManager.get(pid)?.instance ?? null) as T | null,
        };
    }

    /** Restore the built-in renderer after a replacement renderer's owner is swept. */
    restoreBuiltinRenderer(): void {
        this.customRenderer = null;
        this.customRendererOwner = null;
        systemRegistry.registerBuiltin('render', this.renderGraph, 'engine');
    }

    /** The active renderer: a plugin replacement when installed, else the built-in graph. */
    get renderer(): IRenderer {
        return this.customRenderer ?? this.renderGraph;
    }

    /** Publish an opaque object under `name` (owner-tagged for sweeps). */
    setAttachment(name: string, obj: unknown, owner: string): void {
        this.attachments.set(name, { obj, owner });
        this.attachmentsView[name] = obj;
    }

    deleteAttachment(name: string): void {
        this.attachments.delete(name);
        delete this.attachmentsView[name];
    }

    loadSceneData(json: SceneData): void {
        for (const [key, entityData] of Object.entries(json)) {
            this.scene.createEntity(key, entityData);
        }
        this.resolveHandles();
    }

    /** Fill MeshComponent GPU handles/counts from built meshes. */
    resolveHandles(): void {
        for (const [, eid] of this.scene.entityKeyMap) {
            if (!this.scene.hasComponent(eid, 'MeshComponent')) continue;
            if ((this.scene.getField(eid, 'MeshComponent', 'hPos') as number) > 0) continue;
            const meshName = this.scene.getField(eid, 'MeshComponent', 'mesh') as string;
            if (!meshName || !resourceManager.hasMesh(meshName)) continue;

            const mesh = resourceManager.getMesh(meshName);
            const s = this.scene;
            for (const slotName of SLOT_ORDER) {
                s.setField(eid, 'MeshComponent', `h${slotName}`, mesh.slotHandles[slotName] ?? 0);
            }
            s.setField(eid, 'MeshComponent', 'hIndex', mesh.indexHandle);
            s.setField(eid, 'MeshComponent', 'vertexCount', mesh.vertexCount);
            s.setField(eid, 'MeshComponent', 'indexCount', mesh.indexCount);
            s.setField(eid, 'MeshComponent', 'edgeCount', mesh.edgeCount);
            s.setField(eid, 'MeshComponent', 'pointCount', mesh.pointCount);
            s.setField(eid, 'MeshComponent', 'indexFormat', mesh.indexFormat === 'uint32' ? 1 : 0);
        }
    }

    async loadRenderGraphData(json: RenderGraphData, appBase?: string): Promise<void> {
        this.renderGraph.fromData(json);
        // Render targets are plugin declarations (core's render-targets.json +
        // any capability plugin's `renderTargets` field) — already registered.
        const scripts = (json as { renderScripts?: string[] }).renderScripts ?? [];
        this.renderGraph.setScriptFiles(scripts);
        this.renderGraph.setScriptsSubdir(this.engineConfig.renderScriptsSubdir);
        await this.renderGraph.compile(this.device, this.format, this.engineConfig.dataRoot, appBase);
    }

    /**
     * Load an application from its manifest at /apps/<name>/app.json. The manifest
     * declares which app-specific components, scene, render graph, tools and glTF
     * models to load; engine-common assets live under /common.
     *
     * Any previously loaded app is unloaded first (scene, GPU resources owned by
     * the old app, escape-hatch hooks, particle buffers, physics bodies, script
     * modules and event handlers are all released).
     */
    async loadApp(name: string): Promise<void> {
        this.appLoading = true;
        try {
            await this.loadAppInner(name);
        } finally {
            this.appLoading = false;
        }
    }

    private async loadAppInner(name: string): Promise<void> {
        this.unloadCurrentApp();
        this.currentApp = name;
        resourceManager.enterApp(name);

        const base = `${this.engineConfig.appsRoot}/${name}`;
        const manifestResp = await fetch(`${base}/app.json`);
        if (!this.isJson(manifestResp)) {
            throw new Error(`App not found at ${base}/app.json. If you renamed the folder, update the "name" field in app.json to match.`);
        }
        const manifest = await manifestResp.json() as AppManifest;

        // App-scoped plugins (unloaded on app switch). Loaded before systems.json
        // so plugin-registered systems are resolvable in the app's system order.
        await pluginManager.loadMany(manifest.plugins ?? [], 'app');

        // An app may override the common system order by shipping its own
        // systems.json; absent → use the common baseline + auto-insert any
        // registered systems that declared after/before dependencies.
        const systemsUrl = this.resolveAsset(base, manifest.systems ?? 'systems.json');
        const sysResp = await fetch(systemsUrl);
        if (this.isJson(sysResp)) {
            this.activeSystems = await sysResp.json() as SystemEntry[];
        } else {
            this.activeSystems = systemRegistry.autoInsert(this.commonSystems);
        }

        // Pre-load each system's def JSON + any script systems referenced by
        // `source: "<path>.js"` so resolve() in the frame loop is synchronous.
        await systemRegistry.loadDefs(this.activeSystems, this.engineConfig.dataRoot, base);

        // Allocate every UBO/storage buffer declared in the active systems' defs
        // (`ubos`/`buffers` fields). App-scoped: released on app switch.
        bufferRegistry.allocateFor(this.activeSystems, name, this.device);

        for (const rel of manifest.components ?? []) {
            await schemaRegistry.loadMore(this.resolveAsset(base, rel), `app:${name}`);
        }

        const sceneUrl = this.resolveAsset(base, manifest.scene ?? 'scene.json');
        const renderUrl = this.resolveAsset(base, manifest.render ?? 'render.json');
        const [sceneResp, renderResp] = await Promise.all([
            fetch(sceneUrl),
            fetch(renderUrl),
        ]);
        if (!this.isJson(sceneResp)) throw new Error(`Scene not found: ${sceneUrl}`);
        if (!this.isJson(renderResp)) throw new Error(`Render graph not found: ${renderUrl}`);
        const [sceneJson, renderJson] = await Promise.all([
            sceneResp.json(),
            renderResp.json(),
        ]);

        this.loadSceneData(sceneJson);

        // Render graph assets (pipelines/shaders/textures) live under /common and
        // must be common-owned so they survive app switches; temporarily flip owner.
        resourceManager.enterApp('common');
        try {
            await this.loadRenderGraphData(renderJson, base);
        } finally {
            resourceManager.enterApp(name);
        }

        // Interaction tools (tools.json) are an editor concern — the editor's
        // input manager loads them after the app is up (EditorUILayer.mount).
        for (const glb of manifest.gltf ?? []) {
            await this.loadGltf(this.resolveAsset(base, glb));
        }

        // Notify every loaded plugin that the app (scene + render graph) is up
        // (app-scoped capabilities load their per-scene assets here, e.g. the
        // splat plugin scans GsComponent entities and loads PLY data).
        await pluginManager.broadcastAppLoaded(base);

        // Every system named in the active list must resolve to a runnable
        // instance (builtin or loaded script); a name that resolves to nothing
        // would otherwise be skipped silently every frame.
        this.assertSystemsResolve();
    }

    /** Fail loud when an active system name resolves to no implementation. */
    private assertSystemsResolve(): void {
        const unresolved = this.activeSystems.filter(s => !systemRegistry.resolve(s));
        if (unresolved.length > 0) {
            throw new Error(
                `Unresolved system(s): ${unresolved.map(s => `'${s.name}'`).join(', ')} — ` +
                `each needs a builtin registration or a system def with a loadable source (systems.json / systems/<name>.json)`,
            );
        }
    }

    /** Unload the current app: release every app-owned resource and reset state.
     *  Common assets (preset meshes, common pipelines, shaders, named layouts,
     *  samplers, default textures) are kept for reuse. */
    unloadCurrentApp(): void {
        if (!this.currentApp) return;
        const appId = this.currentApp;
        pluginManager.broadcastAppUnloading();
        this.eventBus.clear();
        systemRegistry.clearScripts();
        bufferRegistry.exitApp(appId);
        this.activeSystems = this.commonSystems;
        this.scene.clear();
        schemaRegistry.resetStrings();
        schemaRegistry.removeOwner(`app:${appId}`);
        this.renderGraph.exitApp(appId);
        resourceManager.exitApp(appId);
        // App-scoped plugins unload last: their teardown may release resources
        // registered under their own owner tag (swept via sweepPluginOwner).
        pluginManager.unloadAppPlugins();
        this.currentApp = null;
    }

    /** Resource counts for diagnostics / stress testing (delegates to ResourceManager). */
    getResourceStats(): Record<string, number> {
        return resourceManager.getStats() as unknown as Record<string, number>;
    }

    /** Resolve an app asset path: absolute (leading /) or relative to the app dir. */
    private resolveAsset(base: string, rel: string): string {
        return rel.startsWith('/') ? rel : `${base}/${rel}`;
    }

    /** Check that a fetch response is actually JSON (Vite SPA fallback returns 200 + HTML). */
    private isJson(resp: Response): boolean {
        const ct = resp.headers.get('content-type') ?? '';
        return resp.ok && (ct.includes('json') || ct.includes('application'));
    }

    /** True if the named system is in the active app's system list. */
    private hasSystem(name: string): boolean {
        return this.activeSystems.some(s => s.name === name);
    }

    resize(): void {
        this._canvas.width = this._canvas.clientWidth * this.dpr;
        this._canvas.height = this._canvas.clientHeight * this.dpr;
    }

    /** Build the reusable FrameContext: stable references + closures that
     *  bind to `this` and module singletons. Only time/dt/aspect/cw/ch update
     *  per frame (assigned in frame()). */
    private buildFrameContext(): FrameContext {
        return {
            scene: this.scene,
            time: 0, dt: 0,
            aspect: this.aspect(),
            cw: this._canvas.width,
            ch: this._canvas.height,
            canvas: this._canvas,
            device: this.device,
            context: this.context,
            format: this.format,
            eventBus: this.eventBus,
            attachments: this.attachmentsView,
            getSystem: <T,>(name: string) => systemRegistry.resolve({ name }) as T | null,
            getBuffer: (name: string) => bufferRegistry.get(name),
            writeBuffer: (name: string, data: BufferSource) => bufferRegistry.write(name, this.device, data),
            dispatchCompute: (pipelineName: string, count: number, entries?: GPUBindGroupEntry[]) => {
                this.dispatchCompute(pipelineName, count, entries);
            },
            flushCompute: () => { this.flushCompute(); },
        };
    }

    private frame = (): void => {
        const now = performance.now();
        if (this.startTime === 0) { this.startTime = now; this.lastTime = now; }
        // Skip system updates while an app is loading (partial scene/registries).
        if (this.appLoading) {
            this.lastTime = now;
            requestAnimationFrame(this.frame);
            return;
        }
        const time = (now - this.startTime) / 1000;
        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;

        // Reuse the pooled FrameContext — only mutable fields update per frame.
        const ctx = this.frameCtx;
        ctx.time = time;
        ctx.dt = dt;
        ctx.aspect = this.aspect();
        ctx.cw = this._canvas.width;
        ctx.ch = this._canvas.height;

        for (const sys of this.activeSystems) {
            const impl = systemRegistry.resolve(sys);
            impl?.update(ctx);
        }
        // Safety-net flush for any compute dispatched by the render system or
        // after it. The renderer also calls ctx.flushCompute() at the start of
        // execute() so same-frame compute results are visible to render passes.
        this.flushCompute();
        requestAnimationFrame(this.frame);
    };

    startLoop(): void {
        requestAnimationFrame(this.frame);
    }

    /** Dispatch a preloaded compute pipeline by name (script-system escape hatch).
     *  Dispatches are batched into one compute pass per frame and submitted
     *  together by flushCompute() (called by the renderer before recording
     *  render passes, and at end of frame as a safety net). */
    private dispatchCompute(pipelineName: string, count: number, entries?: GPUBindGroupEntry[]): void {
        const pipeline = this.renderGraph.getComputePipeline(pipelineName);
        if (!pipeline) throw new Error(`compute pipeline '${pipelineName}' not loaded`);
        const meta = PipelineLoader.getComputeMeta(pipelineName);
        const tgs = meta?.workgroupSize ?? this.engineConfig.computeTgs;
        // Lazily open one compute pass spanning all dispatches in this frame.
        if (!this.pendingComputePass) {
            if (!this.pendingComputeEncoder) {
                this.pendingComputeEncoder = this.device.createCommandEncoder();
            }
            this.pendingComputePass = this.pendingComputeEncoder.beginComputePass();
        }
        this.pendingComputePass.setPipeline(pipeline);
        if (entries && entries.length > 0) {
            const bg = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries,
            });
            this.pendingComputePass.setBindGroup(0, bg);
        }
        this.pendingComputePass.dispatchWorkgroups(Math.ceil(count / tgs));
    }

    /** End the batched compute pass (if open) and submit it. Called by the
     *  renderer at the start of execute() so compute results are visible to
     *  render passes in the same frame, and again at end of frame as a
     *  safety net (no-op when nothing was dispatched). */
    private flushCompute(): void {
        if (this.pendingComputePass) {
            this.pendingComputePass.end();
            this.pendingComputePass = null;
        }
        if (this.pendingComputeEncoder) {
            this.device.queue.submit([this.pendingComputeEncoder.finish()]);
            this.pendingComputeEncoder = null;
        }
    }

    exportScene(): object {
        return { entities: this.scene.toJSON() };
    }

    exportRenderGraph(): object {
        return this.renderGraph.toData();
    }

    async loadGltf(url: string): Promise<void> {
        const m = this.gltfMapping;
        if (!m) {
            throw new Error(
                `glTF '${url}' declared but ${this.engineConfig.dataRoot}/gltf-mapping.json is missing — ` +
                `the glTF → component mapping must be declared, not hardcoded`,
            );
        }
        const gltfLoader = new GltfLoader();
        const result = await gltfLoader.load(url);

        console.log(`[GLTF] loaded ${result.primitives.length} primitives, ${result.textures.length} textures`);
        for (const prim of result.primitives) {
            console.log(`  mesh: ${prim.name} | verts=${prim.meshData.positions.length/3} nrm=${prim.meshData.normals.length/3} uv=${prim.meshData.uvs.length/2} idx=${prim.meshData.indices.length}`);
            console.log(`  material: bc=${prim.material.baseColorFactor} met=${prim.material.metallicFactor} rough=${prim.material.roughnessFactor}`);
            console.log(`  textures: bc=${prim.baseColorTexture} mr=${prim.metallicRoughnessTexture} ao=${prim.occlusionTexture} em=${prim.emissiveTexture}`);
        }

        for (const tex of result.textures) {
            await resourceManager.uploadTextureFromImage(tex.key, tex.image, tex.sRGB);
        }

        for (const prim of result.primitives) {
            resourceManager.registerPbrMesh(prim.name, prim.meshData);
        }

        for (const node of result.nodes) {
            const entityData: Record<string, Record<string, unknown>> = {};

            entityData[m.transform.component] = {
                [m.transform.fields.position]: node.transform.position,
                [m.transform.fields.rotation]: node.transform.rotation,
                [m.transform.fields.scale]: node.transform.scale,
            };
            entityData[m.mesh.component] = { [m.mesh.field]: node.meshName };

            const pm = result.primitives.find(p => p.name === node.meshName);
            if (pm) {
                const mat: Record<string, unknown> = {};
                for (const [gltfKey, fieldKey] of Object.entries(m.material.fields)) {
                    mat[fieldKey] = (pm.material as unknown as Record<string, unknown>)[gltfKey];
                }
                for (const [gltfKey, fieldKey] of Object.entries(m.material.textures)) {
                    const texKey = (pm as unknown as Record<string, unknown>)[gltfKey] as string | undefined;
                    mat[fieldKey] = texKey ? resourceManager.textureHandle(texKey) : 0;
                }
                entityData[m.material.component] = mat;
            }

            this.scene.createEntity(node.name, entityData);
        }

        this.resolveHandles();
    }
}

```

## core\math.ts

```ts
export interface TRS {
    pos: [number, number, number];
    rot: [number, number, number, number];
    scale: [number, number, number];
}

export function buildCameraMatrices(
    trs: TRS,
    fov: number,
    aspect: number,
    near: number,
    far: number,
): { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array } {
    return buildCameraMatricesInto(trs, fov, aspect, near, far, {
        vp: new Float32Array(16), ivp: new Float32Array(16),
        pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
    });
}

/** Reusable scratch for the world-matrix temporary in buildCameraMatricesInto. */
const _scratchWorld = new Float32Array(16);

/** out-parameter variant: writes into the caller-provided arrays in `out`.
 *  The `out` object and its Float32Array fields are reused across calls —
 *  no per-call allocation. Not reentrant (uses a module-level scratch). */
export function buildCameraMatricesInto(
    trs: TRS,
    fov: number,
    aspect: number,
    near: number,
    far: number,
    out: { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array },
): typeof out {
    // world = mat4FromTRS(...)
    mat4FromTRSInto(trs.pos, trs.rot, trs.scale, _scratchWorld);
    // view = mat4Inverse(world) — reuse vp as scratch then overwrite
    mat4InverseInto(_scratchWorld, out.view);
    // proj = mat4Perspective(...)
    mat4PerspectiveInto((fov * Math.PI) / 180, aspect, near, far, out.proj);
    // vp = mat4Mul(proj, view)
    mat4MulInto(out.proj, out.view, out.vp);
    // ivp = mat4Inverse(vp)
    mat4InverseInto(out.vp, out.ivp);
    // pos
    out.pos[0] = trs.pos[0]; out.pos[1] = trs.pos[1]; out.pos[2] = trs.pos[2]; out.pos[3] = 0;
    return out;
}

export function mat4FromTRS(
    pos: [number, number, number],
    rot: [number, number, number, number],
    scale: [number, number, number],
): Float32Array {
    return mat4FromTRSInto(pos, rot, scale, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4FromTRSInto(
    pos: [number, number, number],
    rot: [number, number, number, number],
    scale: [number, number, number],
    out: Float32Array,
): Float32Array {
    const [rx, ry, rz, rw] = rot;
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    const qx = rx / len, qy = ry / len, qz = rz / len, qw = rw / len;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const m = out;
    m[0] = (1 - 2 * (yy + zz)) * scale[0];  m[4] = (2 * (xy - wz)) * scale[1];      m[8]  = (2 * (xz + wy)) * scale[2];      m[12] = pos[0];
    m[1] = (2 * (xy + wz)) * scale[0];      m[5] = (1 - 2 * (xx + zz)) * scale[1];  m[9]  = (2 * (yz - wx)) * scale[2];      m[13] = pos[1];
    m[2] = (2 * (xz - wy)) * scale[0];      m[6] = (2 * (yz + wx)) * scale[1];      m[10] = (1 - 2 * (xx + yy)) * scale[2];  m[14] = pos[2];
    m[3] = 0;                               m[7] = 0;                               m[11] = 0;                               m[15] = 1;
    return m;
}

/** Symmetric orthographic projection (WebGPU z in [0,1]), for directional-light shadows. */
export function mat4OrthographicSym(halfExtent: number, near: number, far: number): Float32Array {
    return mat4OrthographicSymInto(halfExtent, near, far, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4OrthographicSymInto(halfExtent: number, near: number, far: number, out: Float32Array): Float32Array {
    const m = out;
    const rl = halfExtent;
    m[0] = 1 / rl;  m[4] = 0;       m[8]  = 0;                 m[12] = 0;
    m[1] = 0;       m[5] = 1 / rl;  m[9]  = 0;                 m[13] = 0;
    m[2] = 0;       m[6] = 0;       m[10] = 1 / (near - far);  m[14] = near / (near - far);
    m[3] = 0;       m[7] = 0;       m[11] = 0;                 m[15] = 1;
    return m;
}

/** Right-handed lookAt view matrix (column-major), for building light-space matrices. */
export function mat4LookAt(
    eye: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
): Float32Array {
    return mat4LookAtInto(eye, target, up, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4LookAtInto(
    eye: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
    out: Float32Array,
): Float32Array {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    const m = out;
    m[0] = xx;  m[4] = xy;  m[8]  = xz;  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    m[1] = yx;  m[5] = yy;  m[9]  = yz;  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    m[2] = zx;  m[6] = zy;  m[10] = zz;  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    m[3] = 0;   m[7] = 0;   m[11] = 0;   m[15] = 1;
    return m;
}

/** Rotate a unit vector by a quaternion [x,y,z,w]. */
export function quatRotateVec3(
    q: [number, number, number, number],
    v: [number, number, number],
): [number, number, number] {
    const [qx, qy, qz, qw] = q;
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ];
}

export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
    return mat4PerspectiveInto(fovY, aspect, near, far, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4PerspectiveInto(fovY: number, aspect: number, near: number, far: number, out: Float32Array): Float32Array {
    const f = 1 / Math.tan(fovY / 2);
    const m = out;
    m[0] = f / aspect;  m[4] = 0;  m[8]  = 0;                     m[12] = 0;
    m[1] = 0;           m[5] = f;  m[9]  = 0;                     m[13] = 0;
    m[2] = 0;           m[6] = 0;  m[10] = far / (near - far);    m[14] = (far * near) / (near - far);
    m[3] = 0;           m[7] = 0;  m[11] = -1;                    m[15] = 0;
    return m;
}

/**
 * Normal matrix = transpose(inverse(upper-left 3x3 of model)).
 * Returned as 3 columns padded to vec4 (12 floats) matching WGSL mat3x3f layout.
 */
export function normalMatrix(model: Float32Array): Float32Array {
    return normalMatrixInto(model, new Float32Array(12));
}

/** out-parameter variant: writes into `out` (length 12) and returns it. */
export function normalMatrixInto(model: Float32Array, out: Float32Array): Float32Array {
    const a00 = model[0], a01 = model[1], a02 = model[2];
    const a10 = model[4], a11 = model[5], a12 = model[6];
    const a20 = model[8], a21 = model[9], a22 = model[10];

    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    let det = a00 * b01 + a01 * b11 + a02 * b21;
    det = det !== 0 ? 1 / det : 0;

    const i00 = b01 * det;
    const i01 = (-a22 * a01 + a02 * a21) * det;
    const i02 = (a12 * a01 - a02 * a11) * det;
    const i10 = b11 * det;
    const i11 = (a22 * a00 - a02 * a20) * det;
    const i12 = (-a12 * a00 + a02 * a10) * det;
    const i20 = b21 * det;
    const i21 = (-a21 * a00 + a01 * a20) * det;
    const i22 = (a11 * a00 - a01 * a10) * det;

    // transpose of inverse, stored column-major with vec4 padding
    out[0] = i00; out[1] = i10; out[2] = i20; out[3] = 0;
    out[4] = i01; out[5] = i11; out[6] = i21; out[7] = 0;
    out[8] = i02; out[9] = i12; out[10] = i22; out[11] = 0;
    return out;
}

/** Multiply column-major mat4 by a vec4; returns [x, y, z, w]. */
export function mat4TransformVec4(
    m: Float32Array,
    v: [number, number, number, number],
): [number, number, number, number] {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
}

export function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
    return mat4MulInto(a, b, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4MulInto(a: Float32Array, b: Float32Array, out: Float32Array): Float32Array {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[col * 4 + row] =
                a[row] * b[col * 4] +
                a[row + 4] * b[col * 4 + 1] +
                a[row + 8] * b[col * 4 + 2] +
                a[row + 12] * b[col * 4 + 3];
        }
    }
    return out;
}

export function mat4Inverse(m: Float32Array): Float32Array {
    return mat4InverseInto(m, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4InverseInto(m: Float32Array, out: Float32Array): Float32Array {
    const n00 = m[0], n01 = m[4], n02 = m[8],  n03 = m[12];
    const n10 = m[1], n11 = m[5], n12 = m[9],  n13 = m[13];
    const n20 = m[2], n21 = m[6], n22 = m[10], n23 = m[14];
    const n30 = m[3], n31 = m[7], n32 = m[11], n33 = m[15];

    const t1 = n22 * n33 - n23 * n32;  const t2 = n21 * n33 - n23 * n31;
    const t3 = n21 * n32 - n22 * n31;  const t4 = n20 * n33 - n23 * n30;
    const t5 = n20 * n32 - n22 * n30;  const t6 = n20 * n31 - n21 * n30;

    let det = n00 * (n11 * t1 - n12 * t2 + n13 * t3)
            - n01 * (n10 * t1 - n12 * t4 + n13 * t5)
            + n02 * (n10 * t2 - n11 * t4 + n13 * t6)
            - n03 * (n10 * t3 - n11 * t5 + n12 * t6);
    det = 1 / det;

    const inv = out;
    inv[0]  =  (n11 * t1 - n12 * t2 + n13 * t3) * det;
    inv[1]  = -(n10 * t1 - n12 * t4 + n13 * t5) * det;
    inv[2]  =  (n10 * t2 - n11 * t4 + n13 * t6) * det;
    inv[3]  = -(n10 * t3 - n11 * t5 + n12 * t6) * det;

    inv[4]  = -(n01 * t1 - n02 * t2 + n03 * t3) * det;
    inv[5]  =  (n00 * t1 - n02 * t4 + n03 * t5) * det;
    inv[6]  = -(n00 * t2 - n01 * t4 + n03 * t6) * det;
    inv[7]  =  (n00 * t3 - n01 * t5 + n02 * t6) * det;

    const u1 = n01 * n12 - n02 * n11;  const u2 = n01 * n13 - n03 * n11;
    const u3 = n02 * n13 - n03 * n12;  const u4 = n00 * n12 - n02 * n10;
    const u5 = n00 * n13 - n03 * n10;  const u6 = n00 * n11 - n01 * n10;

    inv[8]  =  (n31 * u3 - n32 * u2 + n33 * u1) * det;
    inv[9]  = -(n30 * u3 - n32 * u5 + n33 * u4) * det;
    inv[10] =  (n30 * u2 - n31 * u5 + n33 * u6) * det;
    inv[11] = -(n30 * u1 - n31 * u4 + n32 * u6) * det;

    inv[12] = -(n21 * u3 - n22 * u2 + n23 * u1) * det;
    inv[13] =  (n20 * u3 - n22 * u5 + n23 * u4) * det;
    inv[14] = -(n20 * u2 - n21 * u5 + n23 * u6) * det;
    inv[15] =  (n20 * u1 - n21 * u4 + n22 * u6) * det;

    return inv;
}

```

## core\PluginHost.ts

```ts
import { schemaRegistry } from './ecs/SchemaRegistry';
import { uniformLayouts } from './render/UniformLayout';
import { resourceManager } from './render/ResourceManager';
import { bufferRegistry } from './render/BufferRegistry';
import { systemRegistry } from './ecs/SystemRegistry';
import { PipelineLoader } from './render/PipelineLoader';
import { removeVertexSlotsByOwner, loadVertexSlots } from './render/vertexSlots';
import {
    meshGenerators, isPbrMeshData,
    registerMeshGenerator, unregisterMeshGenerator,
} from './render/Primitives';
import { registerToolType, unregisterToolType } from './tools/ToolRegistry';
import { atomNamespaces } from './render/valueResolver';
import type { RenderGraph } from './render/RenderGraph';
import type { EnginePlugin, MeshCatalogEntry } from './plugins/Plugin';
import type { IRenderer } from './render/types';

/** Tracks what a plugin registered through its ctx / declarations, so the
 *  open registries (tools, generators, atoms, phases) can be swept on unload. */
export interface PluginLedger {
    tools: string[];
    generators: string[];
    atoms: Array<[string, string]>;
    phases: string[];
}

/** Dependencies the PluginHostHelper needs from the Engine host. */
export interface PluginHostDeps {
    renderGraph: RenderGraph;
    attachments: Map<string, { obj: unknown; owner: string }>;
    pluginLedgers: Map<string, PluginLedger>;
    customRenderer: IRenderer | null;
    customRendererOwner: string | null;
    setAttachment(name: string, obj: unknown, owner: string): void;
    deleteAttachment(name: string): void;
    /** Restore the built-in renderer after a replacement renderer's owner is swept. */
    restoreBuiltinRenderer(): void;
}

/**
 * Extracted from Engine: applies plugin declaration fields into engine
 * registries and sweeps them on unload. Keeping this logic in a dedicated
 * class makes the plugin registration lifecycle independently testable
 * and shrinks the Engine God Class.
 */
export class PluginHostHelper {
    constructor(private deps: PluginHostDeps) {}

    /** Get or create the ledger for a plugin owner. */
    ledgerFor(owner: string): PluginLedger {
        let ledger = this.deps.pluginLedgers.get(owner);
        if (!ledger) {
            ledger = { tools: [], generators: [], atoms: [], phases: [] };
            this.deps.pluginLedgers.set(owner, ledger);
        }
        return ledger;
    }

    /** One name, all three hook namespaces (mirrors RenderScriptLoader.loadAll). */
    registerRenderHook(name: string, fn: unknown, owner: string): void {
        this.deps.renderGraph.registerValueScript(name, fn as never, owner);
        this.deps.renderGraph.registerGeometryHook(name, fn as never, owner);
        this.deps.renderGraph.registerComputeHook(name, fn as never, owner);
    }

    /** Merge a plugin's declaration fields into the engine registries. */
    applyDeclarations(id: string, plugin: EnginePlugin, owner: string): void {
        const ledger = this.ledgerFor(owner);
        if (plugin.components) schemaRegistry.registerDefs(plugin.components, owner);
        if (plugin.uniformLayouts) uniformLayouts.load(plugin.uniformLayouts, owner);
        if (plugin.vertexSlots) loadVertexSlots(plugin.vertexSlots, owner);
        if (plugin.vertexInputs) PipelineLoader.mergeVertexInputs(plugin.vertexInputs, owner);
        if (plugin.bindLayouts) resourceManager.loadBindLayouts(plugin.bindLayouts);
        if (plugin.samplers) resourceManager.loadSamplers(plugin.samplers);
        if (plugin.blendPresets) PipelineLoader.mergeBlendPresets(plugin.blendPresets, owner);
        if (plugin.fallbackTextures) resourceManager.loadFallbackTextures(plugin.fallbackTextures);
        if (plugin.vboPresets) resourceManager.loadVboPresets(plugin.vboPresets);
        if (plugin.renderTargets) {
            resourceManager.loadRenderTargets(plugin.renderTargets);
            this.deps.renderGraph.mergeRenderTargets(plugin.renderTargets);
        }
        if (plugin.phases) {
            this.deps.renderGraph.addPhases(plugin.phases);
            for (const p of plugin.phases) ledger.phases.push(p.name);
        }
        if (plugin.meshes) this.registerMeshCatalog(plugin.meshes);
        if (plugin.systemDefs) {
            for (const def of plugin.systemDefs) systemRegistry.addDef(def, owner);
        }
        if (plugin.pipelines) {
            for (const [key, config] of Object.entries(plugin.pipelines)) {
                PipelineLoader.registerVirtualConfig(key.includes(':') ? key : `${id}:${key}`, config);
            }
        }
        if (plugin.shaders) {
            for (const [key, src] of Object.entries(plugin.shaders)) {
                PipelineLoader.registerVirtualShader(key.includes(':') ? key : `${id}:${key}`, src);
            }
        }
        if (plugin.renderHooks) {
            for (const [name, fn] of Object.entries(plugin.renderHooks)) this.registerRenderHook(name, fn, owner);
        }
        if (plugin.meshGenerators) {
            for (const [name, fn] of Object.entries(plugin.meshGenerators)) {
                registerMeshGenerator(name, fn);
                ledger.generators.push(name);
            }
        }
        if (plugin.toolTypes) {
            for (const [name, factory] of Object.entries(plugin.toolTypes)) {
                registerToolType(name, factory);
                ledger.tools.push(name);
            }
        }
        if (plugin.valueAtoms) {
            for (const [ns, atoms] of Object.entries(plugin.valueAtoms)) {
                atomNamespaces[ns] = { ...(atomNamespaces[ns] ?? {}), ...atoms };
                for (const name of Object.keys(atoms)) ledger.atoms.push([ns, name]);
            }
        }
    }

    /** Release everything a plugin registered (called on plugin unload). */
    sweepOwner(owner: string): void {
        resourceManager.exitApp(owner);
        bufferRegistry.exitApp(owner);
        systemRegistry.removeDefsByOwner(owner);
        systemRegistry.removeSystemsByOwner(owner);
        schemaRegistry.removeOwner(owner);
        uniformLayouts.removeOwner(owner);
        removeVertexSlotsByOwner(owner);
        PipelineLoader.removeVirtualsByPrefix(owner.replace(/^plugin:/, '') + ':');
        PipelineLoader.removeInputsByOwner(owner);
        PipelineLoader.removeBlendPresetsByOwner(owner);
        this.deps.renderGraph.removeHooksByOwner(owner);
        this.deps.renderGraph.removePhaseBehaviorsByOwner(owner);
        if (this.deps.customRendererOwner === owner) {
            this.deps.restoreBuiltinRenderer();
        }
        for (const [name, entry] of this.deps.attachments) {
            if (entry.owner === owner) this.deps.deleteAttachment(name);
        }
        const ledger = this.deps.pluginLedgers.get(owner);
        if (ledger) {
            for (const t of ledger.tools) unregisterToolType(t);
            for (const g of ledger.generators) unregisterMeshGenerator(g);
            for (const [ns, name] of ledger.atoms) {
                if (atomNamespaces[ns]) delete atomNamespaces[ns][name];
            }
            if (ledger.phases.length > 0) this.deps.renderGraph.removePhases(ledger.phases);
            this.deps.pluginLedgers.delete(owner);
        }
    }

    /** Build meshes from a catalog (meshes.json or a plugin `meshes` field). */
    registerMeshCatalog(entries: MeshCatalogEntry[]): void {
        for (const entry of entries) {
            const gen = meshGenerators[entry.generator];
            if (!gen) {
                throw new Error(
                    `Mesh catalog entry '${entry.name}' references unknown generator '${entry.generator}' ` +
                    `(available: ${Object.keys(meshGenerators).join(', ')})`,
                );
            }
            const data = gen(entry.params ?? {});
            if (isPbrMeshData(data)) {
                resourceManager.registerPbrMesh(entry.name, data);
            } else {
                resourceManager.registerMesh(entry.name, data);
            }
        }
    }
}

```

## core\ecs\Scene.ts

```ts
import { createWorld, addEntity, removeEntity, type World } from 'bitecs';
import { addComponent, hasComponent, removeComponent } from 'bitecs/legacy';
import { schemaRegistry } from './SchemaRegistry';
import { buildCameraMatricesInto, mat4FromTRSInto, type TRS } from '../math';

export type SceneData = Record<string, Record<string, Record<string, unknown>>>;

/** A resolved camera ready to render: view-projection matrices + its on-screen
 *  viewport rect (normalized x/y/w/h, default full screen). `aspect` is the
 *  camera's own aspect ratio (canvas aspect scaled by viewport w/h). */
export interface CameraView {
    eid: number;
    vp: Float32Array;
    ivp: Float32Array;
    pos: Float32Array;
    view: Float32Array;
    proj: Float32Array;
    viewport: [number, number, number, number];
    aspect: number;
}

export class Scene {
    world: World;
    entityKeyMap = new Map<string, number>();
    entityTags = new Map<number, string[]>();
    /** Per-entity component list (for O(E×avgC) toJSON instead of O(E×C)). */
    private entityComponents = new Map<number, string[]>();
    /** Scratch model matrix — reused by getModelMatrix to avoid per-call
     *  allocation. Safe because callers consume the result before the next
     *  entity's matrix is computed (PipelineDriver processes entities serially). */
    private scratchModel = new Float32Array(16);
    /** Reusable camera pool: pre-allocated CameraView objects with pre-allocated
     *  Float32Array fields, grown as needed. Avoids per-frame allocation in the
     *  getActiveCameras hot path. */
    private cameraPool: CameraView[] = [];
    /** Number of camera pool entries currently populated this frame. */
    private cameraCount = 0;

    constructor() {
        this.world = createWorld();
    }

    createEntity(key: string, data: Record<string, Record<string, unknown>>): number {
        const eid = addEntity(this.world);
        const tags: string[] = [];
        const comps: string[] = [];

        // force NameComponent
        const nc = schemaRegistry.get('NameComponent')!;
        addComponent(this.world, nc, eid);
        schemaRegistry.setAllFields('NameComponent', nc, eid, { name: key });
        comps.push('NameComponent');

        for (const [compName, compData] of Object.entries(data)) {
            const comp = schemaRegistry.get(compName);
            if (!comp) {
                throw new Error(
                    `Entity '${key}': unknown component '${compName}' — ` +
                    `is it declared in components.json (common or the app's)?`,
                );
            }
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, compData);
            comps.push(compName);

            if (schemaRegistry.isRenderTag(compName)) {
                tags.push(compName);
            }
        }

        this.entityKeyMap.set(key, eid);
        this.entityTags.set(eid, tags);
        this.entityComponents.set(eid, comps);
        return eid;
    }

    removeEntity(key: string): void {
        const eid = this.entityKeyMap.get(key);
        if (eid !== undefined) {
            removeEntity(this.world, eid);
            this.entityKeyMap.delete(key);
            this.entityTags.delete(eid);
            this.entityComponents.delete(eid);
        }
    }

    /** Remove all entities. Call before loading a new app so the ECS world is empty. */
    clear(): void {
        for (const key of [...this.entityKeyMap.keys()]) {
            this.removeEntity(key);
        }
        this.entityKeyMap.clear();
        this.entityTags.clear();
    }

    setField(eid: number, compName: string, field: string, value: unknown): void {
        const comp = schemaRegistry.get(compName);
        if (!comp || !hasComponent(this.world, comp, eid)) return;
        schemaRegistry.setComposite(compName, comp, eid, field, value);
    }

    toggleComponent(eid: number, compName: string, enabled: boolean): void {
        if (schemaRegistry.mandatory.has(compName)) return;
        const comp = schemaRegistry.get(compName);
        if (!comp) return;
        const comps = this.entityComponents.get(eid);
        if (enabled && !hasComponent(this.world, comp, eid)) {
            addComponent(this.world, comp, eid);
            schemaRegistry.setAllFields(compName, comp, eid, {});
            if (comps && !comps.includes(compName)) comps.push(compName);
        } else if (!enabled && hasComponent(this.world, comp, eid)) {
            removeComponent(this.world, comp, eid);
            if (comps) {
                const i = comps.indexOf(compName);
                if (i >= 0) comps.splice(i, 1);
            }
        }
    }

    hasTag(eid: number, tag: string): boolean {
        const comp = schemaRegistry.get(tag);
        return comp ? hasComponent(this.world, comp, eid) : false;
    }

    hasComponent(eid: number, compName: string): boolean {
        const comp = schemaRegistry.get(compName);
        return comp ? hasComponent(this.world, comp, eid) : false;
    }

    getField(eid: number, compName: string, field: string): unknown {
        const comp = schemaRegistry.get(compName);
        if (!comp || !hasComponent(this.world, comp, eid)) return undefined;
        return schemaRegistry.getComposite(compName, comp, eid, field);
    }

    getTagColor(eid: number, tag: string): [number, number, number, number] {
        const comp = schemaRegistry.get(tag);
        const field = schemaRegistry.getFieldByRole(tag, 'color');
        if (!comp || !field) return [1, 1, 1, 1];
        return [
            schemaRegistry.getScalarField(tag, comp, eid, field, 0),
            schemaRegistry.getScalarField(tag, comp, eid, field, 1),
            schemaRegistry.getScalarField(tag, comp, eid, field, 2),
            schemaRegistry.getScalarField(tag, comp, eid, field, 3),
        ];
    }

    getTagExtra(eid: number, tag: string): number {
        const comp = schemaRegistry.get(tag);
        const field = schemaRegistry.getFieldByRole(tag, 'extra');
        if (!comp || !field) return 0;
        return schemaRegistry.getScalarField(tag, comp, eid, field, 0);
    }

    getTranslate(eid: number): [number, number] {
        const comp = schemaRegistry.get('Transform')!;
        if (!hasComponent(this.world, comp, eid)) return [0, 0];
        return [
            schemaRegistry.getScalarField('Transform', comp, eid, 'position', 0),
            schemaRegistry.getScalarField('Transform', comp, eid, 'position', 1),
        ];
    }

    getActiveCamera(aspect: number): { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array } | null {
        const cams = this.getActiveCameras(aspect);
        if (cams.length === 0) return null;
        const c = cams[0];
        return { vp: c.vp, ivp: c.ivp, pos: c.pos, view: c.view, proj: c.proj };
    }

    /** Collect every active Camera entity. Multi-view: more than one active
     *  camera is supported — each carries its own on-screen viewport rect
     *  (Camera.viewport, normalized) and a per-camera aspect derived from the
     *  viewport's w/h times the canvas aspect. Insertion order (= scene.json
     *  object order) is preserved, so the first declared camera is the "primary".
     *  Reuses a pre-allocated CameraView pool to avoid per-frame allocation. */
    getActiveCameras(canvasAspect: number): CameraView[] {
        const camComp = schemaRegistry.get('Camera')!;
        this.cameraCount = 0;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, camComp, eid)) continue;
            const active = schemaRegistry.getScalar(camComp, eid, 'active');
            if (active !== 1) continue;
            const fov = schemaRegistry.getScalar(camComp, eid, 'fov');
            const near = schemaRegistry.getScalar(camComp, eid, 'near');
            const far = schemaRegistry.getScalar(camComp, eid, 'far');
            // Viewport rect (normalized). Missing/zero → full screen [0,0,1,1].
            const vw = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 2) || 1;
            const vh = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 3) || 1;
            const vx = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 0) || 0;
            const vy = schemaRegistry.getScalarField('Camera', camComp, eid, 'viewport', 1) || 0;
            const camAspect = canvasAspect * (vw / Math.max(1e-6, vh));
            // Grow the pool lazily — never shrinks (stale entries are harmless
            // because cameraCount bounds the returned slice).
            const idx = this.cameraCount++;
            if (idx >= this.cameraPool.length) {
                this.cameraPool.push({
                    eid: 0,
                    vp: new Float32Array(16), ivp: new Float32Array(16),
                    pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
                    viewport: [0, 0, 1, 1], aspect: 1,
                });
            }
            const cam = this.cameraPool[idx];
            cam.eid = eid;
            cam.viewport[0] = vx; cam.viewport[1] = vy;
            cam.viewport[2] = vw; cam.viewport[3] = vh;
            cam.aspect = camAspect;
            buildCameraMatricesInto(this.getTransformTRS(eid), fov, camAspect, near, far, cam);
        }
        return this.cameraPool.slice(0, this.cameraCount);
    }

    private getTransformTRS(eid: number): TRS {
        const comp = schemaRegistry.get('Transform')!;
        if (!hasComponent(this.world, comp, eid)) {
            return { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
        }
        const f = (field: string, i: number): number =>
            schemaRegistry.getScalarField('Transform', comp, eid, field, i);
        const rx = f('rotation', 0), ry = f('rotation', 1), rz = f('rotation', 2), rw = f('rotation', 3);
        const rLen = Math.hypot(rx, ry, rz, rw) || 1;
        return {
            pos: [f('position', 0), f('position', 1), f('position', 2)],
            rot: [rx / rLen, ry / rLen, rz / rLen, rw / rLen],
            scale: [f('scale', 0), f('scale', 1), f('scale', 2)],
        };
    }

    /** Compute an entity's model matrix. With no `out`, writes into a reusable
     *  scratch buffer (safe for immediate consumption — callers must not retain
     *  the reference across another getModelMatrix call). Pass `out` to write
     *  into a caller-owned buffer for long-lived storage. */
    getModelMatrix(eid: number, out?: Float32Array): Float32Array {
        const trs = this.getTransformTRS(eid);
        return mat4FromTRSInto(trs.pos, trs.rot, trs.scale, out ?? this.scratchModel);
    }

    /** Export every entity's components as JSON. Uses the per-entity component
     *  list (entityComponents) for O(E×avgC) instead of scanning every
     *  registered component per entity (O(E×C)). */
    toJSON(): SceneData {
        const result: SceneData = {};
        for (const [key, eid] of this.entityKeyMap) {
            const entityData: Record<string, Record<string, unknown>> = {};
            const comps = this.entityComponents.get(eid);
            if (comps) {
                for (const compName of comps) {
                    const comp = schemaRegistry.get(compName);
                    if (comp && hasComponent(this.world, comp, eid)) {
                        entityData[compName] = schemaRegistry.readAllFields(compName, comp, eid);
                    }
                }
            }
            result[key] = entityData;
        }
        return result;
    }

    getAllEntities(): { key: string; eid: number; tags: string[] }[] {
        return [...this.entityKeyMap.entries()].map(([key, eid]) => ({
            key, eid,
            tags: this.entityTags.get(eid) ?? [],
        }));
    }

    get componentNames(): string[] {
        return [...schemaRegistry.comps.keys()];
    }

    /** Return the component names registered on a specific entity. */
    getEntityComponentNames(eid: number): string[] {
        return this.entityComponents.get(eid) ?? [];
    }

    getEnvironmentAmbient(): [number, number, number, number] {
        const comp = schemaRegistry.get('EnvironmentComponent')!;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, comp, eid)) continue;
            return [
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 0),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 1),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 2),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'ambientLight', 3),
            ];
        }
        const def = schemaRegistry.getFieldDefault('EnvironmentComponent', 'ambientLight') as number[];
        return [def?.[0] ?? 0, def?.[1] ?? 0, def?.[2] ?? 0, def?.[3] ?? 1];
    }

    getEnvironmentClearColor(): [number, number, number, number] | null {
        const comp = schemaRegistry.get('EnvironmentComponent')!;
        for (const [, eid] of this.entityKeyMap) {
            if (!hasComponent(this.world, comp, eid)) continue;
            return [
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 0),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 1),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 2),
                schemaRegistry.getScalarField('EnvironmentComponent', comp, eid, 'clearColor', 3),
            ];
        }
        return null;
    }
}

```

## core\ecs\SchemaRegistry.ts

```ts
import { defineComponent, Types } from 'bitecs/legacy';

export interface FieldDef {
    type: string;
    default: unknown;
    options?: string[];
    role?: string;
}

export interface ComponentDef {
    name: string;
    mandatory?: boolean;
    fields: Record<string, FieldDef>;
}

const SCALAR_TYPE_MAP: Record<string, number> = {
    f32: Types.f32, i32: Types.i32, u32: Types.ui32, u8: Types.ui8, bool: Types.ui8,
};

const COMPOSITE_EXPAND: Record<string, string[]> = {
    vec2: ['x', 'y'],
    vec3: ['x', 'y', 'z'],
    vec4: ['x', 'y', 'z', 'w'],
};

type ExpandedField = { scalars: string[]; type: string; default: unknown; isString: boolean };

export class SchemaRegistry {
    defs: ComponentDef[] = [];
    comps = new Map<string, object>();
    nameMap = new Map<object, string>();
    mandatory = new Set<string>();

    expandMap = new Map<string, Map<string, ExpandedField>>();
    stringTables = new Map<string, string[]>();
    /** Component name → owner tag ('engine' | 'app:<id>' | 'plugin:<id>'). */
    private owners = new Map<string, string>();

    async load(url: string, owner = 'engine'): Promise<void> {
        const defs = await fetchComponentDefs(url);
        this.defs = [];
        this.register(defs, owner);
    }

    /** Merge additional component definitions (e.g. app-specific) after the base set. */
    async loadMore(url: string, owner = 'engine'): Promise<void> {
        const defs = await fetchComponentDefs(url);
        this.register(defs, owner);
    }

    /** Register component definitions provided programmatically (plugins). */
    registerDefs(defs: ComponentDef[], owner = 'engine'): void {
        this.register(defs, owner);
    }

    /** Remove every component registered by `owner` (app/plugin unload).
     *  Callers must ensure no live entities still carry these components
     *  (the engine clears the scene before sweeping owners). */
    removeOwner(owner: string): void {
        for (const [name, o] of [...this.owners]) {
            if (o !== owner) continue;
            this.owners.delete(name);
            const comp = this.comps.get(name);
            if (comp) this.nameMap.delete(comp);
            this.comps.delete(name);
            this.mandatory.delete(name);
            this.expandMap.delete(name);
            this.defs = this.defs.filter(d => d.name !== name);
            for (const key of [...this.stringTables.keys()]) {
                if (key.startsWith(`${name}.`)) this.stringTables.delete(key);
            }
        }
    }

    private register(defs: ComponentDef[], owner: string): void {
        for (const def of defs) {
            const existing = this.owners.get(def.name);
            if (existing !== undefined) {
                if (existing !== owner) {
                    throw new Error(
                        `Component '${def.name}' already declared by ${existing} (attempted by ${owner})`,
                    );
                }
                continue;   // same-owner re-registration (app reload) → keep original
            }
            this.owners.set(def.name, owner);
            this.defs.push(def);
            if (def.mandatory) this.mandatory.add(def.name);

            const expandFields = new Map<string, ExpandedField>();
            const schema: Record<string, number> = {};

            for (const [logicalName, fd] of Object.entries(def.fields)) {
                if (fd.type === 'string') {
                    const sf = `_str_${logicalName}`;
                    schema[sf] = Types.ui32;
                    expandFields.set(logicalName, { scalars: [sf], type: 'string', default: fd.default, isString: true });
                    this.stringTables.set(`${def.name}.${logicalName}`, []);
                } else if (fd.type in COMPOSITE_EXPAND) {
                    const suffixes = COMPOSITE_EXPAND[fd.type];
                    const scalars = suffixes.map(s => `${logicalName}_${s}`);
                    for (const s of scalars) schema[s] = Types.f32;
                    expandFields.set(logicalName, { scalars, type: fd.type, default: fd.default, isString: false });
                } else {
                    schema[logicalName] = SCALAR_TYPE_MAP[fd.type] ?? Types.f32;
                    expandFields.set(logicalName, { scalars: [logicalName], type: fd.type, default: fd.default, isString: false });
                }
            }

            const comp = defineComponent(schema);
            this.comps.set(def.name, comp);
            this.nameMap.set(comp, def.name);
            this.expandMap.set(def.name, expandFields);
        }
    }

    get(name: string): object | undefined { return this.comps.get(name); }
    getName(comp: object): string | undefined { return this.nameMap.get(comp); }
    getDef(name: string): ComponentDef | undefined { return this.defs.find(d => d.name === name); }

    getStringTable(compName: string, field: string): string[] {
        return this.stringTables.get(`${compName}.${field}`) ?? [];
    }

    allocString(compName: string, field: string, value: string): number {
        const key = `${compName}.${field}`;
        let table = this.stringTables.get(key);
        if (!table) { table = []; this.stringTables.set(key, table); }
        table.push(value);
        return table.length - 1;
    }

    /** Clear every string table (call when the scene is reset so stale strings don't leak). */
    resetStrings(): void {
        for (const table of this.stringTables.values()) {
            table.length = 0;
        }
    }

    /* ── Composite read/write ─────────────────────── */

    getComposite(compName: string, comp: object, eid: number, field: string): unknown {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef) return undefined;
        if (ef.isString) {
            const idx = (comp as any)[ef.scalars[0]]?.[eid];
            const table = this.stringTables.get(`${compName}.${field}`) ?? [];
            return idx != null ? (table[idx] ?? '') : '';
        }
        const arr = ef.scalars.map(s => (comp as any)[s]?.[eid] ?? 0);
        return arr;
    }

    setComposite(compName: string, comp: object, eid: number, field: string, value: unknown): void {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef) return;
        if (ef.isString) {
            const raw = Array.isArray(value) ? value[0] : value;
            const idx = typeof raw === 'number' ? raw : this.allocString(compName, field, String(raw));
            (comp as any)[ef.scalars[0]][eid] = idx;
        } else {
            const vals = Array.isArray(value) ? value : [value];
            const n = Math.min(vals.length, ef.scalars.length);
            for (let i = 0; i < n; i++) (comp as any)[ef.scalars[i]][eid] = Number(vals[i]) ?? 0;
        }
    }

    /* ── Full read / apply ────────────────────────── */

    applyDefaults(compName: string, data: Record<string, unknown>): Record<string, unknown[]> {
        const def = this.getDef(compName);
        if (!def) return {};
        const result: Record<string, unknown[]> = {};
        for (const [key, fd] of Object.entries(def.fields)) {
            const ef = this.expandMap.get(compName)?.get(key);
            if (!ef) continue;
            const dVal = fd.default;
            const v = key in data ? data[key] : (Array.isArray(dVal) ? [...dVal] : dVal);
            if (ef.isString) {
                const s = String(v);
                result[key] = [this.allocString(compName, key, s)];
            } else if (Array.isArray(v)) {
                result[key] = v.map(Number);
            } else {
                result[key] = [Number(v)];
            }
        }
        return result;
    }

    setAllFields(compName: string, comp: object, eid: number, data: Record<string, unknown>): void {
        const applied = this.applyDefaults(compName, data);
        for (const [field, val] of Object.entries(applied)) {
            this.setComposite(compName, comp, eid, field, val);
        }
    }

    readAllFields(compName: string, comp: object, eid: number): Record<string, unknown> {
        const def = this.getDef(compName);
        if (!def) return {};
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(def.fields)) {
            result[key] = this.getComposite(compName, comp, eid, key);
        }
        return result;
    }

    getFieldDefs(compName: string): [string, FieldDef][] {
        const def = this.getDef(compName);
        return def ? Object.entries(def.fields) : [];
    }

    getFieldDefault(compName: string, field: string): unknown {
        return this.getDef(compName)?.fields[field]?.default;
    }

    /* ── Field roles (render tag metadata) ────────── */

    /** First field name in a component tagged with the given role, or undefined. */
    getFieldByRole(compName: string, role: string): string | undefined {
        const def = this.getDef(compName);
        if (!def) return undefined;
        for (const [name, fd] of Object.entries(def.fields)) {
            if (fd.role === role) return name;
        }
        return undefined;
    }

    /** A component is a render tag if any of its fields declares a role. */
    isRenderTag(compName: string): boolean {
        const def = this.getDef(compName);
        if (!def) return false;
        return Object.values(def.fields).some(fd => fd.role != null);
    }

    /* ── Scalar access for renderer ───────────────── */

    getScalar(comp: object, eid: number, scalarName: string): number {
        return (comp as any)[scalarName]?.[eid] ?? 0;
    }

    getScalarField(compName: string, comp: object, eid: number, field: string, index: number): number {
        const ef = this.expandMap.get(compName)?.get(field);
        if (!ef || index >= ef.scalars.length) return 0;
        return (comp as any)[ef.scalars[index]]?.[eid] ?? 0;
    }

    getScalarNames(compName: string, field: string): string[] {
        return this.expandMap.get(compName)?.get(field)?.scalars ?? [];
    }
}

/** Fetch a component-defs JSON file, failing loud on 404 / Vite SPA-fallback HTML. */
async function fetchComponentDefs(url: string): Promise<ComponentDef[]> {
    const resp = await fetch(url);
    const ct = resp.headers.get('content-type') ?? '';
    if (!resp.ok || !(ct.includes('json') || ct.includes('application'))) {
        throw new Error(`Component schema not found: ${url}`);
    }
    return await resp.json() as ComponentDef[];
}

export const schemaRegistry = new SchemaRegistry();

```

## core\ecs\SystemRegistry.ts

```ts
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

```

## core\events\EventBus.ts

```ts
export type EventHandler = (payload: unknown) => void;

export class EventBus {
    private handlers = new Map<string, Set<EventHandler>>();

    on(type: string, handler: EventHandler): () => void {
        let set = this.handlers.get(type);
        if (!set) { set = new Set(); this.handlers.set(type, set); }
        set.add(handler);
        return () => set!.delete(handler);
    }

    emit(type: string, payload?: unknown): void {
        const set = this.handlers.get(type);
        if (!set) return;
        for (const h of set) h(payload);
    }

    /** Remove all handlers (call when the scene is reset so stale script handlers don't linger). */
    clear(): void {
        this.handlers.clear();
    }
}

```

## core\events\eventTypes.ts

```ts
/** Centralized event type constants. Single source of truth for engine-internal events. */
export const EVENT_TYPES = {
    MOUSE_MOVE: 'mousemove',
    MOUSE_DOWN: 'mousedown',
    MOUSE_UP: 'mouseup',
    WHEEL: 'wheel',
    COLLISION: 'collision',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

```

## core\gltf\GltfLoader.ts

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Vector3, Quaternion, Texture as ThreeTexture } from 'three';
import type { Mesh, MeshStandardMaterial, BufferGeometry, Object3D } from 'three';
import type { PbrMeshData } from '../render/Primitives';
import type { PbrMaterialData, GltfTextureData, GltfPrimitiveResult, GltfNodeResult } from './GltfTypes';

function extractGeometry(geometry: BufferGeometry): PbrMeshData {
    const posAttr = geometry.getAttribute('position');
    const normAttr = geometry.getAttribute('normal');
    const uvAttr = geometry.getAttribute('uv');
    const tanAttr = geometry.getAttribute('tangent');
    const index = geometry.index;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const indices: number[] = [];

    if (posAttr) {
        positions.push(...posAttr.array);
    }
    if (normAttr) {
        normals.push(...normAttr.array);
    }
    if (uvAttr) {
        uvs.push(...uvAttr.array);
    }
    if (tanAttr) {
        tangents.push(...tanAttr.array);
    } else {
        const vc = posAttr?.count ?? 0;
        for (let i = 0; i < vc; i++) tangents.push(1, 0, 0, 1);
    }
    if (index) {
        indices.push(...index.array);
    } else {
        const vertexCount = posAttr?.count ?? 0;
        for (let i = 0; i < vertexCount; i++) indices.push(i);
    }

    return { positions, normals, uvs, tangents, indices };
}

function debugLogMesh(data: PbrMeshData, name: string): void {
    console.log(`[GLTF] ${name}: pos[0..2]=${data.positions.slice(0, 3)} nrm[0..2]=${data.normals.slice(0, 3)} uv[0..1]=${data.uvs.slice(0, 2)} idx[0..2]=${data.indices.slice(0, 3)}`);
    console.log(`[GLTF] ${name}: uv min/max = (${Math.min(...data.uvs)}, ${Math.max(...data.uvs)})`);
}

function extractMaterial(mat: MeshStandardMaterial): PbrMaterialData {
    return {
        name: mat.name || 'PbrMaterial',
        baseColorFactor: [mat.color.r, mat.color.g, mat.color.b, mat.opacity],
        metallicFactor: mat.metalness,
        roughnessFactor: mat.roughness,
        emissiveFactor: [mat.emissive.r, mat.emissive.g, mat.emissive.b],
        aoStrength: 1.0,
        alphaCutoff: mat.alphaTest,
        alphaMode: mat.transparent ? 'BLEND' : 'OPAQUE',
    };
}

function getTextureImage(tex: ThreeTexture | null): ImageBitmap | HTMLImageElement | HTMLCanvasElement | null {
    if (!tex) return null;
    const img = tex.image;
    if (img instanceof ImageBitmap || img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
        return img;
    }
    return null;
}

export class GltfLoader {
    private loader: GLTFLoader;

    constructor() {
        this.loader = new GLTFLoader();
    }

    async load(url: string): Promise<{
        primitives: GltfPrimitiveResult[];
        nodes: GltfNodeResult[];
        textures: GltfTextureData[];
    }> {
        const gltf = await this.loader.loadAsync(url);
        const primitives: GltfPrimitiveResult[] = [];
        const nodes: GltfNodeResult[] = [];
        const textureMap = new Map<string, GltfTextureData>();
        const textureKeyMap = new Map<ThreeTexture, string>();

        function registerTexture(tex: ThreeTexture | null | undefined, suffix: string, isSRGB: boolean): string | undefined {
            if (!tex) return undefined;
            const existing = textureKeyMap.get(tex);
            if (existing) return existing;
            const img = getTextureImage(tex);
            if (!img) return undefined;
            const key = `gltf_tex_${textureMap.size}_${suffix}`;
            textureKeyMap.set(tex, key);
            textureMap.set(key, { key, image: img, sRGB: isSRGB });
            return key;
        }

        gltf.scene.traverse((obj: Object3D) => {
            const mesh = obj as Mesh;
            if (!mesh.isMesh) return;

            const geometry = mesh.geometry as BufferGeometry;
            const material = mesh.material as MeshStandardMaterial;

            const meshData = extractGeometry(geometry);
            const matData = extractMaterial(material);
            const matName = mesh.name || matData.name || `mesh_${primitives.length}`;
            debugLogMesh(meshData, matName);

            const tc = registerTexture(material.map, 'baseColor', true);
            const tm = registerTexture(material.roughnessMap || material.metalnessMap, 'metalRough', false);
            const tn = registerTexture(material.normalMap, 'normal', false);
            const to = registerTexture(material.aoMap, 'occlusion', false);
            const te = registerTexture(material.emissiveMap, 'emissive', true);

            primitives.push({
                name: matName,
                meshData,
                material: matData,
                baseColorTexture: tc,
                metallicRoughnessTexture: tm,
                normalTexture: tn,
                occlusionTexture: to,
                emissiveTexture: te,
            });

            const wPos = new Vector3();
            const wQuat = new Quaternion();
            const wScale = new Vector3();
            mesh.getWorldPosition(wPos);
            mesh.getWorldQuaternion(wQuat);
            mesh.getWorldScale(wScale);

            nodes.push({
                name: obj.name || matName,
                transform: {
                    position: [wPos.x, wPos.y, wPos.z],
                    rotation: [wQuat.x, wQuat.y, wQuat.z, wQuat.w],
                    scale: [wScale.x, wScale.y, wScale.z],
                },
                meshName: matName,
            });
        });

        return { primitives, nodes, textures: [...textureMap.values()] };
    }
}

```

## core\gltf\GltfTypes.ts

```ts
import type { PbrMeshData } from '../render/Primitives';

export interface PbrMaterialData {
    name: string;
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
    emissiveFactor: [number, number, number];
    aoStrength: number;
    alphaCutoff: number;
    alphaMode: string;
}

export interface GltfTextureData {
    key: string;
    image: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
    sRGB: boolean;
}

export interface GltfPrimitiveResult {
    name: string;
    meshData: PbrMeshData;
    material: PbrMaterialData;
    baseColorTexture?: string;
    metallicRoughnessTexture?: string;
    normalTexture?: string;
    occlusionTexture?: string;
    emissiveTexture?: string;
}

export interface GltfNodeResult {
    name: string;
    transform: {
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
    };
    meshName: string;
}

```

## core\plugins\Plugin.ts

```ts
import type { ComponentDef } from '../ecs/SchemaRegistry';
import type { Scene } from '../ecs/Scene';
import type { System, SystemDef } from '../ecs/SystemRegistry';
import type { EventBus } from '../events/EventBus';
import type { EngineConfig } from '../Engine';
import type { UniformLayoutDecls } from '../render/UniformLayout';
import type { VertexSlotDecls } from '../render/vertexSlots';
import type {
    PipelineConfig,
    ComputePipelineConfig,
    PhaseDecl,
    PhaseBehavior,
    VertexInputDecls,
    BindLayoutDecls,
    SamplerDecls,
    IRenderer,
} from '../render/types';
import type { RenderTargetDecls } from '../render/rendererDecl';
import type { GeometryHook, ComputeHook } from '../render/PipelineDriver';
import type { ValueContext, AtomResolver } from '../render/valueResolver';
import type { MeshGenerator } from '../render/Primitives';
import type { ToolFactory } from '../tools/ToolRegistry';

/** Identity + dependency declaration of a plugin. `id` must equal the plugin's
 *  folder name under the plugins root (fail-loud checked at load). */
export interface PluginMeta {
    id: string;
    dependencies?: string[];
}

/** A value-source hook (JSON `script:<name>` in uniform writes). */
export type ValueHook = (ctx: ValueContext) => number | number[];

/** One entry of the plugin `meshes` catalog (same shape as meshes.json). */
export interface MeshCatalogEntry {
    name: string;
    generator: string;
    params?: Record<string, number>;
}

export type FallbackTextureDecls = Record<string, { pixel: number[]; format: GPUTextureFormat }>;
export type VboPresetDecls = Record<string, { data: number[]; format: string; stride: number }>;

/**
 * Everything a plugin behavior may touch. Mechanism singletons are also
 * importable from '@shaderlab/api'; the ctx carries the per-plugin identity
 * (baseUrl) and the owner-tracked registration surface — registrations made
 * through the ctx are swept automatically when the plugin unloads.
 */
export interface PluginContext {
    device: GPUDevice;
    scene: Scene;
    eventBus: EventBus;
    engineConfig: EngineConfig;
    /** The render canvas (input listeners, aspect computation). */
    canvas: HTMLCanvasElement;
    /** '/plugins/<id>' — base for fetching co-located assets. */
    baseUrl: string;
    /** The active renderer (built-in RenderGraph unless replaced). */
    renderer: IRenderer;

    /** Register a frame system under `name` (referenced by systems.json). */
    registerSystem(name: string, sys: System): void;
    /** Publish an opaque object for hooks / other plugins (e.g. 'particles'). */
    registerAttachment(name: string, obj: unknown): void;
    /** Register a render escape-hatch hook addressable as `script:<name>`
     *  (value / geometry / compute — same name space as renderScripts). */
    registerRenderHook(name: string, fn: GeometryHook | ComputeHook | ValueHook): void;
    /** Register a pass-execution strategy (phases.json `behavior` names it). */
    registerPhaseBehavior(name: string, behavior: PhaseBehavior): void;
    registerMeshGenerator(name: string, fn: MeshGenerator): void;
    registerToolType(name: string, factory: ToolFactory): void;
    registerValueAtoms(ns: string, atoms: Record<string, AtomResolver>): void;
    /** Renderer seam: replace the whole renderer (rare; see IRenderer). */
    replaceRenderer(renderer: IRenderer): void;

    /** Cross-plugin collaboration: look up a system registered by any plugin.
     *  Contract is structural — declare a local interface for what you need. */
    getSystem<T = System>(name: string): T | null;
    /** Direct access to another loaded plugin instance (declare it in deps). */
    getPlugin<T extends EnginePlugin = EnginePlugin>(id: string): T | null;
}

/**
 * Base class for every plugin (public/plugins/<id>/index.ts default export).
 *
 * Declaration fields are plain data merged into the engine registries when the
 * plugin loads (owner-tagged; cross-plugin name conflicts throw). They may be
 * TS literals or filled from co-located JSON in `init()` (fetch relative to
 * `ctx.baseUrl`) — author's choice.
 *
 * Lifecycle (all optional):
 *   init(ctx)          before declarations are applied — fetch/fill decl fields
 *   setup(ctx)         declarations applied, dependencies set up — create
 *                      System/Manager instances, ctx.registerSystem(...)
 *   appLoaded(ctx, appBase)   an app finished loading (scene + render graph)
 *   appUnloading(ctx)  the current app is about to unload
 *   teardown(ctx)      the plugin itself unloads (registries are swept by
 *                      owner automatically; release everything else here)
 */
export abstract class EnginePlugin {
    abstract readonly meta: PluginMeta;

    /* ── declarations (all optional) ── */
    components?: ComponentDef[];
    uniformLayouts?: UniformLayoutDecls;
    bindLayouts?: BindLayoutDecls;
    vertexSlots?: VertexSlotDecls;
    vertexInputs?: VertexInputDecls;
    samplers?: SamplerDecls;
    blendPresets?: Record<string, GPUBlendState>;
    fallbackTextures?: FallbackTextureDecls;
    vboPresets?: VboPresetDecls;
    meshes?: MeshCatalogEntry[];
    renderTargets?: RenderTargetDecls;
    phases?: PhaseDecl[];
    /** System metadata (ubos/buffers/needs) consumed by BufferRegistry;
     *  the implementation is registered in setup() via ctx.registerSystem. */
    systemDefs?: SystemDef[];
    /** Pipelines under virtual paths: key '<id>:<name>' or plain '<name>'
     *  (auto-prefixed with '<id>:'). */
    pipelines?: Record<string, PipelineConfig | ComputePipelineConfig>;
    /** WGSL sources for virtual pipeline shader refs (same key convention). */
    shaders?: Record<string, string>;
    renderHooks?: Record<string, GeometryHook | ComputeHook | ValueHook>;
    meshGenerators?: Record<string, MeshGenerator>;
    toolTypes?: Record<string, ToolFactory>;
    valueAtoms?: Record<string, Record<string, AtomResolver>>;

    /* ── lifecycle (all optional) ── */
    init?(ctx: PluginContext): void | Promise<void>;
    setup?(ctx: PluginContext): void | Promise<void>;
    appLoaded?(ctx: PluginContext, appBase: string): void | Promise<void>;
    appUnloading?(ctx: PluginContext): void;
    teardown?(ctx: PluginContext): void;
}

```

## core\plugins\PluginManager.ts

```ts
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
    return import.meta.env.DEV
        ? `${location.origin}/src/api.ts`
        : `${location.origin}/assets/engine-api.js`;
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
        } catch (err) {
            // Two-phase rollback: if init/applyDeclarations/setup threw, sweep
            // everything this plugin registered so far (schemas, uniforms,
            // pipelines, hooks, tools, atoms, attachments, …) to prevent
            // half-initialized state from leaking to dependent plugins.
            this.host.sweepOwner(pluginOwner(id));
            throw new Error(`Plugin '${id}' failed to load: ${err}`);
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

```

## core\render\BufferRegistry.ts

```ts
import { uniformLayouts } from './UniformLayout';
import { systemRegistry, type SystemBufferDecl } from '../ecs/SystemRegistry';

/** @deprecated use SystemBufferDecl from SystemRegistry — re-exported for back-compat. */
export type { SystemBufferDecl } from '../ecs/SystemRegistry';

const USAGE_FLAGS: Record<string, GPUBufferUsageFlags> = {
    uniform: GPUBufferUsage.UNIFORM,
    storage: GPUBufferUsage.STORAGE,
    vertex: GPUBufferUsage.VERTEX,
    index: GPUBufferUsage.INDEX,
    copy_src: GPUBufferUsage.COPY_SRC,
    copy_dst: GPUBufferUsage.COPY_DST,
    indirect: GPUBufferUsage.INDIRECT,
    'read-only-storage': GPUBufferUsage.STORAGE, // TS enum has no READ_ONLY_STORAGE; mapped below
};

const READ_ONLY_STORAGE = 0x00000080; // GPUBufferUsage.READ_ONLY_STORAGE (1 << 7)

/**
 * Module-singleton registry of named GPU buffers (UBOs + storage buffers)
 * declared by system defs. Replaces the implicit hardcoded UBO getters in
 * ResourceManager: a user can now declare `"buffers": [{"name":"mySsbo","size":4096}]`
 * in any system.json and reference it from bind-layouts.json via
 * `"resource": "mySsbo"` — no TS change required.
 *
 * Allocation: Engine.loadApp calls `allocateFor(activeSystems, appId, device)`
 * to allocate every app-scoped buffer declared by the active systems' defs;
 * `unloadCurrentApp` calls `exitApp(appId)` to release them. Common-scoped
 * buffers persist across app switches.
 *
 * Step 3 scope: only newly-declared buffers go through the registry. The four
 * legacy engine UBOs (camera/light/timeInput/pointShadowFaces) are migrated in
 * Step 4 (their ResourceManager getters will delegate here).
 */
class BufferRegistry {
    private buffers = new Map<string, GPUBuffer>();
    private owners = new Map<string, string>();

    /** Allocate every buffer declared by `systems`' defs.
     *  - `appId`: 'common' for engine-lifetime buffers (allocated once at init);
     *            any other string for app-scoped buffers (released on app switch).
     *  Idempotent: re-listing an already-allocated buffer is a no-op. */
    allocateFor(systems: { name: string }[], appId: string, device: GPUDevice): void {
        for (const entry of systems) {
            const def = systemRegistry.getDef(entry.name);
            if (!def) continue;
            // UBOs: name matches a uniform-layouts.json entry; layout = same name.
            // A UBO whose layout isn't declared is skipped with a warning — the
            // owning system is expected to allocate it itself (e.g. dynamic-size
            // UBOs like the splat model UBO built by GaussianSplatManager).
            for (const uboName of def.ubos ?? []) {
                if (!uniformLayouts.has(uboName)) {
                    console.warn(
                        `[BufferRegistry] system '${entry.name}' declares ubo '${uboName}' ` +
                        `but no such layout in uniform-layouts.json — skipping (system must allocate it itself)`,
                    );
                    continue;
                }
                this.ensure({
                    name: uboName,
                    layout: uboName,
                    scope: 'app',
                    usage: ['uniform', 'copy_dst'],
                }, appId, device);
            }
            // Storage / other buffers: explicit decl with size/layout/usage.
            // String entries (instead of objects) are skipped with a warning —
            // dynamic-size storage buffers (e.g. splat centers/colors) can't be
            // statically allocated from a def and must be created at runtime.
            for (const bufDecl of def.buffers ?? []) {
                if (typeof bufDecl === 'string') {
                    console.warn(
                        `[BufferRegistry] system '${entry.name}' declares buffer '${bufDecl}' ` +
                        `as a string — storage buffers need a {name,size,...} object decl; skipping`,
                    );
                    continue;
                }
                this.ensure(bufDecl, appId, device);
            }
        }
    }

    /** Idempotent buffer allocation from a decl. Skips if already allocated. */
    private ensure(decl: SystemBufferDecl, appId: string, device: GPUDevice): void {
        if (this.buffers.has(decl.name)) return;
        const size = this.resolveSize(decl);
        if (size <= 0) throw new Error(`Buffer '${decl.name}' has zero size (need size|layout[+count])`);
        const usage = this.resolveUsage(decl);
        const buf = device.createBuffer({ label: decl.name, size, usage });
        this.buffers.set(decl.name, buf);
        this.owners.set(decl.name, decl.scope === 'common' ? 'common' : appId);
    }

    private resolveSize(decl: SystemBufferDecl): number {
        if (decl.size) return decl.size * (decl.count ?? 1);
        if (decl.layout) {
            const layout = uniformLayouts.get(decl.layout);
            return layout.byteSize * (decl.count ?? 1);
        }
        return 0;
    }

    private resolveUsage(decl: SystemBufferDecl): GPUBufferUsageFlags {
        const names = decl.usage ?? (decl.layout ? ['uniform', 'copy_dst'] : ['storage', 'copy_dst']);
        let flags = 0;
        for (const n of names) {
            if (n === 'read-only-storage') flags |= READ_ONLY_STORAGE;
            else flags |= USAGE_FLAGS[n] ?? 0;
        }
        return flags;
    }

    /** Get an allocated buffer by name (throws if not declared/allocated). */
    get(name: string): GPUBuffer {
        const buf = this.buffers.get(name);
        if (!buf) throw new Error(`Buffer '${name}' not declared in any system def`);
        return buf;
    }

    /** True if the named buffer is currently allocated. */
    has(name: string): boolean {
        return this.buffers.has(name);
    }

    /** Write data into a named buffer (queue.writeBuffer wrapper). */
    write(name: string, device: GPUDevice, data: BufferSource, offset = 0): void {
        device.queue.writeBuffer(this.get(name), offset, data);
    }

    /** Release all app-scoped buffers owned by `appId`. Common-scoped buffers stay. */
    exitApp(appId: string): void {
        for (const [name, owner] of this.owners) {
            if (owner !== appId) continue;
            this.buffers.get(name)?.destroy();
            this.buffers.delete(name);
            this.owners.delete(name);
        }
    }
}

export const bufferRegistry = new BufferRegistry();

```

## core\render\phaseBehaviors.ts

```ts
import { resourceManager } from './ResourceManager';
import type { PhaseBehavior, PhaseBehaviorContext } from './types';

/**
 * Default pass-execution strategies shipped with the engine, registered through
 * the same public registry plugins use (RenderGraph.registerPhaseBehavior) —
 * no special-cased dispatch. Their sources move into the owning plugins in
 * migration Phase C; the registry keeps working unchanged.
 */

/** Structural contract for the shadow behavior's light-system dependency. */
interface ShadowPassProvider {
    shadowPassList: Array<{ view: GPUTextureView; lightIdx: number; face: number }>;
}

/** 'normal': merge enabled drivers by (color,depth) target and record. */
export const normalBehavior: PhaseBehavior = {
    perCamera: true,
    run: (ctx: PhaseBehaviorContext): void => ctx.runDefault(),
};

/** 'shadow-clear': one depth-only pass per (light, face) from the light
 *  system's shadowPassList. Faces are cleared even when the shadow pipeline
 *  is disabled, so stale depth never leaks into lighting. */
export const shadowClearBehavior: PhaseBehavior = {
    perCamera: false,
    run(ctx: PhaseBehaviorContext): void {
        const light = ctx.getSystem<ShadowPassProvider>('light');
        const passes = light?.shadowPassList ?? [];
        if (passes.length === 0) return;
        const driver = ctx.drivers.find(d => d.entry.enabled);
        const pipeline = driver ? ctx.pipelineFor(driver) : undefined;
        if (driver && !pipeline) {
            throw new Error(`Shadow pipeline '${driver.path}' was not compiled`);
        }
        for (let i = 0; i < passes.length; i++) {
            const p = passes[i];
            const pass = ctx.encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: p.view,
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                },
            });
            if (pipeline && driver) {
                // Per-face selector {lightIdx, face} for the shadow-depth vertex shader.
                pass.setBindGroup(2, resourceManager.shadowPassBindGroup(i, p.lightIdx, p.face));
                driver.record(pass, ctx.scene, pipeline, ctx.frame);
            }
            pass.end();
        }
    },
};

/** 'postprocess-chain': fullscreen ping-pong chain. First enabled pass reads
 *  'scene', last writes 'screen', middle passes alternate transient targets. */
export const postProcessChainBehavior: PhaseBehavior = {
    perCamera: false,
    run(ctx: PhaseBehaviorContext): void {
        const drivers = ctx.drivers.filter(d => d.entry.enabled);
        if (drivers.length === 0) return;
        const transients = ctx.transientTargets();
        let prevOutput = 'scene';
        for (let i = 0; i < drivers.length; i++) {
            const last = i === drivers.length - 1;
            const entry = drivers[i].entry;
            const input = prevOutput;
            const output = last
                ? 'screen'
                : transients.find(t => t !== input) ?? 'ppB';
            const srcView = input === 'scene' && ctx.sceneIsScreen
                ? ctx.swapView
                : resourceManager.namedColorTargetView(input, ctx.cw, ctx.ch, ctx.format);
            const dstView = output === 'screen'
                ? ctx.swapView
                : resourceManager.namedColorTargetView(output, ctx.cw, ctx.ch, ctx.format);
            const pipeline = ctx.pipelineFor(drivers[i]);
            if (!pipeline) throw new Error(`Post-process pipeline '${drivers[i].path}' was not compiled`);

            const pass = ctx.encoder.beginRenderPass({
                colorAttachments: [{ view: dstView, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, resourceManager.fullscreenBindGroup(srcView, entry));
            pass.draw(3);
            pass.end();
            prevOutput = output;
        }
    },
};

```

## core\render\PipelineDriver.ts

```ts
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

```

## core\render\PipelineLoader.ts

```ts
import { resourceManager } from './ResourceManager';
import { VERTEX_SLOTS, type SlotName } from './vertexSlots';
import type {
    PipelineConfig,
    ComputePipelineConfig,
    ComputeMeta,
    VertexInputDecls,
    BlendPreset,
} from './types';

function resolvePath(base: string, relative: string): string {
    const stack = base.split('/').filter(Boolean);
    for (const seg of relative.split('/')) {
        if (seg === '..') { if (stack.length > 0) stack.pop(); }
        else if (seg !== '.') { stack.push(seg); }
    }
    return '/' + stack.join('/');
}

/** Join a relative shader ref onto a relative dir (no leading slash). */
function joinRel(dir: string, relative: string): string {
    const stack = dir.split('/').filter(Boolean);
    for (const seg of relative.split('/')) {
        if (seg === '..') { if (stack.length > 0) stack.pop(); }
        else if (seg !== '.') { stack.push(seg); }
    }
    return stack.join('/');
}

function dirOf(path: string): string {
    return path.substring(0, path.lastIndexOf('/') + 1);
}

/** Where a pipeline's shader refs resolve from: a URL dir, or a plugin's
 *  virtual namespace (in-memory `shaders` declarations with file fallback). */
type ShaderBase =
    | { kind: 'url'; dir: string }
    | { kind: 'virtual'; plugin: string; dir: string };

/** Build one GPUVertexBufferLayout per SoA slot from a named vertex-input decl. */
function buildSlotLayouts(slots: SlotName[]): GPUVertexBufferLayout[] {
    return slots.map(slot => {
        const def = VERTEX_SLOTS[slot];
        return {
            arrayStride: def.stride,
            stepMode: 'vertex' as GPUVertexStepMode,
            attributes: [{ format: def.format, offset: 0, shaderLocation: def.location }],
        };
    });
}

export class PipelineLoader {
    private static vertexInputs: VertexInputDecls = {};
    private static vertexInputOwners = new Map<string, string>();
    private static pipelineSlots = new Map<string, SlotName[]>();
    private static configs = new Map<string, { config: PipelineConfig; format: GPUTextureFormat }>();
    private static shaderModules = new Map<string, GPUShaderModule>();
    private static computeMeta = new Map<string, ComputeMeta>();
    /** In-memory pipeline configs declared by plugins ('<plugin>:<name>' keys). */
    private static virtualConfigs = new Map<string, PipelineConfig | ComputePipelineConfig>();
    /** In-memory WGSL sources declared by plugins ('<plugin>:<relpath>' keys). */
    private static virtualShaders = new Map<string, string>();
    private static blendPresetOwners = new Map<string, string>();
    /** Engine-wide default workgroup size, set from engine-config.json. */
    static defaultWorkgroupSize = 64;
    /** Plugins root URL (from engine-config.json), for '<plugin>:<path>' refs. */
    static pluginsRoot = '/plugins';
    /** Blend presets loaded from blend-presets.json. */
    static blendPresets: Record<string, GPUBlendState> = {};

    static setVertexInputs(decls: VertexInputDecls): void {
        this.vertexInputs = decls;
        this.vertexInputOwners.clear();
        for (const name of Object.keys(decls)) this.vertexInputOwners.set(name, 'engine');
    }

    /** Merge additional vertex inputs (plugins). Cross-owner duplicates throw. */
    static mergeVertexInputs(decls: VertexInputDecls, owner = 'engine'): void {
        for (const [name, decl] of Object.entries(decls)) {
            const existing = this.vertexInputOwners.get(name);
            if (existing !== undefined && existing !== owner) {
                throw new Error(`Vertex input '${name}' already declared by ${existing} (attempted by ${owner})`);
            }
            this.vertexInputOwners.set(name, owner);
            this.vertexInputs[name] = decl;
        }
    }

    /** Drop vertex inputs registered by `owner` (plugin unload). */
    static removeInputsByOwner(owner: string): void {
        for (const [name, o] of [...this.vertexInputOwners]) {
            if (o !== owner) continue;
            this.vertexInputOwners.delete(name);
            delete this.vertexInputs[name];
        }
    }

    static loadBlendPresets(decls: Record<string, GPUBlendState>): void {
        this.blendPresets = decls;
        this.blendPresetOwners.clear();
        for (const name of Object.keys(decls)) this.blendPresetOwners.set(name, 'engine');
    }

    /** Merge additional blend presets (plugins). Cross-owner duplicates throw. */
    static mergeBlendPresets(decls: Record<string, GPUBlendState>, owner = 'engine'): void {
        for (const [name, decl] of Object.entries(decls)) {
            const existing = this.blendPresetOwners.get(name);
            if (existing !== undefined && existing !== owner) {
                throw new Error(`Blend preset '${name}' already declared by ${existing} (attempted by ${owner})`);
            }
            this.blendPresetOwners.set(name, owner);
            this.blendPresets[name] = decl;
        }
    }

    /** Drop blend presets registered by `owner` (plugin unload). */
    static removeBlendPresetsByOwner(owner: string): void {
        for (const [name, o] of [...this.blendPresetOwners]) {
            if (o !== owner) continue;
            this.blendPresetOwners.delete(name);
            delete this.blendPresets[name];
        }
    }

    /** Register an in-memory pipeline config under a virtual path (plugins). */
    static registerVirtualConfig(path: string, config: PipelineConfig | ComputePipelineConfig): void {
        if (this.virtualConfigs.has(path)) throw new Error(`Virtual pipeline '${path}' already registered`);
        this.virtualConfigs.set(path, config);
    }

    /** Register an in-memory WGSL source under a virtual path (plugins). */
    static registerVirtualShader(path: string, src: string): void {
        if (this.virtualShaders.has(path)) throw new Error(`Virtual shader '${path}' already registered`);
        this.virtualShaders.set(path, src);
    }

    /** Drop virtual configs/shaders + retained state for a plugin prefix (unload). */
    static removeVirtualsByPrefix(prefix: string): void {
        for (const key of [...this.virtualConfigs.keys()]) {
            if (key.startsWith(prefix)) {
                this.virtualConfigs.delete(key);
                this.configs.delete(key);
                this.computeMeta.delete(key);
                this.pipelineSlots.delete(key);
            }
        }
        for (const key of [...this.virtualShaders.keys()]) {
            if (key.startsWith(prefix)) this.virtualShaders.delete(key);
        }
        for (const key of [...this.shaderModules.keys()]) {
            if (key.startsWith(`virtual:${prefix}`)) this.shaderModules.delete(key);
        }
    }

    /** All declared blend preset names (keys of blend-presets.json). */
    static get blendPresetNames(): string[] {
        return Object.keys(this.blendPresets);
    }

    static resolveBlend(blend: PipelineConfig['blend']): GPUBlendState | undefined {
        if (!blend) return undefined;
        if (typeof blend === 'string') return this.blendPresets[blend as BlendPreset];
        return blend;
    }

    /** SoA slot order used by a pipeline's vertex-input, for buffer binding. */
    static getSlots(configPath: string): SlotName[] | undefined {
        return this.pipelineSlots.get(configPath);
    }

    /** Retained compute metadata (workgroup size, bindings) for a loaded compute pipeline. */
    static getComputeMeta(configPath: string): ComputeMeta | undefined {
        return this.computeMeta.get(configPath);
    }

    /** Retained parsed config for a loaded render pipeline (for live editing). */
    static getConfig(configPath: string): PipelineConfig | undefined {
        return this.configs.get(configPath)?.config;
    }

    /** '<plugin>:rest' → parts, or null for URL/relative paths. */
    static pluginRef(path: string): { plugin: string; rest: string } | null {
        const m = /^([A-Za-z0-9_-]+):(?!\/)(.+)$/.exec(path);
        return m ? { plugin: m[1], rest: m[2] } : null;
    }

    /** Resolve a config path to a fetchable URL (plugin-prefixed, absolute, or baseDir-relative). */
    private static configUrl(baseDir: string, configPath: string): string {
        const ref = this.pluginRef(configPath);
        if (ref) return `${this.pluginsRoot}/${ref.plugin}/${ref.rest}`;
        return configPath.startsWith('/') ? configPath : `${baseDir}/${configPath}`;
    }

    private static shaderBaseFor(baseDir: string, configPath: string): ShaderBase {
        const ref = this.pluginRef(configPath);
        if (ref) {
            if (this.virtualConfigs.has(configPath)) {
                return { kind: 'virtual', plugin: ref.plugin, dir: dirOf(ref.rest) };
            }
            return { kind: 'url', dir: `${this.pluginsRoot}/${ref.plugin}/${dirOf(ref.rest)}` };
        }
        const configDir = dirOf(configPath);
        return { kind: 'url', dir: configPath.startsWith('/') ? configDir : `${baseDir}/${configDir}` };
    }

    /** Canonical shader-module cache key for a shader ref against a base. */
    private static shaderKey(base: ShaderBase, shaderRef: string): string {
        if (base.kind === 'virtual') {
            return `virtual:${base.plugin}:${joinRel(base.dir, shaderRef)}`;
        }
        return resolvePath(base.dir, shaderRef);
    }

    /** Fetch (or look up in the virtual registry) a shader's WGSL source. */
    private static async shaderSource(base: ShaderBase, shaderRef: string): Promise<string> {
        if (base.kind === 'virtual') {
            const rel = joinRel(base.dir, shaderRef);
            const inline = this.virtualShaders.get(`${base.plugin}:${rel}`);
            if (inline !== undefined) return inline;
            const url = `${this.pluginsRoot}/${base.plugin}/${rel}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`Shader '${shaderRef}' not found: neither virtual '${base.plugin}:${rel}' nor ${url}`);
            }
            return await resp.text();
        }
        const url = resolvePath(base.dir, shaderRef);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Shader not found: ${url}`);
        return await resp.text();
    }

    private static async ensureShaderModule(device: GPUDevice, base: ShaderBase, shaderRef: string): Promise<void> {
        const key = this.shaderKey(base, shaderRef);
        if (this.shaderModules.has(key)) return;
        const src = await this.shaderSource(base, shaderRef);
        this.shaderModules.set(key, device.createShaderModule({ label: shaderRef, code: src }));
    }

    /** Fetch/lookup a render-pipeline config (virtual registry first). */
    private static async fetchRenderConfig(baseDir: string, configPath: string): Promise<PipelineConfig> {
        const virtual = this.virtualConfigs.get(configPath);
        if (virtual) return virtual as PipelineConfig;
        const url = this.configUrl(baseDir, configPath);
        const resp = await fetch(url);
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || (!ct.includes('json') && !ct.includes('application'))) {
            throw new Error(`Pipeline not found: ${url}`);
        }
        return await resp.json();
    }

    static async load(
        device: GPUDevice,
        format: GPUTextureFormat,
        baseDir: string,
        configPath: string,
    ): Promise<GPURenderPipeline> {
        const config = await this.fetchRenderConfig(baseDir, configPath);
        const shaderBase = this.shaderBaseFor(baseDir, configPath);

        const shaderFiles = new Set<string>();
        shaderFiles.add(config.vertex.shader);
        if (config.fragment) shaderFiles.add(config.fragment.shader);
        for (const shaderPath of shaderFiles) {
            await this.ensureShaderModule(device, shaderBase, shaderPath);
        }

        this.configs.set(configPath, { config, format });
        return this.buildRender(device, format, configPath, config, shaderBase);
    }

    /** Rebuild a render pipeline from its (possibly mutated) retained config. */
    static rebuild(
        device: GPUDevice,
        baseDir: string,
        configPath: string,
    ): GPURenderPipeline {
        const stored = this.configs.get(configPath);
        if (!stored) throw new Error(`Pipeline '${configPath}' not loaded`);
        const shaderBase = this.shaderBaseFor(baseDir, configPath);
        return this.buildRender(device, stored.format, configPath, stored.config, shaderBase);
    }

    private static buildRender(
        device: GPUDevice,
        format: GPUTextureFormat,
        configPath: string,
        config: PipelineConfig,
        shaderBase: ShaderBase,
    ): GPURenderPipeline {
        const vsModule = this.shaderModules.get(this.shaderKey(shaderBase, config.vertex.shader))!;

        const vertex: GPUVertexState = {
            module: vsModule,
            entryPoint: config.vertex.entryPoint,
        };

        if (config.vertex.input) {
            const decl = this.vertexInputs[config.vertex.input];
            if (!decl) throw new Error(`Vertex input '${config.vertex.input}' not declared`);
            vertex.buffers = buildSlotLayouts(decl.slots);
            this.pipelineSlots.set(configPath, decl.slots);
        } else if (config.vertexLayouts) {
            vertex.buffers = config.vertexLayouts.map(vl => ({
                arrayStride: vl.arrayStride,
                stepMode: (vl.stepMode as GPUVertexStepMode) ?? 'vertex',
                attributes: vl.attributes as GPUVertexAttribute[],
            }));
        } else if (config.vertexLayout) {
            const vl = config.vertexLayout;
            vertex.buffers = [{
                arrayStride: vl.arrayStride,
                stepMode: (vl.stepMode as GPUVertexStepMode) ?? 'vertex',
                attributes: vl.attributes as GPUVertexAttribute[],
            }];
        }

        const blend = PipelineLoader.resolveBlend(config.blend);
        const layout: GPUPipelineLayout | 'auto' = config.bindLayout
            ? resourceManager.pipelineLayout(config.bindLayout)
            : 'auto';

        const descriptor: GPURenderPipelineDescriptor = {
            label: config.name,
            layout,
            vertex,
            primitive: {
                topology: config.primitive.topology,
                cullMode: config.primitive.cullMode,
                frontFace: config.primitive.frontFace ?? 'ccw',
            },
        };

        if (config.fragment) {
            const fsModule = this.shaderModules.get(this.shaderKey(shaderBase, config.fragment.shader))!;
            const targets: GPUColorTargetState[] = (config.targets ?? [{ format: 'default' }]).map(t => ({
                format: (!t.format || t.format === 'default') ? format : t.format,
                ...(blend ? { blend } : {}),
            }));
            descriptor.fragment = {
                module: fsModule,
                entryPoint: config.fragment.entryPoint,
                targets,
            };
        }

        if (config.depthStencil) {
            const { format: depthFormat, ...rest } = config.depthStencil;
            descriptor.depthStencil = {
                format: (depthFormat ?? 'depth24plus') as GPUTextureFormat,
                ...rest,
            } as GPUDepthStencilState;
        }

        return device.createRenderPipeline(descriptor);
    }

    static async loadCompute(
        device: GPUDevice,
        baseDir: string,
        configPath: string,
    ): Promise<GPUComputePipeline> {
        let config: ComputePipelineConfig;
        const virtual = this.virtualConfigs.get(configPath);
        if (virtual) {
            config = virtual as ComputePipelineConfig;
        } else {
            const url = this.configUrl(baseDir, configPath);
            const resp = await fetch(url);
            const ct = resp.headers.get('content-type') ?? '';
            if (!resp.ok || (!ct.includes('json') && !ct.includes('application'))) {
                throw new Error(`Compute pipeline not found: ${url}`);
            }
            config = await resp.json();
        }

        const shaderBase = this.shaderBaseFor(baseDir, configPath);
        const src = await this.shaderSource(shaderBase, config.compute.shader);
        const module = device.createShaderModule({ label: config.compute.shader, code: src });

        const layout: GPUPipelineLayout | 'auto' = config.bindLayout
            ? resourceManager.pipelineLayout(config.bindLayout)
            : 'auto';

        this.computeMeta.set(configPath, {
            workgroupSize: config.workgroupSize ?? PipelineLoader.defaultWorkgroupSize,
            bindLayout: config.bindLayout ?? [],
            countField: config.countField ?? 'count',
            bindings: config.bindings ?? [],
        });

        return device.createComputePipeline({
            label: config.name,
            layout,
            compute: { module, entryPoint: config.compute.entryPoint },
        });
    }
}

```

## core\render\Primitives.ts

```ts
export interface MeshData {
    positions: number[];
    indices: number[];
}

export interface PbrMeshData {
    positions: number[];
    normals: number[];
    uvs: number[];
    tangents: number[];
    indices: number[];
}

export function makeTriangle(): MeshData {
    return {
        positions: [
            0.0,  0.5, 0.0,
            -0.5, -0.5, 0.0,
            0.5, -0.5, 0.0,
        ],
        indices: [0, 1, 2],
    };
}

export function makeCube(): MeshData {
    const s = 0.5;
    const positions = [
        -s, -s, -s,   s, -s, -s,   s,  s, -s,  -s,  s, -s,
        -s, -s,  s,   s, -s,  s,   s,  s,  s,  -s,  s,  s,
    ];
    const indices = [
        0, 2, 1,  0, 3, 2,
        4, 5, 6,  4, 6, 7,
        0, 1, 5,  0, 5, 4,
        3, 7, 6,  3, 6, 2,
        0, 4, 7,  0, 7, 3,
        1, 2, 6,  1, 6, 5,
    ];
    return { positions, indices };
}

export function makeIcosphere(subdivisions = 1): MeshData {
    const t = (1 + Math.sqrt(5)) / 2;
    const verts: [number, number, number][] = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    let faces: [number, number, number][] = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];

    const midCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const cached = midCache.get(key);
        if (cached !== undefined) return cached;
        const va = verts[a];
        const vb = verts[b];
        verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
        const idx = verts.length - 1;
        midCache.set(key, idx);
        return idx;
    };

    for (let i = 0; i < subdivisions; i++) {
        const next: [number, number, number][] = [];
        for (const [a, b, c] of faces) {
            const ab = midpoint(a, b);
            const bc = midpoint(b, c);
            const ca = midpoint(c, a);
            next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        }
        faces = next;
    }

    const positions: number[] = [];
    for (const v of verts) {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        positions.push((v[0] / len) * 0.5, (v[1] / len) * 0.5, (v[2] / len) * 0.5);
    }
    const indices: number[] = [];
    for (const f of faces) indices.push(f[0], f[1], f[2]);
    return { positions, indices };
}

export function makeUvSphere(segments = 16, rings = 12): MeshData {
    const r = 0.5;
    const positions: number[] = [];
    const indices: number[] = [];

    for (let y = 0; y <= rings; y++) {
        const phi = (y / rings) * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        for (let x = 0; x <= segments; x++) {
            const theta = (x / segments) * 2 * Math.PI;
            positions.push(
                r * sinPhi * Math.cos(theta),
                r * cosPhi,
                r * sinPhi * Math.sin(theta),
            );
        }
    }

    const stride = segments + 1;
    for (let y = 0; y < rings; y++) {
        for (let x = 0; x < segments; x++) {
            const i0 = y * stride + x;
            const i1 = i0 + 1;
            const i2 = i0 + stride;
            const i3 = i2 + 1;
            indices.push(i0, i1, i2, i2, i1, i3);
        }
    }
    return { positions, indices };
}

export function meshEdges(mesh: MeshData): number[] {
    const seen = new Set<string>();
    const out: number[] = [];
    const addEdge = (a: number, b: number): void => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(
            mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2],
            mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2],
        );
    };
    for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = mesh.indices[i];
        const b = mesh.indices[i + 1];
        const c = mesh.indices[i + 2];
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
    }
    return out;
}

export const PRESET_MESHES: Record<string, MeshData> = {
    triangle: makeTriangle(),
    cube: makeCube(),
    icosphere: makeIcosphere(1),
    uvsphere: makeUvSphere(16, 12),
};

/* ── PBR primitives (with normals + UVs) ─────── */

export function makePbrCube(): PbrMeshData {
    const s = 0.5;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const indices: number[] = [];

    const faces: { n: [number, number, number]; verts: [number, number, number][] }[] = [
        { n: [ 0,  0, -1], verts: [[-s, -s, -s], [ s, -s, -s], [ s,  s, -s], [-s,  s, -s]] },
        { n: [ 0,  0,  1], verts: [[ s, -s,  s], [-s, -s,  s], [-s,  s,  s], [ s,  s,  s]] },
        { n: [ 0, -1,  0], verts: [[-s, -s,  s], [ s, -s,  s], [ s, -s, -s], [-s, -s, -s]] },
        { n: [ 0,  1,  0], verts: [[-s,  s, -s], [ s,  s, -s], [ s,  s,  s], [-s,  s,  s]] },
        { n: [-1,  0,  0], verts: [[-s, -s,  s], [-s, -s, -s], [-s,  s, -s], [-s,  s,  s]] },
        { n: [ 1,  0,  0], verts: [[ s, -s, -s], [ s, -s,  s], [ s,  s,  s], [ s,  s, -s]] },
    ];

    const quadUvs = [0, 0, 1, 0, 1, 1, 0, 1];

    for (const face of faces) {
        const base = positions.length / 3;
        for (const v of face.verts) {
            positions.push(...v);
            normals.push(...face.n);
        }
        uvs.push(...quadUvs);
        // tangent = U direction along face
        const tU = [
            face.verts[1][0] - face.verts[0][0],
            face.verts[1][1] - face.verts[0][1],
            face.verts[1][2] - face.verts[0][2],
        ];
        const tLen = Math.hypot(tU[0], tU[1], tU[2]) || 1;
        const tx = tU[0] / tLen;
        const ty = tU[1] / tLen;
        const tz = tU[2] / tLen;
        // same tangent for all 4 vertices of this face
        for (let j = 0; j < 4; j++) {
            tangents.push(tx, ty, tz, 1);
        }
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }

    return { positions, normals, uvs, tangents, indices };
}

export function makePbrIcosphere(subdivisions = 1): PbrMeshData {
    const base = makeIcosphere(subdivisions);
    const vertexCount = base.positions.length / 3;
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];

    for (let i = 0; i < vertexCount; i++) {
        const x = base.positions[i * 3];
        const y = base.positions[i * 3 + 1];
        const z = base.positions[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;
        normals.push(nx, ny, nz);
        uvs.push(
            0.5 + Math.atan2(z, x) / (2 * Math.PI),
            0.5 - Math.asin(y / len) / Math.PI,
        );

        // tangent = cross(up, normal) along latitude
        const tx = -nz;
        const ty = 0;
        const tz = nx;
        const tLen = Math.hypot(tx, ty, tz);
        if (tLen < 1e-6) {
            tangents.push(1, 0, 0, 1);
        } else {
            tangents.push(tx / tLen, ty / tLen, tz / tLen, 1);
        }
    }

    return { positions: base.positions, normals, uvs, tangents, indices: base.indices };
}

export function makePbrUvSphere(segments = 16, rings = 12): PbrMeshData {
    const base = makeUvSphere(segments, rings);
    const vertexCount = base.positions.length / 3;
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const stride = segments + 1;

    for (let i = 0; i < vertexCount; i++) {
        const x = base.positions[i * 3];
        const y = base.positions[i * 3 + 1];
        const z = base.positions[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;
        normals.push(nx, ny, nz);

        const ring = Math.floor(i / stride);
        const seg = i % stride;
        uvs.push(seg / segments, ring / rings);

        const tx = -nz;
        const ty = 0;
        const tz = nx;
        const tLen = Math.hypot(tx, ty, tz);
        if (tLen < 1e-6) {
            tangents.push(1, 0, 0, 1);
        } else {
            tangents.push(tx / tLen, ty / tLen, tz / tLen, 1);
        }
    }

    return { positions: base.positions, normals, uvs, tangents, indices: base.indices };
}

export function makePbrPlane(): PbrMeshData {
    const s = 0.5;
    const positions: number[] = [
        -s, 0,  s,   s, 0,  s,   s, 0, -s,  -s, 0, -s,
    ];
    const normals: number[] = [
        0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    ];
    const uvs: number[] = [0, 0, 1, 0, 1, 1, 0, 1];
    const tangents: number[] = [
        1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
    ];
    const indices: number[] = [0, 1, 2, 0, 2, 3];
    return { positions, normals, uvs, tangents, indices };
}

export const PRESET_PBR_MESHES: Record<string, PbrMeshData> = {
    pbr_cube: makePbrCube(),
    pbr_icosphere: makePbrIcosphere(2),
    pbr_uvsphere: makePbrUvSphere(16, 12),
    pbr_plane: makePbrPlane(),
};

/* ── Data-driven mesh catalog (meshes.json) ──── */

export type MeshGenerator = (params: Record<string, number>) => MeshData | PbrMeshData;

/** Register a mesh generator (plugins). Duplicate names throw (fail-loud). */
export function registerMeshGenerator(name: string, gen: MeshGenerator): void {
    if (meshGenerators[name]) throw new Error(`Mesh generator '${name}' already registered`);
    meshGenerators[name] = gen;
}

/** Remove a mesh generator (plugin unload). */
export function unregisterMeshGenerator(name: string): void {
    delete meshGenerators[name];
}

export const meshGenerators: Record<string, MeshGenerator> = {
    triangle: () => makeTriangle(),
    cube: () => makeCube(),
    icosphere: (p) => makeIcosphere(p.subdivisions ?? 1),
    uvsphere: (p) => makeUvSphere(p.segments ?? 16, p.rings ?? 12),
    pbrCube: () => makePbrCube(),
    pbrIcosphere: (p) => makePbrIcosphere(p.subdivisions ?? 2),
    pbrUvSphere: (p) => makePbrUvSphere(p.segments ?? 16, p.rings ?? 12),
    pbrPlane: () => makePbrPlane(),
};

export function isPbrMeshData(data: MeshData | PbrMeshData): data is PbrMeshData {
    return 'tangents' in data && 'normals' in data;
}

```

## core\render\rendererDecl.ts

```ts
import type { RenderPhase } from './types';

/**
 * Declarative renderer block embedded in a pipeline JSON. A generic driver
 * reads this to run the pipeline: which entities to draw (query), where to
 * render (target), what geometry to emit, and how to fill each bind group
 * from component fields — no per-pipeline TypeScript required.
 */
export interface RendererDecl {
    /** Component names an entity must have to be drawn. Omit = draw once. */
    query?: string[];
    /** Which phase this pipeline runs in (name from phases.json). */
    phase: RenderPhase;
    /** Named color/depth targets (see render-targets.json); "screen" = swapchain.
     *  `color` accepts a single name or an array for multiple render targets (MRT,
     *  e.g. a deferred GBuffer pass writing albedo + normal in one pass). */
    target?: { color?: string | string[]; depth?: string };
    /** Render-tag component used by `tag.color` / `tag.extra` value sources. */
    tag?: string;
    /** Per-entity filter: skip entities where the component field doesn't match. */
    filter?: { component: string; field: string; value: number };
    /** Marks this pipeline as transparent — entities are sorted far→near
     *  (painter's algorithm). Opaque pipelines sort near→far (early-z benefit). */
    transparent?: boolean;
    /** GPU instancing: batch all matching entities into a single
     *  drawIndexed(indexCount, instanceCount) call. Model matrices are
     *  written to a storage buffer; the shader MUST use
     *  @builtin(instance_index) to index into array<mat4x4f>.
     *  Requires the object bind group layout to declare a storage buffer
     *  (not uniform). Incompatible with transparent (instancing ignores
     *  per-instance sort order). */
    instanced?: boolean;
    /** Participates in the post-process ping-pong chain (reads $framebuffer). */
    postProcess?: boolean;
    geometry: GeometryDecl;
    /** Per-draw bind groups (group 0 = frame is auto-bound when bindLayout[0]="frame"). */
    bindGroups?: BindGroupDecl[];
    /** Optional compute stage declaration (declarative bindings, reused from compute meta). */
    compute?: unknown;
    /**
     * Open container of auxiliary resources passed through to compute/geometry
     * hooks via `ctx.aux`. Keys are pipeline-defined; values that end with
     * `.json` are preloaded as compute pipelines at compile time. Adding a new
     * aux key does not require touching TypeScript.
     */
    aux?: Record<string, string>;
}

export interface GeometryDecl {
    /** Script hook name (escape hatch: the hook records its own draws). */
    hook?: string;
    /** Declarative draw steps. Required when hook is omitted. */
    steps?: DrawStep[];
}

export interface DrawStep {
    /** Vertex buffers to bind before the draw call. */
    vertexBuffers?: VertexBufferBinding[];
    /** Index buffer to bind (optional). */
    indexBuffer?: IndexBufferBinding;
    /** The draw call to make. */
    draw?: DrawCall;
}

export interface VertexBufferBinding {
    /** GPU vertex buffer slot index. */
    slot: number;
    /** 'meshSlots' = bind all SoA slots from the named mesh (in vertex-input order);
     *  'vbo' = named built-in VBO; 'meshField' = specific named buffer from a mesh. */
    source: 'meshSlots' | 'vbo' | 'meshField';
    /** meshSlots/meshField: value source for the mesh name (default "MeshComponent.mesh"). */
    mesh?: string;
    /** meshField: which named buffer (e.g., "edgeBuffer", "pointBuffer"). */
    field?: string;
    /** vbo: named built-in VBO (e.g., "quad"). */
    vbo?: string;
}

export interface IndexBufferBinding {
    /** Value source for the mesh name (default "MeshComponent.mesh"). */
    mesh?: string;
}

export interface DrawCall {
    type: 'draw' | 'drawIndexed';
    /** draw: static vertex count (default 3). */
    vertexCount?: number;
    /** draw/drawIndexed: value source for the count (overrides static). */
    countField?: string;
    /** draw: static instance count (default 1). */
    instanceCount?: number;
    /** draw: value source for instance count. */
    instanceCountField?: string;
}

export interface BindGroupDecl {
    /** @group index; the named layout is pipeline.bindLayout[group]. */
    group: number;
    /** A uniform block written from value sources. */
    uniform?: {
        layoutRef: string;
        binding?: number;   // default 0
        writes: { member: string; value: string }[];
    };
    samplers?: { binding: number; name?: string }[];
    textures?: { binding: number; source: string; fallback?: string }[];
}

/** render-targets.json: named offscreen color/depth targets. */
export interface RenderTargetDecl {
    kind: 'color' | 'depth';
    format?: GPUTextureFormat | 'default';
    clearColor?: [number, number, number, number];
    /** Size policy. Omitted = viewport-sized (canvas dimensions). */
    size?: RenderTargetSize;
    /** Marks this target as a transient scratch buffer for post-process chains. */
    transient?: boolean;
    /** Texture dimension. '2d' (default) = single-layer; '2d-array' = layered depth for
     *  per-light directional shadow maps; 'cube-array' = layered cube depth for point
     *  shadow maps. Only meaningful for depth targets. */
    dimension?: '2d' | '2d-array' | 'cube-array';
    /** Number of array layers (for '2d-array' / 'cube-array'). For 'cube-array' this is
     *  the number of cubes (each contributes 6 faces internally). */
    arrayLayers?: number;
}

/** Size declaration for a named render target. */
export interface RenderTargetSize {
    /** 'viewport' = follows canvas size (optionally scaled); 'fixed' = constant. */
    type: 'viewport' | 'fixed';
    /** viewport: scale factor (default 1 = full canvas). */
    scale?: number;
    /** fixed: width in pixels. */
    w?: number;
    /** fixed: height in pixels. */
    h?: number;
}

export type RenderTargetDecls = Record<string, RenderTargetDecl>;

```

## core\render\RenderGraph.ts

```ts
import { defineQuery } from 'bitecs/legacy';
import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { PipelineDriver, type GeometryHook, type ComputeHook } from './PipelineDriver';
import { RenderScriptLoader } from './RenderScriptLoader';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { uniformLayouts } from './UniformLayout';
import { normalBehavior, shadowClearBehavior, postProcessChainBehavior } from './phaseBehaviors';
import {
    type RenderGraphData,
    type PhaseMap,
    type PhaseDecl,
    type PhaseBehavior,
    type PhaseBehaviorContext,
    type DriverFrame,
    type ViewportRect,
    type IRenderer,
} from './types';
import type { RenderTargetDecls } from './rendererDecl';
import type { ValueContext } from './valueResolver';
import type { CameraView } from '../ecs/Scene';
import type { FrameContext, System } from '../ecs/SystemRegistry';

const SCREEN = 'screen';

/**
 * Data-driven render graph. Owns no per-pipeline draw logic and no pass
 * strategy: each render pipeline embeds a declarative `renderer` block executed
 * by a generic PipelineDriver, and each phase names a registered PhaseBehavior
 * (open registry — engine defaults and plugins register through the same API).
 */
export class RenderGraph implements System, IRenderer {
    name = '';
    phases: PhaseMap = {};

    private phaseList: PhaseDecl[] = [];
    private phaseBehaviors = new Map<string, PhaseBehavior>();
    private phaseBehaviorOwners = new Map<string, string>();
    private clearColor: [number, number, number, number] = [0, 0, 0, 1];
    private pipelines = new Map<string, GPURenderPipeline>();
    private computePipelines = new Map<string, GPUComputePipeline>();
    private drivers: PipelineDriver[] = [];
    private targets: RenderTargetDecls = {};
    private dataBase = '/common';
    private scriptsSubdir = 'scripts';
    private format: GPUTextureFormat = 'bgra8unorm';
    private sceneIsScreen = true;
    /** Multi-view split-screen toggle (from render.json `multiView: true`). */
    private multiView = false;
    /** Scratch buffer for per-camera UBO uploads in multi-view mode. */
    private cameraData: Float32Array = new Float32Array(0);
    /** Staging buffer for multi-view camera UBO updates: all cameras' data
     *  is written here via queue.writeBuffer, then copyBufferToBuffer copies
     *  each camera's slice into the shared camera UBO between render passes
     *  within a single command encoder. Avoids per-camera submit. */
    private cameraStagingBuffer: GPUBuffer | null = null;

    private valueScripts = new Map<string, (ctx: ValueContext) => number[] | number>();
    private geometryHooks = new Map<string, GeometryHook>();
    private computeHooks = new Map<string, ComputeHook>();
    /** Hook name → owner tag ('app' = render.json renderScripts, 'plugin:<id>'). */
    private hookOwners = new Map<string, string>();
    private scriptFiles: string[] = [];

    constructor() {
        // Engine-default pass strategies, registered through the same public
        // registry plugins use — no special-cased dispatch anywhere.
        this.registerPhaseBehavior('normal', normalBehavior, 'engine');
        this.registerPhaseBehavior('shadow-clear', shadowClearBehavior, 'engine');
        this.registerPhaseBehavior('postprocess-chain', postProcessChainBehavior, 'engine');
    }

    /** Register a pass strategy under a behavior name (phases.json `behavior`). */
    registerPhaseBehavior(name: string, behavior: PhaseBehavior, owner = 'engine'): void {
        const existing = this.phaseBehaviorOwners.get(name);
        if (existing !== undefined && existing !== owner) {
            throw new Error(`Phase behavior '${name}' already registered by ${existing} (attempted by ${owner})`);
        }
        this.phaseBehaviorOwners.set(name, owner);
        this.phaseBehaviors.set(name, behavior);
    }

    /** Drop every phase behavior registered by `owner` (plugin unload). */
    removePhaseBehaviorsByOwner(owner: string): void {
        for (const [name, o] of [...this.phaseBehaviorOwners]) {
            if (o !== owner) continue;
            this.phaseBehaviorOwners.delete(name);
            this.phaseBehaviors.delete(name);
        }
    }

    /** Register an escape-hatch script (renderScripts or plugins). */
    registerValueScript(name: string, fn: (ctx: ValueContext) => number[] | number, owner = 'app'): void {
        this.valueScripts.set(name, fn);
        this.hookOwners.set(name, owner);
    }
    registerGeometryHook(name: string, fn: GeometryHook, owner = 'app'): void {
        this.geometryHooks.set(name, fn);
        this.hookOwners.set(name, owner);
    }
    registerComputeHook(name: string, fn: ComputeHook, owner = 'app'): void {
        this.computeHooks.set(name, fn);
        this.hookOwners.set(name, owner);
    }

    /** Drop every hook registered by `owner` (app switch / plugin unload). */
    removeHooksByOwner(owner: string): void {
        for (const [name, o] of [...this.hookOwners]) {
            if (o !== owner) continue;
            this.hookOwners.delete(name);
            this.valueScripts.delete(name);
            this.geometryHooks.delete(name);
            this.computeHooks.delete(name);
        }
    }

    setRenderTargets(targets: RenderTargetDecls): void {
        this.targets = { ...this.targets, ...targets };
    }

    /** Merge render targets declared by a plugin. Duplicate names throw. */
    mergeRenderTargets(targets: RenderTargetDecls): void {
        for (const [name, decl] of Object.entries(targets)) {
            if (this.targets[name]) throw new Error(`Render target '${name}' already declared`);
            this.targets[name] = decl;
        }
    }

    /** Release app-owned state: drivers, escape-hatch hooks, particle GPU buffers.
     *  Common pipelines / shader modules are kept for reuse across apps. */
    exitApp(_appId: string): void {
        // Drop per-entity bind-group caches promptly (the driver objects will be
        // GC'd eventually, but explicitly clearing the cache makes the cached
        // GPUBindGroups dereferenced now rather than after driver GC).
        for (const d of this.drivers) d.dispose();
        this.drivers = [];
        this.cameraStagingBuffer?.destroy();
        this.cameraStagingBuffer = null;
        this.removeHooksByOwner('app');
    }

    /** Names of render escape-hatch scripts to load at compile (e.g. "render/pbr.js"). */
    setScriptFiles(files: string[]): void {
        this.scriptFiles = files;
    }

    /** Set the scripts subdirectory (from engine-config.json). */
    setScriptsSubdir(subdir: string): void {
        this.scriptsSubdir = subdir;
    }

    /** Set the phase list (from phases.json). */
    setPhases(phases: PhaseDecl[]): void {
        this.phaseList = [...phases].sort((a, b) => a.order - b.order);
    }

    /** Merge phases declared by a plugin. Duplicate names throw (fail-loud). */
    addPhases(phases: PhaseDecl[]): void {
        for (const p of phases) {
            if (this.phaseList.some(e => e.name === p.name)) {
                throw new Error(`Phase '${p.name}' already declared`);
            }
            this.phaseList.push(p);
        }
        this.phaseList.sort((a, b) => a.order - b.order);
    }

    /** Remove phases by name (plugin unload). */
    removePhases(names: string[]): void {
        this.phaseList = this.phaseList.filter(p => !names.includes(p.name));
    }

    /** Ordered phase names (for editor display). */
    getPhaseNames(): string[] {
        return this.phaseList.map(p => p.name);
    }

    fromData(data: RenderGraphData): void {
        this.name = data.name;
        if (data.clearColor) {
            this.clearColor = data.clearColor;
        } else {
            const def = schemaRegistry.getFieldDefault('EnvironmentComponent', 'clearColor') as number[] | undefined;
            if (def) this.clearColor = [def[0], def[1], def[2], def[3]];
        }
        this.multiView = data.multiView ?? false;
        // Every phase key in render.json must exist in phases.json — entries
        // under an unknown phase name would otherwise be dropped silently.
        const known = new Set(this.phaseList.map(p => p.name));
        for (const key of Object.keys(data.phases)) {
            if (!known.has(key)) {
                throw new Error(
                    `Render graph '${data.name}' declares phase '${key}' which is not in phases.json ` +
                    `(known: ${[...known].join(', ')})`,
                );
            }
        }
        this.phases = {};
        for (const phase of this.phaseList) {
            const list = data.phases[phase.name] ?? [];
            this.phases[phase.name] = list.map(e => ({ ...e, enabled: e.enabled ?? true }));
        }
    }

    async compile(device: GPUDevice, format: GPUTextureFormat, dataBase: string, appBase?: string): Promise<void> {
        this.dataBase = dataBase;
        this.format = format;
        this.drivers = [];

        // Load escape-hatch render scripts, merge into the hook registries.
        // Plugin-registered hooks of the same name take precedence (skip).
        if (this.scriptFiles.length > 0) {
            const loader = new RenderScriptLoader(dataBase, this.scriptsSubdir);
            const hooks = await loader.loadAll(this.scriptFiles);
            for (const [k, v] of hooks.value) if (!this.valueScripts.has(k)) this.registerValueScript(k, v, 'app');
            for (const [k, v] of hooks.geometry) if (!this.geometryHooks.has(k)) this.registerGeometryHook(k, v, 'app');
            for (const [k, v] of hooks.compute) if (!this.computeHooks.has(k)) this.registerComputeHook(k, v, 'app');
        }

        // Load every pipeline listed in the manifest, build a driver from its renderer block.
        for (const phase of this.phaseList) {
            for (const entry of this.phases[phase.name] ?? []) {
                // compute-only entries (particle emit/sim) are loaded lazily by their driver
                if (entry.kind === 'compute') {
                    if (!this.computePipelines.has(entry.pipeline)) {
                        this.computePipelines.set(entry.pipeline, await this.tryLoadCompute(device, dataBase, appBase, entry.pipeline));
                    }
                    continue;
                }

                if (!this.pipelines.has(entry.pipeline)) {
                    this.pipelines.set(entry.pipeline, await this.tryLoadPipeline(device, format, dataBase, appBase, entry.pipeline));
                }
                const config = PipelineLoader.getConfig(entry.pipeline);
                const decl = config?.renderer;
                if (!decl) continue;

                // preload auxiliary compute pipelines declared in renderer.aux
                // (values ending with .json are preloaded as compute pipelines).
                for (const v of Object.values(decl.aux ?? {})) {
                    if (typeof v === 'string' && v.endsWith('.json') && !this.computePipelines.has(v)) {
                        this.computePipelines.set(v, await this.tryLoadCompute(device, dataBase, appBase, v));
                    }
                }
                // preload skybox / declared asset textures
                for (const bg of decl.bindGroups ?? []) {
                    for (const t of bg.textures ?? []) {
                        if (t.source.startsWith('asset:')) {
                            await resourceManager.loadTexture(`${dataBase}/${t.source.slice(6)}`);
                        }
                    }
                }

                const driver = new PipelineDriver(entry.pipeline, decl, entry, this.valueScripts, this.geometryHooks, this.computeHooks);
                driver.dataBase = dataBase;
                driver.aux = decl.aux ?? {};
                if (decl.query) {
                    driver.query = defineQuery(decl.query.map(name => {
                        const comp = schemaRegistry.get(name);
                        if (!comp) {
                            throw new Error(`Pipeline '${entry.pipeline}': renderer.query component '${name}' is not registered (components.json)`);
                        }
                        return comp;
                    }));
                }
                this.drivers.push(driver);
            }
        }

        // Multi-view cannot share a command buffer with the postprocess ping-pong
        // chain (each camera owns its own command buffer; the chain routes through
        // a single shared screen target). Fail loud at compile so the conflict is
        // surfaced as a config error, not a silent frame drop.
        if (this.multiView) {
            const postPhase = this.phaseList.find(p => p.behavior === 'postprocess-chain');
            const postEnabled = postPhase
                ? this.drivers.some(d => d.entry.enabled && d.decl.phase === postPhase.name)
                : false;
            if (postEnabled) {
                throw new Error(
                    `Render graph '${this.name}' declares multiView:true but has an enabled ` +
                    `postprocess-chain driver in phase '${postPhase!.name}' — these are mutually ` +
                    `exclusive. Disable multiView or the post-process pipeline.`,
                );
            }
        }

        // Lazily allocate the per-camera UBO scratch buffer now that the camera
        // layout size is known (from uniform-layouts.json).
        if (this.multiView && this.cameraData.length === 0) {
            this.cameraData = uniformLayouts.get('camera').createBuffer();
        }
    }

    /** Try loading a render pipeline from commonBase first, then appBase on 404.
     *  Plugin-prefixed paths ('<plugin>:…') resolve directly, no fallback. */
    private async tryLoadPipeline(
        device: GPUDevice, format: GPUTextureFormat, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPURenderPipeline> {
        if (path.startsWith('/') || PipelineLoader.pluginRef(path)) {
            return PipelineLoader.load(device, format, commonBase, path);
        }
        try {
            return await PipelineLoader.load(device, format, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.load(device, format, appBase, path);
        }
    }

    /** Try loading a compute pipeline from commonBase first, then appBase on 404.
     *  Plugin-prefixed paths ('<plugin>:…') resolve directly, no fallback. */
    private async tryLoadCompute(
        device: GPUDevice, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPUComputePipeline> {
        if (path.startsWith('/') || PipelineLoader.pluginRef(path)) {
            return PipelineLoader.loadCompute(device, commonBase, path);
        }
        try {
            return await PipelineLoader.loadCompute(device, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Compute pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.loadCompute(device, appBase, path);
        }
    }

    /** System interface: run the render graph for this frame. */
    update(ctx: FrameContext): void {
        this.execute(ctx);
    }

    execute(ctx: FrameContext): void {
        // Submit any compute dispatches batched by script/physics systems this
        // frame so their results are visible to the render passes below.
        ctx.flushCompute();
        const tex = ctx.context.getCurrentTexture();
        const cw = tex.width;
        const ch = tex.height;
        const canvasAspect = cw / Math.max(1, ch);

        // Multi-view is opt-in via render.json `multiView: true`. When enabled
        // AND more than one Camera is active, each camera renders the whole
        // scene into its own on-screen viewport (Camera.viewport). The shared
        // camera UBO is re-written per camera, so each camera must own its own
        // command buffer (writeBuffer → submit) — a single command buffer
        // cannot safely re-write a shared UBO between render passes.
        const cameras = ctx.scene.getActiveCameras(canvasAspect);
        const swapView = tex.createView();
        if (this.multiView && cameras.length > 1) {
            this.executeMultiView(ctx, cw, ch, swapView, cameras);
            return;
        }
        this.executeSingle(ctx, cw, ch, swapView);
    }

    /** Per-frame info for drivers + hooks (attachments carry plugin objects). */
    private driverFrame(ctx: FrameContext, cw: number, ch: number): DriverFrame {
        const cam = ctx.scene.getActiveCamera(ctx.aspect);
        return {
            time: ctx.time,
            dt: ctx.dt,
            cw, ch,
            attachments: ctx.attachments,
            computePipelines: this.computePipelines,
            cameraPos: cam?.pos ?? null,
        };
    }

    /** Resolve a phase's behavior from the registry (fail-loud when missing). */
    private behaviorFor(phase: PhaseDecl): PhaseBehavior {
        const name = phase.behavior || 'normal';
        const behavior = this.phaseBehaviors.get(name);
        if (!behavior) {
            throw new Error(
                `Phase '${phase.name}': behavior '${name}' is not registered ` +
                `(known: ${[...this.phaseBehaviors.keys()].join(', ')})`,
            );
        }
        return behavior;
    }

    /** True when any enabled driver sits in a phase with the given behavior. */
    private hasEnabledWithBehavior(behaviorName: string): boolean {
        const names = new Set(
            this.phaseList.filter(p => (p.behavior || 'normal') === behaviorName).map(p => p.name),
        );
        return this.drivers.some(d => d.entry.enabled && names.has(d.decl.phase));
    }

    /** Build the narrow facade a PhaseBehavior runs against. */
    private behaviorContext(
        ctx: FrameContext,
        encoder: GPUCommandEncoder,
        phase: PhaseDecl,
        frame: DriverFrame,
        cw: number, ch: number,
        swapView: GPUTextureView,
        cleared: Set<string>,
        viewport: ViewportRect | null,
    ): PhaseBehaviorContext {
        return {
            encoder,
            phase,
            drivers: this.drivers.filter(d => d.decl.phase === phase.name),
            scene: ctx.scene,
            frame,
            cw, ch,
            format: ctx.format,
            swapView,
            viewport,
            cleared,
            sceneIsScreen: this.sceneIsScreen,
            getSystem: ctx.getSystem,
            pipelineFor: (d) => this.pipelines.get(d.path),
            transientTargets: () => this.transientTargetNames(),
            runDefault: () => {
                const enabled = this.drivers.filter(d => d.entry.enabled && d.decl.phase === phase.name);
                if (enabled.length === 0) return;
                this.runNormalPhase(encoder, enabled, ctx, frame, cw, ch, swapView, cleared, viewport);
            },
        };
    }

    /** Single-camera (or zero-camera) path. The camera UBO is assumed already
     *  written by the camera system. */
    private executeSingle(ctx: FrameContext, cw: number, ch: number, swapView: GPUTextureView): void {
        const frame = this.driverFrame(ctx, cw, ch);
        const encoder = ctx.device.createCommandEncoder();

        // ── compute stage (script hooks) ──
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(encoder, {
                scene: ctx.scene,
                time: ctx.time,
                dt: ctx.dt,
                computePipelines: this.computePipelines,
                attachments: ctx.attachments,
            });
        }

        // If nothing post-processes, the "scene" target is the swapchain directly.
        this.sceneIsScreen = !this.hasEnabledWithBehavior('postprocess-chain');

        // ── behavior-dispatched phase execution ──
        const cleared = new Set<string>();
        for (const phase of this.phaseList) {
            const behavior = this.behaviorFor(phase);
            behavior.run(this.behaviorContext(ctx, encoder, phase, frame, cw, ch, swapView, cleared, null));
        }

        ctx.device.queue.submit([encoder.finish()]);
    }

    /** Multi-view path: compute + per-frame behaviors + per-camera passes all
     *  recorded into a single command encoder and submitted once. Per-camera
     *  UBO updates use copyBufferToBuffer between passes (the staging buffer
     *  holds all cameras' data, pre-written via queue.writeBuffer before the
     *  encoder is built, so each copy loads the right camera's matrices
     *  in-encoder-order without extra submits). */
    private executeMultiView(
        ctx: FrameContext, cw: number, ch: number, swapView: GPUTextureView, cameras: CameraView[],
    ): void {
        const frame = this.driverFrame(ctx, cw, ch);

        // Multi-view does not support the postprocess chain (it routes through a
        // single screen target); validated out at compile(). Scene IS the screen.
        this.sceneIsScreen = true;

        // ── Pre-write all cameras' data into the staging buffer ──
        const camLayout = uniformLayouts.get('camera');
        const camSize = camLayout.byteSize;
        const requiredSize = cameras.length * camSize;
        if (!this.cameraStagingBuffer || this.cameraStagingBuffer.size < requiredSize) {
            this.cameraStagingBuffer?.destroy();
            this.cameraStagingBuffer = ctx.device.createBuffer({
                label: 'camera-staging',
                size: requiredSize,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
        }
        const staging = this.cameraStagingBuffer;
        const buf = this.cameraData;
        for (let i = 0; i < cameras.length; i++) {
            const cam = cameras[i];
            camLayout.write(buf, 'vp', cam.vp);
            camLayout.write(buf, 'ivp', cam.ivp);
            camLayout.write(buf, 'pos', cam.pos);
            camLayout.write(buf, 'view', cam.view);
            camLayout.write(buf, 'proj', cam.proj);
            ctx.device.queue.writeBuffer(staging, i * camSize, buf.buffer, buf.byteOffset, buf.byteLength);
        }
        const camUBO = resourceManager.cameraUBO;

        // ── Single encoder for compute + per-frame + per-camera passes ──
        const enc = ctx.device.createCommandEncoder();

        // Stage 1: compute + per-frame behaviors (perCamera: false — e.g. shadow)
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(enc, {
                scene: ctx.scene,
                time: ctx.time,
                dt: ctx.dt,
                computePipelines: this.computePipelines,
                attachments: ctx.attachments,
            });
        }
        const cleared0 = new Set<string>();
        for (const phase of this.phaseList) {
            const behavior = this.behaviorFor(phase);
            if (behavior.perCamera !== false) continue;
            behavior.run(this.behaviorContext(ctx, enc, phase, frame, cw, ch, swapView, cleared0, null));
        }

        // Stage 2: per-camera passes — copy each camera's UBO slice, then run
        // the perCamera behaviors scoped to its viewport. `cleared` is shared
        // across cameras so the first camera clears the screen target and
        // subsequent cameras load it (preserving prior viewports).
        const cleared = new Set<string>();
        for (let ci = 0; ci < cameras.length; ci++) {
            const cam = cameras[ci];
            // Update the frame's camera position for this camera's render-sort.
            frame.cameraPos = cam.pos;
            // Copy this camera's data from staging into the shared camera UBO.
            enc.copyBufferToBuffer(staging, ci * camSize, camUBO, 0, camSize);
            // Pixel rect, clamped to the framebuffer so 1px rounding on odd
            // canvas sizes can't overflow the scissor/viewport (WebGPU validation).
            let vx = Math.round(cam.viewport[0] * cw);
            let vy = Math.round(cam.viewport[1] * ch);
            let vw = Math.round(cam.viewport[2] * cw);
            let vh = Math.round(cam.viewport[3] * ch);
            if (vx < 0) { vw += vx; vx = 0; }
            if (vy < 0) { vh += vy; vy = 0; }
            if (vx + vw > cw) vw = cw - vx;
            if (vy + vh > ch) vh = ch - vy;
            if (vw <= 0 || vh <= 0) continue;
            const vp: ViewportRect = { x: vx, y: vy, w: vw, h: vh };
            for (const phase of this.phaseList) {
                const behavior = this.behaviorFor(phase);
                if (behavior.perCamera === false) continue;
                behavior.run(this.behaviorContext(ctx, enc, phase, frame, cw, ch, swapView, cleared, vp));
            }
        }

        ctx.device.queue.submit([enc.finish()]);
    }

    /** Default 'normal' behavior body: merge consecutive enabled drivers that
     *  share the same color(s)+depth target into one pass, then record. */
    private runNormalPhase(
        encoder: GPUCommandEncoder,
        drivers: PipelineDriver[],
        ctx: FrameContext,
        frame: DriverFrame,
        cw: number, ch: number, swapView: GPUTextureView,
        cleared: Set<string>, viewport: ViewportRect | null,
    ): void {
        // `color` may be a single name or an array (MRT, e.g. deferred GBuffer).
        const colorNamesOf = (d: PipelineDriver): string[] => {
            const c = d.decl.target?.color;
            return Array.isArray(c) ? c : [c ?? 'scene'];
        };
        let i = 0;
        while (i < drivers.length) {
            const colors = colorNamesOf(drivers[i]);
            const colorsKey = colors.join(',');
            const depthName = drivers[i].decl.target?.depth ?? 'sceneDepth';

            let j = i;
            while (j < drivers.length
                && colorNamesOf(drivers[j]).join(',') === colorsKey
                && (drivers[j].decl.target?.depth ?? 'sceneDepth') === depthName) {
                j++;
            }

            // Clear a target only the first time it is written this frame.
            const key = `${colorsKey}|${depthName}`;
            const clear = !cleared.has(key);
            cleared.add(key);
            this.openPassAndRecord(
                encoder, colors, depthName, drivers.slice(i, j),
                ctx, frame, cw, ch, swapView, clear, viewport,
            );
            i = j;
        }
    }

    private openPassAndRecord(
        encoder: GPUCommandEncoder,
        colorNames: string[], depthName: string,
        drivers: PipelineDriver[],
        ctx: FrameContext,
        frame: DriverFrame,
        cw: number, ch: number, swapView: GPUTextureView, clear: boolean,
        viewport: ViewportRect | null,
    ): void {
        const isDepthOnly = colorNames.length === 1 && colorNames[0] === 'none';

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (!isDepthOnly) {
            const envClear = ctx.scene.getEnvironmentClearColor() ?? this.clearColor;
            for (const name of colorNames) {
                const view = (name === SCREEN || (name === 'scene' && this.sceneIsScreen))
                    ? swapView
                    : resourceManager.namedColorTargetView(name, cw, ch, ctx.format);
                colorAttachments.push({
                    view,
                    // The scene/screen target clears to the env color; offscreen
                    // GBuffer targets clear to zero (black, no albedo/normal).
                    clearValue: (name === 'scene' || name === SCREEN) ? envClear : [0, 0, 0, 0],
                    loadOp: clear ? 'clear' : 'load',
                    storeOp: 'store',
                });
            }
        }

        const desc: GPURenderPassDescriptor = {
            colorAttachments,
        };

        if (depthName && depthName !== 'none') {
            // Multi-view cameras share the full-screen depth target; scissor
            // restricts each camera's writes to its own viewport region.
            const depthView = resourceManager.namedDepthTargetView(depthName, cw, ch);
            desc.depthStencilAttachment = {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: clear ? 'clear' : 'load',
                depthStoreOp: 'store',
            };
        }

        const pass = encoder.beginRenderPass(desc);
        if (viewport) {
            pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
            pass.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);
        }
        for (const d of drivers) {
            const pipeline = this.pipelines.get(d.path);
            if (!pipeline) throw new Error(`Pipeline '${d.path}' was not compiled (compile() must load every manifest entry)`);
            d.record(pass, ctx.scene, pipeline, frame);
        }
        pass.end();
    }

    /** Collect transient color target names from render-targets.json. */
    private transientTargetNames(): string[] {
        const names: string[] = [];
        for (const [name, decl] of Object.entries(this.targets)) {
            if (decl.transient) names.push(name);
        }
        return names.length > 0 ? names : ['ppA', 'ppB'];
    }

    toData(): RenderGraphData {
        const phases: Partial<PhaseMap> = {};
        for (const phase of this.phaseList) {
            phases[phase.name] = (this.phases[phase.name] ?? []).map(e => ({ ...e }));
        }
        return { name: this.name, clearColor: [...this.clearColor], phases, multiView: this.multiView };
    }

    /** Look up a loaded compute pipeline by name (for script systems that
     *  want to dispatch their own compute via ctx.dispatchCompute). */
    getComputePipeline(name: string): GPUComputePipeline | undefined {
        return this.computePipelines.get(name);
    }

    rebuildPipeline(device: GPUDevice, pipelinePath: string): void {
        if (!this.pipelines.has(pipelinePath)) return;
        this.pipelines.set(pipelinePath, PipelineLoader.rebuild(device, this.dataBase, pipelinePath));
    }
}

```

## core\render\RenderScriptLoader.ts

```ts
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
        // In dev, skip the cache so script edits take effect without a page
        // reload (the ?t= cache-bust fetches fresh content, but the loaded
        // Map would return stale exports otherwise).
        const cached = import.meta.env.DEV ? undefined : this.loaded.get(file);
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
            // A script listed in render.json "renderScripts" that fails to load
            // is a config bug — propagate instead of silently dropping its hooks.
            const exports = await this.load(file);
            // Derive the hook key base from the file's basename: strip the
            // leading sub-namespace dir (e.g. "render/" in "render/particles.js")
            // and the .js suffix, so the registered key is "particles.simulate"
            // regardless of which sub-namespace under <scriptsSubdir>/ is used.
            const baseName = file.replace(/^[^/]+\//, '').replace(/\.js$/, '');
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

```

## core\render\ResourceManager.ts

```ts
import { meshEdges, type MeshData, type PbrMeshData } from './Primitives';
import { uniformLayouts } from './UniformLayout';
import { bufferRegistry } from './BufferRegistry';
import type { SlotName } from './vertexSlots';
import type { PipelineEntry, BindLayoutDecls, BindEntryDecl, SamplerDecls } from './types';
import type { RenderTargetDecls, RenderTargetSize } from './rendererDecl';

export interface MeshGpu {
    slots: Partial<Record<SlotName, GPUBuffer>>;
    slotHandles: Partial<Record<SlotName, number>>;
    index?: GPUBuffer;
    indexHandle: number;
    indexFormat: GPUIndexFormat;
    indexCount: number;
    vertexCount: number;
    edgeBuffer?: GPUBuffer;
    edgeCount: number;
    pointBuffer?: GPUBuffer;
    pointCount: number;
}

interface ColorTarget {
    tex: GPUTexture;
    w: number;
    h: number;
    format: GPUTextureFormat;
}

const VISIBILITY_BITS: Record<string, number> = {
    vertex: GPUShaderStage.VERTEX,
    fragment: GPUShaderStage.FRAGMENT,
    compute: GPUShaderStage.COMPUTE,
};

export class ResourceManager {
    device!: GPUDevice;

    private uniformBuffers = new Map<string, GPUBuffer>();
    private storageBuffers = new Map<string, { buffer: GPUBuffer; size: number }>();
    private meshData = new Map<string, MeshData>();
    private pbrMeshData = new Map<string, PbrMeshData>();
    private meshGpu = new Map<string, MeshGpu>();
    private colorTargets = new Map<string, ColorTarget>();
    private depthTargets = new Map<string, { tex: GPUTexture; w: number; h: number; format: GPUTextureFormat }>();

    /* owner bookkeeping: which app owns each cached resource. 'common' = persistent. */
    private currentOwner = 'common';
    private meshDataOwner = new Map<string, string>();
    private pbrMeshDataOwner = new Map<string, string>();
    private meshGpuOwner = new Map<string, string>();
    private uniformOwner = new Map<string, string>();
    private storageOwner = new Map<string, string>();
    private textureOwner = new Map<string, string>();
    private colorTargetOwner = new Map<string, string>();
    private depthTargetOwner = new Map<string, string>();

    /* handle tables: index 0 reserved as invalid/default */
    private bufferList: (GPUBuffer | null)[] = [null];
    private textureList: (GPUTexture | null)[] = [null];
    private textureKeyToHandle = new Map<string, number>();
    private textures = new Map<string, GPUTexture>();
    /** Free lists for handle recycling: destroyed resources' indices are
     *  pushed here and reused on the next allocation, keeping the handle
     *  tables proportional to live resource count rather than append-only. */
    private bufferFreeList: number[] = [];
    private textureFreeList: number[] = [];

    private bindLayoutDecls = new Map<string, BindEntryDecl[]>();
    private bindLayouts = new Map<string, GPUBindGroupLayout>();
    private samplers = new Map<string, GPUSampler>();
    private renderTargetDecls: RenderTargetDecls = {};
    private namedVbos = new Map<string, GPUBuffer>();
    private fallbackTextures = new Map<string, GPUTexture>();
    /* owner maps for named declaration registries (plugin sweep support) */
    private bindLayoutOwner = new Map<string, string>();
    private samplerOwner = new Map<string, string>();
    private renderTargetOwner = new Map<string, string>();
    private namedVboOwner = new Map<string, string>();
    private fallbackTextureOwner = new Map<string, string>();
    /** Cached default (full) views per GPUTexture. GPUTexture objects are stable
     *  (cached by URL/handle/name and only destroyed on app-switch/resize, which
     *  produces a NEW GPUTexture object), so a WeakMap keyed by the texture yields
     *  the correct cache behaviour: a recreated texture misses the cache and gets
     *  a fresh view, while a stable texture reuses one view across all frames.
     *  Without this, every `tex.createView()` in the per-entity / per-pass paths
     *  would allocate a new GPUTextureView each frame — a severe object leak. */
    private textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

    private _shadow2D: GPUTexture | null = null;
    private _shadow2DW = 0;
    private _shadow2DH = 0;
    private _shadow2DLayers = 0;
    private _shadowPoint: GPUTexture | null = null;
    private _shadowPointW = 0;
    private _shadowPointH = 0;
    private _shadowPointLayers = 0;
    /** Cached 2d-array views of the shadow maps (invalidated when the
     *  underlying textures are recreated by ensureShadowTextures). */
    private _shadow2DArrayView: GPUTextureView | null = null;
    private _shadowPoint2DArrayView: GPUTextureView | null = null;
    /** Cached per-layer / per-face views of the shadow maps (used by the
     *  shadow render passes). Lazily filled by index, invalidated alongside
     *  the array views when the shadow textures are recreated. */
    private _shadow2DLayerViews: (GPUTextureView | null)[] = [];
    private _shadowPointFaceViews: (GPUTextureView | null)[] = [];
    /** Cached frame bind groups. Content-stable across frames (UBOs are
     *  updated in place via writeBuffer; shadow textures only change on
     *  resize), so rebuild only when shadow textures are recreated. Without
     *  this cache, every entity×driver×frame would create a new GPUBindGroup
     *  plus two new shadow TextureViews — a severe GPU-object leak. */
    private _frameBg: GPUBindGroup | null = null;
    private _frameShadowBg: GPUBindGroup | null = null;
    /** Cached per-face shadow bind groups (@group(2) selector UBO wrapper).
     *  Each wraps a stable `shadowPass_${i}` UBO buffer (contents updated in
     *  place each frame); the bind group object itself never changes, so it
     *  is cached per passIndex. Cleared on app switch (the UBO buffers are
     *  app-owned and destroyed in exitApp). */
    private _shadowPassBindGroups = new Map<number, GPUBindGroup>();
    private _shadowPassScratch: Uint32Array = new Uint32Array(4);

    init(device: GPUDevice): void {
        this.device = device;
    }

    /* ── App scope ──────────────────────────────────── */

    /** Mark subsequent resource registrations as owned by `appId` ('common' = persistent). */
    enterApp(appId: string): void {
        this.currentOwner = appId;
    }

    /** Current owner tag for resource registrations. */
    get currentOwnerId(): string {
        return this.currentOwner;
    }

    /** Resource counts for diagnostics / stress testing (all scopes). */
    getStats(): { meshes: number; pbrMeshes: number; meshGpu: number; textures: number; colorTargets: number; depthTargets: number; uniforms: number; storageBuffers: number } {
        return {
            meshes: this.meshData.size,
            pbrMeshes: this.pbrMeshData.size,
            meshGpu: this.meshGpu.size,
            textures: this.textures.size,
            colorTargets: this.colorTargets.size,
            depthTargets: this.depthTargets.size,
            uniforms: this.uniformBuffers.size,
            storageBuffers: this.storageBuffers.size,
        };
    }

    /** Claim a name in a named-decl registry for the current owner.
     *  Cross-owner duplicates throw (fail-loud); same-owner reloads pass. */
    private claimName(owners: Map<string, string>, name: string, kind: string): void {
        const existing = owners.get(name);
        if (existing !== undefined && existing !== this.currentOwner) {
            throw new Error(`${kind} '${name}' already declared by ${existing} (attempted by ${this.currentOwner})`);
        }
        owners.set(name, this.currentOwner);
    }

    /** Release and forget every resource owned by `appId`. 'common' is never released. */
    exitApp(appId: string): void {
        if (appId === 'common') return;
        for (const [name, owner] of this.meshDataOwner) {
            if (owner !== appId) continue;
            this.meshData.delete(name);
            this.meshDataOwner.delete(name);
        }
        for (const [name, owner] of this.pbrMeshDataOwner) {
            if (owner !== appId) continue;
            this.pbrMeshData.delete(name);
            this.pbrMeshDataOwner.delete(name);
        }
        for (const [name, owner] of this.meshGpuOwner) {
            if (owner !== appId) continue;
            const gpu = this.meshGpu.get(name);
            if (gpu) this.destroyMeshGpu(gpu);
            this.meshGpu.delete(name);
            this.meshGpuOwner.delete(name);
        }
        for (const [key, owner] of this.uniformOwner) {
            if (owner !== appId) continue;
            this.uniformBuffers.get(key)?.destroy();
            this.uniformBuffers.delete(key);
            this.uniformOwner.delete(key);
        }
        for (const [key, owner] of this.storageOwner) {
            if (owner !== appId) continue;
            this.storageBuffers.get(key)?.buffer.destroy();
            this.storageBuffers.delete(key);
            this.storageOwner.delete(key);
        }
        for (const [key, owner] of this.textureOwner) {
            if (owner !== appId) continue;
            const tex = this.textures.get(key);
            if (tex) {
                // Drop the cached view promptly so it is GC-eligible without
                // waiting for the destroyed GPUTexture to be collected.
                this.textureViewCache.delete(tex);
                tex.destroy();
            }
            this.textures.delete(key);
            this.textureOwner.delete(key);
            const handle = this.textureKeyToHandle.get(key);
            if (handle !== undefined) {
                this.textureList[handle] = null;
                this.textureFreeList.push(handle);
                this.textureKeyToHandle.delete(key);
            }
        }
        for (const [key, owner] of this.colorTargetOwner) {
            if (owner !== appId) continue;
            const entry = this.colorTargets.get(key);
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            this.colorTargets.delete(key);
            this.colorTargetOwner.delete(key);
        }
        for (const [key, owner] of this.depthTargetOwner) {
            if (owner !== appId) continue;
            const entry = this.depthTargets.get(key);
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            this.depthTargets.delete(key);
            this.depthTargetOwner.delete(key);
        }
        /* named-decl registries (populated by common init or plugins) */
        for (const [name, owner] of this.bindLayoutOwner) {
            if (owner !== appId) continue;
            this.bindLayoutDecls.delete(name);
            this.bindLayouts.delete(name);
            this.bindLayoutOwner.delete(name);
        }
        for (const [name, owner] of this.samplerOwner) {
            if (owner !== appId) continue;
            this.samplers.delete(name);
            this.samplerOwner.delete(name);
        }
        for (const [name, owner] of this.namedVboOwner) {
            if (owner !== appId) continue;
            this.namedVbos.get(name)?.destroy();
            this.namedVbos.delete(name);
            this.namedVboOwner.delete(name);
        }
        for (const [name, owner] of this.fallbackTextureOwner) {
            if (owner !== appId) continue;
            const tex = this.fallbackTextures.get(name);
            if (tex) { this.textureViewCache.delete(tex); tex.destroy(); }
            this.fallbackTextures.delete(name);
            this.fallbackTextureOwner.delete(name);
        }
        for (const [name, owner] of this.renderTargetOwner) {
            if (owner !== appId) continue;
            delete this.renderTargetDecls[name];
            this.renderTargetOwner.delete(name);
        }
        // Invalidate cached frame bind groups: future user-declared app-scoped
        // UBOs (referenced via `resource: "myAppUbo"` in bind-layouts.json) would
        // leave _frameBg/_frameShadowBg pointing at destroyed buffers. The four
        // legacy engine UBOs are common-scoped so this is a no-op for them today,
        // but invalidating eagerly keeps the cache correct under app-scoped growth.
        this._frameBg = null;
        this._frameShadowBg = null;
        // Note: shadow-pass selector UBOs + bind groups are common-owned (not
        // app-scoped) so they survive reload — do not clear _shadowPassBindGroups.
        this.currentOwner = 'common';
    }

    private destroyMeshGpu(gpu: MeshGpu): void {
        for (const buf of Object.values(gpu.slots)) buf?.destroy();
        gpu.index?.destroy();
        gpu.edgeBuffer?.destroy();
        gpu.pointBuffer?.destroy();
        // Recycle registered handles so the handle tables stay proportional
        // to live resources rather than growing without bound.
        for (const handle of Object.values(gpu.slotHandles)) {
            if (handle !== undefined) {
                this.bufferList[handle] = null;
                this.bufferFreeList.push(handle);
            }
        }
        this.bufferList[gpu.indexHandle] = null;
        this.bufferFreeList.push(gpu.indexHandle);
    }

    /* ── Named bind group layouts (bind-layouts.json) ─────── */

    loadBindLayouts(decls: BindLayoutDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.bindLayoutOwner, name, 'Bind layout');
            this.bindLayoutDecls.set(name, decl.entries);
            this.bindLayouts.set(name, this.buildBindLayout(name, decl.entries));
        }
    }

    private buildBindLayout(label: string, entries: BindEntryDecl[]): GPUBindGroupLayout {
        const gpuEntries: GPUBindGroupLayoutEntry[] = entries.map(e => {
            let visibility = 0;
            for (const stage of e.visibility) visibility |= VISIBILITY_BITS[stage] ?? 0;
            const entry: GPUBindGroupLayoutEntry = { binding: e.binding, visibility };
            if (e.buffer) {
                entry.buffer = { type: e.buffer };
            } else if (e.sampler) {
                entry.sampler = { type: e.sampler };
            } else if (e.texture) {
                entry.texture = { sampleType: e.texture };
                if (e.viewDimension) (entry.texture as GPUTextureBindingLayout).viewDimension = e.viewDimension;
            } else if (e.storageTexture) {
                entry.storageTexture = {
                    format: e.storageTexture.format,
                    access: e.storageTexture.access ?? 'write-only',
                };
            }
            return entry;
        });
        return this.device.createBindGroupLayout({ label, entries: gpuEntries });
    }

    namedLayout(name: string): GPUBindGroupLayout {
        const layout = this.bindLayouts.get(name);
        if (!layout) throw new Error(`Bind layout '${name}' not found`);
        return layout;
    }

    pipelineLayout(names: string[]): GPUPipelineLayout {
        return this.device.createPipelineLayout({
            bindGroupLayouts: names.map(n => this.namedLayout(n)),
        });
    }

    /* ── Handle tables ────────────────────────────── */

    private registerBuffer(buffer: GPUBuffer): number {
        const free = this.bufferFreeList.pop();
        if (free !== undefined) {
            this.bufferList[free] = buffer;
            return free;
        }
        this.bufferList.push(buffer);
        return this.bufferList.length - 1;
    }

    getBuffer(handle: number): GPUBuffer | undefined {
        return this.bufferList[handle] ?? undefined;
    }

    getTextureByHandle(handle: number): GPUTexture | undefined {
        return this.textureList[handle] ?? undefined;
    }

    /* ── Mesh registration (SoA) ──────────────────── */

    registerMesh(name: string, data: MeshData): void {
        this.meshData.set(name, data);
        this.meshDataOwner.set(name, this.currentOwner);
    }

    registerPbrMesh(name: string, data: PbrMeshData): void {
        this.pbrMeshData.set(name, data);
        this.pbrMeshDataOwner.set(name, this.currentOwner);
    }

    getMesh(name: string): MeshGpu {
        let gpu = this.meshGpu.get(name);
        if (gpu) return gpu;

        const pbr = this.pbrMeshData.get(name);
        let owner = this.pbrMeshDataOwner.get(name);
        if (pbr) {
            gpu = this.buildPbrMesh(pbr);
        } else {
            const simple = this.meshData.get(name);
            if (!simple) throw new Error(`Mesh '${name}' not registered`);
            gpu = this.buildSimpleMesh(simple);
            owner = this.meshDataOwner.get(name);
        }
        this.meshGpu.set(name, gpu);
        this.meshGpuOwner.set(name, owner ?? this.currentOwner);
        return gpu;
    }

    hasMesh(name: string): boolean {
        return this.meshData.has(name) || this.pbrMeshData.has(name) || this.meshGpu.has(name);
    }

    private makeVertexBuffer(src: ArrayLike<number>): GPUBuffer {
        const arr = Float32Array.from(src);
        const buf = this.device.createBuffer({
            size: Math.max(arr.byteLength, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        if (arr.byteLength > 0) {
            this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        }
        return buf;
    }

    private makeIndexBuffer(indices: number[]): { buffer: GPUBuffer; format: GPUIndexFormat } {
        const count = indices.length;
        const maxIndex = count > 0 ? Math.max(...indices) : 0;
        const use32 = maxIndex > 65535 || count > 65535;
        if (use32) {
            const idx = new Uint32Array(Math.ceil(count / 2) * 2);
            idx.set(indices);
            const buffer = this.device.createBuffer({
                size: Math.max(idx.byteLength, 4),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(buffer, 0, idx.buffer, idx.byteOffset, idx.byteLength);
            return { buffer, format: 'uint32' };
        }
        const idx = new Uint16Array(Math.ceil(count / 2) * 2);
        idx.set(indices);
        const buffer = this.device.createBuffer({
            size: Math.max(idx.byteLength, 4),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, 0, idx.buffer, idx.byteOffset, idx.byteLength);
        return { buffer, format: 'uint16' };
    }

    private buildSimpleMesh(data: MeshData): MeshGpu {
        const posBuf = this.makeVertexBuffer(data.positions);
        const { buffer: index, format } = this.makeIndexBuffer(data.indices);

        const edges = new Float32Array(meshEdges(data));
        const edgeBuffer = this.device.createBuffer({
            size: Math.max(edges.byteLength, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        if (edges.byteLength > 0) {
            this.device.queue.writeBuffer(edgeBuffer, 0, edges.buffer, edges.byteOffset, edges.byteLength);
        }
        const pointBuffer = this.makeVertexBuffer(data.positions);

        const posHandle = this.registerBuffer(posBuf);
        const indexHandle = this.registerBuffer(index);

        return {
            slots: { Pos: posBuf },
            slotHandles: { Pos: posHandle },
            index,
            indexHandle,
            indexFormat: format,
            indexCount: data.indices.length,
            vertexCount: data.positions.length / 3,
            edgeBuffer,
            edgeCount: edges.length / 6,
            pointBuffer,
            pointCount: data.positions.length / 3,
        };
    }

    private buildPbrMesh(data: PbrMeshData): MeshGpu {
        const posBuf = this.makeVertexBuffer(data.positions);
        const nrmBuf = this.makeVertexBuffer(data.normals);
        const uvBuf = this.makeVertexBuffer(data.uvs);
        const tanBuf = this.makeVertexBuffer(data.tangents);
        const { buffer: index, format } = this.makeIndexBuffer(data.indices);

        const slots: Partial<Record<SlotName, GPUBuffer>> = {
            Pos: posBuf, Normal: nrmBuf, UV: uvBuf, Tangent: tanBuf,
        };
        const slotHandles: Partial<Record<SlotName, number>> = {
            Pos: this.registerBuffer(posBuf),
            Normal: this.registerBuffer(nrmBuf),
            UV: this.registerBuffer(uvBuf),
            Tangent: this.registerBuffer(tanBuf),
        };

        return {
            slots,
            slotHandles,
            index,
            indexHandle: this.registerBuffer(index),
            indexFormat: format,
            indexCount: data.indices.length,
            vertexCount: data.positions.length / 3,
            edgeCount: 0,
            pointCount: 0,
        };
    }

    /* ── Shared GPU resources ─────────────────────── */

    loadVboPresets(decls: Record<string, { data: number[]; format: string; stride: number }>): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.namedVboOwner, name, 'VBO preset');
            const arr = Float32Array.from(decl.data);
            const buf = this.device.createBuffer({
                label: `vbo:${name}`,
                size: arr.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
            this.namedVbos.set(name, buf);
        }
    }

    getNamedVBO(name: string): GPUBuffer | undefined {
        return this.namedVbos.get(name);
    }

    get quadVBO(): GPUBuffer {
        const buf = this.namedVbos.get('quad');
        if (!buf) throw new Error(`VBO 'quad' not declared in vbo-presets.json`);
        return buf;
    }

    /** Camera UBO. Backed by BufferRegistry (declared in camera.json `ubos`). */
    get cameraUBO(): GPUBuffer {
        return bufferRegistry.get('camera');
    }

    /** Light UBO. Backed by BufferRegistry (declared in light.json `ubos`). */
    get lightUBO(): GPUBuffer {
        return bufferRegistry.get('light');
    }

    /** Per-point-light cube-face view-projection array (6 faces × up to 4 point lights).
     *  Written by LightSystem; read by the shadow-depth pass (vertex) and PBR (fragment).
     *  Backed by BufferRegistry (declared in light.json `ubos`). */
    get pointShadowFaceUBO(): GPUBuffer {
        return bufferRegistry.get('pointShadowFaces');
    }

    /** TimeInput UBO. Backed by BufferRegistry (declared in input.json `ubos`). */
    get timeInputUBO(): GPUBuffer {
        return bufferRegistry.get('timeInput');
    }

    /** Create (or reuse) the two shadow depth textures from render-targets.json:
     *  shadowDepth2D (one 2d-array layer per directional shadow light) and
     *  shadowPoint2D (a 2d-array with 6 layers per point shadow light, i.e. up to
     *  24 face layers). Point shadows use a 2d-array rather than a cube texture so
     *  face selection is controlled end-to-end (no WebGPU cube-face convention to match). */
    private ensureShadowTextures(): void {
        const decl2D = this.renderTargetDecls['shadowDepth2D'];
        const s2D = this.resolveTargetSize('shadowDepth2D', 1, 1);
        const layers2D = decl2D?.arrayLayers ?? 4;
        if (!this._shadow2D || this._shadow2DW !== s2D.w || this._shadow2DH !== s2D.h || this._shadow2DLayers !== layers2D) {
            this._shadow2D?.destroy();
            this._shadow2D = this.device.createTexture({
                label: 'depth:shadowDepth2D',
                size: { width: s2D.w, height: s2D.h, depthOrArrayLayers: layers2D },
                format: (decl2D?.format as GPUTextureFormat) ?? 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._shadow2DW = s2D.w; this._shadow2DH = s2D.h; this._shadow2DLayers = layers2D;
            // Invalidate caches that reference the old texture's views.
            this._shadow2DArrayView = null;
            this._shadow2DLayerViews.length = 0;
            this._frameBg = null;
            this._frameShadowBg = null;
        }
        const declPoint = this.renderTargetDecls['shadowPoint2D'];
        const sPoint = this.resolveTargetSize('shadowPoint2D', 1, 1);
        const layersPoint = declPoint?.arrayLayers ?? 24;
        if (!this._shadowPoint || this._shadowPointW !== sPoint.w || this._shadowPointH !== sPoint.h || this._shadowPointLayers !== layersPoint) {
            this._shadowPoint?.destroy();
            this._shadowPoint = this.device.createTexture({
                label: 'depth:shadowPoint2D',
                size: { width: sPoint.w, height: sPoint.h, depthOrArrayLayers: layersPoint },
                format: (declPoint?.format as GPUTextureFormat) ?? 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this._shadowPointW = sPoint.w; this._shadowPointH = sPoint.h; this._shadowPointLayers = layersPoint;
            // Invalidate caches that reference the old texture's views.
            this._shadowPoint2DArrayView = null;
            this._shadowPointFaceViews.length = 0;
            this._frameBg = null;
            this._frameShadowBg = null;
        }
    }

    /** Full 2d-array view of the directional shadow map (for PBR sampling). */
    shadowDepth2DArrayView(): GPUTextureView {
        this.ensureShadowTextures();
        if (!this._shadow2DArrayView) {
            this._shadow2DArrayView = this._shadow2D!.createView({ dimension: '2d-array' });
        }
        return this._shadow2DArrayView;
    }

    /** Single-layer 2D view of one directional shadow map (for the shadow render pass). */
    shadowDepth2DLayerView(layer: number): GPUTextureView {
        this.ensureShadowTextures();
        let v = this._shadow2DLayerViews[layer];
        if (!v) {
            v = this._shadow2D!.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 });
            this._shadow2DLayerViews[layer] = v;
        }
        return v;
    }

    /** Full 2d-array view of the point-light shadow map (for PBR sampling). */
    shadowPoint2DArrayView(): GPUTextureView {
        this.ensureShadowTextures();
        if (!this._shadowPoint2DArrayView) {
            this._shadowPoint2DArrayView = this._shadowPoint!.createView({ dimension: '2d-array' });
        }
        return this._shadowPoint2DArrayView;
    }

    /** Single 2D face view of one point-light shadow face (for the shadow render pass).
     *  `faceSlot` = pointShadowMapIndex * 6 + face (0..23). */
    shadowPoint2DFaceView(faceSlot: number): GPUTextureView {
        this.ensureShadowTextures();
        let v = this._shadowPointFaceViews[faceSlot];
        if (!v) {
            v = this._shadowPoint!.createView({ dimension: '2d', baseArrayLayer: faceSlot, arrayLayerCount: 1 });
            this._shadowPointFaceViews[faceSlot] = v;
        }
        return v;
    }

    /** Named depth target view; distinct depth textures keyed by name (data-driven targets).
     *  Format comes from render-targets.json if declared; falls back to 'depth24plus'.
     *
     *  Note: WebGPU requires the depth attachment's size to exactly match the color
     *  attachment's base plane size, so a viewport-sized depth target MUST be
     *  reallocated on every canvas resize. The old GPUTextureView cannot be freed
     *  eagerly (no destroy()), so each resize leaves one stale view until GC — this
     *  is a WebGPU/browser limitation, not an engine bug. */
    namedDepthTargetView(name: string, viewportW: number, viewportH: number): GPUTextureView {
        const { w, h } = this.resolveTargetSize(name, viewportW, viewportH);
        const decl = this.renderTargetDecls[name];
        const format = (decl?.format && decl.format !== 'default'
            ? decl.format : 'depth24plus') as GPUTextureFormat;
        let entry = this.depthTargets.get(name);
        if (!entry || entry.w !== w || entry.h !== h || entry.format !== format) {
            if (entry) { this.textureViewCache.delete(entry.tex); entry.tex.destroy(); }
            const tex = this.device.createTexture({
                label: `depth:${name}`,
                size: { width: w, height: h },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            entry = { tex, w, h, format };
            this.depthTargets.set(name, entry);
            this.depthTargetOwner.set(name, this.currentOwner);
        }
        return this.textureView(entry.tex);
    }

    getUniform(key: string, data: number[] | Float32Array, byteSize: number): GPUBuffer {
        let buf = this.uniformBuffers.get(key);
        if (!buf) {
            buf = this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.uniformBuffers.set(key, buf);
            this.uniformOwner.set(key, this.currentOwner);
        }
        const arr = Float32Array.from(data);
        this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, arr.byteLength);
        return buf;
    }

    getStorageBuffer(key: string, byteSize: number): GPUBuffer {
        let entry = this.storageBuffers.get(key);
        if (!entry || entry.size < byteSize) {
            entry?.buffer.destroy();
            const buffer = this.device.createBuffer({
                size: byteSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            entry = { buffer, size: byteSize };
            this.storageBuffers.set(key, entry);
            this.storageOwner.set(key, this.currentOwner);
        }
        return entry.buffer;
    }

    /* ── Textures ─────────────────────────────────── */

    async loadTexture(url: string): Promise<GPUTexture> {
        let tex = this.textures.get(url);
        if (tex) return tex;

        const resp = await fetch(url);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });

        tex = this.device.createTexture({
            size: { width: bitmap.width, height: bitmap.height },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: tex },
            { width: bitmap.width, height: bitmap.height },
        );
        bitmap.close();

        this.textures.set(url, tex);
        this.textureOwner.set(url, this.currentOwner);
        this.registerTextureHandle(url, tex);
        return tex;
    }

    getTexture(url: string): GPUTexture | undefined {
        return this.textures.get(url);
    }

    private registerTextureHandle(key: string, tex: GPUTexture): number {
        const existing = this.textureKeyToHandle.get(key);
        if (existing) { this.textureList[existing] = tex; return existing; }
        const free = this.textureFreeList.pop();
        let handle: number;
        if (free !== undefined) {
            this.textureList[free] = tex;
            handle = free;
        } else {
            this.textureList.push(tex);
            handle = this.textureList.length - 1;
        }
        this.textureKeyToHandle.set(key, handle);
        return handle;
    }

    textureHandle(key: string): number {
        return this.textureKeyToHandle.get(key) ?? 0;
    }

    async uploadTextureFromImage(key: string, img: ImageBitmap | HTMLImageElement | HTMLCanvasElement, sRGB = false): Promise<GPUTexture> {
        if (this.textures.has(key)) return this.textures.get(key)!;

        const bitmap = img instanceof ImageBitmap ? img : await createImageBitmap(img, { colorSpaceConversion: 'none' });
        const format: GPUTextureFormat = sRGB ? 'rgba8unorm-srgb' : 'rgba8unorm';

        const tex = this.device.createTexture({
            size: { width: bitmap.width, height: bitmap.height },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: tex },
            { width: bitmap.width, height: bitmap.height },
        );
        if (bitmap !== img) bitmap.close();

        this.textures.set(key, tex);
        this.textureOwner.set(key, this.currentOwner);
        this.registerTextureHandle(key, tex);
        return tex;
    }

    colorTarget(key: string, w: number, h: number, format: GPUTextureFormat): GPUTexture {
        const prev = this.colorTargets.get(key);
        if (!prev || prev.w !== w || prev.h !== h || prev.format !== format) {
            if (prev) { this.textureViewCache.delete(prev.tex); prev.tex.destroy(); }
            const tex = this.device.createTexture({
                size: { width: w, height: h },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this.colorTargets.set(key, { tex, w, h, format });
            this.colorTargetOwner.set(key, this.currentOwner);
            return tex;
        }
        return prev.tex;
    }

    get sampler(): GPUSampler {
        return this.namedSampler('default');
    }

    /* ── Named samplers (samplers.json) ───────────── */

    loadSamplers(decls: SamplerDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.samplerOwner, name, 'Sampler');
            this.samplers.set(name, this.device.createSampler({ label: name, ...decl }));
        }
    }

    /* ── Named render targets (render-targets.json) ──── */

    loadRenderTargets(decls: RenderTargetDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.renderTargetOwner, name, 'Render target');
            this.renderTargetDecls[name] = decl;
        }
    }

    /** Resolve a target's actual pixel size from its declaration. */
    private resolveTargetSize(name: string, viewportW: number, viewportH: number): { w: number; h: number } {
        const decl = this.renderTargetDecls[name];
        if (!decl?.size) return { w: viewportW, h: viewportH };
        const size = decl.size;
        if (size.type === 'fixed') {
            return { w: size.w ?? viewportW, h: size.h ?? viewportH };
        }
        const scale = size.scale ?? 1;
        return { w: Math.max(1, Math.round(viewportW * scale)), h: Math.max(1, Math.round(viewportH * scale)) };
    }

    namedSampler(name: string): GPUSampler {
        const s = this.samplers.get(name);
        if (!s) throw new Error(`Sampler '${name}' not declared in samplers.json`);
        return s;
    }

    loadFallbackTextures(decls: Record<string, { pixel: number[]; format: GPUTextureFormat }>): void {
        for (const [name, decl] of Object.entries(decls)) {
            this.claimName(this.fallbackTextureOwner, name, 'Fallback texture');
            const tex = this.device.createTexture({
                label: `fallback:${name}`,
                size: { width: 1, height: 1 },
                format: decl.format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.device.queue.writeTexture(
                { texture: tex },
                new Uint8Array(decl.pixel),
                { bytesPerRow: 4, rowsPerImage: 1 },
                { width: 1, height: 1 },
            );
            this.fallbackTextures.set(name, tex);
        }
    }

    get defaultWhite(): GPUTexture {
        const tex = this.fallbackTextures.get('white');
        if (!tex) throw new Error(`Fallback texture 'white' not declared in fallback-textures.json`);
        return tex;
    }

    get defaultNormal(): GPUTexture {
        const tex = this.fallbackTextures.get('normal');
        if (!tex) throw new Error(`Fallback texture 'normal' not declared in fallback-textures.json`);
        return tex;
    }

    /* ── Bind groups (built against named layouts) ── */

    /** Resolve a single resource entry for a frame bind group. */
    private resolveFrameResource(entry: BindEntryDecl): GPUBindingResource {
        const name = entry.resource ?? '';
        if (name.startsWith('sampler:')) {
            return this.namedSampler(name.slice(8));
        }
        // Buffer resources (UBOs + storage buffers) — registered by name in
        // BufferRegistry (declared via system.json `ubos`/`buffers` fields).
        // The name matches the uniform-layouts.json layout name (for UBOs) or
        // the explicit `name` field (for storage buffers).
        if (bufferRegistry.has(name)) {
            return { buffer: bufferRegistry.get(name) };
        }
        // Shadow texture resources — still special-cased here pending a
        // TextureViewRegistry (Step 9 cleanup).
        switch (name) {
            case 'shadowDepth2DArray':  return this.shadowDepth2DArrayView();
            case 'shadowPoint2DArray':  return this.shadowPoint2DArrayView();
            default: throw new Error(`Unknown frame resource '${name}' in bind-layouts.json`);
        }
    }

    /** Build a frame bind group from the named layout's entry declarations. */
    private buildFrameBindGroup(layoutName: string): GPUBindGroup {
        const entries = this.bindLayoutDecls.get(layoutName);
        if (!entries) throw new Error(`Bind layout '${layoutName}' not declared`);
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries: entries.map(e => ({
                binding: e.binding,
                resource: this.resolveFrameResource(e),
            })),
        });
    }

    frameBindGroup(): GPUBindGroup {
        if (!this._frameBg) this._frameBg = this.buildFrameBindGroup('frame');
        return this._frameBg;
    }

    /** Frame bind group for the shadow render pass: UBOs only (camera/light/time +
     *  pointShadowFaces), no shadow textures (they are the render targets). */
    frameShadowBindGroup(): GPUBindGroup {
        if (!this._frameShadowBg) this._frameShadowBg = this.buildFrameBindGroup('frameShadow');
        return this._frameShadowBg;
    }

    /** Per-face shadow-pass bind group: {lightIdx, face} selecting the current shadow
     *  light and (for point lights) the cube face. Distinct tiny UBOs per pass index
     *  (each written once per frame) avoid the write-after-write hazard of updating a
     *  single shared UBO between render passes in one command buffer.
     *  The bind group wraps the per-passIndex UBO buffer (stable object; its
     *  {lightIdx, face} contents are rewritten each frame via writeBuffer), so the
     *  bind group object is cached per passIndex — only built once, then reused.
     *
     *  The UBO + bind group are common-owned (not app-scoped): the passIndex →
     *  lightIdx/face mapping is rewritten every frame, so they survive app reload
     *  without going stale. This avoids recreating them on every reload (the
     *  browser does not promptly GC GPUBindGroup). */
    shadowPassBindGroup(passIndex: number, lightIdx: number, face: number): GPUBindGroup {
        const key = `shadowPass_${passIndex}`;
        let buf = this.uniformBuffers.get(key);
        if (!buf) {
            buf = this.device.createBuffer({
                size: uniformLayouts.get('shadowPass').byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.uniformBuffers.set(key, buf);
            this.uniformOwner.set(key, 'common');
        }
        const layout = uniformLayouts.get('shadowPass');
        const scratch = this._shadowPassScratch;
        scratch.fill(0);
        layout.writeU32(scratch, 'lightIdx', lightIdx);
        layout.writeU32(scratch, 'face', face);
        this.device.queue.writeBuffer(buf, 0, scratch.buffer, scratch.byteOffset, scratch.byteLength);
        let bg = this._shadowPassBindGroups.get(passIndex);
        if (!bg) {
            bg = this.device.createBindGroup({
                layout: this.namedLayout('shadowPass'),
                entries: [{ binding: 0, resource: { buffer: buf } }],
            });
            this._shadowPassBindGroups.set(passIndex, bg);
        }
        return bg;
    }

    objectBindGroup(uniformBuffer: GPUBuffer): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout('object'),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });
    }

    pbrMaterialBindGroup(
        uniformBuffer: GPUBuffer,
        tex: {
            baseColor?: GPUTexture;
            metallicRoughness?: GPUTexture;
            occlusion?: GPUTexture;
            emissive?: GPUTexture;
            normal?: GPUTexture;
        },
    ): GPUBindGroup {
        const white = this.defaultWhite;
        return this.device.createBindGroup({
            layout: this.namedLayout('materialPbr'),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: (tex.baseColor ?? white).createView() },
                { binding: 3, resource: (tex.metallicRoughness ?? white).createView() },
                { binding: 4, resource: (tex.occlusion ?? white).createView() },
                { binding: 5, resource: (tex.emissive ?? white).createView() },
                { binding: 6, resource: (tex.normal ?? this.defaultNormal).createView() },
            ],
        });
    }

    skyboxMaterialBindGroup(texture: GPUTexture): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout('materialSkybox'),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: texture.createView() },
            ],
        });
    }

    computeBindGroup(layoutName: string, entries: GPUBindGroupEntry[]): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries,
        });
    }

    /** Build a bind group against a named layout from arbitrary entries (data-driven). */
    genericBindGroup(layoutName: string, entries: GPUBindGroupEntry[]): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.namedLayout(layoutName),
            entries,
        });
    }

    /** Cached default view of a GPUTexture. Reused across frames for stable
     *  textures (UBO buffers, shadow maps, render targets, fallback 1x1
     *  textures, loaded asset textures); a fresh view is created only when the
     *  underlying GPUTexture object changes (recreate-on-resize / app switch). */
    textureView(tex: GPUTexture): GPUTextureView {
        let v = this.textureViewCache.get(tex);
        if (!v) {
            v = tex.createView();
            this.textureViewCache.set(tex, v);
        }
        return v;
    }

    /** Fallback 1x1 texture view by name (from fallback-textures.json); no name → white. */
    fallbackTextureView(name?: string): GPUTextureView {
        if (name && !this.fallbackTextures.has(name)) {
            throw new Error(`Fallback texture '${name}' not declared in fallback-textures.json`);
        }
        const tex = name ? this.fallbackTextures.get(name)! : this.defaultWhite;
        return this.textureView(tex);
    }

    /** Named color render target view (offscreen). Size resolved from render-targets.json.
     *  The texture format is taken from the target's declaration (render-targets.json)
     *  when set, so float GBuffer targets keep their format regardless of the caller's
     *  fallback (e.g. the swapchain format passed for the 'scene' target). */
    namedColorTargetView(name: string, viewportW: number, viewportH: number, fallbackFormat: GPUTextureFormat): GPUTextureView {
        const decl = this.renderTargetDecls[name];
        const format = decl?.format && decl.format !== 'default'
            ? (decl.format as GPUTextureFormat)
            : fallbackFormat;
        const { w, h } = this.resolveTargetSize(name, viewportW, viewportH);
        return this.textureView(this.colorTarget(name, w, h, format));
    }

    /** Sampleable view of a named render target for a pipeline that READS it (e.g. a
     *  deferred lighting pass reading the GBuffer). Shares the same underlying texture
     *  as the write-side namedColorTargetView (cached by name in this.colorTargets). */
    renderTargetView(name: string, viewportW: number, viewportH: number): GPUTextureView {
        const decl = this.renderTargetDecls[name];
        const format: GPUTextureFormat = (decl?.format && decl.format !== 'default')
            ? (decl.format as GPUTextureFormat)
            : 'bgra8unorm';
        return this.namedColorTargetView(name, viewportW, viewportH, format);
    }

    fullscreenBindGroup(srcView: GPUTextureView, entry: PipelineEntry): GPUBindGroup {
        if (entry.params) {
            const data: number[] = [];
            for (const values of Object.values(entry.params)) data.push(...values);
            const buf = this.getUniform(`pp_${entry.name}`, data, Math.max(256, data.length * 4));
            return this.device.createBindGroup({
                layout: this.namedLayout('fullscreenParam'),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: srcView },
                    { binding: 2, resource: { buffer: buf } },
                ],
            });
        }
        return this.device.createBindGroup({
            layout: this.namedLayout('fullscreen'),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: srcView },
            ],
        });
    }
}

export const resourceManager = new ResourceManager();

```

## core\render\types.ts

```ts
import type { SlotName } from './vertexSlots';
import type { Scene } from '../ecs/Scene';
import type { FrameContext } from '../ecs/SystemRegistry';

export interface VertexAttributeConfig {
    format: GPUVertexFormat;
    offset: number;
    shaderLocation: number;
}

export interface VertexLayoutConfig {
    arrayStride: number;
    stepMode?: GPUVertexStepMode;
    attributes: VertexAttributeConfig[];
}

export type BlendPreset = string;

/** phases.json: declarative phase list with ordering and behavior tags.
 *  `behavior` names a registered PhaseBehavior ('normal' when omitted);
 *  new behaviors can be registered by plugins — the set is open. */
export interface PhaseDecl {
    name: string;
    order: number;
    behavior: string;
}

export type RenderPhase = string;

export type PhaseMap = Record<string, PipelineEntry[]>;

export interface PipelineConfig {
    name: string;
    vertex: { shader: string; entryPoint: string; input?: string };
    fragment?: { shader: string; entryPoint: string };
    primitive: {
        topology: GPUPrimitiveTopology;
        cullMode: GPUCullMode;
        frontFace?: GPUFrontFace;
    };
    /** Explicit vertex buffer layouts (legacy / special geometry). */
    vertexLayouts?: VertexLayoutConfig[];
    vertexLayout?: VertexLayoutConfig;
    depthStencil: { format?: GPUTextureFormat; [key: string]: unknown } | false;
    blend?: BlendPreset | GPUBlendState;
    targets?: { format?: GPUTextureFormat | 'default' }[];
    /** Named bind group layouts (from bind-layouts.json), in @group order. */
    bindLayout?: string[];
    layout?: 'auto' | GPUPipelineLayoutDescriptor;
    /** Declarative renderer block (data-driven draw); see rendererDecl.ts. */
    renderer?: import('./rendererDecl').RendererDecl;
}

export interface ComputePipelineConfig {
    name: string;
    compute: { shader: string; entryPoint: string };
    workgroupSize?: number;
    bindLayout?: string[];
    layout?: 'auto' | GPUPipelineLayoutDescriptor;
    /** Per-item count read from this component field (dispatch + storage sizing). */
    countField?: string;
    /** Declarative binding sources for the compute bind group (@group0). */
    bindings?: ComputeBindingDecl[];
}

/** One entry in a compute pipeline's declarative bind group. */
export interface ComputeBindingDecl {
    binding: number;
    /** storage = per-entity SSBO; uniform = packed UBO; timeInput = global TimeInput UBO. */
    source: 'storage' | 'uniform' | 'timeInput';
    /** Buffer cache-key prefix (storage/uniform), suffixed with the entity id. */
    key?: string;
    /** storage: bytes per item (buffer size = count * stride). */
    stride?: number;
    /** storage: alternative to stride — use a named uniform layout's byteSize as the per-item size. */
    strideLayout?: string;
    /** uniform: values to pack, each a component field name or `$time` / `$count`. */
    pack?: string[];
}

/** Retained metadata for a compiled compute pipeline. */
export interface ComputeMeta {
    workgroupSize: number;
    bindLayout: string[];
    countField: string;
    bindings: ComputeBindingDecl[];
}

/** samplers.json: named GPUSampler descriptors. */
export interface SamplerDecl {
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    addressModeW?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    compare?: GPUCompareFunction;
}

export type SamplerDecls = Record<string, SamplerDecl>;

/** vertex-inputs.json: named lists of SoA vertex slots. */
export type VertexInputDecls = Record<string, { slots: SlotName[] }>;

/** bind-layouts.json: named GPUBindGroupLayout declarations. */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

export interface BindEntryDecl {
    binding: number;
    visibility: ShaderStage[];
    buffer?: GPUBufferBindingType;
    sampler?: GPUSamplerBindingType;
    texture?: GPUTextureSampleType;
    /** Texture view dimension. Defaults to '2d'; set '2d-array' / 'cube-array' for
     *  layered shadow maps bound as texture_depth_2d_array / texture_depth_cube_array. */
    viewDimension?: GPUTextureViewDimension;
    storageTexture?: { format: GPUTextureFormat; access?: GPUStorageTextureAccess };
    /** Runtime resource name for frame bind group auto-assembly.
     *  - "sampler:<samplerName>" → named sampler from samplers.json
     *  - "<uboName>" → UBO registered by BufferRegistry (declared via
     *    system.json `ubos` field, name matches uniform-layouts.json layout)
     *  - "<storageBufferName>" → storage buffer registered by BufferRegistry
     *    (declared via system.json `buffers[].name`)
     *  - "shadowDepth2DArray" / "shadowPoint2DArray" → legacy shadow map views
     *    (still special-cased pending TextureViewRegistry). */
    resource?: string;
}

export type BindLayoutDecls = Record<string, { entries: BindEntryDecl[] }>;

/** A load-manifest entry (render.json). Behaviour now lives in the pipeline's
 *  own `renderer` block; this just lists which pipelines to load. */
export interface PipelineEntry {
    name: string;
    pipeline: string;
    enabled: boolean;
    /** Legacy/optional kind hint. Loosened from a closed enum to an open
     *  string so apps can use their own kind tags without TS changes. The
     *  only special value consumed by the engine is "compute" (loads the
     *  entry as a compute pipeline instead of a render pipeline). */
    kind?: string;
    /** Post-process params passed to fullscreenParam bind group. */
    params?: Record<string, number[]>;
    /** Optional texture asset (legacy). */
    texture?: string;
    /** Post-process: source texture name (default: previous output or "scene"). */
    input?: string;
    /** Post-process: destination target name (default: next transient or "screen"). */
    output?: string;
}

export interface RenderGraphData {
    name: string;
    /** Scene pass clear color [r,g,b,a]; defaults to a dark blue if omitted. */
    clearColor?: [number, number, number, number];
    phases: Partial<PhaseMap>;
    /** Enable multi-view split-screen rendering. When true, every active Camera
     *  entity renders into its own on-screen `Camera.viewport` rect per frame.
     *  When false (default), only the primary (first active) Camera renders. */
    multiView?: boolean;
}

/* ── Phase behaviors (open pass-strategy registry) ─────────────────── */

/** Pixel rect for a camera's on-screen viewport (scissor + viewport). */
export interface ViewportRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Per-frame info handed to PipelineDriver.record and render hooks. */
export interface DriverFrame {
    time: number;
    dt: number;
    cw: number;
    ch: number;
    /** Opaque plugin-published objects (particles/physics/splats/…). */
    attachments: Record<string, unknown>;
    computePipelines: Map<string, GPUComputePipeline>;
    /** Active camera world position for render-sort (distance-based entity
     *  ordering). Null when no camera is active (sort is skipped). */
    cameraPos: Float32Array | null;
}

/**
 * Facade handed to a PhaseBehavior.run. Deliberately narrow: it exposes the
 * mechanisms a pass strategy needs (encoder, drivers, target metadata, the
 * default record path) without opening the render graph internals.
 */
export interface PhaseBehaviorContext {
    encoder: GPUCommandEncoder;
    phase: PhaseDecl;
    /** Every driver declared in this phase — enabled AND disabled (behaviors
     *  like shadow-clear run even when their pipeline is disabled). */
    drivers: import('./PipelineDriver').PipelineDriver[];
    scene: Scene;
    frame: DriverFrame;
    cw: number;
    ch: number;
    format: GPUTextureFormat;
    swapView: GPUTextureView;
    viewport: ViewportRect | null;
    /** Targets cleared so far this frame (share to merge load/clear ops). */
    cleared: Set<string>;
    /** True when the 'scene' target aliases the swapchain (no post chain). */
    sceneIsScreen: boolean;
    getSystem<T>(name: string): T | null;
    pipelineFor(d: import('./PipelineDriver').PipelineDriver): GPURenderPipeline | undefined;
    /** Names of transient (ping-pong) render targets from render-targets.json. */
    transientTargets(): string[];
    /** The engine's default normal-phase path: group enabled drivers by
     *  (color,depth) target, open merged passes, record every driver. */
    runDefault(): void;
}

/** A pass-execution strategy, registered by name (phases.json `behavior`). */
export interface PhaseBehavior {
    /** Multi-view: run once per camera (true, default) or once per frame
     *  before the per-camera stage (false — e.g. shadow map rendering). */
    perCamera?: boolean;
    run(ctx: PhaseBehaviorContext): void;
}

/* ── Renderer seam (whole-renderer replacement, opt-in) ────────────── */

/**
 * The renderer contract the engine holds. The built-in RenderGraph implements
 * it; a plugin may provide its own via ctx.replaceRenderer (the built-in graph
 * then stays idle). Editor data-plane methods are part of the contract so the
 * pipeline panel keeps working against custom renderers.
 */
export interface IRenderer {
    update(ctx: FrameContext): void;
    compile(device: GPUDevice, format: GPUTextureFormat, dataBase: string, appBase?: string): Promise<void>;
    fromData(data: RenderGraphData): void;
    toData(): RenderGraphData;
    exitApp(appId: string): void;
    registerPhaseBehavior(name: string, behavior: PhaseBehavior, owner?: string): void;
}

```

## core\render\UniformLayout.ts

```ts
/**
 * std140 uniform block layout, data-driven from uniform-layouts.json.
 *
 * Given a named list of members, computes each member's float offset following
 * WGSL uniform (std140) alignment rules, so the renderer can write fields by
 * name instead of hard-coded array indices.
 */

export type UniformMemberType =
    | 'f32' | 'i32' | 'u32'
    | 'vec2f' | 'vec3f' | 'vec4f'
    | 'mat3x3f' | 'mat4x4f';

export interface UniformMemberDecl {
    name: string;
    type: UniformMemberType;
}

export type UniformLayoutDecls = Record<string, UniformMemberDecl[]>;

interface TypeInfo {
    align: number;   // bytes
    size: number;    // bytes
}

const TYPE_INFO: Record<UniformMemberType, TypeInfo> = {
    f32:     { align: 4,  size: 4 },
    i32:     { align: 4,  size: 4 },
    u32:     { align: 4,  size: 4 },
    vec2f:   { align: 8,  size: 8 },
    vec3f:   { align: 16, size: 12 },
    vec4f:   { align: 16, size: 16 },
    mat3x3f: { align: 16, size: 48 },   // 3 columns, each vec3 padded to 16
    mat4x4f: { align: 16, size: 64 },
};

function alignUp(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
}

interface MemberOffset {
    type: UniformMemberType;
    byteOffset: number;
    floatOffset: number;
}

export class UniformLayout {
    /** Total block size in bytes, rounded up to a 16-byte boundary. */
    readonly byteSize: number;
    /** Total block size in floats. */
    readonly floatCount: number;

    private members = new Map<string, MemberOffset>();

    constructor(decls: UniformMemberDecl[]) {
        let offset = 0;
        for (const m of decls) {
            const info = TYPE_INFO[m.type];
            offset = alignUp(offset, info.align);
            this.members.set(m.name, { type: m.type, byteOffset: offset, floatOffset: offset / 4 });
            offset += info.size;
        }
        this.byteSize = alignUp(offset, 16);
        this.floatCount = this.byteSize / 4;
    }

    /** Float index of a member within the block (throws if unknown). */
    floatOffsetOf(name: string): number {
        const m = this.members.get(name);
        if (!m) throw new Error(`Uniform member '${name}' not declared`);
        return m.floatOffset;
    }

    /** Whether a member is declared in this layout. */
    has(name: string): boolean {
        return this.members.has(name);
    }

    /** Allocate a zeroed Float32Array sized for this block. */
    createBuffer(): Float32Array {
        return new Float32Array(this.floatCount);
    }

    /** Write a scalar or vector/matrix component array into a member slot. */
    write(buf: Float32Array, name: string, value: number | ArrayLike<number>): void {
        const base = this.floatOffsetOf(name);
        if (typeof value === 'number') {
            buf[base] = value;
        } else {
            buf.set(value, base);
        }
    }

    /** Write a u32 value into a member slot (via a Uint32Array view of the same buffer). */
    writeU32(buf: Uint32Array, name: string, value: number): void {
        const base = this.floatOffsetOf(name);
        buf[base] = value >>> 0;
    }
}

export class UniformLayoutRegistry {
    private layouts = new Map<string, UniformLayout>();
    /** Layout name → owner tag ('engine' | 'plugin:<id>'). */
    private owners = new Map<string, string>();

    load(decls: UniformLayoutDecls, owner = 'engine'): void {
        for (const [name, members] of Object.entries(decls)) {
            const existing = this.owners.get(name);
            if (existing !== undefined && existing !== owner) {
                throw new Error(`Uniform layout '${name}' already declared by ${existing} (attempted by ${owner})`);
            }
            this.owners.set(name, owner);
            this.layouts.set(name, new UniformLayout(members));
        }
    }

    /** Remove every layout registered by `owner` (plugin unload). */
    removeOwner(owner: string): void {
        for (const [name, o] of [...this.owners]) {
            if (o !== owner) continue;
            this.owners.delete(name);
            this.layouts.delete(name);
        }
    }

    has(name: string): boolean {
        return this.layouts.has(name);
    }

    get(name: string): UniformLayout {
        const layout = this.layouts.get(name);
        if (!layout) throw new Error(`Uniform layout '${name}' not found`);
        return layout;
    }
}

export const uniformLayouts = new UniformLayoutRegistry();

```

## core\render\valueResolver.ts

```ts
import { normalMatrixInto } from '../math';
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
    /** Lazily-computed model matrix for the current entity. Returns a reference
     *  to a scratch buffer — consume immediately, do not retain across calls. */
    model(): Float32Array;
    /** Named value scripts (script:file.fn) resolved at compile time. */
    scripts: Map<string, (ctx: ValueContext) => number[] | number>;
}

/** A resolver for a single field within a namespace (e.g. builtin.time, transform.model). */
export type AtomResolver = (ctx: ValueContext) => number | ArrayLike<number>;

/** Resolver tables for each namespace prefix (builtin, transform, tag). */
export const atomNamespaces: Record<string, Record<string, AtomResolver>> = {
    builtin: {},
    transform: {},
    tag: {},
};

/** Scratch buffers for transform atoms — reused per resolve to avoid
 *  allocation. Safe because resolved values are consumed immediately by
 *  UniformLayout.write before the next resolve overwrites the scratch. */
const _scratchNormal = new Float32Array(12);

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
    // Return the model scratch buffer directly (no Array.from copy).
    model:        (ctx) => ctx.model(),
    // Compute into a scratch buffer; safe because consumed immediately.
    normalMatrix: (ctx) => normalMatrixInto(ctx.model(), _scratchNormal),
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
export function resolveValue(src: string, ctx: ValueContext): number | ArrayLike<number> {
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
function resolveAtom(src: string, ctx: ValueContext): number | ArrayLike<number> {
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
        if (typeof v === 'number') {
            out.push(v);
        } else {
            // ArrayLike<number> (number[] or Float32Array) — copy all elements
            for (let i = 0; i < v.length; i++) out.push(v[i]);
        }
    }
    return out;
}

/** Resolve a value-source expected to be a single integer handle (textures, etc). */
export function resolveHandle(src: string, ctx: ValueContext): number {
    const v = resolveValue(src, ctx);
    return typeof v === 'number' ? v : (v[0] ?? 0);
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

// ── Compile-time precompilation ──────────────────────────────────
// The functions below pre-compile value-source strings into closures at
// pipeline-construction time, so the per-entity hot path only invokes a
// closure — no indexOf/split/schemaRegistry.get string parsing per frame.

/** A precompiled value source: call with a ValueContext to get the value. */
export type CompiledValue = (ctx: ValueContext) => number | ArrayLike<number>;

/** Precompile a value-source string into a closure. */
export function compileValue(src: string): CompiledValue {
    const colon = src.indexOf(':');
    const prefix = colon >= 0 ? src.slice(0, colon) : '';
    const rest = colon >= 0 ? src.slice(colon + 1) : src;

    switch (prefix) {
        case 'pack':
            return compilePack(rest);
        case 'const': {
            const nums = rest.split(',').map(s => Number(s.trim()));
            return () => nums;
        }
        case 'script':
            return (ctx) => {
                const fn = ctx.scripts.get(rest);
                if (!fn) {
                    throw new Error(
                        `Value script '${rest}' not found — is its file listed in render.json "renderScripts" ` +
                        `and does it export that function?`,
                    );
                }
                return fn(ctx);
            };
        default:
            return compileAtom(src);
    }
}

/** Precompile a single (non-prefixed) atom. */
function compileAtom(src: string): CompiledValue {
    const asNum = Number(src);
    if (!Number.isNaN(asNum)) return () => asNum;

    const dot = src.indexOf('.');
    if (dot < 0) {
        throw new Error(`Cannot compile value atom '${src}' (expected number, Comp.field, builtin.*, transform.* or tag.*)`);
    }

    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);

    const ns = atomNamespaces[head];
    if (ns) {
        const fn = ns[field];
        if (!fn) {
            throw new Error(`Unknown value atom '${src}' (known ${head}.*: ${Object.keys(ns).join(', ')})`);
        }
        return fn;
    }

    if (!schemaRegistry.get(head)) {
        throw new Error(`Value source '${src}' references unknown component '${head}'`);
    }
    const compName = head;
    const fieldName = field;
    return (ctx) => {
        const v = ctx.scene.getField(ctx.eid, compName, fieldName);
        if (Array.isArray(v)) return v.map(Number);
        return Number(v ?? 0);
    };
}

/** Precompile a pack: list into a closure that concatenates resolved atoms. */
function compilePack(list: string): CompiledValue {
    const parts: Array<{ num: number; fn: CompiledValue | null }> = [];
    for (const raw of list.split(',')) {
        const token = raw.trim();
        if (token === '') continue;
        if (/^-?\d*\.?\d+$/.test(token)) {
            parts.push({ num: Number(token), fn: null });
        } else {
            parts.push({ num: 0, fn: compileAtom(token) });
        }
    }
    return (ctx) => {
        const out: number[] = [];
        for (const p of parts) {
            if (p.fn === null) { out.push(p.num); continue; }
            const v = p.fn(ctx);
            if (typeof v === 'number') {
                out.push(v);
            } else {
                for (let i = 0; i < v.length; i++) out.push(v[i]);
            }
        }
        return out;
    };
}

/** A precompiled string source (mesh names). */
export type CompiledString = (ctx: ValueContext) => string;

/** Precompile a string-source into a closure. */
export function compileString(src: string): CompiledString {
    const dot = src.indexOf('.');
    if (dot < 0) return () => src;
    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);
    if (head === 'builtin' || head === 'transform' || head === 'tag') return () => src;
    if (!schemaRegistry.get(head)) {
        throw new Error(`String source '${src}' references unknown component '${head}'`);
    }
    const compName = head;
    const fieldName = field;
    return (ctx) => {
        const v = ctx.scene.getField(ctx.eid, compName, fieldName);
        return typeof v === 'string' ? v : String(v ?? '');
    };
}

```

## core\render\vertexSlots.ts

```ts
export type SlotName = string;

export interface SlotDef {
    location: number;
    format: GPUVertexFormat;
    stride: number;
    components: number;
}

export type VertexSlotDecls = Record<string, SlotDef>;

export const VERTEX_SLOTS: Record<SlotName, SlotDef> = {};

export const SLOT_ORDER: SlotName[] = [];

/** Slot name → owner tag ('engine' | 'plugin:<id>'). */
const SLOT_OWNERS = new Map<SlotName, string>();

export function loadVertexSlots(decls: VertexSlotDecls, owner = 'engine'): void {
    for (const [name, def] of Object.entries(decls)) {
        const existing = SLOT_OWNERS.get(name);
        if (existing !== undefined) {
            if (existing !== owner) {
                throw new Error(`Vertex slot '${name}' already declared by ${existing} (attempted by ${owner})`);
            }
            VERTEX_SLOTS[name] = def;   // same-owner reload → refresh decl
            continue;
        }
        const clash = Object.entries(VERTEX_SLOTS).find(([n, d]) => n !== name && d.location === def.location);
        if (clash) {
            throw new Error(`Vertex slot '${name}' location ${def.location} already used by slot '${clash[0]}'`);
        }
        SLOT_OWNERS.set(name, owner);
        VERTEX_SLOTS[name] = def;
        SLOT_ORDER.push(name);
    }
    SLOT_ORDER.sort((a, b) => VERTEX_SLOTS[a].location - VERTEX_SLOTS[b].location);
}

/** Remove every slot registered by `owner` (plugin unload). */
export function removeVertexSlotsByOwner(owner: string): void {
    for (const [name, o] of [...SLOT_OWNERS]) {
        if (o !== owner) continue;
        SLOT_OWNERS.delete(name);
        delete VERTEX_SLOTS[name];
        const i = SLOT_ORDER.indexOf(name);
        if (i >= 0) SLOT_ORDER.splice(i, 1);
    }
}

export function isSlotName(name: string): name is SlotName {
    return name in VERTEX_SLOTS;
}

```

## core\tools\ToolRegistry.ts

```ts
import type { ToolFactory } from '../../editor/input/SceneTool';

export type { ToolFactory } from '../../editor/input/SceneTool';

/** Module-level registry of tool factories, keyed by config `type`. Populated
 *  entirely by plugins (ctx.registerToolType) — the engine ships no built-in
 *  tools. Lives in core (no DOM/editor deps) so plugins may register tool
 *  types in player mode too; only the editor's input manager ever instantiates
 *  them from a tools.json config. */
export const TOOL_REGISTRY: Record<string, ToolFactory> = {};

/** Register a tool type (plugins). Duplicate names throw (fail-loud). */
export function registerToolType(type: string, factory: ToolFactory): void {
    if (TOOL_REGISTRY[type]) throw new Error(`Tool type '${type}' already registered`);
    TOOL_REGISTRY[type] = factory;
}

/** Remove a tool type (plugin unload). */
export function unregisterToolType(type: string): void {
    delete TOOL_REGISTRY[type];
}

```

## editor\dom.ts

```ts
export function ce(tag: string, cls?: string, text?: string): HTMLElement {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
}

export function makeSelect(options: string[], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = ce('select', 'ed-select') as HTMLSelectElement;
    for (const opt of options) {
        const o = ce('option') as HTMLOptionElement;
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
    }
    sel.value = value;
    sel.onchange = () => onChange(sel.value);
    return sel;
}

export function makeCheckbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const chk = ce('input', 'ed-check') as HTMLInputElement;
    chk.type = 'checkbox';
    chk.checked = checked;
    chk.onchange = () => onChange(chk.checked);
    return chk;
}

export interface FloatField {
    el: HTMLElement;
    setValue(v: number): void;
}

export function makeFloatField(initial: number, onChange: (v: number) => void): FloatField {
    const wrap = ce('div', 'ed-float-wrap') as HTMLElement;
    const display = ce('span', 'ed-float-val');
    const step = 0.1;

    const format = (v: number) => {
        if (Number.isInteger(v)) return String(v);
        const fixed = v.toFixed(4);
        return parseFloat(fixed).toString();
    };
    display.textContent = format(initial);

    let dragging = false;
    let editing = false;
    let startX = 0;
    let startVal = initial;
    let currentVal = initial;

    const onMouseMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        currentVal = parseFloat((startVal + dx * step).toFixed(4));
        display.textContent = format(currentVal);
        onChange(currentVal);
    };

    const onMouseUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    display.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startVal = currentVal;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    display.addEventListener('dblclick', () => {
        if (dragging) return;
        editing = true;
        const input = ce('input', 'ed-float-edit') as HTMLInputElement;
        input.type = 'number';
        input.step = String(step);
        input.value = String(currentVal);
        input.style.width = '100%';
        wrap.replaceChildren(input);
        input.focus();
        input.select();

        const commit = () => {
            const v = parseFloat(input.value);
            if (!isNaN(v)) {
                currentVal = v;
                display.textContent = format(v);
                onChange(v);
            }
            editing = false;
            wrap.replaceChildren(display);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { editing = false; wrap.replaceChildren(display); }
        });
    });

    wrap.appendChild(display);
    return {
        el: wrap,
        setValue(v: number): void {
            if (dragging || editing) return;
            if (v === currentVal) return;
            currentVal = v;
            display.textContent = format(v);
        },
    };
}

```

## editor\EditorCommandBus.ts

```ts
import type { Engine } from '../core/Engine';
import type { Command, CommandContext } from './commands/Command';
import {
    SetFieldCommand,
    CreateEntityCommand,
    RemoveEntityCommand,
    LoadSceneDataCommand,
    ToggleComponentCommand,
} from './commands/SceneCommands';
import {
    MutateRenderGraphCommand,
    PatchRenderGraphCommand,
    MutatePipelineConfigCommand,
} from './commands/RenderGraphCommands';
import type { SceneData } from '../core/ecs/Scene';
import type { RenderGraphData } from '../core/render/types';

export type EditMode = 'edit' | 'play' | 'pause';

/**
 * Editor command channel: the ONLY path by which editor UI state changes reach
 * the engine. Dispatches execute commands with undo/redo + edit-mode gating,
 * then broadcast `editor:changed` for panels to refresh. UI never touches the
 * engine registries/scene/render-graph write methods directly.
 */
export class EditorCommandBus {
    private mode: EditMode = 'edit';
    private undoStack: Command[] = [];
    private redoStack: Command[] = [];
    private maxHistory = 50;
    private editSnapshot: object | null = null;

    constructor(private _engine: Engine) {}

    get engine(): Engine { return this._engine; }
    get editMode(): EditMode { return this.mode; }
    get scene() { return this._engine.scene; }
    get renderGraph() { return this._engine.renderGraph; }

    play(): void {
        if (this.mode === 'play') return;
        this.editSnapshot = {
            scene: this._engine.exportScene(),
            renderGraph: this._engine.exportRenderGraph(),
        };
        this.mode = 'play';
        this._engine.eventBus.emit('editor:play');
    }

    pause(): void {
        if (this.mode !== 'play') return;
        this.mode = 'pause';
        this._engine.eventBus.emit('editor:pause');
    }

    stop(): void {
        if (this.mode === 'edit') return;
        this.mode = 'edit';
        if (this.editSnapshot) {
            const s = this.editSnapshot as { scene: unknown; renderGraph: unknown };
            this._engine.loadSceneData(s.scene as SceneData);
            this._engine.renderGraph.fromData(s.renderGraph as RenderGraphData);
        }
        this._engine.eventBus.emit('editor:stop');
    }

    dispatch(cmd: Command): boolean {
        if (this.mode !== 'edit') {
            console.warn(`[EditorCommandBus] Blocked ${cmd.type} while in ${this.mode} mode`);
            return false;
        }
        const ctx: CommandContext = { engine: this._engine };
        if (!cmd.execute(ctx)) return false;

        this.undoStack.push(cmd);
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
        this.redoStack.length = 0;
        this._engine.eventBus.emit('editor:changed', { source: cmd.type });
        return true;
    }

    undo(): void {
        if (this.undoStack.length === 0) return;
        const cmd = this.undoStack.pop()!;
        cmd.undo({ engine: this._engine });
        this.redoStack.push(cmd);
        this._engine.eventBus.emit('editor:changed', { source: 'undo' });
    }

    redo(): void {
        if (this.redoStack.length === 0) return;
        const cmd = this.redoStack.pop()!;
        cmd.execute({ engine: this._engine });
        this.undoStack.push(cmd);
        this._engine.eventBus.emit('editor:changed', { source: 'redo' });
    }

    setField(entityKey: string, comp: string, field: string, value: unknown): boolean {
        return this.dispatch(new SetFieldCommand(entityKey, comp, field, value));
    }

    createEntity(key: string, data: Record<string, Record<string, unknown>>): boolean {
        return this.dispatch(new CreateEntityCommand(key, data));
    }

    removeEntity(key: string): boolean {
        return this.dispatch(new RemoveEntityCommand(key));
    }

    loadSceneData(data: SceneData, prevData?: string): boolean {
        return this.dispatch(new LoadSceneDataCommand(data, prevData));
    }

    toggleComponent(entityKey: string, compName: string, enabled: boolean): boolean {
        return this.dispatch(new ToggleComponentCommand(entityKey, compName, enabled));
    }

    mutateRenderGraph(data: object): boolean {
        return this.dispatch(new MutateRenderGraphCommand(data));
    }

    patchRenderGraph(data: RenderGraphData, prevData?: string): boolean {
        return this.dispatch(new PatchRenderGraphCommand(data, prevData));
    }

    mutatePipelineConfig(pipeline: string, nextJson: string, prevJson?: string): boolean {
        return this.dispatch(new MutatePipelineConfigCommand(pipeline, nextJson, prevJson));
    }
}

```

## editor\EditorPanel.ts

```ts
import type { EditorCommandBus } from './EditorCommandBus';
import { schemaRegistry } from '../core/ecs/SchemaRegistry';
import type { SceneData } from '../core/ecs/Scene';
import { ce, makeFloatField, makeSelect } from './dom';

export class EditorPanel {
    private panel: HTMLElement;
    private bus!: EditorCommandBus;
    private unsubscribe?: () => void;
    private selected = '';
    private syncers: (() => void)[] = [];
    private lastEntityCount = -1;
    /** Scroll position of the entity list (preserved across re-renders). */
    private entityScrollTop = 0;
    /** Estimated entity row height in pixels (matches CSS ed-ent-row). */
    private readonly ROW_H = 28;
    /** Maximum visible rows in the entity list viewport. */
    private readonly VISIBLE_ROWS = 18;
    /** Called when loadJSON receives an app.json manifest; the host layer wires
     *  this to engine.loadApp + panel refresh so glTF / render graph reload. */
    onAppSwitch?: (name: string) => Promise<void>;

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(bus: EditorCommandBus): void {
        this.bus = bus;
        // Idempotent: app switch clears the event bus, so re-attaching must not
        // double-subscribe.
        this.unsubscribe?.();
        this.unsubscribe = bus.engine.eventBus.on('editor:changed', () => {
            const count = bus.scene.entityKeyMap.size;
            if (count !== this.lastEntityCount) {
                this.lastEntityCount = count;
                this.render();
                return;
            }
            for (const sync of this.syncers) sync();
        });
    }

    render(): void {
        this.panel.innerHTML = '';
        this.syncers = [];
        const scene = this.bus.scene;
        this.lastEntityCount = scene.entityKeyMap.size;

        // ── Header ──
        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Scene Editor'));
        const btns = ce('div', 'editor-btn-row');
        btns.appendChild(this.btn('Save JSON', () => this.saveJSON()));
        btns.appendChild(this.btn('Load JSON', () => this.loadJSON()));
        head.appendChild(btns);
        this.panel.appendChild(head);

        // ── Entity list (virtual scroll) ──
        const list = ce('div', 'ed-ent-list');
        const listHead = ce('div', 'ed-ent-list-head');
        listHead.appendChild(ce('span', '', 'Entities'));
        const ab = ce('div', 'ed-ent-list-actions');
        ab.appendChild(this.btn('+', () => this.addEntity()));
        ab.appendChild(this.btn('✕', () => { if (this.selected) { this.bus.removeEntity(this.selected); this.selected = ''; this.render(); } }));
        listHead.appendChild(ab);
        list.appendChild(listHead);

        const allEntities = scene.getAllEntities();
        const total = allEntities.length;
        const rowsScroll = ce('div', 'ed-ent-rows');
        rowsScroll.style.maxHeight = `${this.ROW_H * this.VISIBLE_ROWS}px`;
        rowsScroll.style.overflowY = 'auto';
        rowsScroll.style.position = 'relative';
        rowsScroll.scrollTop = this.entityScrollTop;
        rowsScroll.onscroll = () => {
            this.entityScrollTop = rowsScroll.scrollTop;
            this.renderVisibleRows(content, allEntities);
        };

        // Content container sized to the full list height so the scrollbar
        // reflects the true entity count; only visible rows are in the DOM.
        const content = ce('div');
        content.style.height = `${total * this.ROW_H}px`;
        content.style.position = 'relative';
        this.renderVisibleRows(content, allEntities);
        rowsScroll.appendChild(content);
        list.appendChild(rowsScroll);

        if (!this.selected && scene.entityKeyMap.size > 0) {
            this.selected = [...scene.entityKeyMap.keys()][0];
        }
        this.panel.appendChild(list);

        // ── Selected entity detail ──
        if (this.selected && scene.entityKeyMap.has(this.selected)) {
            const eid = scene.entityKeyMap.get(this.selected)!;
            const detail = this.renderDetail(eid);
            this.panel.appendChild(detail);
        }
    }

    /** Render only the entity rows visible in the scroll viewport (+ a small
     *  overscan buffer). Rows are absolutely positioned within the content
     *  container so the scrollbar reflects the true entity count without
     *  materializing a DOM node per entity. */
    private renderVisibleRows(content: HTMLElement, allEntities: { key: string }[]): void {
        content.innerHTML = '';
        const total = allEntities.length;
        const overscan = 5;
        const start = Math.max(0, Math.floor(this.entityScrollTop / this.ROW_H) - overscan);
        const end = Math.min(total, start + this.VISIBLE_ROWS + overscan * 2);
        for (let i = start; i < end; i++) {
            const { key } = allEntities[i];
            const row = ce('div', `ed-ent-row ${this.selected === key ? 'ed-ent-sel' : ''}`);
            row.style.position = 'absolute';
            row.style.top = `${i * this.ROW_H}px`;
            row.style.height = `${this.ROW_H}px`;
            row.style.width = '100%';
            row.style.boxSizing = 'border-box';
            const eid = this.bus.scene.entityKeyMap.get(key);
            const name = eid != null
                ? (this.bus.scene.getField(eid, 'NameComponent', 'name') as string ?? key)
                : key;
            row.appendChild(ce('span', 'ed-ent-name', name));
            row.onclick = () => { this.selected = key; this.render(); };
            content.appendChild(row);
        }
    }

    private renderDetail(eid: number): HTMLElement {
        const scene = this.bus.scene;
        const wrap = ce('div', 'ed-detail');

        const hdr = ce('div', 'ed-detail-head');
        const name = scene.getField(eid, 'NameComponent', 'name') as string ?? this.selected;
        hdr.appendChild(ce('span', '', `Components — ${name}`));
        wrap.appendChild(hdr);

        const compNames = scene.componentNames
            .filter(compName => {
                const def = schemaRegistry.getDef(compName);
                return def && Object.keys(def.fields).length > 0;
            })
            .sort((a, b) => Number(scene.hasComponent(eid, b)) - Number(scene.hasComponent(eid, a)));

        for (const compName of compNames) {
            const def = schemaRegistry.getDef(compName)!;

            const hasComp = scene.hasComponent(eid, compName);
            const locked = schemaRegistry.mandatory.has(compName);

            const compDiv = ce('div', `ed-comp ${hasComp ? '' : 'ed-comp-off'}`);
            const compHead = ce('div', 'ed-comp-head');

            if (locked) {
                compHead.appendChild(ce('span', 'ed-lock', '🔒'));
            } else {
                const chk = ce('input') as HTMLInputElement;
                chk.type = 'checkbox'; chk.checked = hasComp;
                chk.onchange = () => { this.bus.toggleComponent(this.selected, compName, chk.checked); this.render(); };
                compHead.appendChild(chk);
            }
            compHead.appendChild(ce('span', '', compName));
            compDiv.appendChild(compHead);

            if (hasComp) {
                const grid = ce('div', 'ed-fields');
                for (const [fieldName, fd] of Object.entries(def.fields)) {
                    grid.appendChild(this.renderField(this.selected, eid, compName, fieldName, fd));
                }
                compDiv.appendChild(grid);
            }
            wrap.appendChild(compDiv);
        }
        return wrap;
    }

    private renderField(entityKey: string, eid: number, compName: string, field: string, fd: { type: string; default: unknown; options?: string[] }): HTMLElement {
        const scene = this.bus.scene;
        const row = ce('div', 'ed-field-row');
        row.appendChild(ce('label', 'ed-field-label', field));

        const val = scene.getField(eid, compName, field);
        const numInputs = ce('div', 'ed-field-inputs');

        if (fd.type === 'string' && fd.options) {
            const sel = makeSelect(fd.options, (val as string) ?? String(fd.default), v => this.bus.setField(entityKey, compName, field, v));
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field) as string | undefined;
                if (cur != null) sel.value = cur;
            });
            numInputs.appendChild(sel);
        } else if (fd.type === 'string') {
            const inp = this.makeInput('text', val as string, v => this.bus.setField(entityKey, compName, field, v));
            numInputs.appendChild(inp);
        } else if (fd.type === 'bool') {
            const chk = ce('input', 'ed-check') as HTMLInputElement;
            chk.type = 'checkbox';
            chk.checked = Number(val ?? fd.default) === 1;
            chk.onchange = () => this.bus.setField(entityKey, compName, field, chk.checked ? 1 : 0);
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field);
                if (cur != null) chk.checked = Number(cur) === 1;
            });
            numInputs.appendChild(chk);
        } else if (fd.type === 'f32' || fd.type === 'u32') {
            const defVal = (fd.default as number[]) ?? [0];
            const v = val != null ? Number(val) : defVal[0] ?? 0;
            const el = makeFloatField(v, newVal => {
                this.bus.setField(entityKey, compName, field, newVal);
            });
            this.syncers.push(() => {
                const cur = scene.getField(eid, compName, field);
                if (cur != null) el.setValue(Number(cur));
            });
            numInputs.appendChild(el.el);
        } else if (fd.type === 'vec2' || fd.type === 'vec3' || fd.type === 'vec4') {
            const count = parseInt(fd.type[3]);
            const arr = (Array.isArray(val) ? val : (fd.default as number[])) as number[];
            for (let i = 0; i < count; i++) {
                const el = makeFloatField(arr[i] ?? 0, newVal => {
                    const a = [...(scene.getField(eid, compName, field) as number[] ?? (fd.default as number[]))];
                    for (let j = 0; j < count; j++) a[j] = a[j] ?? 0;
                    a[i] = newVal;
                    this.bus.setField(entityKey, compName, field, a);
                });
                this.syncers.push(() => {
                    const cur = scene.getField(eid, compName, field) as number[] | undefined;
                    if (cur?.[i] != null) el.setValue(cur[i]);
                });
                numInputs.appendChild(el.el);
            }
        }
        row.appendChild(numInputs);
        return row;
    }

    private makeInput(type: string, val: string, onChange: (v: string) => void): HTMLInputElement {
        const inp = ce('input', 'ed-input') as HTMLInputElement;
        inp.type = type; inp.value = val;
        inp.onchange = () => onChange(inp.value);
        return inp;
    }

    private btn(text: string, cb: () => void): HTMLButtonElement {
        const b = ce('button', 'editor-btn', text);
        b.onclick = cb; return b as HTMLButtonElement;
    }

    private addEntity(): void {
        const name = prompt('Entity name:', 'NewEntity');
        if (!name) return;
        this.bus.createEntity(name, {});
        this.selected = name;
        this.render();
    }

    /** Select an entity by key (from 3D picking or the entity list). */
    select(key: string): void {
        if (!this.bus.scene.entityKeyMap.has(key)) return;
        this.selected = key;
        this.render();
    }

    private saveJSON(): void {
        const json = { entities: this.bus.scene.toJSON() };
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'scene.json'; a.click();
    }

    private loadJSON(): void {
        const input = ce('input') as HTMLInputElement;
        input.type = 'file'; input.accept = '.json';
        input.onchange = async () => {
            const file = input.files?.[0]; if (!file) return;
            const json = JSON.parse(await file.text()) as Record<string, unknown>;
            // App manifest (has gltf/render/scene-as-string) → full app reload,
            // which re-loads glTF models, render graph and tools via loadApp.
            const isAppManifest = !!json.gltf || !!json.render
                || (typeof json.scene === 'string');
            if (isAppManifest) {
                const name = json.name as string | undefined;
                if (!name) { alert('app manifest missing "name" field'); return; }
                if (!this.onAppSwitch) {
                    alert('No app-switch handler wired (run through the host layer).');
                    return;
                }
                await this.onAppSwitch(name);
            } else {
                // Scene entity data → reload entities in place (no glTF / render graph).
                this.bus.loadSceneData(
                    (json.entities ?? json) as SceneData,
                    JSON.stringify(this.bus.scene.toJSON()),
                );
            }
            this.selected = '';
            this.render();
        };
        input.click();
    }
}

```

## editor\PipelinePanel.ts

```ts
import type { EditorCommandBus } from './EditorCommandBus';
import { type PipelineEntry, type PipelineConfig, type RenderGraphData } from '../core/render/types';
import { PipelineLoader } from '../core/render/PipelineLoader';
import { ce, makeFloatField, makeSelect, makeCheckbox } from './dom';

const TOPOLOGY_OPTIONS: string[] = [
    'point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip',
];
const CULL_OPTIONS: string[] = ['none', 'front', 'back'];
const FRONT_FACE_OPTIONS: string[] = ['ccw', 'cw'];
const COMPARE_OPTIONS: string[] = [
    'never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always',
];

/**
 * Pipeline inspector. All state changes — entry toggles, parameter edits and
 * pipeline config edits — go through the EditorCommandBus so they are undoable
 * and never write to the render graph directly. Ctrl+Z / Ctrl+Y delegate to
 * the command bus's unified undo/redo.
 */
export class PipelinePanel {
    private panel: HTMLElement;
    private bus!: EditorCommandBus;
    private unsubscribe?: () => void;

    private get blendOptions(): string[] {
        return PipelineLoader.blendPresetNames.length > 0
            ? PipelineLoader.blendPresetNames
            : ['opaque', 'alpha', 'additive'];
    }

    constructor(container: HTMLElement) {
        this.panel = container;
    }

    attach(bus: EditorCommandBus): void {
        this.bus = bus;
        this.panel.tabIndex = 0;
        this.panel.addEventListener('keydown', (e) => {
            if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                this.bus.undo();
            } else if (e.ctrlKey && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
                e.preventDefault();
                this.bus.redo();
            }
        });
        this.unsubscribe?.();
        this.unsubscribe = bus.engine.eventBus.on('editor:changed', () => this.render());
    }

    /** Dispatch a structural edit (enabled/params) as a live-sync patch. */
    private patchStructural(apply: (data: RenderGraphData) => void): void {
        const prev = JSON.stringify(this.bus.renderGraph.toData());
        const data = this.bus.renderGraph.toData();
        apply(data);
        this.bus.patchRenderGraph(data, prev);
        this.render();
    }

    /** Dispatch a pipeline config edit (topology/blend/cull/depth) + rebuild.
     *  The panel mutates a deep copy; the command applies it to the live config. */
    private patchConfig(entry: PipelineEntry, mutate: (config: PipelineConfig) => void): void {
        const config = PipelineLoader.getConfig(entry.pipeline);
        if (!config) return;
        const prev = JSON.stringify(config);
        const next = JSON.parse(prev) as PipelineConfig;
        mutate(next);
        this.bus.mutatePipelineConfig(entry.pipeline, JSON.stringify(next), prev);
        this.render();
    }

    render(): void {
        this.panel.innerHTML = '';

        const head = ce('div', 'editor-head');
        head.appendChild(ce('span', 'ed-title', 'Render Pipeline'));
        this.panel.appendChild(head);

        const phases = this.bus.renderGraph.phases;
        const phaseNames = this.bus.renderGraph.getPhaseNames();
        for (const phase of phaseNames) {
            const section = ce('div', 'pp-phase');
            section.appendChild(ce('div', 'pp-phase-title', phase));

            const entries = phases[phase] ?? [];
            if (entries.length === 0) {
                section.appendChild(ce('div', 'pp-empty', '(empty)'));
            } else {
                for (const entry of entries) {
                    section.appendChild(this.renderEntry(entry));
                }
            }
            this.panel.appendChild(section);
        }
    }

    private renderEntry(entry: PipelineEntry): HTMLElement {
        const wrap = ce('div', 'pp-entry-wrap');

        const row = ce('div', 'pp-entry');
        const chk = ce('input') as HTMLInputElement;
        chk.type = 'checkbox';
        chk.checked = entry.enabled;
        chk.onchange = () => this.patchStructural(data => {
            for (const list of Object.values(data.phases)) {
                const target = (list ?? []).find(e => e.name === entry.name);
                if (target) target.enabled = chk.checked;
            }
        });
        row.appendChild(chk);
        row.appendChild(ce('span', 'pp-entry-name', entry.name));
        const config = PipelineLoader.getConfig(entry.pipeline);
        const badge = config?.renderer?.phase ?? entry.kind ?? '';
        row.appendChild(ce('span', 'pp-entry-kind', badge));
        wrap.appendChild(row);

        if (entry.params) {
            for (const [key, values] of Object.entries(entry.params)) {
                wrap.appendChild(this.renderParam(entry, key, values));
            }
        }

        if (config) {
            wrap.appendChild(this.renderConfig(entry, config));
        }
        return wrap;
    }

    private renderParam(entry: PipelineEntry, key: string, values: number[]): HTMLElement {
        const box = ce('div', 'pp-params');
        box.appendChild(ce('span', 'pp-param-label', key));
        values.forEach((v, i) => {
            const field = makeFloatField(v, newVal => this.patchStructural(data => {
                for (const list of Object.values(data.phases)) {
                    const target = (list ?? []).find(e => e.name === entry.name);
                    if (target && target.params?.[key]) target.params[key][i] = newVal;
                }
            }));
            box.appendChild(field.el);
        });
        return box;
    }

    private renderConfig(entry: PipelineEntry, config: PipelineConfig): HTMLElement {
        const box = ce('div', 'pp-config');
        const edit = (mutate: (c: PipelineConfig) => void): void => this.patchConfig(entry, mutate);

        // ── Primitive ──
        box.appendChild(this.field('topology', makeSelect(
            TOPOLOGY_OPTIONS, config.primitive.topology,
            v => edit(c => { c.primitive.topology = v as GPUPrimitiveTopology; }),
        )));
        box.appendChild(this.field('cullMode', makeSelect(
            CULL_OPTIONS, config.primitive.cullMode,
            v => edit(c => { c.primitive.cullMode = v as GPUCullMode; }),
        )));
        box.appendChild(this.field('frontFace', makeSelect(
            FRONT_FACE_OPTIONS, config.primitive.frontFace ?? 'ccw',
            v => edit(c => { c.primitive.frontFace = v as GPUFrontFace; }),
        )));

        // ── Blend ──
        const blendVal = typeof config.blend === 'string' ? config.blend : 'opaque';
        box.appendChild(this.field('blend', makeSelect(
            this.blendOptions, blendVal,
            v => edit(c => { c.blend = v as PipelineConfig['blend']; }),
        )));

        // ── Depth ──
        if (config.depthStencil) {
            const writeEnabled = config.depthStencil.depthWriteEnabled === true;
            box.appendChild(this.field('depthWrite', makeCheckbox(
                writeEnabled,
                v => edit(c => { if (c.depthStencil) c.depthStencil.depthWriteEnabled = v; }),
            )));
            const compare = (config.depthStencil.depthCompare as string) ?? 'less';
            box.appendChild(this.field('depthCompare', makeSelect(
                COMPARE_OPTIONS, compare,
                v => edit(c => { if (c.depthStencil) c.depthStencil.depthCompare = v as GPUCompareFunction; }),
            )));
        }

        return box;
    }

    private field(label: string, control: HTMLElement): HTMLElement {
        const row = ce('div', 'pp-config-row');
        row.appendChild(ce('span', 'pp-config-label', label));
        row.appendChild(control);
        return row;
    }
}

```

## editor\commands\Command.ts

```ts
import type { Engine } from '../../core/Engine';

export interface Command {
    readonly type: string;
    readonly description: string;
    execute(ctx: CommandContext): boolean;
    undo(ctx: CommandContext): boolean;
}

export interface CommandContext {
    engine: Engine;
}

```

## editor\commands\RenderGraphCommands.ts

```ts
import type { Command, CommandContext } from './Command';
import type { RenderGraphData, PipelineConfig } from '../../core/render/types';
import { PipelineLoader } from '../../core/render/PipelineLoader';

export class MutateRenderGraphCommand implements Command {
    readonly type = 'mutateRenderGraph';
    readonly description = 'mutateRenderGraph';
    private prevData: string;
    constructor(private nextData: object, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(nextData);
    }

    execute(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.fromData(this.nextData as RenderGraphData);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.renderGraph.fromData(JSON.parse(this.prevData));
        return true;
    }
}

/**
 * Live-sync structural render-graph edits (entry.enabled / entry.params) onto
 * the EXISTING entry objects so PipelineDriver references stay valid — a plain
 * fromData() would replace entries with clones and silently detach drivers.
 * Prev state is stored as JSON for undo. Used by the pipeline panel.
 */
export class PatchRenderGraphCommand implements Command {
    readonly type = 'patchRenderGraph';
    readonly description = 'patchRenderGraph';
    private prevData: string;
    constructor(private nextData: RenderGraphData, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(nextData);
    }

    execute(ctx: CommandContext): boolean {
        this.patch(ctx, this.nextData);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        this.patch(ctx, JSON.parse(this.prevData) as RenderGraphData);
        return true;
    }

    private patch(ctx: CommandContext, data: RenderGraphData): void {
        for (const [phaseName, entries] of Object.entries(data.phases)) {
            if (!entries) continue;
            const live = ctx.engine.renderGraph.phases[phaseName] ?? [];
            for (const next of entries) {
                const target = live.find(e => e.name === next.name);
                if (!target) continue;
                target.enabled = next.enabled ?? true;
                if (next.params) target.params = next.params;
            }
        }
    }
}

/** Apply a full pipeline config (topology/blend/cull/depth) to a named
 *  pipeline and recompile its GPU pipeline. Undo restores the prior config. */
export class MutatePipelineConfigCommand implements Command {
    readonly type = 'mutatePipelineConfig';
    readonly description = 'mutatePipelineConfig';
    private prevJson: string;
    constructor(
        private pipeline: string,
        private nextJson: string,
        prevJson?: string,
    ) {
        this.prevJson = prevJson ?? nextJson;
    }

    execute(ctx: CommandContext): boolean {
        const config = PipelineLoader.getConfig(this.pipeline);
        if (!config) return false;
        this.apply(config, this.nextJson);
        ctx.engine.renderGraph.rebuildPipeline(ctx.engine.device, this.pipeline);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const config = PipelineLoader.getConfig(this.pipeline);
        if (!config) return false;
        this.apply(config, this.prevJson);
        ctx.engine.renderGraph.rebuildPipeline(ctx.engine.device, this.pipeline);
        return true;
    }

    private apply(config: PipelineConfig, json: string): void {
        const parsed = JSON.parse(json) as PipelineConfig;
        // Replace top-level fields wholesale so nested objects (primitive /
        // depthStencil) are swapped in, keeping any runtime references coherent.
        const cfg = config as unknown as Record<string, unknown>;
        for (const key of Object.keys(config)) delete cfg[key];
        Object.assign(config, parsed);
    }
}


```

## editor\commands\SceneCommands.ts

```ts
import { schemaRegistry } from '../../core/ecs/SchemaRegistry';
import type { SceneData } from '../../core/ecs/Scene';
import type { Command, CommandContext } from './Command';

export class SetFieldCommand implements Command {
    readonly type = 'setField';
    get description(): string { return `setField ${this.compName}.${this.field} = ${this.newValue}`; }
    private oldValue: unknown;
    constructor(
        private entityKey: string,
        private compName: string,
        private field: string,
        private newValue: unknown,
    ) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        this.oldValue = ctx.engine.scene.getField(eid, this.compName, this.field);
        ctx.engine.scene.setField(eid, this.compName, this.field, this.newValue);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        ctx.engine.scene.setField(eid, this.compName, this.field, this.oldValue);
        return true;
    }
}

export class CreateEntityCommand implements Command {
    readonly type = 'createEntity';
    get description(): string { return `createEntity ${this.key}`; }
    private createdKey: string;
    constructor(
        private key: string,
        private data: Record<string, Record<string, unknown>>,
    ) {
        this.createdKey = key;
    }

    execute(ctx: CommandContext): boolean {
        ctx.engine.scene.createEntity(this.createdKey, this.data);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        ctx.engine.scene.removeEntity(this.createdKey);
        return true;
    }
}

export class RemoveEntityCommand implements Command {
    readonly type = 'removeEntity';
    get description(): string { return `removeEntity ${this.key}`; }
    private backupData: Record<string, Record<string, unknown>> | null = null;
    constructor(private key: string) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.key);
        if (eid == null) return false;
        this.backupData = this.serializeEntity(ctx, eid);
        ctx.engine.scene.removeEntity(this.key);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        if (!this.backupData) return false;
        ctx.engine.scene.createEntity(this.key, this.backupData);
        return true;
    }

    private serializeEntity(ctx: CommandContext, eid: number): Record<string, Record<string, unknown>> {
        const result: Record<string, Record<string, unknown>> = {};
        const comps = ctx.engine.scene.getEntityComponentNames(eid);
        for (const compName of comps) {
            const comp = schemaRegistry.get(compName);
            if (comp && ctx.engine.scene.hasComponent(eid, compName)) {
                result[compName] = schemaRegistry.readAllFields(compName, comp, eid);
            }
        }
        return result;
    }
}

/** Replace the whole scene (clear + load entity data), e.g. editor "Load JSON"
 *  of a plain scene-entities file. Snapshot is the previous scene data. */
export class LoadSceneDataCommand implements Command {
    readonly type = 'loadSceneData';
    readonly description = 'loadSceneData';
    private prevData: string;
    constructor(private data: SceneData, prevData?: string) {
        this.prevData = prevData ?? JSON.stringify(data);
    }

    execute(ctx: CommandContext): boolean {
        this.replaceScene(ctx, this.data);
        return true;
    }

    undo(ctx: CommandContext): boolean {
        this.replaceScene(ctx, JSON.parse(this.prevData) as SceneData);
        return true;
    }

    private replaceScene(ctx: CommandContext, data: SceneData): void {
        const scene = ctx.engine.scene;
        for (const k of [...scene.entityKeyMap.keys()]) scene.removeEntity(k);
        ctx.engine.loadSceneData(data);
    }
}

/** Add/remove a component on an entity (undo restores prior field values when
 *  the component was removed). Used by the editor's component checkboxes. */
export class ToggleComponentCommand implements Command {
    readonly type = 'toggleComponent';
    get description(): string { return `toggleComponent ${this.compName}`; }
    private backup: Record<string, Record<string, unknown>> | null = null;
    private added = false;
    constructor(
        private entityKey: string,
        private compName: string,
        private enabled: boolean,
    ) {}

    execute(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        const wasEnabled = ctx.engine.scene.hasComponent(eid, this.compName);
        if (wasEnabled === this.enabled) return false;
        if (!this.enabled) {
            const comp = schemaRegistry.get(this.compName);
            if (comp) {
                this.backup = { [this.compName]: schemaRegistry.readAllFields(this.compName, comp, eid) };
            }
        }
        ctx.engine.scene.toggleComponent(eid, this.compName, this.enabled);
        this.added = this.enabled;
        return true;
    }

    undo(ctx: CommandContext): boolean {
        const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
        if (eid == null) return false;
        if (this.added) {
            ctx.engine.scene.toggleComponent(eid, this.compName, false);
        } else if (this.backup) {
            ctx.engine.scene.toggleComponent(eid, this.compName, true);
            for (const [field, value] of Object.entries(this.backup[this.compName] ?? {})) {
                ctx.engine.scene.setField(eid, this.compName, field, value);
            }
        }
        return true;
    }
}

```

## editor\input\EditorInputManager.ts

```ts
import { ToolSystem } from './ToolSystem';
import type { Scene } from '../../core/ecs/Scene';
import type { EventBus } from '../../core/events/EventBus';

/**
 * Editor-owned wrapper around the tool lifecycle. The engine core no longer
 * loads tools.json — only the editor mounts an input manager, so picking and
 * other interaction tools stay fully editor-side (player mode never loads
 * them). ToolSystem manages SceneTool attach/detach internally via load().
 */
export class EditorInputManager {
    private toolSystem: ToolSystem;

    constructor(
        scene: Scene,
        eventBus: EventBus,
        getSystem: <T>(name: string) => T | null,
        getAspect: () => number,
    ) {
        this.toolSystem = new ToolSystem(scene, eventBus, getSystem, getAspect);
    }

    /** Load the current App's tools.json (path resolved from the app base). */
    async loadTools(appBase: string, toolsPath: string): Promise<void> {
        this.toolSystem.setBase(appBase);
        await this.toolSystem.loadFromFile(`${appBase}/${toolsPath}`);
    }

    dispose(): void {
        this.toolSystem.dispose();
    }
}

```

## editor\input\SceneTool.ts

```ts
import type { Scene } from '../../core/ecs/Scene';
import type { EventBus } from '../../core/events/EventBus';

export interface ToolConfig {
    /** Builtin tool name (e.g., "pick"). Mutually exclusive with `source`. */
    type?: string;
    /** Script path (e.g., "scripts/myTool.js") — script-loaded tool.
     *  Mutually exclusive with `type`. Path resolves relative to app base
     *  (or absolute if leading /). */
    source?: string;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface ToolContext {
    scene: Scene;
    bus: EventBus;
    /** Cross-system lookup (structural typing at the call site) — tools take
     *  no compile-time dependency on any system implementation. */
    getSystem<T = unknown>(name: string): T | null;
    getAspect: () => number;
}

export interface SceneTool {
    attach(): void;
    detach(): void;
}

/** Factory for a builtin tool type (TOOL_REGISTRY value). */
export type ToolFactory = (config: ToolConfig, ctx: ToolContext) => SceneTool;

/** Lifecycle hooks a script tool may export. All optional; missing hooks are skipped. */
export interface ToolScriptModule {
    attach?: (ctx: ToolContext) => void;
    detach?: () => void;
    [key: string]: unknown;
}

```

## editor\input\ToolSystem.ts

```ts
import type { Scene } from '../../core/ecs/Scene';
import type { EventBus } from '../../core/events/EventBus';
import type { SceneTool, ToolConfig, ToolContext, ToolScriptModule } from './SceneTool';
import { TOOL_REGISTRY } from '../../core/tools/ToolRegistry';

export type { ToolFactory } from './SceneTool';

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

    constructor(scene: Scene, bus: EventBus, getSystem: <T = unknown>(name: string) => T | null, getAspect: () => number) {
        this.ctx = { scene, bus, getSystem, getAspect };
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

```

## host\AppHost.ts

```ts
import { Engine } from '../core/Engine';
import { EventBus } from '../core/events/EventBus';
import type { Command, CommandContext } from '../editor/commands/Command';
import type { UILayer } from '../ui/UILayer';

/**
 * Unified host layer: owns the Engine and the UI layers mounted above it.
 *
 * The dependency direction is strictly downward — UI Layer → AppHost → Engine
 * Core. AppHost is the ONLY bridge between them:
 *   - state changes flow down via `dispatch(new Command())` (command channel)
 *   - notifications flow up via `eventBus.emit(...)` (event channel)
 *   - UI layers get read-only engine access through the engine's accessors
 *
 * In editor mode a mounted editor layer (id === 'editor') intercepts dispatch
 * to run the command bus (edit-mode gating + undo/redo). Without one (player
 * mode) commands execute directly against the engine, unstacked.
 */
export class AppHost {
    public engine: Engine;
    private uiLayers: UILayer[] = [];
    private uiContainer: HTMLElement;
    private editorLayer?: { dispatch(cmd: Command): boolean };

    constructor(canvas: HTMLCanvasElement, uiContainer: HTMLElement) {
        this.engine = new Engine(canvas);
        this.uiContainer = uiContainer;
    }

    async init(): Promise<void> { await this.engine.init(); }
    async loadApp(name: string): Promise<void> { await this.engine.loadApp(name); }
    startLoop(): void { this.engine.startLoop(); }
    resize(): void { this.engine.resize(); }
    get engineConfig() { return this.engine.engineConfig; }

    // Read-only proxies (UI layer queries).
    get scene() { return this.engine.scene; }
    get renderGraph() { return this.engine.renderGraph; }
    /** Live delegate: Engine.eventBus is created in init(), so it must be read
     *  after init() — a field copied in the constructor would be undefined. */
    get eventBus(): EventBus { return this.engine.eventBus; }

    mountLayer(layer: UILayer, container?: HTMLElement): void {
        layer.mount(container ?? this.uiContainer, this);
        this.uiLayers.push(layer);
        if (layer.id === 'editor') {
            this.editorLayer = layer as unknown as { dispatch(cmd: Command): boolean };
        }
    }

    unmountAll(): void {
        for (const layer of this.uiLayers) layer.unmount();
        this.uiLayers = [];
        this.editorLayer = undefined;
    }

    dispatch(cmd: Command): boolean {
        if (this.editorLayer) {
            return this.editorLayer.dispatch(cmd);
        }
        // Runtime has no editor: execute directly, no undo stack.
        const ctx: CommandContext = { engine: this.engine };
        return cmd.execute(ctx);
    }

    async loadAppUI(appBase: string): Promise<void> {
        for (const layer of this.appUILayers) layer.unmount();
        this.appUILayers = [];

        const manifestResp = await fetch(`${appBase}/app.json`);
        if (!manifestResp.ok) return;
        const manifest = await manifestResp.json() as { ui?: string };
        if (!manifest.ui) return;

        const configs = await fetch(`${appBase}/${manifest.ui}`).then(r => r.json()) as AppUIConfig[];
        for (const cfg of configs) {
            const container = (cfg.container ? document.querySelector<HTMLElement>(cfg.container) : null)
                ?? this.createContainer(cfg.id);
            const mod = await this.loadUIScript(`${appBase}/${cfg.source}`);
            const unmount = mod.mount(container, this);
            this.appUILayers.push({ id: cfg.id, unmount });
        }
    }

    private appUILayers: Array<{ id: string; unmount: () => void }> = [];

    private createContainer(id: string): HTMLElement {
        const el = document.createElement('div');
        el.id = `ui-${id}`;
        this.uiContainer.appendChild(el);
        return el;
    }

    private async loadUIScript(url: string): Promise<{ mount: (container: HTMLElement, host: AppHost) => () => void }> {
        const resp = await fetch(`${url}?t=${Date.now()}`);
        if (!resp.ok) throw new Error(`UI script not found: ${url}`);
        const src = await resp.text();
        const blob = new Blob([src], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const mod = await import(/* @vite-ignore */ blobUrl);
            return mod.default ?? mod;
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }
}

interface AppUIConfig {
    id: string;
    source: string;
    container?: string;
}

```

## types\bitecs-legacy.d.ts

```ts
declare module 'bitecs/legacy' {
    import type { World, EntityId } from 'bitecs';

    export const Types: Record<string, number>;

    export function defineComponent<T extends Record<string, number>>(
        schema: T,
    ): Record<keyof T, Float32Array | Uint32Array | Uint8Array | Int32Array>;

    export function defineQuery(
        components: object[],
    ): (world: World) => readonly EntityId[];

    export function addComponent(world: World, component: object, eid: EntityId): void;
    export function removeComponent(world: World, component: object, eid: EntityId): void;
    export function hasComponent(world: World, component: object, eid: EntityId): boolean;
}

```

## ui\UILayer.ts

```ts
import type { AppHost } from '../host/AppHost';

/** A mountable UI layer. Layers are the only place UI code lives; they receive
 *  the AppHost (and through it the engine) on mount and must tear everything
 *  down in unmount(). State changes go through host.dispatch(), notifications
 *  through host.eventBus.emit(). */
export interface UILayer {
    id: string;
    mount(container: HTMLElement, host: AppHost): void | Promise<void>;
    unmount(): void;
}

```

## ui\layers\EditorUILayer.ts

```ts
import type { AppHost } from '../../host/AppHost';
import type { UILayer } from '../UILayer';
import type { Command } from '../../editor/commands/Command';
import { EditorCommandBus } from '../../editor/EditorCommandBus';
import { EditorInputManager } from '../../editor/input/EditorInputManager';
import { EditorPanel } from '../../editor/EditorPanel';
import { PipelinePanel } from '../../editor/PipelinePanel';

/**
 * Editor UI layer: owns the whole editor experience (tab shell, command bus,
 * input manager / tools, panels). Mounted ONLY by the editor entry (main.ts).
 * All state changes flow through the command bus; the layer itself never
 * writes to the engine. App-switch reloads the editor state for the new app.
 */
export class EditorUILayer implements UILayer {
    id = 'editor';
    private commandBus?: EditorCommandBus;
    private inputManager?: EditorInputManager;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};
    private host?: AppHost;
    private unsubscribePick?: () => void;

    async mount(container: HTMLElement, host: AppHost) {
        this.host = host;

        // ── 1. Build the editor tab shell (was static markup in index.html) ──
        container.innerHTML = `
            <div id="tabs">
                <button class="tab-btn active" data-tab="scene">Scene</button>
                <button class="tab-btn" data-tab="pipeline">Pipeline</button>
            </div>
            <div id="tab-scene" class="tab-panel" style="display:flex;">
                <div id="editor"></div>
            </div>
            <div id="tab-pipeline" class="tab-panel" style="display:none;">
                <div id="pipeline-panel"></div>
            </div>
        `;
        const sceneContainer = container.querySelector('#tab-scene') as HTMLElement;
        const pipelineContainer = container.querySelector('#tab-pipeline') as HTMLElement;

        // ── 2. Command bus (undo/redo + edit-mode gating) ──
        this.commandBus = new EditorCommandBus(host.engine);

        // ── 3. Input manager (tools/picking) — editor-only concern ──
        this.inputManager = new EditorInputManager(
            host.engine.scene,
            host.eventBus,
            <N,>(name: string): N | null => host.engine.systemRegistry.resolve({ name }) as unknown as N | null,
            () => host.engine.aspect(),
        );

        // ── 4. Panels (attach through the command bus; read-only core imports) ──
        const editorPanel = new EditorPanel(sceneContainer);
        const pipelinePanel = new PipelinePanel(pipelineContainer);
        editorPanel.attach(this.commandBus);
        pipelinePanel.attach(this.commandBus);
        editorPanel.render();
        pipelinePanel.render();
        this.panels = { editor: editorPanel, pipeline: pipelinePanel };

        // ── 5. Tab switching ──
        const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-btn');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const tab = btn.dataset.tab;
                buttons.forEach(b => b.classList.toggle('active', b === btn));
                sceneContainer.style.display = tab === 'scene' ? 'flex' : 'none';
                pipelineContainer.style.display = tab === 'pipeline' ? 'flex' : 'none';
            };
        });

        // ── 6. App switching (Load-JSON-of-app.json + window.switchApp) ──
        editorPanel.onAppSwitch = (name: string) => this.switchApp(name);

        // ── 7. Load the current app's tools.json (engine no longer does this) ──
        const appName = host.engine.currentApp;
        if (appName) await this.loadToolsFor(appName);

        // ── 8. Wire 3D picking → scene-tree selection (event channel only) ──
        this.subscribePick();
    }

    /** Pick tools emit a 'pick' event ({ key, eid, ... }); highlight the entity.
     *  Re-subscribed on app switch (unloadCurrentApp clears the event bus). */
    private subscribePick(): void {
        if (!this.host || !this.panels.editor) return;
        this.unsubscribePick?.();
        this.unsubscribePick = this.host.eventBus.on('pick', (payload) => {
            const key = (payload as { key?: string })?.key;
            if (key) this.panels.editor?.select(key);
        });
    }

    /** Reload the editor for a different app: detach old tools, load the app,
     *  reload its tools.json + app UI and refresh both panels. Exposed for
     *  devtools (window.switchApp) and the panel's Load-JSON-of-app.json path. */
    async switchApp(name: string): Promise<void> {
        if (!this.host) return;
        this.inputManager?.dispose();
        await this.host.loadApp(name);
        await this.host.loadAppUI(`${this.host.engineConfig.appsRoot}/${name}`);
        await this.loadToolsFor(name);
        // unloadCurrentApp clears the event bus → re-subscribe panel listeners.
        if (this.commandBus) {
            this.panels.editor?.attach(this.commandBus);
            this.panels.pipeline?.attach(this.commandBus);
        }
        this.panels.editor?.render();
        this.panels.pipeline?.render();
        this.subscribePick();
    }

    /** Fetch the app manifest's tools.json and load it through the input manager. */
    private async loadToolsFor(appName: string): Promise<void> {
        if (!this.host || !this.inputManager) return;
        const base = `${this.host.engineConfig.appsRoot}/${appName}`;
        try {
            const manifestResp = await fetch(`${base}/app.json`);
            if (!manifestResp.ok) return;
            const manifest = await manifestResp.json() as { tools?: string };
            if (manifest.tools) {
                await this.inputManager.loadTools(base, manifest.tools);
            }
        } catch (e) {
            console.warn('[EditorUILayer] failed to load tools:', e);
        }
    }

    unmount(): void {
        this.inputManager?.dispose();
        this.unsubscribePick?.();
        this.commandBus = undefined;
        this.inputManager = undefined;
        this.panels = {};
        this.host = undefined;
    }

    /** AppHost routes host.dispatch() here while the editor layer is mounted. */
    dispatch(cmd: Command): boolean {
        return this.commandBus?.dispatch(cmd) ?? false;
    }
}

```

