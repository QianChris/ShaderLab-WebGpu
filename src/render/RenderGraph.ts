import { defineQuery } from 'bitecs/legacy';
import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { ParticleManager } from './ParticleManager';
import { PipelineDriver, type GeometryHook, type ComputeHook } from './PipelineDriver';
import { RenderScriptLoader } from './RenderScriptLoader';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { uniformLayouts } from './UniformLayout';
import { type RenderGraphData, type PhaseMap, type PhaseDecl } from './types';
import type { RenderTargetDecls } from './rendererDecl';
import type { ValueContext } from './valueResolver';
import type { Scene, CameraView } from '../ecs/Scene';

const SCREEN = 'screen';

/** Pixel rect for a camera's on-screen viewport (scissor + viewport). */
interface ViewportRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

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

    private phaseList: PhaseDecl[] = [];
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
    /** Multi-view split-screen toggle (from render.json `multiView: true`). */
    private multiView = false;
    /** Scratch buffer for per-camera UBO uploads in multi-view mode. */
    private cameraData: Float32Array = new Float32Array(0);

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
        // Drop per-entity bind-group caches promptly (the driver objects will be
        // GC'd eventually, but explicitly clearing the cache makes the cached
        // GPUBindGroups dereferenced now rather than after driver GC).
        for (const d of this.drivers) d.dispose();
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
        this.multiView = data.multiView ?? false;
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

        // Multi-view cannot share a command buffer with the postprocess ping-pong
        // chain (each camera owns its own command buffer; the chain routes through
        // a single shared screen target). Fail loud at compile so the conflict is
        // surfaced as a config error, not a silent frame drop.
        if (this.multiView) {
            const postPhase = this.phaseList.find(p => p.behavior === 'postprocess-chain');
            const postEnabled = postPhase
                ? this.drivers.some(d => d.entry.enabled && d.decl.phase === postPhase.name)
                : false;
            if (postEnabled) {
                throw new Error(
                    `Render graph '${this.name}' declares multiView:true but has an enabled ` +
                    `postprocess-chain driver in phase '${postPhase!.name}' — these are mutually ` +
                    `exclusive. Disable multiView or the post-process pipeline.`,
                );
            }
        }

        // Lazily allocate the per-camera UBO scratch buffer now that the camera
        // layout size is known (from uniform-layouts.json).
        if (this.multiView && this.cameraData.length === 0) {
            this.cameraData = uniformLayouts.get('camera').createBuffer();
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
        const canvasAspect = cw / Math.max(1, ch);

        // Multi-view is opt-in via render.json `multiView: true`. When enabled
        // AND more than one Camera is active, each camera renders the whole
        // scene into its own on-screen viewport (Camera.viewport). The shared
        // camera UBO is re-written per camera, so each camera must own its own
        // command buffer (writeBuffer → submit) — a single command buffer
        // cannot safely re-write a shared UBO between render passes.
        const cameras = scene.getActiveCameras(canvasAspect);
        const swapView = tex.createView();
        if (this.multiView && cameras.length > 1) {
            this.executeMultiView(device, scene, time, dt, cw, ch, format, swapView, cameras);
            return;
        }
        this.executeSingle(device, scene, time, dt, cw, ch, format, swapView);
    }

    /** Single-camera (or zero-camera) path: the original render-graph execute.
     *  The camera UBO is assumed already written by CameraSystem.update. */
    private executeSingle(
        device: GPUDevice, scene: Scene, time: number, dt: number,
        cw: number, ch: number, format: GPUTextureFormat, swapView: GPUTextureView,
    ): void {
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
        const cleared = new Set<string>();
        for (const phase of this.phaseList) {
            if (phase.behavior === 'shadow-clear') {
                // Always clear shadow faces (when there are shadow-casting
                // lights), even if the shadow pipeline is disabled — otherwise
                // PBR would sample stale depth and shadows would not disappear.
                this.runShadowPhase(
                    encoder,
                    this.drivers.filter(d => d.decl.phase === phase.name),
                    scene, frame,
                );
                continue;
            }
            const inPhase = this.drivers.filter(d => d.entry.enabled && d.decl.phase === phase.name);
            if (inPhase.length === 0) continue;
            this.runPhase(encoder, phase, inPhase, scene, frame, cw, ch, format, swapView, cleared, null);
        }

        device.queue.submit([encoder.finish()]);
    }

    /** Multi-view path: render every active camera into its own viewport.
     *  Compute + shadow run once (camera-independent); then per camera:
     *  write the camera UBO, open one command buffer, run all non-shadow /
     *  non-postprocess phases with that camera's viewport, submit. */
    private executeMultiView(
        device: GPUDevice, scene: Scene, time: number, dt: number,
        cw: number, ch: number, format: GPUTextureFormat, swapView: GPUTextureView,
        cameras: CameraView[],
    ): void {
        const frame = {
            time, dt, cw, ch,
            physics: this.physics,
            particles: this.particles,
            splats: this.splats,
            computePipelines: this.computePipelines,
        };

        // Multi-view does not support the postprocess chain (it routes through a
        // single screen target). The scene target IS the screen here. The
        // conflict is validated out at compile(), so the skip below is defensive.
        this.sceneIsScreen = true;

        // ── stage 1: compute + shadow (camera-independent), one submit ──
        const enc0 = device.createCommandEncoder();
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(enc0, {
                scene, time, dt,
                computePipelines: this.computePipelines,
                particles: this.particles,
            });
        }
        const shadowPhase = this.phaseList.find(p => p.behavior === 'shadow-clear');
        if (shadowPhase) {
            // Pass all shadow-phase drivers (enabled or not); runShadowPhase
            // picks the first enabled one to record, and clears every face
            // regardless — so a disabled shadow pipeline yields no shadows.
            this.runShadowPhase(
                enc0,
                this.drivers.filter(d => d.decl.phase === shadowPhase.name),
                scene, frame,
            );
        }
        device.queue.submit([enc0.finish()]);

        // ── stage 2: one command buffer per camera ──
        // cleared is shared across cameras so the first camera clears the screen
        // target and subsequent cameras load it (preserving prior viewports).
        const cleared = new Set<string>();
        for (const cam of cameras) {
            this.writeCameraUBO(cam);
            // Pixel rect, clamped to the framebuffer so 1px rounding on odd
            // canvas sizes can't overflow the scissor/viewport (WebGPU validation).
            let vx = Math.round(cam.viewport[0] * cw);
            let vy = Math.round(cam.viewport[1] * ch);
            let vw = Math.round(cam.viewport[2] * cw);
            let vh = Math.round(cam.viewport[3] * ch);
            if (vx < 0) { vw += vx; vx = 0; }
            if (vy < 0) { vh += vy; vy = 0; }
            if (vx + vw > cw) vw = cw - vx;
            if (vy + vh > ch) vh = ch - vy;
            if (vw <= 0 || vh <= 0) continue;
            const vp: ViewportRect = { x: vx, y: vy, w: vw, h: vh };
            const enc = device.createCommandEncoder();
            for (const phase of this.phaseList) {
                // shadow-clear already ran in stage 1; postprocess-chain is
                // validated out at compile(). Any other behavior falls through
                // to runPhase (which itself dispatches by behavior).
                if (phase.behavior === 'shadow-clear') continue;
                if (phase.behavior === 'postprocess-chain') continue;
                const inPhase = this.drivers.filter(d => d.entry.enabled && d.decl.phase === phase.name);
                if (inPhase.length === 0) continue;
                this.runPhase(enc, phase, inPhase, scene, frame, cw, ch, format, swapView, cleared, vp);
            }
            device.queue.submit([enc.finish()]);
        }
    }

    /** Upload one camera's matrices to the shared camera UBO. Used by the
     *  multi-view path only; the single-camera path relies on CameraSystem.update
     *  having already written the primary camera's matrices. */
    private writeCameraUBO(cam: CameraView): void {
        const buf = this.cameraData;
        const camLayout = uniformLayouts.get('camera');
        camLayout.write(buf, 'vp', cam.vp);
        camLayout.write(buf, 'ivp', cam.ivp);
        camLayout.write(buf, 'pos', cam.pos);
        camLayout.write(buf, 'view', cam.view);
        camLayout.write(buf, 'proj', cam.proj);
        const ubo = resourceManager.cameraUBO;
        resourceManager.device.queue.writeBuffer(ubo, 0, buf.buffer, buf.byteOffset, buf.byteLength);
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
        cleared: Set<string>, viewport: ViewportRect | null,
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
                scene, frame, cw, ch, format, swapView, clear, viewport,
            );
            i = j;
        }
    }

    /** Shadow phase: iterate LightSystem.shadowPassList and render all shadow
     *  casters into each shadow light's depth face. The ShadowPipeline driver
     *  auto-binds group 0 (frameShadow) and group 1 (object) per entity; the
     *  per-face selector at group 2 (shadowPass) is set here once per pass.
     *  Each face is cleared via loadOp regardless of whether a driver runs —
     *  so disabling the shadow pipeline makes shadows disappear (PBR samples
     *  depth=1 = lit) instead of leaving stale depth from the previous frame. */
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
        // First ENABLED shadow driver records depth; when none is enabled the
        // passes still run (clear-only) so consumers read a cleared shadow map.
        const driver = drivers.find(d => d.entry.enabled);
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
        viewport: ViewportRect | null,
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
            // Multi-view cameras share the full-screen depth target; scissor
            // restricts each camera's writes to its own viewport region.
            const depthView = resourceManager.namedDepthTargetView(depthName, cw, ch);
            desc.depthStencilAttachment = {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: clear ? 'clear' : 'load',
                depthStoreOp: 'store',
            };
        }

        const pass = encoder.beginRenderPass(desc);
        if (viewport) {
            pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
            pass.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);
        }
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
        return { name: this.name, clearColor: [...this.clearColor], phases, multiView: this.multiView };
    }

    rebuildPipeline(device: GPUDevice, pipelinePath: string): void {
        if (!this.pipelines.has(pipelinePath)) return;
        this.pipelines.set(pipelinePath, PipelineLoader.rebuild(device, this.dataBase, pipelinePath));
    }
}
