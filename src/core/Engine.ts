import { Scene, type SceneData, type CameraView } from './ecs/Scene';
import { registerToolType } from './tools/ToolRegistry';
import { EventBus } from './events/EventBus';
import { RenderGraph } from './render/RenderGraph';
import { resourceManager } from './render/ResourceManager';
import { gpuResourceRegistry } from './render/GpuResourceRegistry';
import { PipelineLoader } from './render/PipelineLoader';
import { resolveComputeBindings } from './render/computeBindings';
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
    /** Scene file path (relative to the app base) for the current app — from
     *  app.json's `scene` field, default "scene.json". Lets the editor write
     *  scene edits back to the exact loaded file. */
    sceneFile = 'scene.json';
    /** Opaque objects published by plugins (owner-tagged), consumed by hooks. */
    attachments = new Map<string, { obj: unknown; owner: string }>();
    /** Plain-object view of attachments handed to FrameContext / hooks. */
    private attachmentsView: Record<string, unknown> = {};
    /** Per-plugin registration ledger (for owner sweeps of open registries). */
    pluginLedgers = new Map<string, PluginLedger>();
    /** Replacement renderer installed via ctx.replaceRenderer (null = built-in). */
    customRenderer: IRenderer | null = null;
    customRendererOwner: string | null = null;
    /** Editor viewport camera override. When non-null, the RenderGraph uses
     *  this view in place of any active scene Camera. Set by the editor's
     *  ViewportCameraController (via Engine.setEditorViewProvider); always null
     *  in player mode, so the render path is unchanged. */
    editorView: CameraView | null = null;
    /** Per-frame provider for editorView. The EditorOrchestrator installs a
     *  closure that returns ViewportCameraController.getCameraView(); the
     *  Engine.frame() reads it each frame. Player mode leaves this null. */
    private editorViewProvider: (() => CameraView | null) | null = null;
    /** Pending capture request: set by captureFrame(), drained in frame()
     *  after the render pass so the swap chain texture has the rendered frame. */
    private captureResolver: { resolve: (blob: Blob) => void; reject: (e: unknown) => void } | null = null;
    /** Editor time-mode: 'play' = systems run + time advances; 'pause' =
     *  systems skipped, time frozen, canvas holds last frame. The Timeline
     *  panel toggles this and calls stepOnce()/setFrameTime() to scrub. */
    editorMode: 'play' | 'pause' = 'play';
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

    /** Install or clear the editor viewport camera provider. When set,
     *  Engine.frame() reads it each frame and uses the returned view in place
     *  of scene cameras. The EditorOrchestrator installs a closure over
     *  ViewportCameraController; player mode never installs one. */
    setEditorViewProvider(provider: (() => CameraView | null) | null): void {
        this.editorViewProvider = provider;
    }

    /** Request a PNG capture of the next rendered frame. The actual GPU
     *  readback runs in frame() right after the render system, so the swap
     *  chain texture has the fully rendered image. Resolves with a Blob
     *  ('image/png'). */
    captureFrame(): Promise<Blob> {
        return new Promise<Blob>((resolve, reject) => {
            this.captureResolver = { resolve, reject };
        });
    }

    /** Scrub the editor clock to time `t` (seconds). Only meaningful while
     *  paused; in play mode the clock runs free. stepOnce() then advances one
     *  frame of systems at this time so the scene reflects t. */
    setFrameTime(t: number): void {
        const now = performance.now();
        this.startTime = now - t * 1000;
        this.lastTime = now;
    }

    /** Advance one frame of systems at the current (scrubbed) time while
     *  paused, then render. Used by the Timeline panel's step button. */
    stepOnce(): void {
        if (this.editorMode !== 'pause') return;
        const now = performance.now();
        const time = (now - this.startTime) / 1000;
        const ctx = this.frameCtx;
        ctx.time = time; ctx.dt = 0;
        ctx.aspect = this.aspect();
        ctx.cw = this._canvas.width;
        ctx.ch = this._canvas.height;
        ctx.editorView = this.editorViewProvider ? this.editorViewProvider() : null;
        this.editorView = ctx.editorView;
        for (const sys of this.activeSystems) {
            const impl = systemRegistry.resolve(sys);
            impl?.update(ctx);
        }
        this.flushCompute();
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

        resourceManager.init(this.device);
        PipelineLoader.defaultWorkgroupSize = this.engineConfig.computeTgs;

        // Configure the swap chain with COPY_SRC so Engine.captureFrame() can
        // copy the rendered texture back to a staging buffer for PNG export.
        // RENDER_ATTACHMENT is always required; COPY_SRC has no rendering cost.
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: this.engineConfig.alphaMode,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });

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
            registerGpuResourceSet: (setName, resources) => {
                gpuResourceRegistry.registerSet(setName, resources, owner);
            },
            replaceGpuResourceSet: (setName, resources) => {
                gpuResourceRegistry.replaceSet(setName, resources, owner);
            },
            unregisterGpuResourceSet: (setName) => {
                gpuResourceRegistry.unregisterSet(setName, owner);
            },
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
        this.sceneFile = manifest.scene ?? 'scene.json';

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
        this.sceneFile = 'scene.json';
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
            editorView: null,
            getSystem: <T,>(name: string) => systemRegistry.resolve({ name }) as T | null,
            getBuffer: (name: string) => bufferRegistry.get(name),
            writeBuffer: (name: string, data: BufferSource) => bufferRegistry.write(name, this.device, data),
            dispatchCompute: (pipelineName: string, count: number, entries?: GPUBindGroupEntry[], eid?: number) => {
                this.dispatchCompute(pipelineName, count, entries, eid);
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
        // Pause: freeze time + skip system updates, but keep rendering so
        // editor camera moves (editorView) stay visible. Time is not advanced,
        // so animations/physics hold. stepOnce()/setFrameTime() scrub.
        if (this.editorMode === 'pause') {
            const pctx = this.frameCtx;
            pctx.aspect = this.aspect();
            pctx.cw = this._canvas.width;
            pctx.ch = this._canvas.height;
            pctx.editorView = this.editorViewProvider ? this.editorViewProvider() : null;
            this.editorView = pctx.editorView;
            this.renderer.update(pctx);
            this.flushCompute();
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
        ctx.editorView = this.editorViewProvider ? this.editorViewProvider() : null;
        this.editorView = ctx.editorView;

        for (const sys of this.activeSystems) {
            const impl = systemRegistry.resolve(sys);
            impl?.update(ctx);
        }
        // Safety-net flush for any compute dispatched by the render system or
        // after it. The renderer also calls ctx.flushCompute() at the start of
        // execute() so same-frame compute results are visible to render passes.
        this.flushCompute();
        // Drain a pending capture request now that the swap chain texture
        // holds the fully rendered frame. Async — does not block the frame.
        if (this.captureResolver) {
            const r = this.captureResolver;
            this.captureResolver = null;
            void this.captureSwapTexture(r.resolve, r.reject);
        }
        requestAnimationFrame(this.frame);
    };

    /** Copy the current swap chain texture to a staging buffer, map it, and
     *  build a PNG Blob. Called from frame() right after the render system
     *  so the texture holds the fully rendered frame. */
    private async captureSwapTexture(
        resolve: (blob: Blob) => void,
        reject: (e: unknown) => void,
    ): Promise<void> {
        try {
            const tex = this.context.getCurrentTexture();
            const w = tex.width, h = tex.height;
            const bytesPerPixel = 4;
            const stride = w * bytesPerPixel;
            // WebGPU requires bytesPerRow to be a multiple of 256.
            const alignedStride = Math.ceil(stride / 256) * 256;
            const staging = this.device.createBuffer({
                label: 'capture-staging',
                size: alignedStride * h,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToBuffer(
                { texture: tex },
                { buffer: staging, bytesPerRow: alignedStride, rowsPerImage: h },
                { width: w, height: h, depthOrArrayLayers: 1 },
            );
            this.device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const src = new Uint8Array(staging.getMappedRange());
            const rgba = new Uint8ClampedArray(w * h * 4);
            const swapRB = this.format === 'bgra8unorm';
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const sIdx = y * alignedStride + x * bytesPerPixel;
                    const dIdx = (y * w + x) * 4;
                    rgba[dIdx] = swapRB ? src[sIdx + 2] : src[sIdx];
                    rgba[dIdx + 1] = src[sIdx + 1];
                    rgba[dIdx + 2] = swapRB ? src[sIdx] : src[sIdx + 2];
                    rgba[dIdx + 3] = 255;
                }
            }
            staging.unmap();
            staging.destroy();
            const imageData = new ImageData(rgba, w, h);
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const cx = c.getContext('2d');
            if (!cx) throw new Error('2D context unavailable for capture');
            cx.putImageData(imageData, 0, 0);
            c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png');
        } catch (e) {
            reject(e);
        }
    }

    startLoop(): void {
        requestAnimationFrame(this.frame);
    }

    /** Dispatch a preloaded compute pipeline by name (script-system escape hatch).
     *  Dispatches are batched into one compute pass per frame and submitted
     *  together by flushCompute() (called by the renderer before recording
     *  render passes, and at end of frame as a safety net).
     *  When `entries` is omitted but `eid` is provided AND the pipeline's
     *  ComputeMeta declares `bindings`, the bindings are resolved declaratively
     *  (storage/uniform/timeInput/storageTexture/texture) against this entity
     *  + the current FrameContext — see resolveComputeBindings(). */
    private dispatchCompute(pipelineName: string, count: number, entries?: GPUBindGroupEntry[], eid?: number): void {
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
        // Declarative binding resolution: if the caller didn't supply raw
        // entries but did supply an eid AND the pipeline declares bindings,
        // resolve them now (storage/uniform/timeInput/storageTexture/texture).
        if ((!entries || entries.length === 0) && eid !== undefined && meta && meta.bindings.length > 0) {
            entries = resolveComputeBindings(meta.bindings, {
                scene: this.scene, eid, count,
                time: this.frameCtx.time, dt: this.frameCtx.dt,
                aspect: this.frameCtx.aspect, screenW: this.frameCtx.cw, screenH: this.frameCtx.ch,
                dataBase: this.engineConfig.dataRoot,
            });
        }
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

        for (const tex of result.textures) {
            await resourceManager.uploadTextureFromImage(tex.key, tex.image, tex.sRGB);
        }
        for (const prim of result.primitives) {
            resourceManager.registerPbrMesh(prim.name, prim.meshData);
        }
        // Land skin + animation data as ResourceManager assets for the
        // animation plugin (Phase 4) to consume. The loader does not skin
        // the mesh here; SkinningSystem reads these at runtime.
        for (const skin of result.skins) {
            resourceManager.registerSkin(skin.name, skin);
        }
        for (const anim of result.animations) {
            resourceManager.registerAnimation(anim.name, anim);
        }

        // Create entities preserving the glTF node tree: each node carries a
        // parentIndex so we wire Transform.parent → parent entity key, and
        // Scene's recursive getModelMatrix composes parent * local (Phase 2a)
        // instead of baking world transforms. Parents are created first
        // because the loader walks the tree depth-first.
        for (const node of result.nodes) {
            const entityData: Record<string, Record<string, unknown>> = {};
            const transformData: Record<string, unknown> = {
                [m.transform.fields.position]: node.transform.position,
                [m.transform.fields.rotation]: node.transform.rotation,
                [m.transform.fields.scale]: node.transform.scale,
            };
            if (node.parentIndex !== undefined) {
                const parent = result.nodes[node.parentIndex];
                if (parent) transformData['parent'] = parent.name;
            }
            entityData[m.transform.component] = transformData;

            if (node.meshName) {
                entityData[m.mesh.component] = { [m.mesh.field]: node.meshName };
                if (node.material) {
                    const mat: Record<string, unknown> = {};
                    for (const [gltfKey, fieldKey] of Object.entries(m.material.fields)) {
                        mat[fieldKey] = (node.material as unknown as Record<string, unknown>)[gltfKey];
                    }
                    const texMap: Record<string, string | undefined> = {
                        baseColorTexture: node.baseColorTexture,
                        metallicRoughnessTexture: node.metallicRoughnessTexture,
                        normalTexture: node.normalTexture,
                        occlusionTexture: node.occlusionTexture,
                        emissiveTexture: node.emissiveTexture,
                    };
                    for (const [gltfKey, fieldKey] of Object.entries(m.material.textures)) {
                        const texKey = texMap[gltfKey];
                        mat[fieldKey] = texKey ? resourceManager.textureHandle(texKey) : 0;
                    }
                    entityData[m.material.component] = mat;
                }
            }

            this.scene.createEntity(node.name, entityData);
        }

        this.resolveHandles();
    }
}
