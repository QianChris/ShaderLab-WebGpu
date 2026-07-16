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
