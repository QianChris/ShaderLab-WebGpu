import { defineQuery } from 'bitecs/legacy';
import { resourceManager } from './ResourceManager';
import { PipelineLoader } from './PipelineLoader';
import { PipelineDriver, type GeometryHook, type ComputeHook } from './PipelineDriver';
import { RenderScriptLoader } from './RenderScriptLoader';
import { schemaRegistry } from '../ecs/SchemaRegistry';
import { uniformLayouts } from './UniformLayout';
import { normalBehavior, shadowClearBehavior, postProcessChainBehavior } from './phaseBehaviors';
import {
    type RenderGraphData,
    type PhaseMap,
    type PhaseDecl,
    type PhaseBehavior,
    type PhaseBehaviorContext,
    type DriverFrame,
    type ViewportRect,
    type IRenderer,
} from './types';
import type { RenderTargetDecls } from './rendererDecl';
import type { ValueContext } from './valueResolver';
import type { CameraView } from '../ecs/Scene';
import type { FrameContext, System } from '../ecs/SystemRegistry';

const SCREEN = 'screen';

/**
 * Data-driven render graph. Owns no per-pipeline draw logic and no pass
 * strategy: each render pipeline embeds a declarative `renderer` block executed
 * by a generic PipelineDriver, and each phase names a registered PhaseBehavior
 * (open registry — engine defaults and plugins register through the same API).
 */
export class RenderGraph implements System, IRenderer {
    name = '';
    phases: PhaseMap = {};

    private phaseList: PhaseDecl[] = [];
    private phaseBehaviors = new Map<string, PhaseBehavior>();
    private phaseBehaviorOwners = new Map<string, string>();
    private clearColor: [number, number, number, number] = [0, 0, 0, 1];
    private pipelines = new Map<string, GPURenderPipeline>();
    private computePipelines = new Map<string, GPUComputePipeline>();
    private drivers: PipelineDriver[] = [];
    private targets: RenderTargetDecls = {};
    private dataBase = '/common';
    private scriptsSubdir = 'scripts';
    private format: GPUTextureFormat = 'bgra8unorm';
    private sceneIsScreen = true;
    /** Multi-view split-screen toggle (from render.json `multiView: true`). */
    private multiView = false;
    /** Scratch buffer for per-camera UBO uploads in multi-view mode. */
    private cameraData: Float32Array = new Float32Array(0);

    private valueScripts = new Map<string, (ctx: ValueContext) => number[] | number>();
    private geometryHooks = new Map<string, GeometryHook>();
    private computeHooks = new Map<string, ComputeHook>();
    /** Hook name → owner tag ('app' = render.json renderScripts, 'plugin:<id>'). */
    private hookOwners = new Map<string, string>();
    private scriptFiles: string[] = [];

    constructor() {
        // Engine-default pass strategies, registered through the same public
        // registry plugins use — no special-cased dispatch anywhere.
        this.registerPhaseBehavior('normal', normalBehavior, 'engine');
        this.registerPhaseBehavior('shadow-clear', shadowClearBehavior, 'engine');
        this.registerPhaseBehavior('postprocess-chain', postProcessChainBehavior, 'engine');
    }

    /** Register a pass strategy under a behavior name (phases.json `behavior`). */
    registerPhaseBehavior(name: string, behavior: PhaseBehavior, owner = 'engine'): void {
        const existing = this.phaseBehaviorOwners.get(name);
        if (existing !== undefined && existing !== owner) {
            throw new Error(`Phase behavior '${name}' already registered by ${existing} (attempted by ${owner})`);
        }
        this.phaseBehaviorOwners.set(name, owner);
        this.phaseBehaviors.set(name, behavior);
    }

    /** Drop every phase behavior registered by `owner` (plugin unload). */
    removePhaseBehaviorsByOwner(owner: string): void {
        for (const [name, o] of [...this.phaseBehaviorOwners]) {
            if (o !== owner) continue;
            this.phaseBehaviorOwners.delete(name);
            this.phaseBehaviors.delete(name);
        }
    }

    /** Register an escape-hatch script (renderScripts or plugins). */
    registerValueScript(name: string, fn: (ctx: ValueContext) => number[] | number, owner = 'app'): void {
        this.valueScripts.set(name, fn);
        this.hookOwners.set(name, owner);
    }
    registerGeometryHook(name: string, fn: GeometryHook, owner = 'app'): void {
        this.geometryHooks.set(name, fn);
        this.hookOwners.set(name, owner);
    }
    registerComputeHook(name: string, fn: ComputeHook, owner = 'app'): void {
        this.computeHooks.set(name, fn);
        this.hookOwners.set(name, owner);
    }

