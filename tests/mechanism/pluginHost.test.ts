import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginHostHelper, type PluginLedger } from '../../src/core/PluginHost';
import { schemaRegistry } from '../../src/core/ecs/SchemaRegistry';
import { uniformLayouts } from '../../src/core/render/UniformLayout';
import { systemRegistry } from '../../src/core/ecs/SystemRegistry';
import { PipelineLoader } from '../../src/core/render/PipelineLoader';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { atomNamespaces } from '../../src/core/render/valueResolver';
import { RenderGraph } from '../../src/core/render/RenderGraph';
import { createMockDevice } from '../mocks/gpu';
import { resetRegistries } from '../helpers/reset';
import type { EnginePlugin } from '../../src/core/plugins/Plugin';
import type { IRenderer } from '../../src/core/render/types';

function createMockDeps() {
    const attachments = new Map<string, { obj: unknown; owner: string }>();
    const pluginLedgers = new Map<string, PluginLedger>();
    let customRenderer: IRenderer | null = null;
    let customRendererOwner: string | null = null;
    const rg = new RenderGraph();
    rg.registerPhaseBehavior('test', { perCamera: true, run: () => {} }, 'test');
    return {
        deps: {
            renderGraph: rg,
            attachments,
            pluginLedgers,
            get customRenderer() { return customRenderer; },
            get customRendererOwner() { return customRendererOwner; },
            setAttachment: (name: string, obj: unknown, owner: string) => {
                attachments.set(name, { obj, owner });
            },
            deleteAttachment: (name: string) => { attachments.delete(name); },
            restoreBuiltinRenderer: () => {
                customRenderer = null;
                customRendererOwner = null;
            },
        } as never,
        _setCustomRenderer: (r: IRenderer | null, o: string | null) => {
            customRenderer = r;
            customRendererOwner = o;
        },
    };
}

beforeEach(() => {
    resourceManager.init(createMockDevice());
    resourceManager.enterApp('test');
});

afterEach(() => {
    resetRegistries();
});

describe('PluginHostHelper.ledgerFor', () => {
    it('creates and reuses ledger per owner', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const l1 = helper.ledgerFor('plugin:a');
        const l2 = helper.ledgerFor('plugin:a');
        expect(l1).toBe(l2);
        expect(l1.tools).toEqual([]);
        expect(l1.generators).toEqual([]);
    });

    it('different owners get different ledgers', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const l1 = helper.ledgerFor('plugin:a');
        const l2 = helper.ledgerFor('plugin:b');
        expect(l1).not.toBe(l2);
    });
});

describe('PluginHostHelper.applyDeclarations', () => {
    it('components registered in schemaRegistry', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const plugin = {
            meta: { id: 'myfx' },
            components: [{ name: 'Speed', fields: { value: { type: 'f32', default: 0 } } }],
        } as unknown as EnginePlugin;
        helper.applyDeclarations('myfx', plugin, 'plugin:myfx');
        expect(schemaRegistry.get('Speed')).toBeDefined();
    });

    it('uniformLayouts registered', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const plugin = {
            meta: { id: 'myfx' },
            uniformLayouts: { myLayout: [{ name: 'val', type: 'f32' }] },
        } as unknown as EnginePlugin;
        helper.applyDeclarations('myfx', plugin, 'plugin:myfx');
        expect(uniformLayouts.has('myLayout')).toBe(true);
    });

    it('pipelines registered as virtual (pluginRef resolves)', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const config = { name: 'test', vertex: { shader: 's', entryPoint: 'main' }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: false };
        const plugin = {
            meta: { id: 'myfx' },
            pipelines: { myPipe: config },
        } as unknown as EnginePlugin;
        // Should not throw when registering the virtual config
        expect(() => helper.applyDeclarations('myfx', plugin, 'plugin:myfx')).not.toThrow();
        // The virtual config path 'myfx:myPipe' is resolved via PipelineLoader.pluginRef
        const ref = PipelineLoader.pluginRef('myfx:myPipe');
        expect(ref).not.toBeNull();
        expect(ref!.plugin).toBe('myfx');
        expect(ref!.rest).toBe('myPipe');
    });

    it('valueAtoms registered in atomNamespaces', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const plugin = {
            meta: { id: 'myfx' },
            valueAtoms: { custom: { foo: () => 42 } },
        } as unknown as EnginePlugin;
        helper.applyDeclarations('myfx', plugin, 'plugin:myfx');
        expect(atomNamespaces.custom).toBeDefined();
        expect(atomNamespaces.custom.foo).toBeDefined();
    });

    it('phases registered + ledger tracks phase names', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const plugin = {
            meta: { id: 'myfx' },
            phases: [{ name: 'customPhase', order: 50, behavior: 'normal' }],
        } as unknown as EnginePlugin;
        helper.applyDeclarations('myfx', plugin, 'plugin:myfx');
        const ledger = (deps as { pluginLedgers: Map<string, PluginLedger> }).pluginLedgers.get('plugin:myfx');
        expect(ledger.phases).toContain('customPhase');
    });
});

