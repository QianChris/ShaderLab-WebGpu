export interface MeshData {
    positions: number[];
    indices: number[];
}

export interface PbrMeshData {
    positions: number[];
    normals: number[];
    uvs: number[];
    tangents: number[];
    indices: number[];
}

export function makeTriangle(): MeshData {
    return {
        positions: [
            0.0,  0.5, 0.0,
            -0.5, -0.5, 0.0,
            0.5, -0.5, 0.0,
        ],
        indices: [0, 1, 2],
    };
}

export function makeCube(): MeshData {
    const s = 0.5;
    const positions = [
        -s, -s, -s,   s, -s, -s,   s,  s, -s,  -s,  s, -s,
        -s, -s,  s,   s, -s,  s,   s,  s,  s,  -s,  s,  s,
    ];
    const indices = [
        0, 2, 1,  0, 3, 2,
        4, 5, 6,  4, 6, 7,
        0, 1, 5,  0, 5, 4,
        3, 7, 6,  3, 6, 2,
        0, 4, 7,  0, 7, 3,
        1, 2, 6,  1, 6, 5,
    ];
    return { positions, indices };
}

export function makeIcosphere(subdivisions = 1): MeshData {
    const t = (1 + Math.sqrt(5)) / 2;
    const verts: [number, number, number][] = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    let faces: [number, number, number][] = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];

    const midCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const cached = midCache.get(key);
        if (cached !== undefined) return cached;
        const va = verts[a];
        const vb = verts[b];
        verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
        const idx = verts.length - 1;
        midCache.set(key, idx);
        return idx;
    };

    for (let i = 0; i < subdivisions; i++) {
        const next: [number, number, number][] = [];
        for (const [a, b, c] of faces) {
            const ab = midpoint(a, b);
            const bc = midpoint(b, c);
            const ca = midpoint(c, a);
            next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        }
        faces = next;
    }

    const positions: number[] = [];
    for (const v of verts) {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        positions.push((v[0] / len) * 0.5, (v[1] / len) * 0.5, (v[2] / len) * 0.5);
    }
    const indices: number[] = [];
    for (const f of faces) indices.push(f[0], f[1], f[2]);
    return { positions, indices };
}

export function makeUvSphere(segments = 16, rings = 12): MeshData {
    const r = 0.5;
    const positions: number[] = [];
    const indices: number[] = [];

    for (let y = 0; y <= rings; y++) {
        const phi = (y / rings) * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        for (let x = 0; x <= segments; x++) {
            const theta = (x / segments) * 2 * Math.PI;
            positions.push(
                r * sinPhi * Math.cos(theta),
                r * cosPhi,
                r * sinPhi * Math.sin(theta),
            );
        }
    }

    const stride = segments + 1;
    for (let y = 0; y < rings; y++) {
        for (let x = 0; x < segments; x++) {
            const i0 = y * stride + x;
            const i1 = i0 + 1;
            const i2 = i0 + stride;
            const i3 = i2 + 1;
            indices.push(i0, i1, i2, i2, i1, i3);
        }
    }
    return { positions, indices };
}

export function meshEdges(mesh: MeshData): number[] {
    const seen = new Set<string>();
    const out: number[] = [];
    const addEdge = (a: number, b: number): void => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(
            mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2],
            mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2],
        );
    };
    for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = mesh.indices[i];
        const b = mesh.indices[i + 1];
        const c = mesh.indices[i + 2];
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
    }
    return out;
}

export const PRESET_MESHES: Record<string, MeshData> = {
    triangle: makeTriangle(),
    cube: makeCube(),
    icosphere: makeIcosphere(1),
    uvsphere: makeUvSphere(16, 12),
};

/* ── PBR primitives (with normals + UVs) ─────── */

