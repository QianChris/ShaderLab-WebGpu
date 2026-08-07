import type { EnginePlugin, PluginContext } from '../../src/core/plugins/Plugin';

interface MockHostRecord {
    declarations: Array<{ id: string; plugin: EnginePlugin }>;
    sweeps: string[];
    owners: Array<{ enter: string; prev: string }>;
    endOwners: string[];
}

/**
 * Mock PluginHost for PluginManager tests. Records all calls so tests
 * can assert load order, rollback behavior, and dependency resolution.
 */
export function createMockHost() {
    const record: MockHostRecord = {
        declarations: [],
        sweeps: [],
        owners: [],
        endOwners: [],
    };

    return {
        pluginsRoot: '/plugins',
        makeCtx: (id: string, _baseUrl: string): PluginContext => {
            return {
                device: {} as GPUDevice,
                scene: {} as never,
                eventBus: {} as never,
                engineConfig: {} as never,
                canvas: {} as never,
                baseUrl: _baseUrl,
                renderer: {} as never,
                registerSystem: () => {},
                registerAttachment: () => {},
                registerRenderHook: () => {},
                registerPhaseBehavior: () => {},
                replaceRenderer: () => {},
                registerMeshGenerator: () => {},
                registerToolType: () => {},
                registerValueAtoms: () => {},
                getSystem: () => null,
                getPlugin: () => null,
            } as unknown as PluginContext;
        },
        applyDeclarations: (id: string, plugin: EnginePlugin) => {
            record.declarations.push({ id, plugin });
        },
        sweepOwner: (owner: string) => {
            record.sweeps.push(owner);
        },
        beginOwner: (owner: string) => {
            const prev = 'common';
            record.owners.push({ enter: owner, prev });
            return prev;
        },
        endOwner: (previous: string) => {
            record.endOwners.push(previous);
        },
        record,
    };
}
