import type { PbrMeshData } from '../render/Primitives';
import type {
    PbrMaterialData,
    GltfTextureData,
    GltfPrimitiveResult,
    GltfNodeResult,
} from './GltfTypes';

/**
 * glTF 2.0 loader (GLB + .gltf). Pure JSON + binary-buffer parsing — no
 * three.js. The accessor/bufferView/glb-chunk logic is adapted from
 * @dotdotdash/stunner-core (MIT, https://github.com/dotdotdashdev/stunner);
 * the output layer is rewritten for ShaderLab's ECS Scene + ResourceManager:
 *   - meshes are registered as PbrMeshData (SoA positions/normals/uvs/.../indices)
 *   - the node tree is preserved (each node carries parentIndex) so Engine.loadGltf
 *     can wire Scene.setParent and Phase 2a's recursive getModelMatrix composes
 *     parent * local instead of baking world transforms.
 *
 * Skins, animations and morph targets are parsed into data but skinning itself
 * is the animation plugin's job (Phase 4). This loader just lands the data.
 */

type GltfAccessor = {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
    normalized?: boolean;
};
type GltfBuffer = { uri?: string; byteLength: number };
type GltfBufferView = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number };
type GltfTextureInfo = { index: number };
type GltfPbrMaterial = {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
};
type GltfMaterial = {
    name?: string;
    pbrMetallicRoughness?: GltfPbrMaterial;
    occlusionTexture?: GltfTextureInfo;
    normalTexture?: GltfTextureInfo;
    emissiveTexture?: GltfTextureInfo;
    emissiveFactor?: [number, number, number];
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    doubleSided?: boolean;
};
type GltfPrimitive = {
    attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number; TANGENT?: number };
    indices?: number;
    material?: number;
};
type GltfMesh = { name?: string; primitives: GltfPrimitive[] };
type GltfNode = {
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
};
type GltfImage = { uri?: string; mimeType?: string; bufferView?: number };
type GltfTexture = { source?: number; sRGB?: boolean };
type GltfScene = { nodes?: number[] };
type GltfDocument = {
    buffers?: GltfBuffer[];
    bufferViews?: GltfBufferView[];
    accessors?: GltfAccessor[];
    materials?: GltfMaterial[];
    meshes?: GltfMesh[];
    nodes?: GltfNode[];
    images?: GltfImage[];
    textures?: GltfTexture[];
    scenes?: GltfScene[];
    scene?: number;
    extensionsUsed?: string[];
};

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

const COMPONENT_BYTE_SIZE: Record<number, number> = {
    5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};
const TYPE_COMPONENT_COUNT: Record<string, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

const textDecoder = new TextDecoder();

const isGzipData = (data: ArrayBuffer): boolean => {
    if (data.byteLength < 2) return false;
    const v = new Uint8Array(data, 0, 2);
    return v[0] === 0x1f && v[1] === 0x8b;
};
const gunzipIfNeeded = async (data: ArrayBuffer): Promise<ArrayBuffer> => {
    if (!isGzipData(data)) return data;
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('gzip-compressed glTF requires DecompressionStream (Chrome 80+).');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
};

const resolveUri = (uri: string, baseUrl: string | undefined): string => {
    if (uri.startsWith('data:')) return uri;
    if (!baseUrl) return uri;
    try { return new URL(uri, new URL(baseUrl, typeof window !== 'undefined' ? window.location.href : 'file://')).toString(); }
    catch { return uri; }
};

