import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Scene } from '../../src/core/ecs/Scene';
import { schemaRegistry } from '../../src/core/ecs/SchemaRegistry';
import { resetRegistries } from '../helpers/reset';

const COMPONENTS = [
    { name: 'NameComponent', mandatory: true, fields: { name: { type: 'string', default: '' } } },
    {
        name: 'Transform',
        fields: {
            position: { type: 'vec3', default: [0, 0, 0] },
            rotation: { type: 'vec4', default: [0, 0, 0, 1] },
            scale: { type: 'vec3', default: [1, 1, 1] },
            parent: { type: 'string', default: '' },
        },
    },
];

beforeAll(() => {
    schemaRegistry.registerDefs(COMPONENTS, 'test');
});

afterAll(() => {
    resetRegistries();
});

describe('Scene parent hierarchy', () => {
    it('createEntity with parent wires getChildren/getParent back-refs', () => {
        const scene = new Scene();
        scene.createEntity('parent', { Transform: { position: [0, 0, 0] } });
        scene.createEntity('child', { Transform: { position: [1, 0, 0], parent: 'parent' } });

        expect(scene.getChildren('parent')).toEqual(['child']);
        const childEid = scene.entityKeyMap.get('child')!;
        expect(scene.getParent(childEid)).toBe('parent');
    });

    it('getModelMatrix composes parent * child (world translate = parent + child)', () => {
        const scene = new Scene();
        scene.createEntity('parent', { Transform: { position: [10, 0, 0] } });
        scene.createEntity('child', { Transform: { position: [1, 0, 0], parent: 'parent' } });
        const childEid = scene.entityKeyMap.get('child')!;

        const m = scene.getModelMatrix(childEid);
        // Column-major translation lives at index 12/13/14.
        expect(m[12]).toBeCloseTo(11, 5);
        expect(m[13]).toBeCloseTo(0, 5);
        expect(m[14]).toBeCloseTo(0, 5);
    });

    it('nested chain: grandchild world = parent + child + grandchild', () => {
        const scene = new Scene();
        scene.createEntity('root', { Transform: { position: [100, 0, 0] } });
        scene.createEntity('mid', { Transform: { position: [10, 0, 0], parent: 'root' } });
        scene.createEntity('leaf', { Transform: { position: [1, 0, 0], parent: 'mid' } });
        const leafEid = scene.entityKeyMap.get('leaf')!;

        const m = scene.getModelMatrix(leafEid);
        expect(m[12]).toBeCloseTo(111, 5);
    });

    it('setField position invalidates so next getModelMatrix recomputes', () => {
        const scene = new Scene();
        scene.createEntity('parent', { Transform: { position: [10, 0, 0] } });
        scene.createEntity('child', { Transform: { position: [1, 0, 0], parent: 'parent' } });
        const childEid = scene.entityKeyMap.get('child')!;

        // Initial: world.x = 11
        expect(scene.getModelMatrix(childEid)[12]).toBeCloseTo(11, 5);

        // Move parent → child world must update.
        const parentEid = scene.entityKeyMap.get('parent')!;
        scene.setField(parentEid, 'Transform', 'position', [20, 0, 0]);
        expect(scene.getModelMatrix(childEid)[12]).toBeCloseTo(21, 5);
    });

    it('setParent cycle throws (would form a loop)', () => {
        const scene = new Scene();
        scene.createEntity('a', { Transform: { position: [0, 0, 0] } });
        scene.createEntity('b', { Transform: { position: [0, 0, 0], parent: 'a' } });

        // b's parent is a; making a's parent b would cycle.
        expect(() => scene.setParent('a', 'b')).toThrow(/cycle/i);
    });

    it('setParent to missing entity throws (fail-loud)', () => {
        const scene = new Scene();
        scene.createEntity('a', { Transform: { position: [0, 0, 0] } });
        expect(() => scene.setParent('a', 'nope')).toThrow(/does not exist/i);
    });

    it('removeEntity reparents orphans to root', () => {
        const scene = new Scene();
        scene.createEntity('parent', { Transform: { position: [10, 0, 0] } });
        scene.createEntity('child', { Transform: { position: [1, 0, 0], parent: 'parent' } });
        const childEid = scene.entityKeyMap.get('child')!;

        scene.removeEntity('parent');
        // Child is now a root: its world translate is just its own [1,0,0].
        expect(scene.getParent(childEid)).toBe('');
        expect(scene.getModelMatrix(childEid)[12]).toBeCloseTo(1, 5);
    });

    it('cached matrix reused across frames when nothing changed', () => {
        const scene = new Scene();
        scene.createEntity('e', { Transform: { position: [5, 0, 0] } });
        const eid = scene.entityKeyMap.get('e')!;
        const a = scene.getModelMatrix(eid);
        // Force a second read — should hit the cache (no new computation).
        const out = new Float32Array(16);
        const b = scene.getModelMatrix(eid, out);
        expect(b).toBe(out);
        expect(b[12]).toBeCloseTo(5, 5);
        // a was the scratch reference; b is the caller's out. Both have the same data.
        expect(a[12]).toBeCloseTo(5, 5);
    });
});