    /** Drop every hook registered by `owner` (app switch / plugin unload). */
    removeHooksByOwner(owner: string): void {
        for (const [name, o] of [...this.hookOwners]) {
            if (o !== owner) continue;
            this.hookOwners.delete(name);
            this.valueScripts.delete(name);
            this.geometryHooks.delete(name);
            this.computeHooks.delete(name);
        }
    }

    setRenderTargets(targets: RenderTargetDecls): void {
        this.targets = { ...this.targets, ...targets };
    }

    /** Merge render targets declared by a plugin. Duplicate names throw. */
    mergeRenderTargets(targets: RenderTargetDecls): void {
        for (const [name, decl] of Object.entries(targets)) {
            if (this.targets[name]) throw new Error(`Render target '${name}' already declared`);
            this.targets[name] = decl;
        }
    }

    /** Release app-owned state: drivers, escape-hatch hooks, particle GPU buffers.
     *  Common pipelines / shader modules are kept for reuse across apps. */
    exitApp(_appId: string): void {
        // Drop per-entity bind-group caches promptly (the driver objects will be
        // GC'd eventually, but explicitly clearing the cache makes the cached
        // GPUBindGroups dereferenced now rather than after driver GC).
        for (const d of this.drivers) d.dispose();
        this.drivers = [];
        this.removeHooksByOwner('app');
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

    /** Merge phases declared by a plugin. Duplicate names throw (fail-loud). */
    addPhases(phases: PhaseDecl[]): void {
        for (const p of phases) {
            if (this.phaseList.some(e => e.name === p.name)) {
                throw new Error(`Phase '${p.name}' already declared`);
            }
            this.phaseList.push(p);
        }
        this.phaseList.sort((a, b) => a.order - b.order);
    }

    /** Remove phases by name (plugin unload). */
    removePhases(names: string[]): void {
        this.phaseList = this.phaseList.filter(p => !names.includes(p.name));
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
        // Every phase key in render.json must exist in phases.json — entries
        // under an unknown phase name would otherwise be dropped silently.
        const known = new Set(this.phaseList.map(p => p.name));
        for (const key of Object.keys(data.phases)) {
            if (!known.has(key)) {
                throw new Error(
                    `Render graph '${data.name}' declares phase '${key}' which is not in phases.json ` +
                    `(known: ${[...known].join(', ')})`,
                );
            }
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
        // Plugin-registered hooks of the same name take precedence (skip).
        if (this.scriptFiles.length > 0) {
            const loader = new RenderScriptLoader(dataBase, this.scriptsSubdir);
            const hooks = await loader.loadAll(this.scriptFiles);
            for (const [k, v] of hooks.value) if (!this.valueScripts.has(k)) this.registerValueScript(k, v, 'app');
            for (const [k, v] of hooks.geometry) if (!this.geometryHooks.has(k)) this.registerGeometryHook(k, v, 'app');
            for (const [k, v] of hooks.compute) if (!this.computeHooks.has(k)) this.registerComputeHook(k, v, 'app');
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
                if (decl.query) {
                    driver.query = defineQuery(decl.query.map(name => {
                        const comp = schemaRegistry.get(name);
                        if (!comp) {
                            throw new Error(`Pipeline '${entry.pipeline}': renderer.query component '${name}' is not registered (components.json)`);
                        }
                        return comp;
                    }));
                }
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

    /** Try loading a render pipeline from commonBase first, then appBase on 404.
     *  Plugin-prefixed paths ('<plugin>:…') resolve directly, no fallback. */
    private async tryLoadPipeline(
        device: GPUDevice, format: GPUTextureFormat, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPURenderPipeline> {
        if (path.startsWith('/') || PipelineLoader.pluginRef(path)) {
            return PipelineLoader.load(device, format, commonBase, path);
        }
        try {
            return await PipelineLoader.load(device, format, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.load(device, format, appBase, path);
        }
    }

    /** Try loading a compute pipeline from commonBase first, then appBase on 404.
     *  Plugin-prefixed paths ('<plugin>:…') resolve directly, no fallback. */
    private async tryLoadCompute(
        device: GPUDevice, commonBase: string, appBase: string | undefined, path: string,
    ): Promise<GPUComputePipeline> {
        if (path.startsWith('/') || PipelineLoader.pluginRef(path)) {
            return PipelineLoader.loadCompute(device, commonBase, path);
        }
        try {
            return await PipelineLoader.loadCompute(device, commonBase, path);
        } catch {
            if (!appBase) throw new Error(`Compute pipeline '${path}' not found in ${commonBase}`);
            return PipelineLoader.loadCompute(device, appBase, path);
        }
    }

    /** System interface: run the render graph for this frame. */
    update(ctx: FrameContext): void {
        this.execute(ctx);
    }

    execute(ctx: FrameContext): void {
        const tex = ctx.context.getCurrentTexture();
        const cw = tex.width;
        const ch = tex.height;
        const canvasAspect = cw / Math.max(1, ch);

        // Multi-view is opt-in via render.json `multiView: true`. When enabled
        // AND more than one Camera is active, each camera renders the whole
        // scene into its own on-screen viewport (Camera.viewport). The shared
        // camera UBO is re-written per camera, so each camera must own its own
        // command buffer (writeBuffer → submit) — a single command buffer
        // cannot safely re-write a shared UBO between render passes.
        const cameras = ctx.scene.getActiveCameras(canvasAspect);
        const swapView = tex.createView();
        if (this.multiView && cameras.length > 1) {
            this.executeMultiView(ctx, cw, ch, swapView, cameras);
            return;
        }
        this.executeSingle(ctx, cw, ch, swapView);
    }

    /** Per-frame info for drivers + hooks (attachments carry plugin objects). */
    private driverFrame(ctx: FrameContext, cw: number, ch: number): DriverFrame {
        return {
            time: ctx.time,
            dt: ctx.dt,
            cw, ch,
            attachments: ctx.attachments,
            computePipelines: this.computePipelines,
        };
    }

    /** Resolve a phase's behavior from the registry (fail-loud when missing). */
    private behaviorFor(phase: PhaseDecl): PhaseBehavior {
        const name = phase.behavior || 'normal';
        const behavior = this.phaseBehaviors.get(name);
        if (!behavior) {
            throw new Error(
                `Phase '${phase.name}': behavior '${name}' is not registered ` +
                `(known: ${[...this.phaseBehaviors.keys()].join(', ')})`,
            );
        }
        return behavior;
    }

    /** True when any enabled driver sits in a phase with the given behavior. */
    private hasEnabledWithBehavior(behaviorName: string): boolean {
        const names = new Set(
            this.phaseList.filter(p => (p.behavior || 'normal') === behaviorName).map(p => p.name),
        );
        return this.drivers.some(d => d.entry.enabled && names.has(d.decl.phase));
    }

    /** Build the narrow facade a PhaseBehavior runs against. */
    private behaviorContext(
        ctx: FrameContext,
        encoder: GPUCommandEncoder,
        phase: PhaseDecl,
        frame: DriverFrame,
        cw: number, ch: number,
        swapView: GPUTextureView,
        cleared: Set<string>,
        viewport: ViewportRect | null,
    ): PhaseBehaviorContext {
        return {
            encoder,
            phase,
            drivers: this.drivers.filter(d => d.decl.phase === phase.name),
            scene: ctx.scene,
            frame,
            cw, ch,
            format: ctx.format,
            swapView,
            viewport,
            cleared,
            sceneIsScreen: this.sceneIsScreen,
            getSystem: ctx.getSystem,
            pipelineFor: (d) => this.pipelines.get(d.path),
            transientTargets: () => this.transientTargetNames(),
            runDefault: () => {
                const enabled = this.drivers.filter(d => d.entry.enabled && d.decl.phase === phase.name);
                if (enabled.length === 0) return;
                this.runNormalPhase(encoder, enabled, ctx, frame, cw, ch, swapView, cleared, viewport);
            },
        };
    }

    /** Single-camera (or zero-camera) path. The camera UBO is assumed already
     *  written by the camera system. */
    private executeSingle(ctx: FrameContext, cw: number, ch: number, swapView: GPUTextureView): void {
        const frame = this.driverFrame(ctx, cw, ch);
        const encoder = ctx.device.createCommandEncoder();

        // ── compute stage (script hooks) ──
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(encoder, {
                scene: ctx.scene,
                time: ctx.time,
                dt: ctx.dt,
                computePipelines: this.computePipelines,
                attachments: ctx.attachments,
            });
        }

        // If nothing post-processes, the "scene" target is the swapchain directly.
        this.sceneIsScreen = !this.hasEnabledWithBehavior('postprocess-chain');

        // ── behavior-dispatched phase execution ──
        const cleared = new Set<string>();
        for (const phase of this.phaseList) {
            const behavior = this.behaviorFor(phase);
            behavior.run(this.behaviorContext(ctx, encoder, phase, frame, cw, ch, swapView, cleared, null));
        }

        ctx.device.queue.submit([encoder.finish()]);
    }

    /** Multi-view path: per-frame behaviors (perCamera: false — e.g. shadow)
     *  run once in stage 1; then each camera gets its own command buffer with
     *  every perCamera behavior scoped to its viewport. */
    private executeMultiView(
        ctx: FrameContext, cw: number, ch: number, swapView: GPUTextureView, cameras: CameraView[],
    ): void {
        const frame = this.driverFrame(ctx, cw, ch);

        // Multi-view does not support the postprocess chain (it routes through a
        // single screen target); validated out at compile(). Scene IS the screen.
        this.sceneIsScreen = true;

        // ── stage 1: compute + per-frame behaviors, one submit ──
        const enc0 = ctx.device.createCommandEncoder();
        for (const d of this.drivers) {
            if (!d.entry.enabled) continue;
            d.compute(enc0, {
                scene: ctx.scene,
                time: ctx.time,
                dt: ctx.dt,
                computePipelines: this.computePipelines,
                attachments: ctx.attachments,
            });
        }
        const cleared0 = new Set<string>();
        for (const phase of this.phaseList) {
            const behavior = this.behaviorFor(phase);
            if (behavior.perCamera !== false) continue;
            behavior.run(this.behaviorContext(ctx, enc0, phase, frame, cw, ch, swapView, cleared0, null));
        }
        ctx.device.queue.submit([enc0.finish()]);

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
            const enc = ctx.device.createCommandEncoder();
            for (const phase of this.phaseList) {
                const behavior = this.behaviorFor(phase);
                if (behavior.perCamera === false) continue;
                behavior.run(this.behaviorContext(ctx, enc, phase, frame, cw, ch, swapView, cleared, vp));
            }
            ctx.device.queue.submit([enc.finish()]);
        }
    }

    /** Upload one camera's matrices to the shared camera UBO. Used by the
     *  multi-view path only; the single-camera path relies on the camera system
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

    /** Default 'normal' behavior body: merge consecutive enabled drivers that
     *  share the same color(s)+depth target into one pass, then record. */
    private runNormalPhase(
        encoder: GPUCommandEncoder,
        drivers: PipelineDriver[],
        ctx: FrameContext,
        frame: DriverFrame,
        cw: number, ch: number, swapView: GPUTextureView,
        cleared: Set<string>, viewport: ViewportRect | null,
    ): void {
        // `color` may be a single name or an array (MRT, e.g. deferred GBuffer).
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
                ctx, frame, cw, ch, swapView, clear, viewport,
            );
            i = j;
        }
    }

    private openPassAndRecord(
        encoder: GPUCommandEncoder,
        colorNames: string[], depthName: string,
        drivers: PipelineDriver[],
        ctx: FrameContext,
        frame: DriverFrame,
        cw: number, ch: number, swapView: GPUTextureView, clear: boolean,
        viewport: ViewportRect | null,
    ): void {
        const isDepthOnly = colorNames.length === 1 && colorNames[0] === 'none';

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (!isDepthOnly) {
            const envClear = ctx.scene.getEnvironmentClearColor() ?? this.clearColor;
            for (const name of colorNames) {
                const view = (name === SCREEN || (name === 'scene' && this.sceneIsScreen))
                    ? swapView
                    : resourceManager.namedColorTargetView(name, cw, ch, ctx.format);
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
            if (!pipeline) throw new Error(`Pipeline '${d.path}' was not compiled (compile() must load every manifest entry)`);
            d.record(pass, ctx.scene, pipeline, frame);
        }
        pass.end();
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

    /** Look up a loaded compute pipeline by name (for script systems that
     *  want to dispatch their own compute via ctx.dispatchCompute). */
    getComputePipeline(name: string): GPUComputePipeline | undefined {
        return this.computePipelines.get(name);
    }

    rebuildPipeline(device: GPUDevice, pipelinePath: string): void {
        if (!this.pipelines.has(pipelinePath)) return;
        this.pipelines.set(pipelinePath, PipelineLoader.rebuild(device, this.dataBase, pipelinePath));
    }
}