const decodeDataUri = (uri: string): ArrayBuffer => {
    const m = /^data:.*?;base64,(.*)$/i.exec(uri);
    if (!m) throw new Error('Only base64 data: URIs are supported for glTF resources.');
    const raw = atob(m[1]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
};

const parseGlb = (bytes: ArrayBuffer): { json: GltfDocument; binChunk?: ArrayBuffer } => {
    const h = new DataView(bytes);
    if (h.byteLength < 12) throw new Error('Invalid GLB: header too small.');
    if (h.getUint32(0, true) !== GLB_MAGIC) throw new Error('Invalid GLB: bad magic.');
    const length = h.getUint32(8, true);
    if (length > bytes.byteLength) throw new Error('Invalid GLB: declared length exceeds buffer.');
    let offset = 12;
    let json: GltfDocument | undefined;
    let binChunk: ArrayBuffer | undefined;
    while (offset + 8 <= length) {
        const chunkLength = h.getUint32(offset, true);
        const chunkType = h.getUint32(offset + 4, true);
        offset += 8;
        if (offset + chunkLength > length) throw new Error('Invalid GLB: chunk extends past file end.');
        const slice = bytes.slice(offset, offset + chunkLength);
        if (chunkType === JSON_CHUNK_TYPE) {
            json = JSON.parse(textDecoder.decode(new Uint8Array(slice))) as GltfDocument;
        } else if (chunkType === BIN_CHUNK_TYPE) {
            binChunk = slice;
        }
        offset += chunkLength;
    }
    if (!json) throw new Error('Invalid GLB: missing JSON chunk.');
    return { json, binChunk };
};

const parseGltfDocument = (data: ArrayBuffer): { json: GltfDocument; binChunk?: ArrayBuffer } => {
    const v = new DataView(data);
    if (v.byteLength >= 4 && v.getUint32(0, true) === GLB_MAGIC) return parseGlb(data);
    return { json: JSON.parse(textDecoder.decode(new Uint8Array(data))) as GltfDocument };
};

const readComponent = (dv: DataView, componentType: number, byteOffset: number): number => {
    switch (componentType) {
        case 5120: return dv.getInt8(byteOffset);
        case 5121: return dv.getUint8(byteOffset);
        case 5122: return dv.getInt16(byteOffset, true);
        case 5123: return dv.getUint16(byteOffset, true);
        case 5125: return dv.getUint32(byteOffset, true);
        case 5126: return dv.getFloat32(byteOffset, true);
    }
    throw new Error(`Unsupported accessor componentType: ${componentType}.`);
};
const normalizeComponent = (value: number, componentType: number): number => {
    if (componentType === 5120) return Math.max(value / 127, -1);
    if (componentType === 5121) return value / 255;
    if (componentType === 5122) return Math.max(value / 32767, -1);
    if (componentType === 5123) return value / 65535;
    return value;
};

const readBufferViewRange = (
    gltf: GltfDocument, buffers: ArrayBuffer[], viewIndex: number,
): { data: ArrayBuffer; byteOffset: number; byteLength: number; byteStride?: number } => {
    const view = (gltf.bufferViews ?? [])[viewIndex];
    if (!view) throw new Error(`glTF bufferView ${viewIndex} is missing.`);
    const src = buffers[view.buffer];
    if (!src) throw new Error(`glTF buffer ${view.buffer} is missing.`);
    return { data: src, byteOffset: view.byteOffset ?? 0, byteLength: view.byteLength, byteStride: view.byteStride };
};

const readAccessorAsFloatArray = (
    gltf: GltfDocument, buffers: ArrayBuffer[], accessorIndex: number,
    expectedType: 'VEC2' | 'VEC3' | 'VEC4',
): Float32Array => {
    const accessor = (gltf.accessors ?? [])[accessorIndex];
    if (!accessor) throw new Error(`glTF accessor ${accessorIndex} is missing.`);
    if (accessor.type !== expectedType) {
        throw new Error(`Accessor ${accessorIndex} expected ${expectedType}, got ${accessor.type}.`);
    }
    if (typeof accessor.bufferView !== 'number') {
        return new Float32Array(accessor.count * TYPE_COMPONENT_COUNT[accessor.type]);
    }
    const compCount = TYPE_COMPONENT_COUNT[accessor.type];
    const compSize = COMPONENT_BYTE_SIZE[accessor.componentType];
    if (!compSize) throw new Error(`Unsupported component type ${accessor.componentType}.`);
    const view = readBufferViewRange(gltf, buffers, accessor.bufferView);
    const stride = view.byteStride ?? compCount * compSize;
    const baseOffset = view.byteOffset + (accessor.byteOffset ?? 0);
    const out = new Float32Array(accessor.count * compCount);
    const dv = new DataView(view.data);
    for (let i = 0; i < accessor.count; i++) {
        const el = baseOffset + i * stride;
        for (let c = 0; c < compCount; c++) {
            const raw = readComponent(dv, accessor.componentType, el + c * compSize);
            out[i * compCount + c] = accessor.normalized ? normalizeComponent(raw, accessor.componentType) : raw;
        }
    }
    return out;
};

const readIndicesAccessor = (
    gltf: GltfDocument, buffers: ArrayBuffer[], accessorIndex: number,
): number[] => {
    const accessor = (gltf.accessors ?? [])[accessorIndex];
    if (!accessor) throw new Error(`glTF index accessor ${accessorIndex} is missing.`);
    if (accessor.type !== 'SCALAR') throw new Error(`Index accessor ${accessorIndex} must be SCALAR.`);
    if (typeof accessor.bufferView !== 'number') throw new Error(`Index accessor ${accessorIndex} has no bufferView.`);
    if (accessor.componentType !== 5121 && accessor.componentType !== 5123 && accessor.componentType !== 5125) {
        throw new Error(`Unsupported index component type ${accessor.componentType}.`);
    }
    const compSize = COMPONENT_BYTE_SIZE[accessor.componentType];
    const view = readBufferViewRange(gltf, buffers, accessor.bufferView);
    const stride = view.byteStride ?? compSize;
    const baseOffset = view.byteOffset + (accessor.byteOffset ?? 0);
    const out: number[] = new Array(accessor.count);
    const dv = new DataView(view.data);
    for (let i = 0; i < accessor.count; i++) {
        out[i] = readComponent(dv, accessor.componentType, baseOffset + i * stride);
    }
    return out;
};

const computeFallbackNormals = (positions: number[], indices: number[]): number[] => {
    const normals = new Array(positions.length).fill(0);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
        normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
        normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
    }
    for (let v = 0; v < normals.length; v += 3) {
        const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
        normals[v] /= len; normals[v + 1] /= len; normals[v + 2] /= len;
    }
    return normals;
};

