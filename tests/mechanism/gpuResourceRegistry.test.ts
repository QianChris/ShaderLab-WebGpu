import { beforeEach, describe, expect, it } from 'vitest';
import { GpuResourceRegistry } from '../../src/core/render/GpuResourceRegistry';

interface MockBufferState {
    label: string;
    destroyCount: number;
    destroy(): void;
}

interface MockTextureState {
    label: string;
    destroyCount: number;
    createViewCount: number;
    lastViewDescriptor?: GPUTextureViewDescriptor;
    destroy(): void;
    createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView;
}

function mockBuffer(label: string): GPUBuffer & MockBufferState {
    return {
        label,
        destroyCount: 0,
        destroy() { this.destroyCount++; },
    } as unknown as GPUBuffer & MockBufferState;
}

function mockTexture(label: string): GPUTexture & MockTextureState {
    const texture = {
        label,
        destroyCount: 0,
        createViewCount: 0,
        lastViewDescriptor: undefined as GPUTextureViewDescriptor | undefined,
        destroy() { this.destroyCount++; },
        createView(descriptor?: GPUTextureViewDescriptor) {
            this.createViewCount++;
            this.lastViewDescriptor = descriptor;
            return { texture: this, descriptor } as unknown as GPUTextureView;
        },
    };
    return texture as unknown as GPUTexture & MockTextureState;
}

const OWNER = 'plugin:environment-lighting';
const SET_NAME = 'environment';
let registry: GpuResourceRegistry;

beforeEach(() => {
    registry = new GpuResourceRegistry();
});