describe('PluginHostHelper.sweepOwner round-trip', () => {
    it('applyDeclarations → sweepOwner → all registrations removed', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        const plugin = {
            meta: { id: 'myfx' },
            components: [{ name: 'Speed', fields: { value: { type: 'f32', default: 0 } } }],
            uniformLayouts: { myLayout: [{ name: 'val', type: 'f32' }] },
            valueAtoms: { custom: { foo: () => 42 } },
        } as unknown as EnginePlugin;

        helper.applyDeclarations('myfx', plugin, 'plugin:myfx');
        expect(schemaRegistry.get('Speed')).toBeDefined();
        expect(uniformLayouts.has('myLayout')).toBe(true);

        helper.sweepOwner('plugin:myfx');
        expect(schemaRegistry.get('Speed')).toBeUndefined();
        expect(uniformLayouts.has('myLayout')).toBe(false);
        // atomNamespaces.custom.foo should be deleted (the atom itself, not the namespace)
        expect(atomNamespaces.custom?.foo).toBeUndefined();
    });

    it('sweepOwner deletes the ledger', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        helper.ledgerFor('plugin:myfx');
        const ledgers = (deps as { pluginLedgers: Map<string, PluginLedger> }).pluginLedgers;
        expect(ledgers.has('plugin:myfx')).toBe(true);
        helper.sweepOwner('plugin:myfx');
        expect(ledgers.has('plugin:myfx')).toBe(false);
    });

    it('sweepOwner removes attachments owned by the plugin', () => {
        const { deps } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        (deps as { setAttachment: (n: string, o: unknown, owner: string) => void }).setAttachment('particles', {}, 'plugin:myfx');
        helper.sweepOwner('plugin:myfx');
        const attachments = (deps as { attachments: Map<string, unknown> }).attachments;
        expect(attachments.has('particles')).toBe(false);
    });

    it('sweepOwner restores builtin renderer when custom renderer owner matches', () => {
        const { deps, _setCustomRenderer } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        _setCustomRenderer({} as IRenderer, 'plugin:myfx');
        helper.sweepOwner('plugin:myfx');
        // restoreBuiltinRenderer should have been called
        expect((deps as { customRenderer: IRenderer | null }).customRenderer).toBeNull();
        expect((deps as { customRendererOwner: string | null }).customRendererOwner).toBeNull();
    });

    it('sweepOwner does NOT restore renderer when owner does not match', () => {
        const { deps, _setCustomRenderer } = createMockDeps();
        const helper = new PluginHostHelper(deps);
        _setCustomRenderer({} as IRenderer, 'plugin:other');
        helper.sweepOwner('plugin:myfx');
        expect((deps as { customRenderer: IRenderer | null }).customRenderer).not.toBeNull();
    });
});
