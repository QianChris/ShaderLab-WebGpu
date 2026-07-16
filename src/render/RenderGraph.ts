import { defineQuery } from 'bitecs/legacy';
import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { ParticleManager } from './ParticleManager';
import { PipelineDriver, type GeometryHook, type ComputeHook } from './PipelineDriver';
import { RenderScriptLoader } from './RenderScriptLoader';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { type RenderGraphData, type PhaseMap, type PhaseDecl } from './types';
import type { RenderTargetDecls } from './rendererDecl';
import type { ValueContext } from './valueResolver';
import type { Scene } from '../ecs/Scene';

const SCREEN = 'screen';

const DEFAULT_PHASES: PhaseDecl[] = [
    { name: 'Preprocess',  order: 10, behavior: 'normal' },
    { name: 'Compute',     order: 20, behavior: 'normal' },
    { name: 'Shadow',      order: 30, behavior: 'shadow-clear' },
    { name: 'Opaque',      order: 40, behavior: 'normal' },
    { name: 'Skybox',      order: 50, behavior: 'normal' },
    { name: 'Transparent', order: 60, behavior: 'normal' },
    { name: 'Postprocess', order: 70, behavior: 'postprocess-chain' },
];

/**
 * Data-driven render graph. Owns no per-pipeline draw logic. Each render
 * pipeline embeds a declarative `renderer` block (query / target / geometry /
 * bind groups); a generic PipelineDriver executes it. Pipelines self-declare
 * their phase; render.json is just the load manifest + defaults.
 */
export class RenderGraph {
    name = '';
    phases: PhaseMap = {};
    physics: import('../ecs/PhysicsSystem').PhysicsSystem | null = null;
    lightSystem: import('../ecs/LightSystem').LightSystem | null = null;
    splats: import('./GaussianSplatManager').GaussianSplatManager | null = null;

    private phaseList: PhaseDecl[] = DEFAULT_PHASES;
    private clearColor: [number, number, number, number] = [0, 0, 0, 1];
    private pipelines = new Map<string, GPURenderPipeline>();
    private computePipelines = new Map<string, GPUComputePipeline>();
    private drivers: PipelineDriver[] = [];
    private targets: RenderTargetDecls = {};
    private dataBase = '/common';
    private scriptsSubdir = 'scripts';
    private format: GPUTextureFormat = 'bgra8unorm';
    private particles = new ParticleManager();
    private sceneIsScreen = true;

    private valueScripts = new Map<string, (ctx: ValueContext) => number[] | number>();
    private geometryHooks = new Map<string, GeometryHook>();
    private computeHooks = new Map<string, ComputeHook>();
    private scriptFiles: string[] = [];

    /** Register an escape-hatch script (Phase 2/3 populate these). */
    registerValueScript(name: string, fn: (ctx: ValueContext) => number[] | number): void {
        this.valueScripts.set(name, fn);
    }
    registerGeometryHook(name: string, fn: GeometryHook): void {
        this.geometryHooks.set(name, fn);
    }
    registerComputeHook(name: string, fn: ComputeHook): void {
        this.computeHooks.set(name, fn);
    }

    setRenderTargets(targets: RenderTargetDecls): void {
        this.targets = targets;
    }

    /** Release app-owned state: drivers, escape-hatch hooks, particle GPU buffers.
     *  Common pipelines / shader modules are kept for reuse across apps. */
    exitApp(_appId: string): void {
        this.drivers = [];
        this.valueScripts.clear();
        this.geometryHooks.clear();
        this.computeHooks.clear();
        this.particles.clear();
    }

    /** Names of render escape-hatch scripts to load at compile (e.g. "render/pbr.js"). */
    setScriptFiles(files: string[]): void {
        this.scriptFiles = files;
    }

    /** Set the scripts subdirectory (from engine-config.json). */
    setScriptsSubdir(subdir: string): void {
        this.scriptsSubdir = subdir;
    }

    /** Set the phase list (from phases.json). */
    setPhases(phases: PhaseDecl[]): void {
        this.phaseList = [...phases].sort((a, b) => a.order - b.order);
    }

    /** Ordered phase names (for editor display). */
    getPhaseNames(): string[] {
        return this.phaseList.map(p => p.name);
    }

    fromData(data: RenderGraphData): void {
        this.name = data.name;
        if (data.clearColor) {
            this.clearColor = data.clearColor;
        } else {
            const def = schemaRegistry.getFieldDefault('EnvironmentComponent', 'clearColor') as number[] | undefined;
            if (def) this.clearColor = [def[0], def[1], def[2], def[3]];
        }
        this.phases = {};
        for (const phase of this.phaseList) {
            const list = data.phases[phase.name] ?? [];
            this.phases[phase.name] = list.map(e => ({ ...e, enabled: e.enabled ?? true }));
        }
    }

