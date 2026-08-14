export interface TRS {
    pos: [number, number, number];
    rot: [number, number, number, number];
    scale: [number, number, number];
}

export function buildCameraMatrices(
    trs: TRS,
    fov: number,
    aspect: number,
    near: number,
    far: number,
): { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array } {
    return buildCameraMatricesInto(trs, fov, aspect, near, far, {
        vp: new Float32Array(16), ivp: new Float32Array(16),
        pos: new Float32Array(4), view: new Float32Array(16), proj: new Float32Array(16),
    });
}

/** Reusable scratch for the world-matrix temporary in buildCameraMatricesInto. */
const _scratchWorld = new Float32Array(16);

/** out-parameter variant: writes into the caller-provided arrays in `out`.
 *  The `out` object and its Float32Array fields are reused across calls —
 *  no per-call allocation. Not reentrant (uses a module-level scratch). */
export function buildCameraMatricesInto(
    trs: TRS,
    fov: number,
    aspect: number,
    near: number,
    far: number,
    out: { vp: Float32Array; ivp: Float32Array; pos: Float32Array; view: Float32Array; proj: Float32Array },
): typeof out {
    // world = mat4FromTRS(...)
    mat4FromTRSInto(trs.pos, trs.rot, trs.scale, _scratchWorld);
    // view = mat4Inverse(world) — reuse vp as scratch then overwrite
    mat4InverseInto(_scratchWorld, out.view);
    // proj = mat4Perspective(...)
    mat4PerspectiveInto((fov * Math.PI) / 180, aspect, near, far, out.proj);
    // vp = mat4Mul(proj, view)
    mat4MulInto(out.proj, out.view, out.vp);
    // ivp = mat4Inverse(vp)
    mat4InverseInto(out.vp, out.ivp);
    // pos
    out.pos[0] = trs.pos[0]; out.pos[1] = trs.pos[1]; out.pos[2] = trs.pos[2]; out.pos[3] = 0;
    return out;
}

