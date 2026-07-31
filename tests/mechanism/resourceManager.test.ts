import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resourceManager } from '../../src/render/ResourceManager';
import { createMockDevice, type MockBuffer } from '../mocks/gpu';
import type { MeshData } from '../../src/render/Primitives';

const MESH_DATA: MeshData = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
};

beforeEach(() => {
    resourceManager.init(createMockDevice());
    resourceManager.enterApp('test');
});

afterEach(() => {
    resourceManager.exitApp('test');
    resourceManager.enterApp('common');
});

describe('ResourceManager: mesh registration + handle lifecycle', () => {
    it('registerMesh + getMesh → MeshGpu with handles', () => {
        resourceManager.registerMesh('cube', MESH_DATA);
        const gpu = resourceManager.getMesh('cube');
        expect(gpu.indexCount).toBe(6);
        expect(gpu.vertexCount).toBe(4);
        expect(gpu.indexHandle).toBeGreaterThan(0);
    });

    it('exitApp destroys GPU buffers', () => {
        resourceManager.registerMesh('cube', MESH_DATA);
        const gpu = resourceManager.getMesh('cube');
        const posBuf = gpu.slots.Pos as MockBuffer;
        resourceManager.exitApp('test');
        expect(posBuf.destroyed).toBe(true);
    });

    it('exitApp("common") → no-op (common not released)', () => {
        resourceManager.registerMesh('persistent', MESH_DATA);
        resourceManager.exitApp('common');
        expect(resourceManager.hasMesh('persistent')).toBe(true);
    });
});

describe('ResourceManager: handle free list recycling', () => {
    it('buffer handle reused from free list after exitApp + re-register', () => {
        resourceManager.registerMesh('m1', MESH_DATA);
        const gpu1 = resourceManager.getMesh('m1');
        const handle1 = gpu1.indexHandle;

        resourceManager.exitApp('test');
        resourceManager.enterApp('test');

        resourceManager.registerMesh('m2', MESH_DATA);
        const gpu2 = resourceManager.getMesh('m2');
        const handle2 = gpu2.indexHandle;

        // Free list recycles indices — the new handle should be within the
        // range of previously used handles (not a new high-water mark).
        expect(handle2).toBeLessThanOrEqual(handle1);
    });

    it('multiple cycles → handles stay small (no unbounded growth)', () => {
        let maxHandle = 0;
        for (let i = 0; i < 5; i++) {
            resourceManager.registerMesh(`m${i}`, MESH_DATA);
            const gpu = resourceManager.getMesh(`m${i}`);
            maxHandle = Math.max(maxHandle, gpu.indexHandle);
            resourceManager.exitApp('test');
            resourceManager.enterApp('test');
        }
        // After 5 register/destroy cycles, max handle should be small (reused)
        expect(maxHandle).toBeLessThan(10);
    });
});

describe('ResourceManager: owner-tagged resource isolation', () => {
    it('resources in different app scopes are independent', () => {
        resourceManager.registerMesh('a_mesh', MESH_DATA);
        resourceManager.exitApp('test');
        resourceManager.enterApp('other');
        resourceManager.registerMesh('b_mesh', MESH_DATA);

        // a_mesh should be gone (test scope destroyed), b_mesh present
        expect(resourceManager.hasMesh('a_mesh')).toBe(false);
        expect(resourceManager.hasMesh('b_mesh')).toBe(true);
    });
});

describe('ResourceManager: claimName cross-owner throws', () => {
    it('bindLayout cross-owner duplicate → throws', () => {
        resourceManager.enterApp('test');
        resourceManager.loadBindLayouts({ shared: { entries: [] } });
        resourceManager.enterApp('other');
        expect(() => resourceManager.loadBindLayouts({ shared: { entries: [] } })).toThrow();
    });

    it('sampler cross-owner duplicate → throws', () => {
        resourceManager.enterApp('test');
        resourceManager.loadSamplers({ mySampler: { type: 'filtering' } });
        resourceManager.enterApp('other');
        expect(() => resourceManager.loadSamplers({ mySampler: { type: 'filtering' } })).toThrow();
    });

    it('same-owner duplicate → no throw', () => {
        resourceManager.enterApp('test');
        resourceManager.loadBindLayouts({ reusable: { entries: [] } });
        expect(() => resourceManager.loadBindLayouts({ reusable: { entries: [] } })).not.toThrow();
    });
});

describe('ResourceManager: texture view cache', () => {
    it('textureView caches view per texture', () => {
        const dev = createMockDevice();
        const tex = dev.createTexture({ size: { width: 1, height: 1 }, format: 'rgba8unorm' }) as never;
        const v1 = resourceManager.textureView(tex);
        const v2 = resourceManager.textureView(tex);
        expect(v1).toBe(v2); // same cached view
    });
});

describe('ResourceManager: getStats', () => {
    it('returns resource counts', () => {
        resourceManager.registerMesh('m', MESH_DATA);
        resourceManager.getMesh('m'); // build GPU
        const stats = resourceManager.getStats();
        expect(stats.meshGpu).toBeGreaterThan(0);
    });
});
