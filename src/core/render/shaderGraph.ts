import { resourceManager } from './ResourceManager';
import { bufferRegistry } from './BufferRegistry';
import { resolveValue } from './valueResolver';
import type { Scene } from '../ecs/Scene';
import type { ValueContext } from './valueResolver';

/**
 * Shader Graph — a per-pipeline compute program, expressed as a node graph.
 *
 * This is NOT the render-graph (which orchestrates which pipeline runs in which
 * phase). It is the INTERNAL shape of one compute pipeline: the order in which
 * data is bound to shaders, and the order shaders run, with If / ForEach / Loop
 * logic nodes. Shader inputs are GPU buffers obtained from component BufferHandle
 * fields (e.g. `MeshComponent.hPos`), and logic-node parameters (condition /
 * count / iterations) are read from component fields at runtime.
 *
 * The graph is a DAG:
 *   - data nodes resolve a GPU buffer (component handle field, or named buffer).
 *   - shader nodes dispatch a compute WGSL module; incoming `in:<binding>`
 *     edges bind buffers to @group(0) @binding(N).
 *   - if / foreach / loop nodes wrap a `body` sub-chain of nodes and a `next`
 *     continuation; their parameters come from component fields.
 *
 * Nodes are executed in a flow order derived from `next` edges (topological,
 * following `body` recursively for control nodes). All data edges are passive
 * references — they describe bindings, not execution.
 */

/** Which storage class a data node's buffer represents. */
export type ShaderGraphBufferKind = 'storage' | 'uniform' | 'vertex';

export interface ShaderGraphDataNode {
    id: string;
    type: 'data';
    /** Buffer handle source: `Component.field` (a u32 BufferHandle) or
     *  `buffer:<name>` for a BufferRegistry storage/uniform buffer. */
    source: string;
    kind: ShaderGraphBufferKind;
    /** Per-item byte stride (storage buffers written by shaders). */
    stride?: number;
}

export interface ShaderGraphShaderNode {
    id: string;
    type: 'shader';
    /** WGSL shader ref (resolved like pipeline shaders — plugin/URL/virtual). */
    shader: string;
    entryPoint: string;
    workgroupSize?: number;
    /** Dispatch count value source (component field, e.g. `ParticleSystemComponent.count`). */
    count: string;
}

export interface ShaderGraphIfNode {
    id: string;
    type: 'if';
    /** Condition value source — a scalar component field (non-zero = true). */
    condition: string;
}

export interface ShaderGraphForEachNode {
    id: string;
    type: 'foreach';
    /** Item count value source — a component field. */
    count: string;
    /** Optional index source (e.g. `builtin.entityId` or a component field). */
    index?: string;
}

export interface ShaderGraphLoopNode {
    id: string;
    type: 'loop';
    /** Iteration count — a component field or numeric literal. */
    iterations: string;
}

export type ShaderGraphNode =
    | ShaderGraphDataNode
    | ShaderGraphShaderNode
    | ShaderGraphIfNode
    | ShaderGraphForEachNode
    | ShaderGraphLoopNode;

export interface ShaderGraphEdge {
    id: string;
    source: string;
    /** 'out' = data/buffer output; 'body' = control body; 'next' = continuation. */
    sourceHandle: 'out' | 'body' | 'next';
    target: string;
    /** 'in:<binding>' = shader binding slot; 'body' = control body. */
    targetHandle: string;
}

export interface ShaderGraph {
    name: string;
    /** Components an entity must have for this graph to run over it. */
    query?: string[];
    nodes: ShaderGraphNode[];
    edges: ShaderGraphEdge[];
}

/** Runtime per-frame context for a ShaderGraphExecutor. */
export interface ShaderGraphFrame {
    scene: Scene;
    eid: number;
    device: GPUDevice;
    encoder: GPUCommandEncoder;
    time: number;
    dt: number;
}

