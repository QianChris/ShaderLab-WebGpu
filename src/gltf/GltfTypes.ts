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

export interface GltfNodeResult {
    name: string;
    transform: {
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
    };
    meshName: string;
}