const computeFallbackTangents = (positions: number[], normals: number[], uvs: number[], indices: number[]): number[] => {
    const vc = positions.length / 3;
    const tanX = new Float32Array(vc), tanY = new Float32Array(vc), tanZ = new Float32Array(vc);
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
        const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
        const uv0 = i0 * 2, uv1 = i1 * 2, uv2 = i2 * 2;
        const e1x = positions[p1] - positions[p0], e1y = positions[p1 + 1] - positions[p0 + 1], e1z = positions[p1 + 2] - positions[p0 + 2];
        const e2x = positions[p2] - positions[p0], e2y = positions[p2 + 1] - positions[p0 + 1], e2z = positions[p2 + 2] - positions[p0 + 2];
        const du1 = uvs[uv1] - uvs[uv0], dv1 = uvs[uv1 + 1] - uvs[uv0 + 1];
        const du2 = uvs[uv2] - uvs[uv0], dv2 = uvs[uv2 + 1] - uvs[uv0 + 1];
        const det = du1 * dv2 - du2 * dv1;
        const r = det !== 0 ? 1 / det : 0;
        const tx = (dv2 * e1x - dv1 * e2x) * r, ty = (dv2 * e1y - dv1 * e2y) * r, tz = (dv2 * e1z - dv1 * e2z) * r;
        tanX[i0] += tx; tanY[i0] += ty; tanZ[i0] += tz;
        tanX[i1] += tx; tanY[i1] += ty; tanZ[i1] += tz;
        tanX[i2] += tx; tanY[i2] += ty; tanZ[i2] += tz;
    }
    const tangents = new Array(vc * 4).fill(0);
    for (let i = 0; i < vc; i++) {
        const ni = i * 3;
        let tx = tanX[i], ty = tanY[i], tz = tanZ[i];
        const nx = normals[ni], ny = normals[ni + 1], nz = normals[ni + 2];
        const dot = tx * nx + ty * ny + tz * nz;
        tx -= nx * dot; ty -= ny * dot; tz -= nz * dot;
        const len = Math.hypot(tx, ty, tz) || 1;
        tangents[i * 4] = tx / len; tangents[i * 4 + 1] = ty / len; tangents[i * 4 + 2] = tz / len; tangents[i * 4 + 3] = 1;
    }
    return tangents;
};