/**
 * Executes a shader graph for one entity: walks the node flow, resolves data
 * buffers from component handles, dispatches each compute shader with a bind
 * group assembled from its `in:<binding>` edges. If/ForEach/Loop nodes evaluate
 * their parameters from component fields and drive body execution.
 */
export class ShaderGraphExecutor {
    private pipelines = new Map<string, GPUComputePipeline>();
    private shaderModules = new Map<string, GPUShaderModule>();
    private order: string[] = [];
    private bodyOf = new Map<string, string[]>();
    private nextOf = new Map<string, string>();
    private bindingsOf = new Map<string, Array<{ binding: number; dataNodeId: string }>>();
    /** Cache of compiled value-source closures keyed by the source string. */
    private compiledSrc = new Map<string, (ctx: ValueContext) => number | ArrayLike<number>>();
    private resolvedBuffers = new Map<string, GPUBuffer>();
    private entryPoints: string[] = [];

    constructor(
        private graph: ShaderGraph,
        private dataBase = '/common',
    ) {
        this.buildStructure();
    }

    /** Derive execution order + binding/body maps from the edge list. */
    private buildStructure(): void {
        const byId = new Map(this.graph.nodes.map(n => [n.id, n]));
        for (const edge of this.graph.edges) {
            if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
            if (edge.sourceHandle === 'body') {
                const list = this.bodyOf.get(edge.source) ?? [];
                list.push(edge.target);
                this.bodyOf.set(edge.source, list);
            } else if (edge.sourceHandle === 'next') {
                this.nextOf.set(edge.source, edge.target);
            } else if (edge.sourceHandle === 'out') {
                // data → shader binding: targetHandle = "in:<binding>"
                const m = /^in:(\d+)$/.exec(edge.targetHandle);
                if (m) {
                    const list = this.bindingsOf.get(edge.target) ?? [];
                    list.push({ binding: Number(m[1]), dataNodeId: edge.source });
                    this.bindingsOf.set(edge.target, list);
                }
            }
        }
        // Determine the root nodes (nodes with no incoming 'next' edge) and
        // linearize via nextOf. Control bodies are handled recursively.
        const hasIncomingNext = new Set<string>();
        for (const [, target] of this.nextOf) hasIncomingNext.add(target);
        for (const [, targets] of this.bodyOf) for (const t of targets) hasIncomingNext.add(t);
        const roots = this.graph.nodes.filter(n => !hasIncomingNext.has(n.id)).map(n => n.id);
        // Ensure a deterministic order: declared node order wins for ties.
        const declared = new Map(this.graph.nodes.map((n, i) => [n.id, i]));
        roots.sort((a, b) => (declared.get(a) ?? 0) - (declared.get(b) ?? 0));
        const seen = new Set<string>();
        const chain: string[] = [];
        const walk = (id: string): void => {
            if (seen.has(id)) return;
            seen.add(id);
            chain.push(id);
            const next = this.nextOf.get(id);
            if (next) walk(next);
        };
        for (const r of roots) walk(r);
        this.order = chain;
    }

    /** Asynchronously compile all shader nodes into compute pipelines. */
    async compile(device: GPUDevice): Promise<void> {
        for (const node of this.graph.nodes) {
            if (node.type !== 'shader') continue;
            const module = await this.loadShaderModule(device, node);
            this.shaderModules.set(node.id, module);
            const pipeline = device.createComputePipeline({
                label: `${this.graph.name}/${node.id}`,
                layout: 'auto',
                compute: { module, entryPoint: node.entryPoint },
            });
            this.pipelines.set(node.id, pipeline);
        }
    }

