import { describe, it, expect } from 'vitest';
import {
    mat4Mul, mat4MulInto, mat4Inverse, mat4InverseInto,
    mat4FromTRS, mat4FromTRSInto, mat4Perspective, mat4PerspectiveInto,
    normalMatrix, normalMatrixInto, buildCameraMatrices, buildCameraMatricesInto,
} from '../../src/math';

const EPS = 1e-5;

function expectClose(actual: Float32Array, expected: Float32Array, msg = ''): void {
    for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i]), `${msg} at [${i}]`).toBeLessThan(EPS);
    }
}

describe('mat4MulInto', () => {
    it('writes into out and matches mat4Mul', () => {
        const a = mat4FromTRS([1, 0, 0], [0, 0, 0, 1], [2, 2, 2]);
        const b = mat4FromTRS([0, 1, 0], [0, 0, 0, 1], [1, 1, 1]);
        const out = new Float32Array(16);
        const result = mat4MulInto(a, b, out);
        expect(result).toBe(out);
        const expected = mat4Mul(a, b);
        expectClose(out, expected, 'mat4MulInto vs mat4Mul');
    });
});

describe('mat4InverseInto', () => {
    it('inverse(inverse(m)) ≈ m', () => {
        const m = mat4FromTRS([3, 1, 2], [0.1, 0.2, 0.3, 0.9], [1, 2, 3]);
        const inv = new Float32Array(16);
        mat4InverseInto(m, inv);
        const invInv = new Float32Array(16);
        mat4InverseInto(inv, invInv);
        expectClose(invInv, m, 'inverse(inverse(m))');
    });

    it('matches mat4Inverse', () => {
        const m = mat4FromTRS([1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
        const out = new Float32Array(16);
        mat4InverseInto(m, out);
        expectClose(out, mat4Inverse(m), 'mat4InverseInto vs mat4Inverse');
    });
});

describe('mat4FromTRSInto', () => {
    it('identity quaternion → identity matrix', () => {
        const out = new Float32Array(16);
        mat4FromTRSInto([0, 0, 0], [0, 0, 0, 1], [1, 1, 1], out);
        expectClose(out, mat4FromTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
        expect(out[0]).toBeCloseTo(1, 5);
        expect(out[5]).toBeCloseTo(1, 5);
        expect(out[10]).toBeCloseTo(1, 5);
        expect(out[15]).toBeCloseTo(1, 5);
        expect(out[12]).toBeCloseTo(0, 5);
    });

    it('pure translation → m[12,13,14] = pos', () => {
        const out = new Float32Array(16);
        mat4FromTRSInto([5, 6, 7], [0, 0, 0, 1], [1, 1, 1], out);
        expect(out[12]).toBeCloseTo(5, 5);
        expect(out[13]).toBeCloseTo(6, 5);
        expect(out[14]).toBeCloseTo(7, 5);
    });

    it('pure scale → diagonal = scale', () => {
        const out = new Float32Array(16);
        mat4FromTRSInto([0, 0, 0], [0, 0, 0, 1], [3, 4, 5], out);
        expect(out[0]).toBeCloseTo(3, 5);
        expect(out[5]).toBeCloseTo(4, 5);
        expect(out[10]).toBeCloseTo(5, 5);
    });
});

describe('mat4PerspectiveInto', () => {
    it('WebGPU convention: m[11]=-1, m[15]=0', () => {
        const out = new Float32Array(16);
        mat4PerspectiveInto(Math.PI / 4, 1.5, 0.1, 100, out);
        expect(out[11]).toBeCloseTo(-1, 5);
        expect(out[15]).toBeCloseTo(0, 5);
    });
});

describe('normalMatrixInto', () => {
    it('identity model → identity normal matrix', () => {
        const model = mat4FromTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
        const out = new Float32Array(12);
        normalMatrixInto(model, out);
        // Identity normal matrix: i00=1, i11=1, i22=1 (padded vec4 layout)
        expect(out[0]).toBeCloseTo(1, 5);
        expect(out[5]).toBeCloseTo(1, 5);
        expect(out[10]).toBeCloseTo(1, 5);
        // Padding slots should be 0
        expect(out[3]).toBeCloseTo(0, 5);
        expect(out[7]).toBeCloseTo(0, 5);
        expect(out[11]).toBeCloseTo(0, 5);
    });

    it('non-uniform scale → differs from identity', () => {
        const model = mat4FromTRS([0, 0, 0], [0, 0, 0, 1], [2, 1, 1]);
        const out = new Float32Array(12);
        normalMatrixInto(model, out);
        const identity = new Float32Array(12);
        normalMatrixInto(mat4FromTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), identity);
        // At least one diagonal element should differ
        const differs = out[0] !== identity[0] || out[5] !== identity[5] || out[10] !== identity[10];
        expect(differs).toBe(true);
    });
});

describe('buildCameraMatricesInto', () => {
    it('vp ≈ mat4Mul(proj, view)', () => {
        const trs = { pos: [1, 2, 3] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const out = {
            vp: new Float32Array(16), ivp: new Float32Array(16),
            pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
        };
        buildCameraMatricesInto(trs, 60, 1.5, 0.1, 100, out);
        const expectedVp = mat4Mul(out.proj, out.view);
        expectClose(out.vp, expectedVp, 'vp = proj * view');
    });

    it('all fields written (non-null)', () => {
        const trs = { pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const out = {
            vp: new Float32Array(16), ivp: new Float32Array(16),
            pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
        };
        buildCameraMatricesInto(trs, 90, 1.0, 0.1, 100, out);
        expect(out.vp.length).toBe(16);
        expect(out.ivp.length).toBe(16);
        expect(out.pos.length).toBe(4);
        expect(out.view.length).toBe(16);
        expect(out.proj.length).toBe(16);
        // pos should have the camera position
        expect(out.pos[0]).toBeCloseTo(0, 5);
        expect(out.pos[1]).toBeCloseTo(0, 5);
        expect(out.pos[2]).toBeCloseTo(0, 5);
    });

    it('matches buildCameraMatrices (non-Into)', () => {
        const trs = { pos: [2, 3, 5] as [number, number, number], rot: [0.1, 0.2, 0.3, 0.9] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
        const ref = buildCameraMatrices(trs, 75, 1.3, 0.5, 200);
        const out = {
            vp: new Float32Array(16), ivp: new Float32Array(16),
            pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
        };
        buildCameraMatricesInto(trs, 75, 1.3, 0.5, 200, out);
        expectClose(out.vp, ref.vp, 'vp');
        expectClose(out.ivp, ref.ivp, 'ivp');
        expectClose(out.view, ref.view, 'view');
        expectClose(out.proj, ref.proj, 'proj');
    });
});
