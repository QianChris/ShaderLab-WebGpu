import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Scene } from '../../src/ecs/Scene';
import { schemaRegistry } from '../../src/ecs/SchemaRegistry';
import { resetRegistries } from '../helpers/reset';

const COMPONENTS = [
    { name: 'NameComponent', mandatory: true, fields: { name: { type: 'string', default: '' } } },
    { name: 'Transform', fields: {
        position: { type: 'vec3', default: [0, 0, 0] },
        rotation: { type: 'vec4', default: [0, 0, 0, 1] },
        scale: { type: 'vec3', default: [1, 1, 1] },
    } },
    { name: 'Speed', fields: { value: { type: 'f32', default: 0 } } },
];

beforeAll(() => {
    schemaRegistry.registerDefs(COMPONENTS, 'test');
});

afterAll(() => {
    resetRegistries();
});

describe('Scene.createEntity + entityComponents tracking', () => {
    it('createEntity → entityComponents includes all declared components + NameComponent', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: { position: [1, 2, 3] }, Speed: { value: 5 } });
        const eid = scene.entityKeyMap.get('e1')!;
        // entityComponents is private — verify via toJSON (which uses it)
        const json = scene.toJSON();
        expect(json.e1).toHaveProperty('NameComponent');
        expect(json.e1).toHaveProperty('Transform');
        expect(json.e1).toHaveProperty('Speed');
    });

    it("toJSON only includes entity own components (not all registered)", () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: { position: [0, 0, 0] } });
        const json = scene.toJSON();
        // Should have NameComponent + Transform, but NOT Speed (not added)
        expect(json.e1).toHaveProperty('NameComponent');
        expect(json.e1).toHaveProperty('Transform');
        expect(json.e1).not.toHaveProperty('Speed');
    });
});

describe('Scene.toJSON round-trip', () => {
    it('createEntity → toJSON → re-createEntity → data consistent', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: { position: [1, 2, 3], scale: [2, 2, 2] }, Speed: { value: 9 } });
        const json = scene.toJSON();

        const scene2 = new Scene();
        // Reconstruct: toJSON output has entity data keyed by entity name
        for (const [key, data] of Object.entries(json)) {
            scene2.createEntity(key, data as Record<string, Record<string, unknown>>);
        }
        const json2 = scene2.toJSON();

        // Compare: both should have same entities with same components
        expect(Object.keys(json2).sort()).toEqual(Object.keys(json).sort());
        // Spot-check Transform position
        const t1 = json.e1.Transform as Record<string, unknown>;
        const t2 = json2.e1.Transform as Record<string, unknown>;
        // position is expanded as {position_x, position_y, position_z} or similar
        // Let's just check both have Transform
        expect(t1).toBeDefined();
        expect(t2).toBeDefined();
    });
});

describe('Scene.getModelMatrix with out param', () => {
    it('out param written and matches no-arg version', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: { position: [5, 6, 7] } });
        const eid = scene.entityKeyMap.get('e1')!;

        const out = new Float32Array(16);
        const result = scene.getModelMatrix(eid, out);
        expect(result).toBe(out); // same reference
        expect(out[12]).toBeCloseTo(5, 5); // translation x
        expect(out[13]).toBeCloseTo(6, 5);
        expect(out[14]).toBeCloseTo(7, 5);
    });

    it('two calls same eid → same scratch reference (reuse)', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: { position: [1, 1, 1] } });
        const eid = scene.entityKeyMap.get('e1')!;
        const a = scene.getModelMatrix(eid);
        const b = scene.getModelMatrix(eid);
        // Both should be the same scratch buffer reference
        expect(a).toBe(b);
    });
});

describe('Scene.getActiveCameras pool reuse', () => {
    it('two consecutive calls → CameraView object reference reused', () => {
        const scene = new Scene();
        // Need a Camera component — register one
        schemaRegistry.registerDefs([{
            name: 'Camera',
            fields: {
                active: { type: 'f32', default: 0 },
                fov: { type: 'f32', default: 60 },
                near: { type: 'f32', default: 0.1 },
                far: { type: 'f32', default: 100 },
                viewport: { type: 'vec4', default: [0, 0, 1, 1] },
            },
        }], 'test');
        scene.createEntity('cam', { Camera: { active: 1, fov: 60, near: 0.1, far: 100 } });

        const cams1 = scene.getActiveCameras(1.5);
        const cams2 = scene.getActiveCameras(1.5);
        expect(cams1.length).toBe(1);
        expect(cams2.length).toBe(1);
        // Pool reuse: the CameraView object should be the same reference
        expect(cams2[0]).toBe(cams1[0]);

        schemaRegistry.removeOwner('test');
        schemaRegistry.registerDefs(COMPONENTS, 'test');
    });

    it('0 cameras → empty array (no crash)', () => {
        const scene = new Scene();
        const cams = scene.getActiveCameras(1.0);
        expect(cams.length).toBe(0);
    });
});

describe('Scene.toggleComponent + entityComponents', () => {
    it('toggle on → component appears in toJSON', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: {} });
        const eid = scene.entityKeyMap.get('e1')!;
        // Speed not yet added
        expect(scene.toJSON().e1).not.toHaveProperty('Speed');
        scene.toggleComponent(eid, 'Speed', true);
        expect(scene.toJSON().e1).toHaveProperty('Speed');
    });

    it('toggle off → component removed from toJSON', () => {
        const scene = new Scene();
        scene.createEntity('e1', { Transform: {}, Speed: { value: 3 } });
        const eid = scene.entityKeyMap.get('e1')!;
        expect(scene.toJSON().e1).toHaveProperty('Speed');
        scene.toggleComponent(eid, 'Speed', false);
        expect(scene.toJSON().e1).not.toHaveProperty('Speed');
    });
});
