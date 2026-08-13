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
    /** glTF skin index when this node is skinned (references result.skins). */
    skinIndex?: number;
    /** Material fields (merged from the referenced primitive's material). */
    material?: PbrMaterialData;
    /** Texture keys for the material slots that have textures. */
    baseColorTexture?: string;
    metallicRoughnessTexture?: string;
    normalTexture?: string;
    occlusionTexture?: string;
    emissiveTexture?: string;
}

/** Parsed glTF skin (skeleton). Joints reference glTF node indices; the
 *  animation plugin (Phase 4) resolves these to Scene entities via the node
 *  index → entity key map Engine.loadGltf produces. */
export interface GltfSkinData {
    name: string;
    /** Joint node indices (in the glTF node array). */
    joints: number[];
    /** Entity key for each joint (glTF node name → Scene entity key), aligned
     *  with `joints`. The animation plugin resolves these to eids via
     *  scene.entityKeyMap without needing a node-index map. */
    jointNames: string[];
    /** Inverse-bind matrices, one mat4 (16 floats) per joint, column-major. */
    inverseBindMatrices: Float32Array;
    /** Root joint node index, if declared. */
    skeleton?: number;
}

export interface GltfAnimationSampler {
    /** Keyframe times (seconds). */
    input: Float32Array;
    /** Keyframe values, interleaved (output.length = input.length * components). */
    output: Float32Array;
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    /** Components per keyframe: 3 (translation/scale), 4 (rotation), N (weights). */
    components: number;
}

export interface GltfAnimationChannel {
    /** Target node index (in the glTF node array). */
    node: number;
    /** Entity key for the target node (resolved at parse time so the animation
     *  plugin writes Local Transform by key, no node-index map needed). */
    nodeName: string;
    path: 'translation' | 'rotation' | 'scale' | 'weights';
    sampler: number;
}

/** Parsed glTF animation. The animation plugin (Phase 4) samples channels
 *  by time and writes TRS into Skeleton/joint entities. */
export interface GltfAnimationData {
    name: string;
    duration: number;
    channels: GltfAnimationChannel[];
    samplers: GltfAnimationSampler[];
}
