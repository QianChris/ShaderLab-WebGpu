import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RenderGraph } from '../../src/core/render/RenderGraph';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { createMockDevice } from '../mocks/gpu';
import { resetRegistries } from '../helpers/reset';
import type { RenderGraphData } from '../../src/core/render/types';

const PHASE_LIST = [
    { name: 'opaque', order: 10, behavior: 'normal' },
    { name: 'shadow', order: 5, behavior: 'shadow-clear' },
    { name: 'post', order: 20, behavior: 'postprocess-chain' },
];

beforeEach(() => {
    resourceManager.init(createMockDevice());
    resourceManager.enterApp('test');
});

afterEach(() => {
    resetRegistries();
});

describe('RenderGraph fromData → toData → fromData round-trip', () => {
    it('data preserved across round-trips', () => {
        const rg = new RenderGraph();
        rg.setPhases(PHASE_LIST);
        const data: RenderGraphData = {
            name: 'roundtrip',
            clearColor: [0.5, 0.5, 0.5, 1],
            phases: {
                opaque: [
                    { name: 'pbr', pipeline: 'core:pbr', enabled: true },
                    { name: 'wire', pipeline: 'core:wire', enabled: false },
                ],
                shadow: [{ name: 'shadow', pipeline: 'core:shadow', enabled: true }],
                post: [],
            },
        };
        rg.fromData(data);
        const out1 = rg.toData();

        // Round-trip 2
        const rg2 = new RenderGraph();
        rg2.setPhases(PHASE_LIST);
        rg2.fromData(out1);
        const out2 = rg2.toData();

        expect(out2.name).toBe('roundtrip');
        expect(out2.clearColor).toEqual([0.5, 0.5, 0.5, 1]);
        expect(out2.phases.opaque.length).toBe(2);
        expect(out2.phases.opaque[1].enabled).toBe(false);
        expect(out2.phases.shadow.length).toBe(1);
    });
});

describe('RenderGraph exitApp → re-compile isolation', () => {
    it('exitApp clears drivers + hooks, re-fromData is clean', () => {
        const rg = new RenderGraph();
        rg.setPhases(PHASE_LIST);
        rg.fromData({
            name: 'app1',
            phases: {
                opaque: [{ name: 'p', pipeline: 'p', enabled: true }],
                shadow: [], post: [],
            },
        });
        rg.registerValueScript('appHook', () => 0, 'app');
        rg.exitApp('app1');

        // Re-load a different app
        rg.fromData({
            name: 'app2',
            phases: {
                opaque: [{ name: 'p2', pipeline: 'p2', enabled: true }],
                shadow: [], post: [],
            },
        });
        // app2 should not have the app1 hook
        rg.registerValueScript('appHook', () => 0, 'app'); // should not throw
    });
});

describe('RenderGraph execute calls flushCompute', () => {
    it('execute calls ctx.flushCompute() before rendering', () => {
        const rg = new RenderGraph();
        rg.setPhases(PHASE_LIST);
        rg.fromData({ name: 'test', phases: { opaque: [], shadow: [], post: [] } });

        let flushCalled = false;
        const ctx = {
            flushCompute: () => { flushCalled = true; },
            context: { getCurrentTexture: () => ({ width: 800, height: 600, createView: () => ({}) }) },
            device: createMockDevice(),
            format: 'bgra8unorm',
            scene: { getActiveCameras: () => [], getActiveCamera: () => null, getEnvironmentClearColor: () => null },
            time: 0, dt: 0, aspect: 1, cw: 800, ch: 600,
            canvas: {} as HTMLCanvasElement,
            eventBus: {} as never,
            attachments: {},
            getSystem: () => null,
            getBuffer: () => ({} as GPUBuffer),
            writeBuffer: () => {},
            dispatchCompute: () => {},
        } as never;

        rg.execute(ctx);
        expect(flushCalled).toBe(true);
    });
});
