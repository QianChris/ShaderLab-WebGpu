import { describe, it, expect } from 'vitest';
import { UniformLayout } from '../../src/render/UniformLayout';

describe('UniformLayout std140 alignment', () => {
    it('single f32 → byteSize = 16 (minimum block)', () => {
        const layout = new UniformLayout([{ name: 'a', type: 'f32' }]);
        expect(layout.byteSize).toBe(16);
        expect(layout.floatCount).toBe(4);
        expect(layout.floatOffsetOf('a')).toBe(0);
    });

    it('vec3f + f32 → b at float offset 3 (std140: f32 fits in vec3 padding)', () => {
        const layout = new UniformLayout([
            { name: 'v', type: 'vec3f' },
            { name: 'b', type: 'f32' },
        ]);
        // vec3f: align 16, size 12 (3 floats). f32 align 4 → can go at byte 12 (float 3).
        expect(layout.floatOffsetOf('v')).toBe(0);
        expect(layout.floatOffsetOf('b')).toBe(3);
    });

    it('mat4x4f → byteSize = 64', () => {
        const layout = new UniformLayout([{ name: 'm', type: 'mat4x4f' }]);
        expect(layout.byteSize).toBe(64);
        expect(layout.floatCount).toBe(16);
    });

    it('mat3x3f → byteSize = 48 (3 columns × vec4 padding)', () => {
        const layout = new UniformLayout([{ name: 'm', type: 'mat3x3f' }]);
        expect(layout.byteSize).toBe(48);
        expect(layout.floatCount).toBe(12);
    });

    it('vec2f → align 8', () => {
        const layout = new UniformLayout([
            { name: 'a', type: 'f32' },
            { name: 'v', type: 'vec2f' },
        ]);
        // f32 at 0 (size 4), vec2f align 8 → offset 8 → float 2
        expect(layout.floatOffsetOf('a')).toBe(0);
        expect(layout.floatOffsetOf('v')).toBe(2);
    });

    it('write scalar to correct offset', () => {
        const layout = new UniformLayout([{ name: 'a', type: 'f32' }]);
        const buf = layout.createBuffer();
        layout.write(buf, 'a', 42);
        expect(buf[0]).toBe(42);
    });

    it('write array to correct offset', () => {
        const layout = new UniformLayout([{ name: 'v', type: 'vec3f' }]);
        const buf = layout.createBuffer();
        layout.write(buf, 'v', [1, 2, 3]);
        expect(buf[0]).toBe(1);
        expect(buf[1]).toBe(2);
        expect(buf[2]).toBe(3);
    });

    it('write Float32Array to correct offset', () => {
        const layout = new UniformLayout([{ name: 'm', type: 'mat4x4f' }]);
        const buf = layout.createBuffer();
        const mat = new Float32Array(16);
        mat[0] = 99;
        layout.write(buf, 'm', mat);
        expect(buf[0]).toBe(99);
    });

    it('unknown member → throws', () => {
        const layout = new UniformLayout([{ name: 'a', type: 'f32' }]);
        const buf = layout.createBuffer();
        expect(() => layout.write(buf, 'unknown', 0)).toThrow();
    });

    it('floatOffsetOf unknown → throws', () => {
        const layout = new UniformLayout([{ name: 'a', type: 'f32' }]);
        expect(() => layout.floatOffsetOf('unknown')).toThrow();
    });

    it('has() works', () => {
        const layout = new UniformLayout([{ name: 'a', type: 'f32' }]);
        expect(layout.has('a')).toBe(true);
        expect(layout.has('b')).toBe(false);
    });

    it('writeU32 writes to correct offset', () => {
        const layout = new UniformLayout([{ name: 'idx', type: 'u32' }]);
        const buf = new Uint32Array(layout.floatCount);
        layout.writeU32(buf, 'idx', 7);
        expect(buf[0]).toBe(7);
    });

    it('multiple members lay out correctly', () => {
        const layout = new UniformLayout([
            { name: 'vp', type: 'mat4x4f' },     // offset 0, size 64
            { name: 'ivp', type: 'mat4x4f' },    // offset 64, align 16
            { name: 'pos', type: 'vec4f' },       // offset 128, align 16, size 16
            { name: 'time', type: 'f32' },        // offset 144, align 4
        ]);
        expect(layout.floatOffsetOf('vp')).toBe(0);
        expect(layout.floatOffsetOf('ivp')).toBe(16);
        expect(layout.floatOffsetOf('pos')).toBe(32);
        // time at 144/4 = 36
        expect(layout.floatOffsetOf('time')).toBe(36);
    });
});