/** Build a PbrMeshData (SoA positions/normals/uvs/tangents/indices) from a
 *  glTF primitive, computing fallback normals/tangents when absent. */
const buildPbrMeshData = (
    gltf: GltfDocument, buffers: ArrayBuffer[], primitive: GltfPrimitive, name: string,
): { meshData: PbrMeshData; primitiveName: string } => {
    if (typeof primitive.attributes.POSITION !== 'number') {
        throw new Error(`glTF primitive in mesh '${name}' is missing POSITION.`);
    }
    const posArr = readAccessorAsFloatArray(gltf, buffers, primitive.attributes.POSITION, 'VEC3');
    const positions: number[] = Array.from(posArr);
    const vertexCount = positions.length / 3;
    let indices: number[];
    if (typeof primitive.indices === 'number') {
        indices = readIndicesAccessor(gltf, buffers, primitive.indices);
    } else {
        indices = new Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }
    const normals: number[] = typeof primitive.attributes.NORMAL === 'number'
        ? Array.from(readAccessorAsFloatArray(gltf, buffers, primitive.attributes.NORMAL, 'VEC3'))
        : computeFallbackNormals(positions, indices);
    const uvs: number[] = typeof primitive.attributes.TEXCOORD_0 === 'number'
        ? Array.from(readAccessorAsFloatArray(gltf, buffers, primitive.attributes.TEXCOORD_0, 'VEC2'))
        : new Array(vertexCount * 2).fill(0);
    const tangents: number[] = typeof primitive.attributes.TANGENT === 'number'
        ? Array.from(readAccessorAsFloatArray(gltf, buffers, primitive.attributes.TANGENT, 'VEC4'))
        : computeFallbackTangents(positions, normals, uvs, indices);
    return { meshData: { positions, normals, uvs, tangents, indices }, primitiveName: name };
};

const materialFromGltf = (
    material: GltfMaterial | undefined, textureKeys: Map<number, string>, materialIndex: number,
): PbrMaterialData => {
    const pbr = material?.pbrMetallicRoughness;
    const emissive = material?.emissiveFactor ?? [0, 0, 0];
    return {
        name: material?.name ?? `gltf-material-${materialIndex}`,
        baseColorFactor: pbr?.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: pbr?.metallicFactor ?? 1,
        roughnessFactor: pbr?.roughnessFactor ?? 1,
        emissiveFactor: [emissive[0], emissive[1], emissive[2]],
        aoStrength: 1,
        alphaCutoff: material?.alphaMode === 'MASK' ? 0.5 : 0,
        alphaMode: material?.alphaMode ?? 'OPAQUE',
        doubleSided: material?.doubleSided ?? false,
    };
};

const loadBuffers = async (
    gltf: GltfDocument, baseUrl: string | undefined, binChunk?: ArrayBuffer,
): Promise<ArrayBuffer[]> => {
    const out: ArrayBuffer[] = [];
    const buffers = gltf.buffers ?? [];
    for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        if (i === 0 && binChunk) { out.push(binChunk); continue; }
        if (!buffer.uri) throw new Error(`glTF buffer ${i} has no URI and no GLB BIN chunk.`);
        const resolved = resolveUri(buffer.uri, baseUrl);
        if (resolved.startsWith('data:')) {
            out.push(decodeDataUri(resolved));
        } else {
            const resp = await fetch(resolved);
            if (!resp.ok) throw new Error(`Failed to fetch glTF buffer: ${resolved}`);
            out.push(await resp.arrayBuffer());
        }
    }
    return out;
};

