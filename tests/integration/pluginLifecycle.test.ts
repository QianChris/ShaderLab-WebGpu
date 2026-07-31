import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PluginManager, pluginOwner } from '../../src/plugins/PluginManager';
import { PluginHostHelper, type PluginLedger } from '../../src/PluginHost';
import { EnginePlugin, type PluginContext } from '../../src/plugins/Plugin';
import { RenderGraph } from '../../src/render/RenderGraph';
import { schemaRegistry } from '../../src/ecs/SchemaRegistry';
import { uniformLayouts } from '../../src/render/UniformLayout';
import { resourceManager } from '../../src/render/ResourceManager';
import { PipelineLoader } from '../../src/render/PipelineLoader';
import { atomNamespaces } from '../../src/render/valueResolver';
import { createMockDevice } from '../mocks/gpu';
import { resetRegistries } from '../helpers/reset';
import type { IRenderer } from '../../src/render/types';

class PluginA extends EnginePlugin {
    readonly meta = { id: 'a', dependencies: [] };
    setupRan = false;
    async setup() { this.setupRan = true; }
    teardownRan = false;
    teardown() { this.teardownRan = true; }
}

class PluginB extends EnginePlugin {
    readonly meta = { id: 'b', dependencies: ['a'] };
    otherPlugin: EnginePlugin | null = null;
    async setup(ctx: PluginContext) {
        this.otherPlugin = ctx.getPlugin<EnginePlugin>('a');
    }
}

function makeModule(P: new () => EnginePlugin) {
    return { default: P };
}

beforeAll(() => {
    resourceManager.init(createMockDevice());
    resourceManager.enterApp('test');
});

afterAll(() => {
    resetRegistries();
});

function createIntegrationDeps() {
    const attachments = new Map<string, { obj: unknown; owner: string }>();
    const pluginLedgers = new Map<string, PluginLedger>();
    let customRenderer: IRenderer | null = null;
    let customRendererOwner: string | null = null;
    const rg = new RenderGraph();
    return {
        deps: {
            renderGraph: rg,
            attachments,
            pluginLedgers,
            get customRenderer() { return customRenderer; },
            get customRendererOwner() { return customRendererOwner; },
            setAttachment: (n: string, o: unknown, owner: string) => attachments.set(n, { obj: o, owner }),
            deleteAttachment: (n: string) => attachments.delete(n),
            restoreBuiltinRenderer: () => { customRenderer = null; customRendererOwner = null; },
        } as never,
        rg,
        attachments,
        pluginLedgers,
    };
}

describe('Plugin full lifecycle round-trip', () => {
    it('load → setup → appLoaded → appUnloading → teardown → sweep → registries clean', async () => {
        const { deps, pluginLedgers } = createIntegrationDeps();
        const helper = new PluginHostHelper(deps);

        const pm = new PluginManager();
        pm.configure({
            pluginsRoot: '/plugins',
            makeCtx: (id: string, baseUrl: string) => ({
                device: createMockDevice(),
                scene: {} as never, eventBus: {} as never,
                engineConfig: {} as never, canvas: {} as never,
                baseUrl, renderer: {} as never,
                registerSystem: () => {},
                registerAttachment: (n: string, o: unknown) => deps.setAttachment(n, o, pluginOwner(id)),
                registerRenderHook: () => {},
                registerPhaseBehavior: () => {},
                replaceRenderer: () => {},
                registerMeshGenerator: () => {},
                registerToolType: () => {},
                registerValueAtoms: () => {},
                getSystem: () => null,
                getPlugin: <T,>(pid: string) => pm.get(pid)?.instance as T | null ?? null,
            } as unknown as PluginContext),
            applyDeclarations: (id: string, plugin: EnginePlugin) => helper.applyDeclarations(id, plugin, pluginOwner(id)),
            sweepOwner: (owner: string) => helper.sweepOwner(owner),
            beginOwner: (owner: string) => { resourceManager.enterApp(owner); return 'common'; },
            endOwner: (prev: string) => resourceManager.enterApp(prev),
        });

        const pluginA = new PluginA();
        pluginA.components = [{ name: 'CompA', fields: { val: { type: 'f32', default: 0 } } }];
        vi.spyOn(pm as never, 'importPluginModule').mockImplementation(async (baseUrl: string) => {
            if (baseUrl.includes('/a')) return makeModule(PluginA);
            return makeModule(PluginB);
        });

        // Load B (depends on A → A loaded first) with app scope
        await (pm as unknown as { loadOne: (id: string, s: 'engine' | 'app', st: string[]) => Promise<void> }).loadOne('b', 'app', []);
        expect(pm.has('a')).toBe(true);
        expect(pm.has('b')).toBe(true);

        // B's setup got plugin A via ctx.getPlugin
        const bInstance = pm.get('b')!.instance as PluginB;
        expect(bInstance.otherPlugin).not.toBeNull();

        // appLoaded broadcast
        await pm.broadcastAppLoaded('/apps/test');

        // appUnloading broadcast (reverse order)
        pm.broadcastAppUnloading();

        // Unload app plugins → teardown + sweep
        pm.unloadAppPlugins();
        expect(pm.has('a')).toBe(false);
        expect(pm.has('b')).toBe(false);

        // Registries should be clean (CompA removed)
        expect(schemaRegistry.get('CompA')).toBeUndefined();
    });
});

describe('Two plugins: A unload → A registrations gone, B unaffected', () => {
    it('sweepOwner removes only the target plugin declarations', async () => {
        const { deps } = createIntegrationDeps();
        const helper = new PluginHostHelper(deps);

        // Register A's components
        helper.applyDeclarations('a', {
            meta: { id: 'a' },
            components: [{ name: 'CompA', fields: { x: { type: 'f32', default: 0 } } }],
        } as unknown as EnginePlugin, 'plugin:a');

        // Register B's components
        helper.applyDeclarations('b', {
            meta: { id: 'b' },
            components: [{ name: 'CompB', fields: { y: { type: 'f32', default: 0 } } }],
        } as unknown as EnginePlugin, 'plugin:b');

        expect(schemaRegistry.get('CompA')).toBeDefined();
        expect(schemaRegistry.get('CompB')).toBeDefined();

        // Sweep A only
        helper.sweepOwner('plugin:a');
        expect(schemaRegistry.get('CompA')).toBeUndefined();
        expect(schemaRegistry.get('CompB')).toBeDefined();

        // Cleanup B
        helper.sweepOwner('plugin:b');
        expect(schemaRegistry.get('CompB')).toBeUndefined();
    });
});
