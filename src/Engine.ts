import { Scene, type SceneData } from './ecs/Scene';
import { ScriptSystem } from './ecs/ScriptSystem';
import { InputSystem } from './ecs/InputSystem';
import { PhysicsSystem } from './ecs/PhysicsSystem';
import { CameraSystem } from './ecs/CameraSystem';
import { LightSystem } from './ecs/LightSystem';
import { AnimationSystem } from './ecs/AnimationSystem';
import { ToolSystem, registerToolType, unregisterToolType } from './tools/ToolSystem';
import { EventBus } from './events/EventBus';
import { RenderGraph } from './render/RenderGraph';
import { resourceManager } from './render/ResourceManager';
import { PipelineLoader } from './render/PipelineLoader';
import { uniformLayouts, type UniformLayoutDecls } from './render/UniformLayout';
import { schemaRegistry } from './ecs/SchemaRegistry';
import { systemRegistry, type FrameContext, type System } from './ecs/SystemRegistry';
import { bufferRegistry } from './render/BufferRegistry';
import { PRESET_MESHES, PRESET_PBR_MESHES, meshGenerators, isPbrMeshData, registerMeshGenerator, unregisterMeshGenerator } from './render/Primitives';
import { loadVertexSlots, removeVertexSlotsByOwner, type VertexSlotDecls, VERTEX_SLOTS, SLOT_ORDER } from './render/vertexSlots';
import { atomNamespaces } from './render/valueResolver';
import { GltfLoader } from './gltf/GltfLoader';
import { GaussianSplatManager } from './render/GaussianSplatManager';
import { pluginManager, pluginOwner } from './plugins/PluginManager';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EnginePlugin, PluginContext, MeshCatalogEntry } from './plugins/Plugin';
import type { RenderGraphData, VertexInputDecls, BindLayoutDecls, SamplerDecls, PhaseDecl, IRenderer } from './render/types';

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
 *  open registries (tools, generators, atoms, phases) can be swept on unload. */
interface PluginLedger {
    tools: string[];
    generators: string[];
    atoms: Array<[string, string]>;
    phases: string[];
}

export class Engine {
    device!: GPUDevice;
    context!: GPUCanvasContext;
    format!: GPUTextureFormat;
    scene!: Scene;
    renderGraph!: RenderGraph;
    scriptSystem!: ScriptSystem;
    inputSystem!: InputSystem;
    physicsSystem!: PhysicsSystem;
    cameraSystem!: CameraSystem;
    lightSystem!: LightSystem;
    animationSystem!: AnimationSystem;
    toolSystem!: ToolSystem;
    /** Splat manager; only instantiated when the active app's systems.json lists the `gaussianSplat` system. */
    gaussianSplatManager: GaussianSplatManager | null = null;
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
    private pluginLedgers = new Map<string, PluginLedger>();
    /** Replacement renderer installed via ctx.replaceRenderer (null = built-in). */
    private customRenderer: IRenderer | null = null;
    private customRendererOwner: string | null = null;

    private dpr: number;
    private canvas: HTMLCanvasElement;
    private startTime = 0;
    private lastTime = 0;
    /** True while loadApp is in flight — frame() skips system updates. */
    private appLoading = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.dpr = window.devicePixelRatio || 1;
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
        await schemaRegistry.load(`${root}/components.json`);
        await RAPIER.init();

        const [vertexInputs, bindLayoutsData, uniformLayoutsData, samplersData, vertexSlotsData, phasesData, vboPresetsData, blendPresetsData, fallbackTexturesData] = await Promise.all([
            fetch(`${root}/vertex-inputs.json`).then(r => r.json() as Promise<VertexInputDecls>),
            fetch(`${root}/bind-layouts.json`).then(r => r.json() as Promise<BindLayoutDecls>),
            fetch(`${root}/uniform-layouts.json`).then(r => r.json() as Promise<UniformLayoutDecls>),
            fetch(`${root}/samplers.json`).then(r => r.json() as Promise<SamplerDecls>),
            fetch(`${root}/vertex-slots.json`).then(r => r.json() as Promise<VertexSlotDecls>),
            fetch(`${root}/phases.json`).then(r => r.json() as Promise<PhaseDecl[]>),
            fetch(`${root}/vbo-presets.json`).then(r => r.json() as Promise<Record<string, { data: number[]; format: string; stride: number }>>),
            fetch(`${root}/blend-presets.json`).then(r => r.json() as Promise<Record<string, GPUBlendState>>),
            fetch(`${root}/fallback-textures.json`).then(r => r.json() as Promise<Record<string, { pixel: number[]; format: GPUTextureFormat }>>),
        ]);

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter');
        this.device = await adapter.requestDevice();
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context = this.canvas.getContext('webgpu')!;

