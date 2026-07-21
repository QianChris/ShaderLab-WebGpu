import { EnginePlugin, type PluginContext, type ComponentDef } from '@shaderlab/api';
import { PbdManager } from './PbdManager.ts';
import * as pbdHooks from './hooks/pbd.ts';

/**
 * GPU PBD (Position-Based Dynamics) soft-body capability plugin.
 *
 * Declares:
 *   - PbdSoftBodyComponent — grid size + physics params (gravity, damping,
 *     solver iterations, compliance, restitution, mass)
 *   - pbdParams uniform layout, 4 bind layouts (pbdPredict / pbdSolve /
 *     pbdIntegrate / pbdDraw), 3 compute pipelines + 2 render pipelines
 *   - 2 render hooks:
 *       pbd.simulate (ComputeHook) — predict -> solve (iters x 8 colors) -> integrate
 *       pbd.draw     (GeometryHook) — surface mesh via storage-buffer vertex lookup
 *       pbd.floor    (GeometryHook) — checker-grid floor quad at y = 0
 *
 * The 'pbd' attachment publishes a PbdManager so other plugins/scripts could
 * query particle positions via structural contract (not used by this demo).
 *
 * App-scoped: load via app.json "plugins": ["pbd"]. Depends on 'core' for the
 * 'frame' bind group (camera UBO) and the Opaque phase.
 */
export default class PbdPlugin extends EnginePlugin {
    readonly meta = { id: 'pbd', dependencies: ['core'] };

    components: ComponentDef[] = [
        {
            name: 'PbdSoftBodyComponent',
            fields: {
                gridN:             { type: 'u32', default: 5 },
                cellSize:          { type: 'f32', default: 0.4 },
                gravity:           { type: 'f32', default: -9.81 },
                damping:           { type: 'f32', default: 0.995 },
                solverIterations:  { type: 'u32', default: 8 },
                compliance:        { type: 'f32', default: 0.0 },
                restitution:       { type: 'f32', default: 0.3 },
                mass:              { type: 'f32', default: 1.0 },
            },
        },
    ];

    renderHooks = {
        'pbd.simulate': pbdHooks.simulate,
        'pbd.draw': pbdHooks.draw,
        'pbd.floor': pbdHooks.floor,
    };

    private manager: PbdManager | null = null;

    async init(ctx: PluginContext): Promise<void> {
        const load = async (file: string): Promise<never> => {
            const resp = await fetch(`${ctx.baseUrl}/${file}`);
            const contentType = resp.headers.get('content-type') ?? '';
            if (!resp.ok || contentType.includes('text/html')) {
                throw new Error(`[pbd] declaration file missing: ${ctx.baseUrl}/${file}`);
            }
            return await resp.json() as never;
        };
        this.uniformLayouts = await load('uniform-layouts.json');
        this.bindLayouts = await load('bind-layouts.json');
    }

    setup(ctx: PluginContext): void {
        this.manager = new PbdManager();
        ctx.registerAttachment('pbd', this.manager);
    }

    appUnloading(): void { this.manager?.clear(); }
    teardown(): void { this.manager?.clear(); this.manager = null; }
}