    private async loadShaderModule(device: GPUDevice, node: ShaderGraphShaderNode): Promise<GPUShaderModule> {
        const shaderBase = this.dataBase;
        const url = node.shader.startsWith('/') ? node.shader : `${shaderBase}/${node.shader}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Shader graph '${this.graph.name}': shader '${node.shader}' not found (${url})`);
        const src = await resp.text();
        return device.createShaderModule({ label: node.shader, code: src });
    }

    /** The graph's query components (an entity must have all of them). */
    get query(): string[] | undefined {
        return this.graph.query;
    }

    get name(): string {
        return this.graph.name;
    }

    /** Serialized graph data (for the editor's node view). */
    toData(): ShaderGraph {
        return {
            name: this.graph.name,
            query: this.graph.query ? [...this.graph.query] : undefined,
            nodes: this.graph.nodes.map(n => ({ ...n })),
            edges: this.graph.edges.map(e => ({ ...e })),
        };
    }

    /** Compile a value source at runtime (cached by source string). */
    private compileSource(src: string): (ctx: ValueContext) => number | ArrayLike<number> {
        let fn = this.compiledSrc.get(src);
        if (!fn) {
            fn = requireCompile(src);
            this.compiledSrc.set(src, fn);
        }
        return fn;
    }

    /** Execute the whole graph for one entity. Returns the resolved output buffers. */
    run(frame: ShaderGraphFrame): Map<string, GPUBuffer> {
        this.resolvedBuffers.clear();
        const vctx: ValueContext = {
            scene: frame.scene, eid: frame.eid, tag: '',
            time: frame.time, dt: frame.dt,
            aspect: frame.scene.getActiveCamera(1) ? 1 : 1,
            screenW: 0, screenH: 0,
            model: () => frame.scene.getModelMatrix(frame.eid),
            scripts: new Map(),
        };
        for (const id of this.order) {
            this.execNode(id, frame, vctx);
        }
        return new Map(this.resolvedBuffers);
    }

    private execNode(id: string, frame: ShaderGraphFrame, vctx: ValueContext): void {
        const node = this.graph.nodes.find(n => n.id === id);
        if (!node) return;
        switch (node.type) {
            case 'data':
                this.resolveData(node, frame);
                break;
            case 'shader':
                this.dispatchShader(node, frame, vctx);
                break;
            case 'if': {
                const cond = Number(this.evalSource(node.condition, vctx));
                if (cond !== 0) this.execChain(this.bodyOf.get(id) ?? [], frame, vctx);
                break;
            }
            case 'foreach': {
                const count = Math.max(0, Math.floor(Number(this.evalSource(node.count, vctx))));
                const body = this.bodyOf.get(id) ?? [];
                for (let i = 0; i < count; i++) {
                    if (node.index) {
                        vctx.eid = Number(this.evalSource(node.index, vctx));
                    }
                    this.execChain(body, frame, vctx);
                }
                break;
            }
            case 'loop': {
                const iters = Math.max(0, Math.floor(Number(this.evalSource(node.iterations, vctx))));
                const body = this.bodyOf.get(id) ?? [];
                for (let i = 0; i < iters; i++) this.execChain(body, frame, vctx);
                break;
            }
        }
    }

    /** Execute a chain of node ids (a control body) in order. */
    private execChain(ids: string[], frame: ShaderGraphFrame, vctx: ValueContext): void {
        for (const id of ids) {
            if (this.bodyOf.has(id) || this.nextOf.has(id)) {
                // A control node's body chain: handle recursion by dispatching
                // the sub-chain, then follow its `next` continuation.
                this.execNode(id, frame, vctx);
                continue;
            }
            this.execNode(id, frame, vctx);
        }
    }

    private resolveData(node: ShaderGraphDataNode, frame: ShaderGraphFrame): void {
        const { scene, eid, device } = frame;
        if (node.source.startsWith('buffer:')) {
            const name = node.source.slice(7);
            if (bufferRegistry.has(name)) {
                this.resolvedBuffers.set(node.id, bufferRegistry.get(name));
                return;
            }
        }
        // Component.field — a BufferHandle stored on the entity.
        const dot = node.source.indexOf('.');
        if (dot < 0) return;
        const comp = node.source.slice(0, dot);
        const field = node.source.slice(dot + 1);
        const handle = Number(scene.getField(eid, comp, field) ?? 0);
        const buf = resourceManager.getBuffer(handle);
        if (buf) {
            this.resolvedBuffers.set(node.id, buf);
            return;
        }
        // Fall back to a named resource.
        if (resourceManager.getNamedVBO(node.source)) {
            this.resolvedBuffers.set(node.id, resourceManager.getNamedVBO(node.source)!);
        }
    }

    private dispatchShader(node: ShaderGraphShaderNode, frame: ShaderGraphFrame, vctx: ValueContext): void {
        const pipeline = this.pipelines.get(node.id);
        if (!pipeline) return;
        const count = Math.max(0, Math.floor(Number(this.evalSource(node.count, vctx))));
        if (count <= 0) return;

        const bindings = this.bindingsOf.get(node.id) ?? [];
        if (bindings.length === 0) return;

        const entries: GPUBindGroupEntry[] = [];
        for (const b of bindings) {
            const buf = this.resolvedBuffers.get(b.dataNodeId);
            if (buf) entries.push({ binding: b.binding, resource: { buffer: buf } });
        }
        if (entries.length === 0) return;

        const bg = frame.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries,
        });
        const pass = frame.encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bg);
        const tgs = node.workgroupSize ?? 64;
        pass.dispatchWorkgroups(Math.ceil(count / tgs));
        pass.end();
    }

    private evalSource(src: string, vctx: ValueContext): number | ArrayLike<number> {
        const fn = this.compileSource(src);
        const v = fn(vctx);
        return typeof v === 'number' ? v : (v[0] ?? 0);
    }
}

