import { EnginePlugin, type PluginContext } from '@shaderlab/api';
import { OrbitSystem } from './OrbitSystem.ts';

/**
 * Demo plugin: a self-contained capability (component schema + system behavior)
 * living entirely in public/plugins/orbit/. The engine has no compile-time
 * knowledge of it — demo8 opts in via app.json `"plugins": ["orbit"]` and runs
 * it by listing `{ "name": "orbit" }` in its systems.json order.
 */
export default class OrbitPlugin extends EnginePlugin {
    readonly meta = { id: 'orbit' };

    components = [
        {
            name: 'OrbitComponent',
            fields: {
                radius: { type: 'f32', default: 2.5 },
                speed: { type: 'f32', default: 0.8 },
                spin: { type: 'f32', default: 1.5 },
            },
        },
    ];

    /** Buffer metadata for BufferRegistry (replaces the old systems/orbit.json def). */
    systemDefs = [
        {
            name: 'orbit',
            source: 'plugin:orbit',
            components: ['Transform', 'OrbitComponent'],
            ubos: [],
            buffers: [
                { name: 'orbitScratch', size: 64, usage: ['storage', 'copy_dst'] },
            ],
            needs: [],
        },
    ];

    setup(ctx: PluginContext): void {
        ctx.registerSystem('orbit', new OrbitSystem());
        console.log('[orbit plugin] setup complete');
    }
}