    async compile(device: GPUDevice, format: GPUTextureFormat, dataBase: string, appBase?: string): Promise<void> {
        this.dataBase = dataBase;
        this.format = format;
        this.drivers = [];

        // Load escape-hatch render scripts, merge into the hook registries.
        if (this.scriptFiles.length > 0) {
            const loader = new RenderScriptLoader(dataBase, this.scriptsSubdir);
            const hooks = await loader.loadAll(this.scriptFiles);
            for (const [k, v] of hooks.value) if (!this.valueScripts.has(k)) this.valueScripts.set(k, v);
            for (const [k, v] of hooks.geometry) if (!this.geometryHooks.has(k)) this.geometryHooks.set(k, v);
            for (const [k, v] of hooks.compute) if (!this.computeHooks.has(k)) this.computeHooks.set(k, v);
        }

        // Load every pipeline listed in the manifest, build a driver from its renderer block.
        for (const phase of this.phaseList) {
            for (const entry of this.phases[phase.name] ?? []) {
                // compute-only entries (particle emit/sim) are loaded lazily by their driver
                if (entry.kind === 'compute') {
                    if (!this.computePipelines.has(entry.pipeline)) {
                        this.computePipelines.set(entry.pipeline, await this.tryLoadCompute(device, dataBase, appBase, entry.pipeline));
                    }
                    continue;
                }

                if (!this.pipelines.has(entry.pipeline)) {
                    this.pipelines.set(entry.pipeline, await this.tryLoadPipeline(device, format, dataBase, appBase, entry.pipeline));
                }
                const config = PipelineLoader.getConfig(entry.pipeline);
                const decl = config?.renderer;
                if (!decl) continue;

                // preload auxiliary compute pipelines declared in renderer.aux
                // (values ending with .json are preloaded as compute pipelines).
                for (const v of Object.values(decl.aux ?? {})) {
                    if (typeof v === 'string' && v.endsWith('.json') && !this.computePipelines.has(v)) {
                        this.computePipelines.set(v, await this.tryLoadCompute(device, dataBase, appBase, v));
                    }
                }
                // preload skybox / declared asset textures
                for (const bg of decl.bindGroups ?? []) {
                    for (const t of bg.textures ?? []) {
                        if (t.source.startsWith('asset:')) {
                            await resourceManager.loadTexture(`${dataBase}/${t.source.slice(6)}`);
                        }
                    }
                }

                const driver = new PipelineDriver(entry.pipeline, decl, entry, this.valueScripts, this.geometryHooks, this.computeHooks);
                driver.dataBase = dataBase;
                driver.aux = decl.aux ?? {};
                if (decl.query) driver.query = defineQuery(decl.query.map(name => schemaRegistry.get(name)!));
                this.drivers.push(driver);
            }
        }
    }

