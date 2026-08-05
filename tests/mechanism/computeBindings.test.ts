import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveComputeBindings } from '../../src/core/render/computeBindings';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { bufferRegistry } from '../../src/core/render/BufferRegistry';
import { uniformLayouts } from '../../src/core/render/UniformLayout';
import { createMockDevice, createMockTexture } from '../mocks/gpu';
import { resetRegistries } from '../helpers/reset';
import type { Scene } from '../../src/core/ecs/Scene';
import type { ComputeBindingDecl } from '../../src/core/render/types';

const CTX = {
    eid: 7,
    count: 100,
    time: 1.5,
    dt: 0.016,
    aspect: 1.6,
    screenW: 800,
    screenH: 500,
    dataBase: '/common',
};

function mockScene(getFieldImpl: (eid: number, comp: string, field: string) => unknown): Scene {
    return { getField: getFieldImpl } as unknown as Scene;
}

describe('resolveComputeBindings: storage source', () => {
    beforeEach(() => {
        resourceManager.init(createMockDevice());
        resourceManager.enterApp('test');
    });
    afterEach(() => {
        resourceManager.exitApp('test');
        resetRegistries();
    });

    it('storage → SSBO keyed `${key}_${eid}`, sized stride×count', () => {
        const spy = vi.spyOn(resourceManager, 'getStorageBuffer').mockReturnValue({} as GPUBuffer);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'storage', key: 'particles', stride: 16 },
        ];
        resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        expect(spy).toHaveBeenCalledWith('particles_7', 1600); // 16 × 100
        spy.mockRestore();
    });

    it('storage with strideLayout → uses layout byteSize', () => {
        uniformLayouts.load({ myLayout: [{ name: 'a', type: 'vec4f' }] }, 'test');
        const spy = vi.spyOn(resourceManager, 'getStorageBuffer').mockReturnValue({} as GPUBuffer);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'storage', key: 's', strideLayout: 'myLayout' },
        ];
        resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        // vec4f layout = 16 bytes × 100
        expect(spy).toHaveBeenCalledWith('s_7', 1600);
        spy.mockRestore();
    });
});

describe('resolveComputeBindings: uniform source (pack)', () => {
    beforeEach(() => {
        resourceManager.init(createMockDevice());
        resourceManager.enterApp('test');
    });
    afterEach(() => {
        resourceManager.exitApp('test');
        resetRegistries();
    });

    it('packs $time, $count, numeric literals, and Comp.field', () => {
        const spy = vi.spyOn(resourceManager, 'getUniform').mockReturnValue({} as GPUBuffer);
        const scene = mockScene((eid, comp, field) => {
            if (comp === 'Brush' && field === 'color') return [1, 0, 0, 1];
            return undefined;
        });
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'uniform', key: 'brush', pack: ['$time', '$count', '0.5', 'Brush.color'] },
        ];
        resolveComputeBindings(bindings, { scene, ...CTX });
        // $time=1.5, $count=100, 0.5, Brush.color=[1,0,0,1] → 7 numbers
        expect(spy).toHaveBeenCalledTimes(1);
        const [key, data, byteSize] = spy.mock.calls[0];
        expect(key).toBe('brush_7');
        expect(data).toEqual([1.5, 100, 0.5, 1, 0, 0, 1]);
        expect(byteSize).toBeGreaterThanOrEqual(16);
        expect(byteSize % 16).toBe(0);
        spy.mockRestore();
    });
});

