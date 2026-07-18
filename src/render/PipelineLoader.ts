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
    private static pipelineSlots = new Map<string, SlotName[]>();
    private static configs = new Map<string, { config: PipelineConfig; format: GPUTextureFormat }>();
    private static shaderModules = new Map<string, GPUShaderModule>();
    private static computeMeta = new Map<string, ComputeMeta>();
    /** In-memory pipeline configs declared by plugins ('<plugin>:<name>' keys). */
    private static virtualConfigs = new Map<string, PipelineConfig | ComputePipelineConfig>();
    /** In-memory WGSL sources declared by plugins ('<plugin>:<relpath>' keys). */
    private static virtualShaders = new Map<string, string>();
    /** Engine-wide default workgroup size, set from engine-config.json. */
    static defaultWorkgroupSize = 64;
    /** Plugins root URL (from engine-config.json), for '<plugin>:<path>' refs. */
    static pluginsRoot = '/plugins';
    /** Blend presets loaded from blend-presets.json. */
    static blendPresets: Record<string, GPUBlendState> = {};

    static setVertexInputs(decls: VertexInputDecls): void {
        this.vertexInputs = decls;
    }

    /** Merge additional vertex inputs (plugins). Duplicate names throw. */
    static mergeVertexInputs(decls: VertexInputDecls): void {
        for (const [name, decl] of Object.entries(decls)) {
            if (this.vertexInputs[name]) throw new Error(`Vertex input '${name}' already declared`);
            this.vertexInputs[name] = decl;
        }
    }

    static loadBlendPresets(decls: Record<string, GPUBlendState>): void {
        this.blendPresets = decls;
    }

    /** Merge additional blend presets (plugins). Duplicate names throw. */
    static mergeBlendPresets(decls: Record<string, GPUBlendState>): void {
        for (const [name, decl] of Object.entries(decls)) {
            if (this.blendPresets[name]) throw new Error(`Blend preset '${name}' already declared`);
            this.blendPresets[name] = decl;
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