        this.resize();
        this.context.configure({ device: this.device, format: this.format, alphaMode: this.engineConfig.alphaMode });

        resourceManager.init(this.device);
        resourceManager.loadBindLayouts(bindLayoutsData);
        resourceManager.loadSamplers(samplersData);
        resourceManager.loadVboPresets(vboPresetsData);
        resourceManager.loadFallbackTextures(fallbackTexturesData);
        PipelineLoader.setVertexInputs(vertexInputs);
        PipelineLoader.loadBlendPresets(blendPresetsData);
        PipelineLoader.defaultWorkgroupSize = this.engineConfig.computeTgs;
        loadVertexSlots(vertexSlotsData);
        uniformLayouts.load(uniformLayoutsData);

        // Load common system defs so BufferRegistry can see what UBOs/storage
        // buffers each common system declares. (loadDefs is idempotent — the
        // subsequent call in loadApp skips already-loaded common defs.)
        await systemRegistry.loadDefs(this.commonSystems, root, '');
        // Allocate every common-scoped buffer declared by common systems' defs
        // (the four legacy engine UBOs — camera / light / timeInput /
        // pointShadowFaces — are declared in camera.json / light.json /
        // input.json). Persists for the engine lifetime; app-scoped buffers
        // declared by an app's own system defs are allocated in loadApp.
        bufferRegistry.allocateFor(this.commonSystems, 'common', this.device);

        for (const [name, data] of Object.entries(PRESET_MESHES)) {
            resourceManager.registerMesh(name, data);
        }
        for (const [name, data] of Object.entries(PRESET_PBR_MESHES)) {
            resourceManager.registerPbrMesh(name, data);
        }

        // meshes.json is optional (warn when absent), but a malformed file or a
        // reference to an unregistered generator is a config bug — fail loud.
        const meshesResp = await fetch(`${root}/meshes.json`);
        let meshesCatalog: Array<{ name: string; generator: string; params?: Record<string, number> }> = [];
        if (this.isJson(meshesResp)) {
            meshesCatalog = await meshesResp.json();
        } else {
            console.warn(`[Engine] ${root}/meshes.json not found — no preset mesh catalog loaded`);
        }
        this.registerMeshCatalog(meshesCatalog);

        // gltf-mapping.json is only required by apps that declare glTF assets;
        // loadGltf() throws when it is needed but missing. Malformed → json() throws here.
        const gltfMapResp = await fetch(`${root}/gltf-mapping.json`);
        this.gltfMapping = this.isJson(gltfMapResp) ? await gltfMapResp.json() as GltfMapping : null;

        this.scene = new Scene();
        this.renderGraph = new RenderGraph();
        this.renderGraph.setPhases(phasesData);
        this.eventBus = new EventBus();
        this.scriptSystem = new ScriptSystem(this.eventBus, '');
        this.scriptSystem.attach(this.scene);
        this.scriptSystem.setHooks(this.engineConfig.scriptHooks);
        this.inputSystem = new InputSystem(this.canvas, this.eventBus);
        this.inputSystem.attach();
        this.physicsSystem = new PhysicsSystem();
        this.physicsSystem.attach(this.scene, this.eventBus);
        this.setAttachment('physics', this.physicsSystem, 'engine');
        this.setAttachment('particles', this.renderGraph.particleManager, 'engine');
        this.cameraSystem = new CameraSystem();
        this.cameraSystem.attach(this.scene);
        this.lightSystem = new LightSystem();
        this.lightSystem.attach(this.scene);
        this.animationSystem = new AnimationSystem();
        this.animationSystem.attach(this.scene);
        this.toolSystem = new ToolSystem(this.scene, this.eventBus, this.physicsSystem, () => this.aspect());
        this.scriptSystem.provide(this.physicsSystem, () => this.aspect());

        // Register built-in systems with the SystemRegistry so frame() dispatch
        // is data-driven (systems.json drives order + presence, registry maps
        // names to instances). 'gaussianSplat' is registered conditionally by
        // loadApp() (app-opted-in); the rest are always-present engine systems.
        systemRegistry.registerBuiltin('input', this.inputSystem);
        systemRegistry.registerBuiltin('script', this.scriptSystem);
        systemRegistry.registerBuiltin('physics', this.physicsSystem);
        systemRegistry.registerBuiltin('camera', this.cameraSystem);
        systemRegistry.registerBuiltin('light', this.lightSystem);
        systemRegistry.registerBuiltin('animation', this.animationSystem);
        systemRegistry.registerBuiltin('render', this.renderGraph);