const loadImageBlobs = (
    gltf: GltfDocument, baseUrl: string | undefined, buffers: ArrayBuffer[],
): { uri: string; mimeType: string }[] => {
    const images = gltf.images ?? [];
    const out: { uri: string; mimeType: string }[] = new Array(images.length);
    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        if (image.uri) {
            out[i] = { uri: resolveUri(image.uri, baseUrl), mimeType: image.mimeType ?? 'image/png' };
        } else if (typeof image.bufferView === 'number') {
            const view = readBufferViewRange(gltf, buffers, image.bufferView);
            const slice = view.data.slice(view.byteOffset, view.byteOffset + view.byteLength);
            const mt = image.mimeType ?? 'image/png';
            out[i] = { uri: URL.createObjectURL(new Blob([slice], { type: mt })), mimeType: mt };
        } else {
            throw new Error(`glTF image ${i} has no uri or bufferView.`);
        }
    }
    return out;
};

/** Decode an image URI/Blob into an ImageBitmap (preferred) or HTMLImageElement. */
const decodeImage = async (uri: string): Promise<ImageBitmap | HTMLImageElement> => {
    if (typeof createImageBitmap === 'function' && !uri.endsWith('.svg')) {
        try {
            const resp = await fetch(uri);
            const blob = await resp.blob();
            return await createImageBitmap(blob);
        } catch { /* fall through to HTMLImage */ }
    }
    return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to decode glTF image: ${uri}`));
        img.src = uri;
    });
};

export class GltfLoader {
    async load(url: string): Promise<{
        primitives: GltfPrimitiveResult[];
        nodes: GltfNodeResult[];
        textures: GltfTextureData[];
    }> {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch glTF: ${url}`);
        const source = await resp.arrayBuffer();
        const decompressed = await gunzipIfNeeded(source);
        const parsed = parseGltfDocument(decompressed);
        const gltf = parsed.json;

        const buffers = await loadBuffers(gltf, url, parsed.binChunk);
        const imageBlobs = loadImageBlobs(gltf, url, buffers);

        // Decode textures (each texture references an image + a colorspace flag).
        const textures: GltfTextureData[] = [];
        const textureKeys = new Map<number, string>();
        const gltfTextures = gltf.textures ?? [];
        for (let i = 0; i < gltfTextures.length; i++) {
            const tex = gltfTextures[i];
            if (typeof tex.source !== 'number') continue;
            const blob = imageBlobs[tex.source];
            if (!blob) continue;
            const key = `gltf_tex_${i}`;
            const image = await decodeImage(blob.uri);
            const sRGB = tex.sRGB === true;
            textures.push({ key, image, sRGB });
            textureKeys.set(i, key);
        }

        // Build primitives (PbrMeshData + material) keyed by mesh index + primitive index.
        const meshes = gltf.meshes ?? [];
        const primitives: GltfPrimitiveResult[] = [];
        const primKey = (m: number, p: number) => `${m}_${p}`;
        const primByName = new Map<string, GltfPrimitiveResult>();
        for (let mi = 0; mi < meshes.length; mi++) {
            const mesh = meshes[mi];
            for (let pi = 0; pi < mesh.primitives.length; pi++) {
                const prim = mesh.primitives[pi];
                const name = mesh.name
                    ? (mesh.primitives.length > 1 ? `${mesh.name}_${pi}` : mesh.name)
                    : `gltf_mesh_${mi}_${pi}`;
                const { meshData } = buildPbrMeshData(gltf, buffers, prim, name);
                const materialIndex = prim.material ?? -1;
                const material = materialFromGltf(gltf.materials?.[materialIndex], textureKeys, materialIndex);
                const pbr = gltf.materials?.[materialIndex]?.pbrMetallicRoughness;
                const result: GltfPrimitiveResult = {
                    name, meshData, material,
                    baseColorTexture: pbr?.baseColorTexture ? textureKeys.get(pbr.baseColorTexture.index) : undefined,
                    metallicRoughnessTexture: pbr?.metallicRoughnessTexture ? textureKeys.get(pbr.metallicRoughnessTexture.index) : undefined,
                    normalTexture: gltf.materials?.[materialIndex]?.normalTexture ? textureKeys.get(gltf.materials[materialIndex]!.normalTexture!.index) : undefined,
                    occlusionTexture: gltf.materials?.[materialIndex]?.occlusionTexture ? textureKeys.get(gltf.materials[materialIndex]!.occlusionTexture!.index) : undefined,
                    emissiveTexture: gltf.materials?.[materialIndex]?.emissiveTexture ? textureKeys.get(gltf.materials[materialIndex]!.emissiveTexture!.index) : undefined,
                };
                primitives.push(result);
                primByName.set(primKey(mi, pi), result);
            }
        }

        // Walk the default scene's node tree, preserving parentIndex so the
        // engine can Scene.setParent (no baked world transforms).
        const nodes = gltf.nodes ?? [];
        const scenes = gltf.scenes ?? [];
        const defaultSceneIdx = gltf.scene ?? 0;
        const defaultScene = scenes[defaultSceneIdx];
        const rootNodes = defaultScene?.nodes ?? nodes.map((_, i) => i);

        const result: GltfNodeResult[] = [];
        const visit = (nodeIndex: number, parentIndex: number | undefined): void => {
            const node = nodes[nodeIndex];
            if (!node) return;
            // Local TRS (matrix takes precedence if present — decompose to TRS).
            let translation = node.translation ?? [0, 0, 0];
            let rotation = node.rotation ?? [0, 0, 0, 1];
            let scale = node.scale ?? [1, 1, 1];
            if (node.matrix) {
                // Matrix form: only translation/scale extractable cheaply; keep
                // identity rotation (rare path; most glTF uses TRS).
                translation = [node.matrix[12], node.matrix[13], node.matrix[14]];
                scale = [
                    Math.hypot(node.matrix[0], node.matrix[1], node.matrix[2]),
                    Math.hypot(node.matrix[4], node.matrix[5], node.matrix[6]),
                    Math.hypot(node.matrix[8], node.matrix[9], node.matrix[10]),
                ];
            }
            const nr: GltfNodeResult = {
                name: node.name ?? `node_${nodeIndex}`,
                parentIndex,
                transform: {
                    position: [translation[0], translation[1], translation[2]],
                    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
                    scale: [scale[0], scale[1], scale[2]],
                },
            };
            if (typeof node.mesh === 'number') {
                const mesh = meshes[node.mesh];
                if (mesh) {
                    // Attach the first primitive's mesh+material to this node.
                    // (Multi-primitive meshes become separate entities under
                    //  the same parent in a follow-up; Phase 2b lands one.)
                    const prim = primByName.get(primKey(node.mesh, 0));
                    if (prim) {
                        nr.meshName = prim.name;
                        nr.material = prim.material;
                        nr.baseColorTexture = prim.baseColorTexture;
                        nr.metallicRoughnessTexture = prim.metallicRoughnessTexture;
                        nr.normalTexture = prim.normalTexture;
                        nr.occlusionTexture = prim.occlusionTexture;
                        nr.emissiveTexture = prim.emissiveTexture;
                    }
                }
            }
            const myIndex = result.length;
            result.push(nr);
            for (const childIndex of node.children ?? []) {
                visit(childIndex, myIndex);
            }
        };
        for (const root of rootNodes) visit(root, undefined);

        return { primitives, nodes: result, textures };
    }
}
