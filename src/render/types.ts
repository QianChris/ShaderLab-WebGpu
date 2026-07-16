import type { SlotName } from './vertexSlots';

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

/** phases.json: declarative phase list with ordering and behavior tags. */
export interface PhaseDecl {
    name: string;
    order: number;
    behavior: 'normal' | 'shadow-clear' | 'postprocess-chain';
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
     *  Valid values: "cameraUBO", "lightUBO", "timeInputUBO", "pointShadowFaceUBO",
     *  "shadowDepth2DArray", "shadowPoint2DArray", "sampler:<samplerName>". */
    resource?: string;
}

export type BindLayoutDecls = Record<string, { entries: BindEntryDecl[] }>;

/** A load-manifest entry (render.json). Behaviour now lives in the pipeline's
 *  own `renderer` block; this just lists which pipelines to load. */
export interface PipelineEntry {
    name: string;
    pipeline: string;
    enabled: boolean;
    /** Legacy/optional kind hint; compute-only entries may still set "compute". */
    kind?: 'scene' | 'fullscreen' | 'compute' | 'skybox' | 'grid' | 'physics-debug' | 'particles';
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
}
