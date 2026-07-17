import { Scene, type SceneData } from './ecs/Scene';
import { ScriptSystem } from './ecs/ScriptSystem';
import { InputSystem } from './ecs/InputSystem';
import { PhysicsSystem } from './ecs/PhysicsSystem';
import { CameraSystem } from './ecs/CameraSystem';
import { LightSystem } from './ecs/LightSystem';
import { AnimationSystem } from './ecs/AnimationSystem';
import { ToolSystem } from './tools/ToolSystem';
import { EventBus } from './events/EventBus';
import { RenderGraph } from './render/RenderGraph';
import { resourceManager } from './render/ResourceManager';
import { PipelineLoader } from './render/PipelineLoader';
import { uniformLayouts, type UniformLayoutDecls } from './render/UniformLayout';
import { schemaRegistry } from './ecs/SchemaRegistry';
import { systemRegistry, type FrameContext } from './ecs/SystemRegistry';
import { bufferRegistry } from './render/BufferRegistry';
import { PRESET_MESHES, PRESET_PBR_MESHES, meshGenerators, isPbrMeshData } from './render/Primitives';
import { loadVertexSlots, type VertexSlotDecls, VERTEX_SLOTS, SLOT_ORDER } from './render/vertexSlots';
import { GltfLoader } from './gltf/GltfLoader';
import { GaussianSplatManager } from './render/GaussianSplatManager';
import RAPIER from '@dimforge/rapier3d-compat';
import type { RenderGraphData, VertexInputDecls, BindLayoutDecls, SamplerDecls, PhaseDecl } from './render/types';

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
};

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

    private dpr: number;
    private canvas: HTMLCanvasElement;
    private startTime = 0;
    private lastTime = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.dpr = window.devicePixelRatio || 1;
    }

    async init(): Promise<void> {
        try {
            const resp = await fetch('/common/engine-config.json');
            if (resp.ok) this.engineConfig = await resp.json() as EngineConfig;
        } catch { /* fall back to defaults */ }

        const root = this.engineConfig.dataRoot;
        // Load the default system order (common/systems.json). Falls back to
        // engine-config.systemOrder for back-compat when the file is absent.
        try {
            const sr = await fetch(`${root}/systems.json`);
            if (sr.ok) this.commonSystems = await sr.json() as SystemEntry[];
        } catch { /* fall back below */ }
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

        const meshesCatalog = await fetch(`${root}/meshes.json`)
            .then(r => r.json() as Promise<Array<{ name: string; generator: string; params?: Record<string, number> }>>)
            .catch(() => []);
        for (const entry of meshesCatalog) {
            const gen = meshGenerators[entry.generator];
            if (!gen) continue;
            const data = gen(entry.params ?? {});
            if (isPbrMeshData(data)) {
                resourceManager.registerPbrMesh(entry.name, data);
            } else {
                resourceManager.registerMesh(entry.name, data);
            }
        }

        this.gltfMapping = await fetch(`${root}/gltf-mapping.json`)
            .then(r => r.ok ? r.json() as Promise<GltfMapping> : null)
            .catch(() => null);

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
        this.renderGraph.physics = this.physicsSystem;
        this.cameraSystem = new CameraSystem();
        this.cameraSystem.attach(this.scene);
        this.lightSystem = new LightSystem();
        this.lightSystem.attach(this.scene);
        this.renderGraph.lightSystem = this.lightSystem;
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
    }

    private aspect(): number {
        return this.canvas.width / Math.max(1, this.canvas.height);
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
        const targets = await fetch(`${this.engineConfig.dataRoot}/render-targets.json`)
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}));
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
        this.unloadCurrentApp();
        this.currentApp = name;
        resourceManager.enterApp(name);

        const base = `${this.engineConfig.appsRoot}/${name}`;
        const manifestResp = await fetch(`${base}/app.json`);
        if (!this.isJson(manifestResp)) {
            throw new Error(`App not found at ${base}/app.json. If you renamed the folder, update the "name" field in app.json to match.`);
        }
        const manifest = await manifestResp.json() as AppManifest;

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
            await schemaRegistry.loadMore(this.resolveAsset(base, rel));
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
            this.renderGraph.splats = mgr;
            systemRegistry.registerBuiltin('gaussianSplat', mgr);
            await mgr.loadFromScene(this.scene, base);
        }
    }

    /** Unload the current app: release every app-owned resource and reset state.
     *  Common assets (preset meshes, common pipelines, shaders, named layouts,
     *  samplers, default textures) are kept for reuse. */
    unloadCurrentApp(): void {
        if (!this.currentApp) return;
        const appId = this.currentApp;
        this.toolSystem.dispose();
        this.scriptSystem.clear();
        this.animationSystem.clear();
        this.eventBus.clear();
        this.physicsSystem.reset();
        this.gaussianSplatManager?.dispose();
        this.gaussianSplatManager = null;
        this.renderGraph.splats = null;
        systemRegistry.unregisterBuiltin('gaussianSplat');
        systemRegistry.clearScripts();
        bufferRegistry.exitApp(appId);
        this.activeSystems = this.commonSystems;
        this.scene.clear();
        schemaRegistry.resetStrings();
        this.renderGraph.exitApp(appId);
        resourceManager.exitApp(appId);
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
            physics: this.physicsSystem,
            camera: this.cameraSystem,
            light: this.lightSystem,
            animation: this.animationSystem,
            input: this.inputSystem,
            script: this.scriptSystem,
            splats: this.gaussianSplatManager,
            renderGraph: this.renderGraph,
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
            const m = this.gltfMapping;
            const entityData: Record<string, Record<string, unknown>> = {};

            if (m) {
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
            } else {
                entityData['Transform'] = {
                    position: node.transform.position,
                    rotation: node.transform.rotation,
                    scale: node.transform.scale,
                };
                entityData['MeshComponent'] = { mesh: node.meshName };

                const pm = result.primitives.find(p => p.name === node.meshName);
                if (pm) {
                    entityData['PbrMaterial'] = {
                        baseColor: pm.material.baseColorFactor,
                        metallic: pm.material.metallicFactor,
                        roughness: pm.material.roughnessFactor,
                        ao: pm.material.aoStrength,
                        emissive: pm.material.emissiveFactor,
                        texBaseColor: pm.baseColorTexture ? resourceManager.textureHandle(pm.baseColorTexture) : 0,
                        texMetalRough: pm.metallicRoughnessTexture ? resourceManager.textureHandle(pm.metallicRoughnessTexture) : 0,
                        texOcclusion: pm.occlusionTexture ? resourceManager.textureHandle(pm.occlusionTexture) : 0,
                        texEmissive: pm.emissiveTexture ? resourceManager.textureHandle(pm.emissiveTexture) : 0,
                        texNormal: pm.normalTexture ? resourceManager.textureHandle(pm.normalTexture) : 0,
                    };
                }
            }

            this.scene.createEntity(node.name, entityData);
        }

        this.resolveHandles();
    }
}
