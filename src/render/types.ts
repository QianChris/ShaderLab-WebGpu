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