export function makePbrCube(): PbrMeshData {
    const s = 0.5;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const indices: number[] = [];

    const faces: { n: [number, number, number]; verts: [number, number, number][] }[] = [
        { n: [ 0,  0, -1], verts: [[-s, -s, -s], [ s, -s, -s], [ s,  s, -s], [-s,  s, -s]] },
        { n: [ 0,  0,  1], verts: [[ s, -s,  s], [-s, -s,  s], [-s,  s,  s], [ s,  s,  s]] },
        { n: [ 0, -1,  0], verts: [[-s, -s,  s], [ s, -s,  s], [ s, -s, -s], [-s, -s, -s]] },
        { n: [ 0,  1,  0], verts: [[-s,  s, -s], [ s,  s, -s], [ s,  s,  s], [-s,  s,  s]] },
        { n: [-1,  0,  0], verts: [[-s, -s,  s], [-s, -s, -s], [-s,  s, -s], [-s,  s,  s]] },
        { n: [ 1,  0,  0], verts: [[ s, -s, -s], [ s, -s,  s], [ s,  s,  s], [ s,  s, -s]] },
    ];

    const quadUvs = [0, 0, 1, 0, 1, 1, 0, 1];

    for (const face of faces) {
        const base = positions.length / 3;
        for (const v of face.verts) {
            positions.push(...v);
            normals.push(...face.n);
        }
        uvs.push(...quadUvs);
        // tangent = U direction along face
        const tU = [
            face.verts[1][0] - face.verts[0][0],
            face.verts[1][1] - face.verts[0][1],
            face.verts[1][2] - face.verts[0][2],
        ];
        const tLen = Math.hypot(tU[0], tU[1], tU[2]) || 1;
        const tx = tU[0] / tLen;
        const ty = tU[1] / tLen;
        const tz = tU[2] / tLen;
        // same tangent for all 4 vertices of this face
        for (let j = 0; j < 4; j++) {
            tangents.push(tx, ty, tz, 1);
        }
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }

    return { positions, normals, uvs, tangents, indices };
}

export function makePbrIcosphere(subdivisions = 1): PbrMeshData {
    const base = makeIcosphere(subdivisions);
    const vertexCount = base.positions.length / 3;
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];

    for (let i = 0; i < vertexCount; i++) {
        const x = base.positions[i * 3];
        const y = base.positions[i * 3 + 1];
        const z = base.positions[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;
        normals.push(nx, ny, nz);
        uvs.push(
            0.5 + Math.atan2(z, x) / (2 * Math.PI),
            0.5 - Math.asin(y / len) / Math.PI,
        );

        // tangent = cross(up, normal) along latitude
        const tx = -nz;
        const ty = 0;
        const tz = nx;
        const tLen = Math.hypot(tx, ty, tz);
        if (tLen < 1e-6) {
            tangents.push(1, 0, 0, 1);
        } else {
            tangents.push(tx / tLen, ty / tLen, tz / tLen, 1);
        }
    }

    return { positions: base.positions, normals, uvs, tangents, indices: base.indices };
}

export function makePbrUvSphere(segments = 16, rings = 12): PbrMeshData {
    const base = makeUvSphere(segments, rings);
    const vertexCount = base.positions.length / 3;
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const stride = segments + 1;

    for (let i = 0; i < vertexCount; i++) {
        const x = base.positions[i * 3];
        const y = base.positions[i * 3 + 1];
        const z = base.positions[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;
        normals.push(nx, ny, nz);

        const ring = Math.floor(i / stride);
        const seg = i % stride;
        uvs.push(seg / segments, ring / rings);

        const tx = -nz;
        const ty = 0;
        const tz = nx;
        const tLen = Math.hypot(tx, ty, tz);
        if (tLen < 1e-6) {
            tangents.push(1, 0, 0, 1);
        } else {
            tangents.push(tx / tLen, ty / tLen, tz / tLen, 1);
        }
    }

    return { positions: base.positions, normals, uvs, tangents, indices: base.indices };
}

export function makePbrPlane(): PbrMeshData {
    const s = 0.5;
    const positions: number[] = [
        -s, 0,  s,   s, 0,  s,   s, 0, -s,  -s, 0, -s,
    ];
    const normals: number[] = [
        0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    ];
    const uvs: number[] = [0, 0, 1, 0, 1, 1, 0, 1];
    const tangents: number[] = [
        1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
    ];
    const indices: number[] = [0, 1, 2, 0, 2, 3];
    return { positions, normals, uvs, tangents, indices };
}

export const PRESET_PBR_MESHES: Record<string, PbrMeshData> = {
    pbr_cube: makePbrCube(),
    pbr_icosphere: makePbrIcosphere(2),
    pbr_uvsphere: makePbrUvSphere(16, 12),
    pbr_plane: makePbrPlane(),
};

/* ── Data-driven mesh catalog (meshes.json) ──── */

export type MeshGenerator = (params: Record<string, number>) => MeshData | PbrMeshData;

export const meshGenerators: Record<string, MeshGenerator> = {
    triangle: () => makeTriangle(),
    cube: () => makeCube(),
    icosphere: (p) => makeIcosphere(p.subdivisions ?? 1),
    uvsphere: (p) => makeUvSphere(p.segments ?? 16, p.rings ?? 12),
    pbrCube: () => makePbrCube(),
    pbrIcosphere: (p) => makePbrIcosphere(p.subdivisions ?? 2),
    pbrUvSphere: (p) => makePbrUvSphere(p.segments ?? 16, p.rings ?? 12),
    pbrPlane: () => makePbrPlane(),
};

export function isPbrMeshData(data: MeshData | PbrMeshData): data is PbrMeshData {
    return 'tangents' in data && 'normals' in data;
}
