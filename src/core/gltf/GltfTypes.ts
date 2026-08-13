import type { PbrMeshData } from '../render/Primitives';

export interface PbrMaterialData {
    name: string;
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
    emissiveFactor: [number, number, number];
    aoStrength: number;
    alphaCutoff: number;
    alphaMode: string;
    doubleSided: boolean;
}

export interface GltfTextureData {
    key: string;
    image: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
    sRGB: boolean;
}

export interface GltfPrimitiveResult {
    name: string;
    meshData: PbrMeshData;
    material: PbrMaterialData;
    baseColorTexture?: string;
    metallicRoughnessTexture?: string;
    normalTexture?: string;
    occlusionTexture?: string;
    emissiveTexture?: string;
}

export interface GltfNodeTransform {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
}

export interface GltfNodeResult {
    name: string;
    /** Parent node index in the loaded glTF node array, or undefined for a
     *  root node. Engine.loadGltf uses this to wire Scene.setParent so the
     *  node hierarchy survives (Phase 2a's recursive getModelMatrix composes
     *  parent * local instead of baking world transforms). */
    parentIndex?: number;
    transform: GltfNodeTransform;
    /** Mesh name (ResourceManager key) when this node attaches a mesh. */
    meshName?: string;
    /** Material fields (merged from the referenced primitive's material). */
    material?: PbrMaterialData;
    /** Texture keys for the material slots that have textures. */
    baseColorTexture?: string;
    metallicRoughnessTexture?: string;
    normalTexture?: string;
    occlusionTexture?: string;
    emissiveTexture?: string;
}