export function mat4FromTRS(
    pos: [number, number, number],
    rot: [number, number, number, number],
    scale: [number, number, number],
): Float32Array {
    return mat4FromTRSInto(pos, rot, scale, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4FromTRSInto(
    pos: [number, number, number],
    rot: [number, number, number, number],
    scale: [number, number, number],
    out: Float32Array,
): Float32Array {
    const [rx, ry, rz, rw] = rot;
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    const qx = rx / len, qy = ry / len, qz = rz / len, qw = rw / len;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const m = out;
    m[0] = (1 - 2 * (yy + zz)) * scale[0];  m[4] = (2 * (xy - wz)) * scale[1];      m[8]  = (2 * (xz + wy)) * scale[2];      m[12] = pos[0];
    m[1] = (2 * (xy + wz)) * scale[0];      m[5] = (1 - 2 * (xx + zz)) * scale[1];  m[9]  = (2 * (yz - wx)) * scale[2];      m[13] = pos[1];
    m[2] = (2 * (xz - wy)) * scale[0];      m[6] = (2 * (yz + wx)) * scale[1];      m[10] = (1 - 2 * (xx + yy)) * scale[2];  m[14] = pos[2];
    m[3] = 0;                               m[7] = 0;                               m[11] = 0;                               m[15] = 1;
    return m;
}

/** Symmetric orthographic projection (WebGPU z in [0,1]), for directional-light shadows. */
export function mat4OrthographicSym(halfExtent: number, near: number, far: number): Float32Array {
    return mat4OrthographicSymInto(halfExtent, near, far, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4OrthographicSymInto(halfExtent: number, near: number, far: number, out: Float32Array): Float32Array {
    const m = out;
    const rl = halfExtent;
    m[0] = 1 / rl;  m[4] = 0;       m[8]  = 0;                 m[12] = 0;
    m[1] = 0;       m[5] = 1 / rl;  m[9]  = 0;                 m[13] = 0;
    m[2] = 0;       m[6] = 0;       m[10] = 1 / (near - far);  m[14] = near / (near - far);
    m[3] = 0;       m[7] = 0;       m[11] = 0;                 m[15] = 1;
    return m;
}

/** Right-handed lookAt view matrix (column-major), for building light-space matrices. */
export function mat4LookAt(
    eye: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
): Float32Array {
    return mat4LookAtInto(eye, target, up, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4LookAtInto(
    eye: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
    out: Float32Array,
): Float32Array {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    const m = out;
    m[0] = xx;  m[4] = xy;  m[8]  = xz;  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    m[1] = yx;  m[5] = yy;  m[9]  = yz;  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    m[2] = zx;  m[6] = zy;  m[10] = zz;  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    m[3] = 0;   m[7] = 0;   m[11] = 0;   m[15] = 1;
    return m;
}

/** Rotate a unit vector by a quaternion [x,y,z,w]. */
export function quatRotateVec3(
    q: [number, number, number, number],
    v: [number, number, number],
): [number, number, number] {
    const [qx, qy, qz, qw] = q;
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ];
}

export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
    return mat4PerspectiveInto(fovY, aspect, near, far, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4PerspectiveInto(fovY: number, aspect: number, near: number, far: number, out: Float32Array): Float32Array {
    const f = 1 / Math.tan(fovY / 2);
    const m = out;
    m[0] = f / aspect;  m[4] = 0;  m[8]  = 0;                     m[12] = 0;
    m[1] = 0;           m[5] = f;  m[9]  = 0;                     m[13] = 0;
    m[2] = 0;           m[6] = 0;  m[10] = far / (near - far);    m[14] = (far * near) / (near - far);
    m[3] = 0;           m[7] = 0;  m[11] = -1;                    m[15] = 0;
    return m;
}

/**
 * Normal matrix = transpose(inverse(upper-left 3x3 of model)).
 * Returned as 3 columns padded to vec4 (12 floats) matching WGSL mat3x3f layout.
 */
export function normalMatrix(model: Float32Array): Float32Array {
    return normalMatrixInto(model, new Float32Array(12));
}

/** out-parameter variant: writes into `out` (length 12) and returns it. */
export function normalMatrixInto(model: Float32Array, out: Float32Array): Float32Array {
    const a00 = model[0], a01 = model[1], a02 = model[2];
    const a10 = model[4], a11 = model[5], a12 = model[6];
    const a20 = model[8], a21 = model[9], a22 = model[10];

    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    let det = a00 * b01 + a01 * b11 + a02 * b21;
    det = det !== 0 ? 1 / det : 0;

    const i00 = b01 * det;
    const i01 = (-a22 * a01 + a02 * a21) * det;
    const i02 = (a12 * a01 - a02 * a11) * det;
    const i10 = b11 * det;
    const i11 = (a22 * a00 - a02 * a20) * det;
    const i12 = (-a12 * a00 + a02 * a10) * det;
    const i20 = b21 * det;
    const i21 = (-a21 * a00 + a01 * a20) * det;
    const i22 = (a11 * a00 - a01 * a10) * det;

    // transpose of inverse, stored column-major with vec4 padding
    out[0] = i00; out[1] = i10; out[2] = i20; out[3] = 0;
    out[4] = i01; out[5] = i11; out[6] = i21; out[7] = 0;
    out[8] = i02; out[9] = i12; out[10] = i22; out[11] = 0;
    return out;
}

/** Multiply column-major mat4 by a vec4; returns [x, y, z, w]. */
export function mat4TransformVec4(
    m: Float32Array,
    v: [number, number, number, number],
): [number, number, number, number] {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
}

export function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
    return mat4MulInto(a, b, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4MulInto(a: Float32Array, b: Float32Array, out: Float32Array): Float32Array {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[col * 4 + row] =
                a[row] * b[col * 4] +
                a[row + 4] * b[col * 4 + 1] +
                a[row + 8] * b[col * 4 + 2] +
                a[row + 12] * b[col * 4 + 3];
        }
    }
    return out;
}

export function mat4Inverse(m: Float32Array): Float32Array {
    return mat4InverseInto(m, new Float32Array(16));
}

/** out-parameter variant: writes into `out` (length 16) and returns it. */
export function mat4InverseInto(m: Float32Array, out: Float32Array): Float32Array {
    const n00 = m[0], n01 = m[4], n02 = m[8],  n03 = m[12];
    const n10 = m[1], n11 = m[5], n12 = m[9],  n13 = m[13];
    const n20 = m[2], n21 = m[6], n22 = m[10], n23 = m[14];
    const n30 = m[3], n31 = m[7], n32 = m[11], n33 = m[15];

    const t1 = n22 * n33 - n23 * n32;  const t2 = n21 * n33 - n23 * n31;
    const t3 = n21 * n32 - n22 * n31;  const t4 = n20 * n33 - n23 * n30;
    const t5 = n20 * n32 - n22 * n30;  const t6 = n20 * n31 - n21 * n30;

    let det = n00 * (n11 * t1 - n12 * t2 + n13 * t3)
            - n01 * (n10 * t1 - n12 * t4 + n13 * t5)
            + n02 * (n10 * t2 - n11 * t4 + n13 * t6)
            - n03 * (n10 * t3 - n11 * t5 + n12 * t6);
    det = 1 / det;

    const inv = out;
    inv[0]  =  (n11 * t1 - n12 * t2 + n13 * t3) * det;
    inv[1]  = -(n10 * t1 - n12 * t4 + n13 * t5) * det;
    inv[2]  =  (n10 * t2 - n11 * t4 + n13 * t6) * det;
    inv[3]  = -(n10 * t3 - n11 * t5 + n12 * t6) * det;

    inv[4]  = -(n01 * t1 - n02 * t2 + n03 * t3) * det;
    inv[5]  =  (n00 * t1 - n02 * t4 + n03 * t5) * det;
    inv[6]  = -(n00 * t2 - n01 * t4 + n03 * t6) * det;
    inv[7]  =  (n00 * t3 - n01 * t5 + n02 * t6) * det;

    const u1 = n01 * n12 - n02 * n11;  const u2 = n01 * n13 - n03 * n11;
    const u3 = n02 * n13 - n03 * n12;  const u4 = n00 * n12 - n02 * n10;
    const u5 = n00 * n13 - n03 * n10;  const u6 = n00 * n11 - n01 * n10;

    inv[8]  =  (n31 * u3 - n32 * u2 + n33 * u1) * det;
    inv[9]  = -(n30 * u3 - n32 * u5 + n33 * u4) * det;
    inv[10] =  (n30 * u2 - n31 * u5 + n33 * u6) * det;
    inv[11] = -(n30 * u1 - n31 * u4 + n32 * u6) * det;

    inv[12] = -(n21 * u3 - n22 * u2 + n23 * u1) * det;
    inv[13] =  (n20 * u3 - n22 * u5 + n23 * u4) * det;
    inv[14] = -(n20 * u2 - n21 * u5 + n23 * u6) * det;
    inv[15] =  (n20 * u1 - n21 * u4 + n22 * u6) * det;

    return inv;
}

/** Extract a rotation quaternion [x,y,z,w] from a column-major mat4's upper
 *  3×3 (m is a 16-element Float32Array/number[] in column-major order). Used
 *  by the glTF loader (matrix-form nodes) and the editor's reparent command
 *  (keep-world-stays). Standard formula. */
export function mat4ToQuat(m: ArrayLike<number>): [number, number, number, number] {
    const m00 = m[0], m01 = m[4], m02 = m[8];
    const m10 = m[1], m11 = m[5], m12 = m[9];
    const m20 = m[2], m21 = m[6], m22 = m[10];
    const trace = m00 + m11 + m22;
    let qx: number, qy: number, qz: number, qw: number;
    if (trace > 0) {
        const S = Math.sqrt(trace + 1.0) * 2;
        qw = 0.25 * S;
        qx = (m21 - m12) / S;
        qy = (m02 - m20) / S;
        qz = (m10 - m01) / S;
    } else if (m00 > m11 && m00 > m22) {
        const S = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
        qw = (m21 - m12) / S;
        qx = 0.25 * S;
        qy = (m01 + m10) / S;
        qz = (m02 + m20) / S;
    } else if (m11 > m22) {
        const S = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
        qw = (m02 - m20) / S;
        qx = (m01 + m10) / S;
        qy = 0.25 * S;
        qz = (m12 + m21) / S;
    } else {
        const S = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
        qw = (m10 - m01) / S;
        qx = (m02 + m20) / S;
        qy = (m12 + m21) / S;
        qz = 0.25 * S;
    }
    return [qx, qy, qz, qw];
}