describe('resolveComputeBindings: texture / storageTexture sources', () => {
    beforeEach(() => {
        resourceManager.init(createMockDevice());
        resourceManager.enterApp('test');
    });
    afterEach(() => {
        resourceManager.exitApp('test');
        resetRegistries();
    });

    it('texture + renderTarget: → resourceManager.renderTargetView', () => {
        const fakeView = { view: true } as unknown as GPUTextureView;
        const spy = vi.spyOn(resourceManager, 'renderTargetView').mockReturnValue(fakeView);
        const bindings: ComputeBindingDecl[] = [
            { binding: 1, source: 'texture', texture: 'renderTarget:scene' },
        ];
        const entries = resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        expect(spy).toHaveBeenCalledWith('scene', 800, 500);
        expect(entries[0].resource).toBe(fakeView);
        spy.mockRestore();
    });

    it('storageTexture + Comp.field handle → tex.createView({dimension})', () => {
        const tex = createMockTexture(64, 64, 'rgba8unorm') as unknown as GPUTexture;
        const view = { created: true } as unknown as GPUTextureView;
        // Stub createView to return a known object so we can assert it.
        (tex as unknown as { createView: () => unknown }).createView = vi.fn(() => view);
        vi.spyOn(resourceManager, 'getTextureByHandle').mockReturnValue(tex);
        const scene = mockScene((eid, comp, field) => {
            if (comp === 'CanvasComponent' && field === 'texHandle') return 42;
            return undefined;
        });
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'storageTexture', texture: 'CanvasComponent.texHandle', access: 'read-write' },
        ];
        const entries = resolveComputeBindings(bindings, { scene, ...CTX });
        expect(resourceManager.getTextureByHandle).toHaveBeenCalledWith(42);
        expect((tex as unknown as { createView: () => unknown }).createView).toHaveBeenCalledWith({ dimension: '2d' });
        expect(entries[0].resource).toBe(view);
    });

    it('texture + named key → resourceManager.textureView(tex)', () => {
        const tex = createMockTexture(64, 64, 'rgba8unorm') as unknown as GPUTexture;
        const view = { cached: true } as unknown as GPUTextureView;
        vi.spyOn(resourceManager, 'getTexture').mockReturnValue(tex);
        vi.spyOn(resourceManager, 'textureView').mockReturnValue(view);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'texture', texture: 'myCanvas' },
        ];
        const entries = resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        expect(resourceManager.getTexture).toHaveBeenCalledWith('myCanvas');
        expect(entries[0].resource).toBe(view);
    });

    it('storageTexture + renderTarget: → throws (no STORAGE_BINDING)', () => {
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'storageTexture', texture: 'renderTarget:scene' },
        ];
        expect(() => resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX })).toThrow(/storageTexture cannot bind a renderTarget/);
    });

    it('storageTexture with no texture ref → throws', () => {
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'storageTexture' },
        ];
        expect(() => resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX })).toThrow(/'texture' field required/);
    });

    it('texture + unknown key → throws', () => {
        vi.spyOn(resourceManager, 'getTexture').mockReturnValue(undefined);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'texture', texture: 'nope' },
        ];
        expect(() => resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX })).toThrow(/not found/);
    });

    it('asset:<path> → getTexture(`${dataBase}/${path}`)', () => {
        const tex = createMockTexture(32, 32, 'rgba8unorm') as unknown as GPUTexture;
        const view = { v: 1 } as unknown as GPUTextureView;
        vi.spyOn(resourceManager, 'getTexture').mockReturnValue(tex);
        vi.spyOn(resourceManager, 'textureView').mockReturnValue(view);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'texture', texture: 'asset:brushes/soft.png' },
        ];
        resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        expect(resourceManager.getTexture).toHaveBeenCalledWith('/common/brushes/soft.png');
    });
});

describe('resolveComputeBindings: timeInput source', () => {
    afterEach(() => resetRegistries());

    it('timeInput → bufferRegistry.get("timeInput")', () => {
        const fakeBuf = { ubo: true } as unknown as GPUBuffer;
        const spy = vi.spyOn(bufferRegistry, 'get').mockReturnValue(fakeBuf);
        const bindings: ComputeBindingDecl[] = [
            { binding: 0, source: 'timeInput' },
        ];
        const entries = resolveComputeBindings(bindings, { scene: mockScene(() => undefined), ...CTX });
        expect(spy).toHaveBeenCalledWith('timeInput');
        expect((entries[0].resource as { buffer: GPUBuffer }).buffer).toBe(fakeBuf);
        spy.mockRestore();
    });
});
