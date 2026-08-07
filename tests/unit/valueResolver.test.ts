import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileValue, compileString, resolveValue, resolveHandle, type ValueContext } from '../../src/core/render/valueResolver';
import { schemaRegistry } from '../../src/core/ecs/SchemaRegistry';
import type { Scene } from '../../src/core/ecs/Scene';

// ── Mock ValueContext ──
const scratchModel = new Float32Array(16);
scratchModel[0] = 1; scratchModel[5] = 1; scratchModel[10] = 1; scratchModel[15] = 1;

function mockCtx(overrides?: Partial<ValueContext>): ValueContext {
    const scene = {
        getField: () => 42,
        getTagColor: () => [1, 0, 0, 1],
        getTagExtra: () => 7,
    } as unknown as Scene;
    return {
        scene,
        eid: 7,
        tag: 'Red',
        time: 3.14,
        dt: 0.016,
        aspect: 1.5,
        screenW: 1920,
        screenH: 1080,
        model: () => scratchModel,
        scripts: new Map(),
        ...overrides,
    };
}

// Register a test component for Comp.field tests
beforeAll(() => {
    schemaRegistry.registerDefs([{
        name: 'Speed',
        fields: { value: { type: 'f32', default: 0 } },
    }], 'test');
});

afterAll(() => {
    schemaRegistry.removeOwner('test');
});

describe('compileValue: const', () => {
    it('const:1,2,3 → returns [1,2,3]', () => {
        const fn = compileValue('const:1,2,3');
        const result = fn(mockCtx());
        expect(Array.from(result as number[])).toEqual([1, 2, 3]);
    });
});

describe('compileValue: builtin', () => {
    it('builtin.time → ctx.time', () => {
        const fn = compileValue('builtin.time');
        expect(fn(mockCtx())).toBe(3.14);
    });

    it('builtin.entityId → ctx.eid', () => {
        const fn = compileValue('builtin.entityId');
        expect(fn(mockCtx())).toBe(7);
    });

    it('builtin.dt → ctx.dt', () => {
        const fn = compileValue('builtin.dt');
        expect(fn(mockCtx())).toBe(0.016);
    });

    it('builtin.aspect → ctx.aspect', () => {
        const fn = compileValue('builtin.aspect');
        expect(fn(mockCtx())).toBe(1.5);
    });
});

describe('compileValue: transform', () => {
    it('transform.model → Float32Array (same as ctx.model())', () => {
        const fn = compileValue('transform.model');
        const result = fn(mockCtx()) as Float32Array;
        expect(result).toBe(scratchModel); // same reference (no copy)
        expect(result.length).toBe(16);
    });

    it('transform.normalMatrix → Float32Array(12)', () => {
        const fn = compileValue('transform.normalMatrix');
        const result = fn(mockCtx()) as Float32Array;
        expect(result.length).toBe(12);
        // Identity model → identity normal matrix
        expect(result[0]).toBeCloseTo(1, 5);
        expect(result[5]).toBeCloseTo(1, 5);
        expect(result[10]).toBeCloseTo(1, 5);
    });
});

describe('compileValue: Comp.field', () => {
    it('Speed.value → scene.getField result', () => {
        const fn = compileValue('Speed.value');
        expect(fn(mockCtx())).toBe(42);
    });

    it('unknown component → throws at compile time', () => {
        expect(() => compileValue('Unknown.field')).toThrow('unknown component');
    });
});

describe('compileValue: pack', () => {
    it('pack:1,2,Speed.value → concatenates const + field', () => {
        const fn = compileValue('pack:1,2,Speed.value');
        const result = fn(mockCtx()) as number[];
        expect(result).toEqual([1, 2, 42]);
    });

    it('pack:1,2,3 → all constants', () => {
        const fn = compileValue('pack:1,2,3');
        const result = fn(mockCtx()) as number[];
        expect(result).toEqual([1, 2, 3]);
    });
});

describe('compileValue: script', () => {
    it('script:foo.bar → looks up in ctx.scripts', () => {
        const scripts = new Map([['foo.bar', () => 99]]);
        const fn = compileValue('script:foo.bar');
        expect(fn(mockCtx({ scripts }))).toBe(99);
    });

    it('script:missing → throws at runtime', () => {
        const fn = compileValue('script:missing.fn');
        expect(() => fn(mockCtx())).toThrow('not found');
    });
});

describe('compileValue: unknown builtin atom', () => {
    it('builtin.unknown → throws at compile time', () => {
        expect(() => compileValue('builtin.unknown')).toThrow('Unknown value atom');
    });
});

describe('compileString', () => {
    it('literal (no dot) → returns literal', () => {
        const fn = compileString('quad');
        expect(fn(mockCtx())).toBe('quad');
    });

    it('MeshComponent.mesh → scene.getField result', () => {
        const ctx = mockCtx({
            scene: { getField: () => 'cube' } as unknown as Scene,
        });
        // Need to register MeshComponent for compileString to succeed
        schemaRegistry.registerDefs([{
            name: 'MeshComponent',
            fields: { mesh: { type: 'string', default: '' } },
        }], 'test');
        const fn = compileString('MeshComponent.mesh');
        expect(fn(ctx)).toBe('cube');
        schemaRegistry.removeOwner('test');
        // Re-register Speed since removeOwner('test') removed it
        schemaRegistry.registerDefs([{
            name: 'Speed',
            fields: { value: { type: 'f32', default: 0 } },
        }], 'test');
    });

    it('builtin.time → returns original string (not resolved)', () => {
        const fn = compileString('builtin.time');
        expect(fn(mockCtx())).toBe('builtin.time');
    });

    it('transform.model → returns original string', () => {
        const fn = compileString('transform.model');
        expect(fn(mockCtx())).toBe('transform.model');
    });

    it('unknown component → throws at compile time', () => {
        expect(() => compileString('Unknown.field')).toThrow('unknown component');
    });
});

describe('resolveValue (runtime) vs compileValue (precompiled) consistency', () => {
    it('const:1,2,3 gives same result', () => {
        const ctx = mockCtx();
        const compiled = compileValue('const:1,2,3')(ctx);
        const runtime = resolveValue('const:1,2,3', ctx);
        expect(Array.from(compiled as number[])).toEqual(Array.from(runtime as number[]));
    });

    it('builtin.time gives same result', () => {
        const ctx = mockCtx();
        expect(compileValue('builtin.time')(ctx)).toBe(resolveValue('builtin.time', ctx));
    });
});

describe('resolveHandle', () => {
    it('numeric literal → returns the number', () => {
        const ctx = mockCtx();
        expect(resolveHandle('42', ctx)).toBe(42);
    });

    it('array → returns first element', () => {
        const ctx = mockCtx();
        // const:5,6 → resolveValue returns [5,6], resolveHandle returns 5
        expect(resolveHandle('const:5,6', ctx)).toBe(5);
    });
});
