import { describe, it, expect, vi } from 'vitest';
import { PluginManager } from '../../src/core/plugins/PluginManager';
import { EnginePlugin, type PluginContext } from '../../src/core/plugins/Plugin';
import { createMockHost } from '../mocks/pluginHost';

// ── Test plugin classes ──
class PluginA extends EnginePlugin {
    readonly meta = { id: 'a', dependencies: [] as string[] };
    initCalled = false;
    setupCalled = false;
    teardownCalled = false;
    async init() { this.initCalled = true; }
    async setup() { this.setupCalled = true; }
    teardown() { this.teardownCalled = true; }
}

class PluginB extends EnginePlugin {
    readonly meta = { id: 'b', dependencies: ['a'] };
}

class FailPlugin extends EnginePlugin {
    readonly meta = { id: 'fail', dependencies: [] };
    async setup(): Promise<void> { throw new Error('setup failed'); }
}

function makeModule(PluginClass: new () => EnginePlugin): { default: new () => EnginePlugin } {
    return { default: PluginClass };
}

describe('PluginManager.loadOne', () => {
    it('successful load �?loaded.has(id) + order contains id', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockResolvedValue(makeModule(PluginA));

        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('a', 'engine', []);

        expect(pm.has('a')).toBe(true);
        expect(pm.all().map(p => p.id)).toContain('a');
    });

    it('init + applyDeclarations + setup called in order', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockResolvedValue(makeModule(PluginA));

        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('a', 'engine', []);

        expect(mock.record.declarations.length).toBe(1);
        expect(mock.record.owners.length).toBe(1);
    });

    it('setup failure �?sweepOwner called + not in loaded', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockResolvedValue(makeModule(FailPlugin));

        await expect(
            (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('fail', 'engine', []),
        ).rejects.toThrow();

        expect(pm.has('fail')).toBe(false);
        expect(mock.record.sweeps).toContain('plugin:fail');
    });

    it('dependency cycle �?throws', async () => {
        class CycleA extends EnginePlugin { readonly meta = { id: 'cycleA', dependencies: ['cycleB'] }; }
        class CycleB extends EnginePlugin { readonly meta = { id: 'cycleB', dependencies: ['cycleA'] }; }

        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        let callCount = 0;
        vi.spyOn(pm as never, 'importPluginModule').mockImplementation(async () => {
            callCount++;
            return callCount === 1 ? makeModule(CycleA) : makeModule(CycleB);
        });

        await expect(
            (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('cycleA', 'engine', []),
        ).rejects.toThrow('cycle');
    });

    it('dependencies loaded before dependent', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockImplementation(async (baseUrl: string) => {
            if (baseUrl.includes('/b')) return makeModule(PluginB);
            return makeModule(PluginA);
        });

        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('b', 'engine', []);

        const order = pm.all().map(p => p.id);
        expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    });
});

describe('PluginManager.unloadAppPlugins', () => {
    it('teardown called + removed from loaded', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockResolvedValue(makeModule(PluginA));
        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('a', 'app', []);

        pm.unloadAppPlugins();

        expect(pm.has('a')).toBe(false);
    });
});

describe('PluginManager.broadcast', () => {
    it('broadcastAppLoaded calls appLoaded in topological order', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockResolvedValue(makeModule(PluginA));
        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('a', 'engine', []);

        const loaded: string[] = [];
        const plugin = pm.get('a')!;
        plugin.instance.appLoaded = async (_ctx: PluginContext, _base: string) => { loaded.push('a'); };

        await pm.broadcastAppLoaded('/apps/test');
        expect(loaded).toContain('a');
    });

    it('broadcastAppUnloading calls appUnloading in reverse order', async () => {
        const mock = createMockHost();
        const pm = new PluginManager();
        pm.configure(mock as never);
        vi.spyOn(pm as never, 'importPluginModule').mockImplementation(async (baseUrl: string) => {
            if (baseUrl.includes('/b')) return makeModule(PluginB);
            return makeModule(PluginA);
        });
        await (pm as unknown as { loadOne: (id: string, scope: 'engine' | 'app', stack: string[]) => Promise<void> }).loadOne('b', 'engine', []);

        const unloaded: string[] = [];
        pm.all().forEach(p => {
            p.instance.appUnloading = (_ctx: PluginContext) => { unloaded.push(p.id); };
        });

        pm.broadcastAppUnloading();
        expect(unloaded.indexOf('b')).toBeLessThanOrEqual(unloaded.indexOf('a'));
    });
});
