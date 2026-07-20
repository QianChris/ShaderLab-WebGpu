import { EnginePlugin, type PluginContext, type FrameContext, type System } from '@shaderlab/api';
import { InputSystem } from './InputSystem.ts';
import { ScriptSystem } from './ScriptSystem.ts';
import { CameraSystem } from './CameraSystem.ts';
import { LightSystem } from './LightSystem.ts';
import { AnimationSystem } from './AnimationSystem.ts';
import * as paramsHooks from './hooks/params.ts';

/**
 * Core capability plugin: the six baseline systems every stock app composes
 * (systems.json order): input / script / camera / light / animation / render.
 * The 'render' system is a thin translation entry — one call into the engine's
 * renderer mechanism (Component → declarative drivers → UBO/SSBO → passes).
 *
 * Engine-scoped: listed first in engine-config.json `plugins` (other plugins
 * may depend on 'core').
 */
export default class CorePlugin extends EnginePlugin {
    readonly meta = { id: 'core' };

    /** System metadata (ubos/buffers/needs) — consumed by BufferRegistry and
     *  order validation; replaces the old common/systems/<name>.json files. */
    systemDefs = [
        { name: 'input', source: 'plugin:core', components: [], ubos: ['timeInput'], buffers: [], needs: [] },
        { name: 'script', source: 'plugin:core', components: ['ScriptComponent'], ubos: [], buffers: [], needs: ['input'] },
        { name: 'camera', source: 'plugin:core', components: ['Camera', 'Transform'], ubos: ['camera'], buffers: [], needs: ['physics'] },
        { name: 'light', source: 'plugin:core', components: ['LightComponent', 'EnvironmentComponent', 'Transform'], ubos: ['light', 'pointShadowFaces'], buffers: [], needs: ['physics'] },
        { name: 'animation', source: 'plugin:core', components: ['SpriteSheetComponent', 'SpriteAnimationComponent'], ubos: [], buffers: [], needs: [] },
        { name: 'render', source: 'plugin:core', components: [], ubos: [], buffers: [], needs: ['camera', 'light', 'animation', 'gaussianSplat'] },
    ];

    /** Escape-hatch hooks addressable from pipeline JSON as script:params.<fn>. */
    renderHooks = {
        'params.point': paramsHooks.point,
        'params.edge': paramsHooks.edge,
    };

    private script: ScriptSystem | null = null;
    private animation: AnimationSystem | null = null;

    /** Fetch the co-located declaration JSONs into the declaration fields.
     *  Runs before the engine applies declarations (PluginManager order:
     *  init → applyDeclarations → setup). */
    async init(ctx: PluginContext): Promise<void> {
        const load = async (file: string): Promise<never> => {
            const resp = await fetch(`${ctx.baseUrl}/${file}`);
            const contentType = resp.headers.get('content-type') ?? '';
            if (!resp.ok || contentType.includes('text/html')) {
                throw new Error(`[core] declaration file missing: ${ctx.baseUrl}/${file}`);
            }
            return await resp.json() as never;
        };
        this.components = await load('components.json');
        this.uniformLayouts = await load('uniform-layouts.json');
        this.bindLayouts = await load('bind-layouts.json');
        this.vertexSlots = await load('vertex-slots.json');
        this.vertexInputs = await load('vertex-inputs.json');
        this.samplers = await load('samplers.json');
        this.blendPresets = await load('blend-presets.json');
        this.fallbackTextures = await load('fallback-textures.json');
        this.vboPresets = await load('vbo-presets.json');
        this.meshes = await load('meshes.json');
        this.renderTargets = await load('render-targets.json');
        this.phases = await load('phases.json');
    }

    setup(ctx: PluginContext): void {
        const input = new InputSystem(ctx.canvas, ctx.eventBus);
        input.attach();

        this.script = new ScriptSystem(ctx.eventBus, '');
        this.script.attach(ctx.scene);
        this.script.setHooks(ctx.engineConfig.scriptHooks);
        this.script.provide(
            () => ctx.getSystem('physics'),
            () => ctx.canvas.width / Math.max(1, ctx.canvas.height),
        );

        const camera = new CameraSystem();
        camera.attach(ctx.scene);

        const light = new LightSystem();
        light.attach(ctx.scene);

        this.animation = new AnimationSystem();
        this.animation.attach(ctx.scene);

        /** Thin render entry: Component data has been translated by the earlier
         *  systems into UBO/attachment state; this hands the frame to the
         *  renderer mechanism (the built-in RenderGraph unless replaced). */
        const render: System = { update: (fctx: FrameContext) => ctx.renderer.update(fctx) };

        ctx.registerSystem('input', input);
        ctx.registerSystem('script', this.script);
        ctx.registerSystem('camera', camera);
        ctx.registerSystem('light', light);
        ctx.registerSystem('animation', this.animation);
        ctx.registerSystem('render', render);
    }

    appLoaded(_ctx: PluginContext, appBase: string): void {
        // Script + sheet assets resolve relative to the active app.
        this.script?.setBaseDir(appBase);
        this.animation?.setBaseDir(appBase);
    }

    appUnloading(): void {
        this.script?.clear();
        this.animation?.clear();
    }
}