    /** Try loading a render pipeline from commonBase first, then appBase on 404. */
    private async tryLoadPipeline(
        device: GPUDevice, format: GPUTextureFormat, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPURenderPipeline> {
        if (path.startsWith('/')) {
            return PipelineLoader.load(device, format, commonBase, path);
        }
        try {
            return await PipelineLoader.load(device, format, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.load(device, format, appBase, path);
        }
    }

    /** Try loading a compute pipeline from commonBase first, then appBase on 404. */
    private async tryLoadCompute(
        device: GPUDevice, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPUComputePipeline> {
        if (path.startsWith('/')) {
            return PipelineLoader.loadCompute(device, commonBase, path);
        }
        try {
            return await PipelineLoader.loadCompute(device, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Compute pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.loadCompute(device, appBase, path);
        }
    }

    execute(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, scene: Scene, time: number, dt: number): void {
        const tex = context.getCurrentTexture();
        const cw = tex.width;
        const ch = tex.height;

        const frame = {
            time, dt, cw, ch,
            physics: this.physics,
            particles: this.particles,
            splats: this.splats,
            computePipelines: this.computePipelines,
        };

        const encoder = device.createCommandEncoder();

        // ── shadow phase ──
        // No upfront clear: when there are shadow-casting lights, runShadowPhase
        // clears each face/layer via loadOp as it renders. When there are none,
        // the shadow textures are never sampled (per-light params.y gating), so
        // clearing would be wasted work — and a whole-array view can't be used as
        // a render-pass attachment anyway (WebGPU requires single-layer views).
        void this.phaseList.find(p => p.behavior === 'shadow-clear');

        // ── compute stage (script hooks) ──
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(encoder, {
                scene, time, dt,
                computePipelines: this.computePipelines,
                particles: this.particles,
            });
        }

        // If nothing post-processes, the "scene" target is the swapchain directly.
        const postPhase = this.phaseList.find(p => p.behavior === 'postprocess-chain');
        const hasPost = postPhase
            ? this.drivers.some(d => d.entry.enabled && d.decl.phase === postPhase.name)
            : false;
        this.sceneIsScreen = !hasPost;

        // ── group drivers by phase, then by (color,depth) target run ──
        const swapView = tex.createView();
        const cleared = new Set<string>();
        for (const phase of this.phaseList) {
            const inPhase = this.drivers.filter(d => d.entry.enabled && d.decl.phase === phase.name);
            if (inPhase.length === 0) continue;
            this.runPhase(encoder, phase, inPhase, scene, frame, cw, ch, format, swapView, cleared);
        }

        device.queue.submit([encoder.finish()]);
    }

    private runPhase(
        encoder: GPUCommandEncoder,
        phase: PhaseDecl,
        drivers: PipelineDriver[],
        scene: Scene,
        frame: {
            time: number; dt: number; cw: number; ch: number;
            physics: import('../ecs/PhysicsSystem').PhysicsSystem | null;
            particles: ParticleManager;
            splats: import('./GaussianSplatManager').GaussianSplatManager | null;
            computePipelines: Map<string, GPUComputePipeline>;
        },
        cw: number, ch: number, format: GPUTextureFormat, swapView: GPUTextureView,
        cleared: Set<string>,
    ): void {
        // Post-process phase: ping-pong fullscreen chain.
        if (phase.behavior === 'postprocess-chain') {
            this.runPostChain(encoder, drivers, scene, frame, cw, ch, format, swapView);
            return;
        }

        // Shadow phase: one depth-only render pass per (light, face), driven by
        // LightSystem.shadowPassList. Each pass clears its own layer/face.
        if (phase.behavior === 'shadow-clear') {
            this.runShadowPhase(encoder, drivers, scene, frame);
            return;
        }

        // Merge consecutive drivers that share the same color(s)+depth target into one
        // pass. `color` may be a single name or an array (MRT, e.g. deferred GBuffer).
        const colorNamesOf = (d: PipelineDriver): string[] => {
            const c = d.decl.target?.color;
            return Array.isArray(c) ? c : [c ?? 'scene'];
        };
        let i = 0;
        while (i < drivers.length) {
            const colors = colorNamesOf(drivers[i]);
            const colorsKey = colors.join(',');
            const depthName = drivers[i].decl.target?.depth ?? 'sceneDepth';

            let j = i;
            while (j < drivers.length
                && colorNamesOf(drivers[j]).join(',') === colorsKey
                && (drivers[j].decl.target?.depth ?? 'sceneDepth') === depthName) {
                j++;
            }

            // Clear a target only the first time it is written this frame.
            const key = `${colorsKey}|${depthName}`;
            const clear = !cleared.has(key);
            cleared.add(key);
            this.openPassAndRecord(
                encoder, colors, depthName, drivers.slice(i, j),
                scene, frame, cw, ch, format, swapView, clear,
            );
            i = j;
        }
    }

    /** Shadow phase: iterate LightSystem.shadowPassList and render all shadow
     *  casters into each shadow light's depth face. The ShadowPipeline driver
     *  auto-binds group 0 (frameShadow) and group 1 (object) per entity; the
     *  per-face selector at group 2 (shadowPass) is set here once per pass.
     *  Each face is cleared via loadOp regardless of whether a driver runs. */
    private runShadowPhase(
        encoder: GPUCommandEncoder,
        drivers: PipelineDriver[],
        scene: Scene,
        frame: {
            time: number; dt: number; cw: number; ch: number;
            physics: import('../ecs/PhysicsSystem').PhysicsSystem | null;
            particles: ParticleManager;
            splats: import('./GaussianSplatManager').GaussianSplatManager | null;
            computePipelines: Map<string, GPUComputePipeline>;
        },
    ): void {
        const passes = this.lightSystem?.shadowPassList ?? [];
        if (passes.length === 0) return;
        const driver = drivers[0];
        const pipeline = driver ? this.pipelines.get(driver.path) : undefined;
        for (let i = 0; i < passes.length; i++) {
            const p = passes[i];
            const pass = encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                    view: p.view,
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                },
            });
            if (pipeline && driver) {
                // Per-face selector {lightIdx, face} for the shadow-depth vertex shader.
                pass.setBindGroup(2, resourceManager.shadowPassBindGroup(i, p.lightIdx, p.face));
                driver.record(pass, scene, pipeline, frame);
            }
            pass.end();
        }
    }