        // Engine-level plugins (session lifetime). The engine has no compile-time
        // knowledge of any plugin: ids come from engine-config.json, invocation
        // goes through the registries populated below.
        PipelineLoader.pluginsRoot = this.engineConfig.pluginsRoot ?? '/plugins';
        pluginManager.configure({
            pluginsRoot: this.engineConfig.pluginsRoot ?? '/plugins',
            makeCtx: (id, baseUrl) => this.makePluginContext(id, baseUrl),
            applyDeclarations: (id, plugin) => this.applyPluginDeclarations(id, plugin),
            sweepOwner: (owner) => this.sweepPluginOwner(owner),
            beginOwner: (owner) => {
                const prev = resourceManager.currentOwnerId;
                resourceManager.enterApp(owner);
                return prev;
            },
            endOwner: (previous) => resourceManager.enterApp(previous),
        });
        await pluginManager.loadMany(this.engineConfig.plugins ?? [], 'engine');

        this.assertSystemsResolve();
    }

    /** Build the per-plugin context: identity (baseUrl) + owner-tracked registration surface. */
    private makePluginContext(id: string, baseUrl: string): PluginContext {
        const owner = pluginOwner(id);
        const ledger = this.ledgerFor(owner);
        return {
            device: this.device,
            scene: this.scene,
            eventBus: this.eventBus,
            engineConfig: this.engineConfig,
            baseUrl,
            renderer: this.renderer,
            registerSystem: (name, sys) => systemRegistry.registerBuiltin(name, sys, owner),
            registerAttachment: (name, obj) => this.setAttachment(name, obj, owner),
            registerRenderHook: (name, fn) => this.registerRenderHook(name, fn, owner),
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

    private ledgerFor(owner: string): PluginLedger {
        let ledger = this.pluginLedgers.get(owner);
        if (!ledger) {
            ledger = { tools: [], generators: [], atoms: [], phases: [] };
            this.pluginLedgers.set(owner, ledger);
        }
        return ledger;
    }

    /** One name, all three hook namespaces (mirrors RenderScriptLoader.loadAll). */
    private registerRenderHook(name: string, fn: unknown, owner: string): void {
        this.renderGraph.registerValueScript(name, fn as never, owner);
        this.renderGraph.registerGeometryHook(name, fn as never, owner);
        this.renderGraph.registerComputeHook(name, fn as never, owner);
    }

    /** Merge a plugin's declaration fields into the engine registries. */
    private applyPluginDeclarations(id: string, plugin: EnginePlugin): void {
        const owner = pluginOwner(id);
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
            this.renderGraph.mergeRenderTargets(plugin.renderTargets);
        }
        if (plugin.phases) {
            this.renderGraph.addPhases(plugin.phases);
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
    private sweepPluginOwner(owner: string): void {
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
        this.renderGraph.removeHooksByOwner(owner);
        this.renderGraph.removePhaseBehaviorsByOwner(owner);
        if (this.customRendererOwner === owner) {
            // The replacement renderer is gone — restore the built-in graph.
            this.customRenderer = null;
            this.customRendererOwner = null;
            systemRegistry.registerBuiltin('render', this.renderGraph, 'engine');
        }
        for (const [name, entry] of this.attachments) {
            if (entry.owner === owner) this.deleteAttachment(name);
        }
        const ledger = this.pluginLedgers.get(owner);
        if (ledger) {
            for (const t of ledger.tools) unregisterToolType(t);
            for (const g of ledger.generators) unregisterMeshGenerator(g);
            for (const [ns, name] of ledger.atoms) {
                if (atomNamespaces[ns]) delete atomNamespaces[ns][name];
            }
            if (ledger.phases.length > 0) this.renderGraph.removePhases(ledger.phases);
            this.pluginLedgers.delete(owner);
        }
    }

    /** Build meshes from a catalog (meshes.json or a plugin `meshes` field). */
    private registerMeshCatalog(entries: MeshCatalogEntry[]): void {
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

    /** The active renderer: a plugin replacement when installed, else the built-in graph. */
    get renderer(): IRenderer {
        return this.customRenderer ?? this.renderGraph;
    }

    private aspect(): number {
        return this.canvas.width / Math.max(1, this.canvas.height);
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
        const targetsUrl = `${this.engineConfig.dataRoot}/render-targets.json`;
        const targetsResp = await fetch(targetsUrl);
        if (!this.isJson(targetsResp)) {
            throw new Error(`render-targets.json not found: ${targetsUrl}`);
        }
        const targets = await targetsResp.json();
        this.renderGraph.setRenderTargets(targets);
        resourceManager.loadRenderTargets(targets);
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
        // systems.json; absent → keep the common baseline (commonSystems).
        const systemsUrl = this.resolveAsset(base, manifest.systems ?? 'systems.json');
        const sysResp = await fetch(systemsUrl);
        if (this.isJson(sysResp)) {
            this.activeSystems = await sysResp.json() as SystemEntry[];
        } else {
            this.activeSystems = this.commonSystems;
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

        // Script paths in scene.json are relative to the app base.
        this.scriptSystem.setBaseDir(base);
        this.animationSystem.setBaseDir(base);

        // Render graph assets (pipelines/shaders/textures) live under /common and
        // must be common-owned so they survive app switches; temporarily flip owner.
        resourceManager.enterApp('common');
        try {
            await this.loadRenderGraphData(renderJson, base);
        } finally {
            resourceManager.enterApp(name);
        }

        if (manifest.tools) {
            this.toolSystem.setBase(base);
            await this.toolSystem.loadFromFile(this.resolveAsset(base, manifest.tools));
        }
        for (const glb of manifest.gltf ?? []) {
            await this.loadGltf(this.resolveAsset(base, glb));
        }
        // Splat (3DGS) is an app-opted-in system: only wire the manager + load
        // GsComponent ply assets when this app's systems.json lists gaussianSplat.
        // Storage buffers live under the app's resource scope (released on switch).
        // The heavy lifting (scan scene for GsComponent + async PLY load) is now
        // a single manager call, keeping splat logic out of the Engine body.
        if (this.hasSystem('gaussianSplat')) {
            resourceManager.enterApp(name);
            const mgr = new GaussianSplatManager();
            this.gaussianSplatManager = mgr;
            this.setAttachment('splats', mgr, 'engine');
            systemRegistry.registerBuiltin('gaussianSplat', mgr);
            await mgr.loadFromScene(this.scene, base);
        }

        // Notify every loaded plugin that the app (scene + render graph) is up.
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
        this.toolSystem.dispose();
        this.scriptSystem.clear();
        this.animationSystem.clear();
        this.eventBus.clear();
        this.physicsSystem.reset();
        this.gaussianSplatManager?.dispose();
        this.gaussianSplatManager = null;
        this.deleteAttachment('splats');
        systemRegistry.unregisterBuiltin('gaussianSplat');
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
        this.canvas.width = this.canvas.clientWidth * this.dpr;
        this.canvas.height = this.canvas.clientHeight * this.dpr;
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

        const ctx: FrameContext = {
            scene: this.scene,
            time, dt,
            aspect: this.aspect(),
            cw: this.canvas.width,
            ch: this.canvas.height,
            canvas: this.canvas,
            device: this.device,
            context: this.context,
            format: this.format,
            eventBus: this.eventBus,
            attachments: this.attachmentsView,
            getSystem: <T,>(name: string) => systemRegistry.resolve({ name }) as T | null,
            // Script-system GPU access helpers (delegated to BufferRegistry + RenderGraph).
            getBuffer: (name: string) => bufferRegistry.get(name),
            writeBuffer: (name: string, data: BufferSource) => bufferRegistry.write(name, this.device, data),
            dispatchCompute: (pipelineName: string, count: number, entries?: GPUBindGroupEntry[]) => {
                this.dispatchCompute(pipelineName, count, entries);
            },
        };

        for (const sys of this.activeSystems) {
            const impl = systemRegistry.resolve(sys);
            impl?.update(ctx);
        }
        requestAnimationFrame(this.frame);
    };

    startLoop(): void {
        requestAnimationFrame(this.frame);
    }

    /** Dispatch a preloaded compute pipeline by name (script-system escape hatch).
     *  Opens a per-call command encoder + submit — functional but not optimal;
     *  batching multiple dispatches per frame is a future optimization. */
    private dispatchCompute(pipelineName: string, count: number, entries?: GPUBindGroupEntry[]): void {
        const pipeline = this.renderGraph.getComputePipeline(pipelineName);
        if (!pipeline) throw new Error(`compute pipeline '${pipelineName}' not loaded`);
        const meta = PipelineLoader.getComputeMeta(pipelineName);
        const tgs = meta?.workgroupSize ?? this.engineConfig.computeTgs;
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        if (entries && entries.length > 0) {
            const bg = this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries,
            });
            pass.setBindGroup(0, bg);
        }
        pass.dispatchWorkgroups(Math.ceil(count / tgs));
        pass.end();
        this.device.queue.submit([encoder.finish()]);
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