/** Lazy value-source compiler (deferred so graph nodes can reference any
 *  component without a compile-time schema dependency). */
function requireCompile(src: string): (ctx: ValueContext) => number | ArrayLike<number> {
    // Numeric literal fast-path.
    const asNum = Number(src);
    if (!Number.isNaN(asNum)) return () => asNum;
    const dot = src.indexOf('.');
    if (dot < 0) return () => 0;
    const head = src.slice(0, dot);
    const field = src.slice(dot + 1);
    if (head === 'builtin' || head === 'transform' || head === 'tag') {
        // Reuse the engine resolver for namespaced atoms.
        return (ctx) => resolveValue(src, ctx) as number | ArrayLike<number>;
    }
    const comp = head;
    const f = field;
    return (ctx) => {
        const v = ctx.scene.getField(ctx.eid, comp, f);
        if (Array.isArray(v)) return v.map(Number);
        return Number(v ?? 0);
    };
}

/**
 * Registry of loaded shader graphs (name → executor). Graphs are declared as
 * render.json entries with `kind: "shaderGraph"` (the `pipeline` field names a
 * `.graph.json` file), or registered programmatically. The render graph runs
 * every registered graph for its matching entities in the compute stage.
 */
class ShaderGraphRegistry {
    private executors = new Map<string, ShaderGraphExecutor>();
    private owners = new Map<string, string>();

    /** Register a compiled executor under its graph name (cross-owner dup throw). */
    register(executor: ShaderGraphExecutor, owner = 'app'): void {
        const existing = this.owners.get(executor.name);
        if (existing !== undefined && existing !== owner) {
            throw new Error(`Shader graph '${executor.name}' already registered by ${existing} (attempted by ${owner})`);
        }
        this.owners.set(executor.name, owner);
        this.executors.set(executor.name, executor);
    }

    /** Get a registered executor by graph name. */
    get(name: string): ShaderGraphExecutor | undefined {
        return this.executors.get(name);
    }

    /** All registered graph names. */
    names(): string[] {
        return [...this.executors.keys()];
    }

    /** All registered executors (for the editor + frame execution). */
    all(): ShaderGraphExecutor[] {
        return [...this.executors.values()];
    }

    /** Drop every executor registered by `owner` (app switch / plugin unload). */
    removeByOwner(owner: string): void {
        for (const [name, o] of [...this.owners]) {
            if (o !== owner) continue;
            this.owners.delete(name);
            this.executors.delete(name);
        }
    }
}

export const shaderGraphRegistry = new ShaderGraphRegistry();