    private openPassAndRecord(
        encoder: GPUCommandEncoder,
        colorNames: string[], depthName: string,
        drivers: PipelineDriver[],
        scene: Scene,
        frame: {
            time: number; dt: number; cw: number; ch: number;
            physics: import('../ecs/PhysicsSystem').PhysicsSystem | null;
            particles: ParticleManager;
            splats: import('./GaussianSplatManager').GaussianSplatManager | null;
            computePipelines: Map<string, GPUComputePipeline>;
        },
        cw: number, ch: number, format: GPUTextureFormat, swapView: GPUTextureView, clear: boolean,
    ): void {
        const isDepthOnly = colorNames.length === 1 && colorNames[0] === 'none';

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (!isDepthOnly) {
            const envClear = scene.getEnvironmentClearColor() ?? this.clearColor;
            for (const name of colorNames) {
                const view = (name === SCREEN || (name === 'scene' && this.sceneIsScreen))
                    ? swapView
                    : resourceManager.namedColorTargetView(name, cw, ch, format);
                colorAttachments.push({
                    view,
                    // The scene/screen target clears to the env color; offscreen
                    // GBuffer targets clear to zero (black, no albedo/normal).
                    clearValue: (name === 'scene' || name === SCREEN) ? envClear : [0, 0, 0, 0],
                    loadOp: clear ? 'clear' : 'load',
                    storeOp: 'store',
                });
            }
        }

        const desc: GPURenderPassDescriptor = {
            colorAttachments,
        };

        if (depthName && depthName !== 'none') {
            const depthView = resourceManager.namedDepthTargetView(depthName, cw, ch);
            desc.depthStencilAttachment = {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: clear ? 'clear' : 'load',
                depthStoreOp: 'store',
            };
        }

        const pass = encoder.beginRenderPass(desc);
        for (const d of drivers) {
            const pipeline = this.pipelines.get(d.path);
            if (!pipeline) continue;
            d.record(pass, scene, pipeline, frame);
        }
        pass.end();
    }

    private runPostChain(
        encoder: GPUCommandEncoder,
        drivers: PipelineDriver[],
        scene: Scene,
        frame: { time: number; dt: number; cw: number; ch: number },
        cw: number, ch: number, format: GPUTextureFormat, swapView: GPUTextureView,
    ): void {
        void scene; void frame;
        const transients = this.transientTargetNames();
        // Dynamic chain routing: first reads from scene, last writes to screen,
        // middle passes ping-pong between transient targets.
        // Declared entry.input/output are hints for transient names but the
        // chain always starts at scene and ends at screen regardless of which
        // passes are enabled/disabled.
        let prevOutput = 'scene';
        for (let i = 0; i < drivers.length; i++) {
            const last = i === drivers.length - 1;
            const entry = drivers[i].entry;
            const input = prevOutput;
            const output = last
                ? 'screen'
                : transients.find(t => t !== input) ?? 'ppB';
            const srcView = input === 'scene' && this.sceneIsScreen
                ? swapView
                : resourceManager.namedColorTargetView(input, cw, ch, format);
            const dstView = output === 'screen'
                ? swapView
                : resourceManager.namedColorTargetView(output, cw, ch, format);
            const pipeline = this.pipelines.get(drivers[i].path);
            if (!pipeline) { prevOutput = output; continue; }

            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: dstView, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, resourceManager.fullscreenBindGroup(srcView, entry));
            pass.draw(3);
            pass.end();
            prevOutput = output;
        }
    }

    /** Collect transient color target names from render-targets.json. */
    private transientTargetNames(): string[] {
        const names: string[] = [];
        for (const [name, decl] of Object.entries(this.targets)) {
            if (decl.transient) names.push(name);
        }
        return names.length > 0 ? names : ['ppA', 'ppB'];
    }

    toData(): RenderGraphData {
        const phases: Partial<PhaseMap> = {};
        for (const phase of this.phaseList) {
            phases[phase.name] = (this.phases[phase.name] ?? []).map(e => ({ ...e }));
        }
        return { name: this.name, clearColor: [...this.clearColor], phases };
    }

    rebuildPipeline(device: GPUDevice, pipelinePath: string): void {
        if (!this.pipelines.has(pipelinePath)) return;
        this.pipelines.set(pipelinePath, PipelineLoader.rebuild(device, this.dataBase, pipelinePath));
    }
}