describe('GpuResourceRegistry', () => {
    it('registers and resolves a typed resource set', () => {
        const buffer = mockBuffer('data');
        const sampler = { label: 'sampler' } as unknown as GPUSampler;
        const texture = mockTexture('specular');

        registry.registerSet(SET_NAME, {
            'environment.data': {
                kind: 'buffer', buffer, offset: 16, size: 64, owned: true,
            },
            'environment.sampler': { kind: 'sampler', sampler },
            'environment.specular': {
                kind: 'texture', texture,
                viewDescriptor: { dimension: 'cube' }, owned: true,
            },
        }, OWNER);

        expect(registry.names()).toEqual([
            'environment.data',
            'environment.sampler',
            'environment.specular',
        ]);
        expect(registry.resolve('environment.data', 'buffer')).toEqual({
            buffer, offset: 16, size: 64,
        });
        expect(registry.resolve('environment.sampler', 'sampler')).toBe(sampler);
        expect((registry.resolve('environment.specular', 'texture') as unknown as {
            texture: GPUTexture;
        }).texture).toBe(texture);
        expect(texture.lastViewDescriptor).toEqual({ dimension: 'cube' });
        expect(() => registry.resolve('environment.specular', 'buffer')).toThrow(/expects buffer/);
    });

    it('rejects a colliding set before constructing any resource views', () => {
        registry.registerSet(SET_NAME, {
            'environment.data': { kind: 'sampler', sampler: {} as GPUSampler },
        }, OWNER);
        const blockedTexture = mockTexture('blocked');

        expect(() => registry.registerSet('other', {
            'environment.new': { kind: 'texture', texture: blockedTexture, owned: true },
            'environment.data': { kind: 'sampler', sampler: {} as GPUSampler },
        }, OWNER)).toThrow(/already registered/);

        expect(blockedTexture.createViewCount).toBe(0);
        expect(registry.has('environment.new')).toBe(false);
    });

    it('keeps the live set intact when a replacement descriptor is malformed', () => {
        const oldBuffer = mockBuffer('old-buffer');
        const oldTexture = mockTexture('old-texture');
        registry.registerSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: oldBuffer, owned: true },
            'environment.specular': { kind: 'texture', texture: oldTexture, owned: true },
        }, OWNER);

        expect(() => registry.replaceSet(SET_NAME, {
            'environment.data': {
                kind: 'buffer', buffer: mockBuffer('staged-buffer'), owned: true,
            },
            'environment.specular': {
                kind: 'texture', texture: mockTexture('invalid'),
                view: {} as GPUTextureView, owned: true,
            },
        }, OWNER)).toThrow(/exactly one/);

        expect((registry.resolve('environment.data', 'buffer') as GPUBufferBinding).buffer)
            .toBe(oldBuffer);
        expect((registry.resolve('environment.specular', 'texture') as unknown as {
            texture: GPUTexture;
        }).texture).toBe(oldTexture);
        expect(oldBuffer.destroyCount).toBe(0);
        expect(oldTexture.destroyCount).toBe(0);
    });

    it('atomically replaces a set and destroys its previous owned resources', () => {
        const oldBuffer = mockBuffer('old-buffer');
        const oldTexture = mockTexture('old-texture');
        registry.registerSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: oldBuffer, owned: true },
            'environment.specular': { kind: 'texture', texture: oldTexture, owned: true },
        }, OWNER);
        const newBuffer = mockBuffer('new-buffer');
        const newTexture = mockTexture('new-texture');

        registry.replaceSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: newBuffer, owned: true },
            'environment.specular': { kind: 'texture', texture: newTexture, owned: true },
        }, OWNER);

        expect(oldBuffer.destroyCount).toBe(1);
        expect(oldTexture.destroyCount).toBe(1);
        expect((registry.resolve('environment.data', 'buffer') as GPUBufferBinding).buffer)
            .toBe(newBuffer);
        expect((registry.resolve('environment.specular', 'texture') as unknown as {
            texture: GPUTexture;
        }).texture).toBe(newTexture);
    });

    it('does not destroy an owned resource reused by its replacement', () => {
        const buffer = mockBuffer('reused-buffer');
        registry.registerSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer, size: 16, owned: true },
        }, OWNER);

        registry.replaceSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer, offset: 16, size: 16, owned: true },
        }, OWNER);

        expect(buffer.destroyCount).toBe(0);
        expect(registry.resolve('environment.data', 'buffer')).toEqual({
            buffer, offset: 16, size: 16,
        });
        registry.unregisterSet(SET_NAME, OWNER);
        expect(buffer.destroyCount).toBe(1);
    });

    it('rejects replacement sets with missing or unexpected members', () => {
        const oldBuffer = mockBuffer('old-buffer');
        const oldTexture = mockTexture('old-texture');
        registry.registerSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: oldBuffer, owned: true },
            'environment.specular': { kind: 'texture', texture: oldTexture, owned: true },
        }, OWNER);

        expect(() => registry.replaceSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: mockBuffer('new'), owned: true },
        }, OWNER)).toThrow(/missing=\[environment.specular\]/);
        expect(() => registry.replaceSet(SET_NAME, {
            'environment.data': { kind: 'buffer', buffer: mockBuffer('new'), owned: true },
            'environment.specular': { kind: 'texture', texture: mockTexture('new'), owned: true },
            'environment.extra': { kind: 'sampler', sampler: {} as GPUSampler },
        }, OWNER)).toThrow(/unexpected=\[environment.extra\]/);

        expect((registry.resolve('environment.data', 'buffer') as GPUBufferBinding).buffer)
            .toBe(oldBuffer);
        expect(oldBuffer.destroyCount).toBe(0);
        expect(oldTexture.destroyCount).toBe(0);
    });

    it('enforces owner isolation and destroys owned resources on removal', () => {
        const buffer = mockBuffer('buffer');
        const texture = mockTexture('texture');
        registry.registerSet('test', {
            'test.buffer': { kind: 'buffer', buffer, owned: true },
            'test.texture': { kind: 'texture', texture, owned: true },
        }, 'plugin:test');

        expect(() => registry.unregisterSet('test', 'plugin:other'))
            .toThrow(/not registered by plugin:other/);
        expect(buffer.destroyCount).toBe(0);
        expect(texture.destroyCount).toBe(0);

        registry.removeOwner('plugin:test');
        expect(buffer.destroyCount).toBe(1);
        expect(texture.destroyCount).toBe(1);
        expect(registry.names()).toEqual([]);
    });

    it('rejects invalid names, empty sets, and ownership of borrowed views', () => {
        expect(() => registry.registerSet('empty', {}, OWNER)).toThrow(/must not be empty/);
        expect(() => registry.registerSet('Bad_Set', {
            'test.valid': { kind: 'sampler', sampler: {} as GPUSampler },
        }, OWNER)).toThrow(/set name.*lowercase ASCII/);
        expect(() => registry.registerSet('invalid-resource', {
            Bad_Name: { kind: 'sampler', sampler: {} as GPUSampler },
        }, OWNER)).toThrow(/lowercase ASCII/);
        expect(() => registry.registerSet('invalid-view', {
            'test.invalid-view': {
                kind: 'texture', view: {} as GPUTextureView, owned: true,
            },
        }, OWNER)).toThrow(/cannot be registered as owned/);
    });
});
