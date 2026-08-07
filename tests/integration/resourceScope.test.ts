import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { createMockDevice, type MockBuffer } from '../mocks/gpu';
import { resetRegistries } from '../helpers/reset';
import type { MeshData } from '../../src/core/render/Primitives';

const MESH: MeshData = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
};

beforeAll(() => {
    resourceManager.init(createMockDevice());
});

afterAll(() => {
    resetRegistries();
});

describe('Cross-app resource scope isolation', () => {
    it('enterApp(a) → register → exitApp(a) → resources gone', () => {
        resourceManager.enterApp('appA');
        resourceManager.registerMesh('aMesh', MESH);
        expect(resourceManager.hasMesh('aMesh')).toBe(true);

        resourceManager.exitApp('appA');
        expect(resourceManager.hasMesh('aMesh')).toBe(false);
    });

    it('common resources survive app switch', () => {
        resourceManager.enterApp('common');
        resourceManager.registerMesh('persistent', MESH);
        resourceManager.enterApp('appX');
        // Do stuff in appX
        resourceManager.exitApp('appX');
        // Common mesh should still be there
        expect(resourceManager.hasMesh('persistent')).toBe(true);
    });

    it('handle free list stays stable across multiple app switches', () => {
        let maxHandle = 0;
        for (let i = 0; i < 5; i++) {
            resourceManager.enterApp(`app${i}`);
            resourceManager.registerMesh(`m${i}`, MESH);
            const gpu = resourceManager.getMesh(`m${i}`);
            maxHandle = Math.max(maxHandle, gpu.indexHandle);
            resourceManager.exitApp(`app${i}`);
        }
        // After 5 full cycles, max handle should stay small (reused, not growing)
        expect(maxHandle).toBeLessThan(10);
    });

    it('exitApp destroys GPU buffers (mock verified)', () => {
        resourceManager.enterApp('appDestroy');
        resourceManager.registerMesh('dMesh', MESH);
        const gpu = resourceManager.getMesh('dMesh');
        const buf = gpu.slots.Pos as MockBuffer;
        expect(buf.destroyed).toBe(false);

        resourceManager.exitApp('appDestroy');
        expect(buf.destroyed).toBe(true);
    });
});
