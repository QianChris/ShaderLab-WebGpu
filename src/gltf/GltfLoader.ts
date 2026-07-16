import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Vector3, Quaternion, Texture as ThreeTexture } from 'three';
import type { Mesh, MeshStandardMaterial, BufferGeometry, Object3D } from 'three';
import type { PbrMeshData } from '../render/Primitives';
import type { PbrMaterialData, GltfTextureData, GltfPrimitiveResult, GltfNodeResult } from './GltfTypes';

function extractGeometry(geometry: BufferGeometry): PbrMeshData {
    const posAttr = geometry.getAttribute('position');
    const normAttr = geometry.getAttribute('normal');
    const uvAttr = geometry.getAttribute('uv');
    const tanAttr = geometry.getAttribute('tangent');
    const index = geometry.index;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tangents: number[] = [];
    const indices: number[] = [];

    if (posAttr) {
        positions.push(...posAttr.array);
    }
    if (normAttr) {
        normals.push(...normAttr.array);
    }
    if (uvAttr) {
        uvs.push(...uvAttr.array);
    }
    if (tanAttr) {
        tangents.push(...tanAttr.array);
    } else {
        const vc = posAttr?.count ?? 0;
        for (let i = 0; i < vc; i++) tangents.push(1, 0, 0, 1);
    }
    if (index) {
        indices.push(...index.array);
    } else {
        const vertexCount = posAttr?.count ?? 0;
        for (let i = 0; i < vertexCount; i++) indices.push(i);
    }

    return { positions, normals, uvs, tangents, indices };
}

function debugLogMesh(data: PbrMeshData, name: string): void {
    console.log(`[GLTF] ${name}: pos[0..2]=${data.positions.slice(0, 3)} nrm[0..2]=${data.normals.slice(0, 3)} uv[0..1]=${data.uvs.slice(0, 2)} idx[0..2]=${data.indices.slice(0, 3)}`);
    console.log(`[GLTF] ${name}: uv min/max = (${Math.min(...data.uvs)}, ${Math.max(...data.uvs)})`);
}

function extractMaterial(mat: MeshStandardMaterial): PbrMaterialData {
    return {
        name: mat.name || 'PbrMaterial',
        baseColorFactor: [mat.color.r, mat.color.g, mat.color.b, mat.opacity],
        metallicFactor: mat.metalness,
        roughnessFactor: mat.roughness,
        emissiveFactor: [mat.emissive.r, mat.emissive.g, mat.emissive.b],
        aoStrength: 1.0,
        alphaCutoff: mat.alphaTest,
        alphaMode: mat.transparent ? 'BLEND' : 'OPAQUE',
    };
}

function getTextureImage(tex: ThreeTexture | null): ImageBitmap | HTMLImageElement | HTMLCanvasElement | null {
    if (!tex) return null;
    const img = tex.image;
    if (img instanceof ImageBitmap || img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
        return img;
    }
    return null;
}

export class GltfLoader {
    private loader: GLTFLoader;

    constructor() {
        this.loader = new GLTFLoader();
    }

    async load(url: string): Promise<{
        primitives: GltfPrimitiveResult[];
        nodes: GltfNodeResult[];
        textures: GltfTextureData[];
    }> {
        const gltf = await this.loader.loadAsync(url);
        const primitives: GltfPrimitiveResult[] = [];
        const nodes: GltfNodeResult[] = [];
        const textureMap = new Map<string, GltfTextureData>();
        const textureKeyMap = new Map<ThreeTexture, string>();

        function registerTexture(tex: ThreeTexture | null | undefined, suffix: string, isSRGB: boolean): string | undefined {
            if (!tex) return undefined;
            const existing = textureKeyMap.get(tex);
            if (existing) return existing;
            const img = getTextureImage(tex);
            if (!img) return undefined;
            const key = `gltf_tex_${textureMap.size}_${suffix}`;
            textureKeyMap.set(tex, key);
            textureMap.set(key, { key, image: img, sRGB: isSRGB });
            return key;
        }

        gltf.scene.traverse((obj: Object3D) => {
            const mesh = obj as Mesh;
            if (!mesh.isMesh) return;

            const geometry = mesh.geometry as BufferGeometry;
            const material = mesh.material as MeshStandardMaterial;

            const meshData = extractGeometry(geometry);
            const matData = extractMaterial(material);
            const matName = mesh.name || matData.name || `mesh_${primitives.length}`;
            debugLogMesh(meshData, matName);

            const tc = registerTexture(material.map, 'baseColor', true);
            const tm = registerTexture(material.roughnessMap || material.metalnessMap, 'metalRough', false);
            const tn = registerTexture(material.normalMap, 'normal', false);
            const to = registerTexture(material.aoMap, 'occlusion', false);
            const te = registerTexture(material.emissiveMap, 'emissive', true);

            primitives.push({
                name: matName,
                meshData,
                material: matData,
                baseColorTexture: tc,
                metallicRoughnessTexture: tm,
                normalTexture: tn,
                occlusionTexture: to,
                emissiveTexture: te,
            });

            const wPos = new Vector3();
            const wQuat = new Quaternion();
            const wScale = new Vector3();
            mesh.getWorldPosition(wPos);
            mesh.getWorldQuaternion(wQuat);
            mesh.getWorldScale(wScale);

            nodes.push({
                name: obj.name || matName,
                transform: {
                    position: [wPos.x, wPos.y, wPos.z],
                    rotation: [wQuat.x, wQuat.y, wQuat.z, wQuat.w],
                    scale: [wScale.x, wScale.y, wScale.z],
                },
                meshName: matName,
            });
        });

        return { primitives, nodes, textures: [...textureMap.values()] };
    }
}
