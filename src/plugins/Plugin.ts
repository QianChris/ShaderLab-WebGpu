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
import type { ToolFactory } from '../tools/ToolSystem';

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
