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
    /** Engine-wide default workgroup size, set from engine-config.json. */
    static defaultWorkgroupSize = 64;
    /** Blend presets loaded from blend-presets.json. */
    static blendPresets: Record<string, GPUBlendState> = {};

    static setVertexInputs(decls: VertexInputDecls): void {
        this.vertexInputs = decls;
    }

    static loadBlendPresets(decls: Record<string, GPUBlendState>): void {
        this.blendPresets = decls;
    }

    static resolveBlend(blend: PipelineConfig['blend']): GPUBlendState | undefined {
        if (!blend) return undefined;
        if (typeof blend === 'string') return this.blendPresets[blend];
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

    static async load(
        device: GPUDevice,
        format: GPUTextureFormat,
        baseDir: string,
        configPath: string,
    ): Promise<GPURenderPipeline> {
        const isAbs = configPath.startsWith('/');
        const url = isAbs ? configPath : `${baseDir}/${configPath}`;
        const resp = await fetch(url);
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || (!ct.includes('json') && !ct.includes('application'))) {
            throw new Error(`Pipeline not found: ${url}`);
        }
        const config: PipelineConfig = await resp.json();

        const configDir = configPath.substring(0, configPath.lastIndexOf('/') + 1);
        const shaderBase = isAbs ? configDir : `${baseDir}/${configDir}`;

        const shaderFiles = new Set<string>();
        shaderFiles.add(config.vertex.shader);
        if (config.fragment) shaderFiles.add(config.fragment.shader);

        for (const shaderPath of shaderFiles) {
            const resolved = resolvePath(shaderBase, shaderPath);
            if (!this.shaderModules.has(resolved)) {
                const src = await (await fetch(resolved)).text();
                this.shaderModules.set(resolved, device.createShaderModule({ label: shaderPath, code: src }));
            }
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
        const isAbs = configPath.startsWith('/');
        const configDir = configPath.substring(0, configPath.lastIndexOf('/') + 1);
        const shaderBase = isAbs ? configDir : `${baseDir}/${configDir}`;
        return this.buildRender(device, stored.format, configPath, stored.config, shaderBase);
    }

    private static buildRender(
        device: GPUDevice,
        format: GPUTextureFormat,
        configPath: string,
        config: PipelineConfig,
        shaderBaseDir: string,
    ): GPURenderPipeline {
        const vsModule = this.shaderModules.get(resolvePath(shaderBaseDir, config.vertex.shader))!;

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
            const fsModule = this.shaderModules.get(resolvePath(shaderBaseDir, config.fragment.shader))!;
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
        const resp = await fetch(`${baseDir}/${configPath}`);
        const ct = resp.headers.get('content-type') ?? '';
        if (!resp.ok || (!ct.includes('json') && !ct.includes('application'))) {
            throw new Error(`Compute pipeline not found: ${baseDir}/${configPath}`);
        }
        const config: ComputePipelineConfig = await resp.json();

        const configDir = configPath.substring(0, configPath.lastIndexOf('/') + 1);
        const resolved = resolvePath(`${baseDir}/${configDir}`, config.compute.shader);
        const src = await (await fetch(resolved)).text();
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
