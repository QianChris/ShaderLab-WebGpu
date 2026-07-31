/**
 * Minimal WebGPU global polyfill for Node test environment.
 * Only defines the constants referenced at module scope by engine source.
 * Actual GPU operations are mocked in tests/mocks/gpu.ts.
 */
const GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
} as const;

const GPUTextureUsage = {
    COPY_SRC: 0x0001,
    COPY_DST: 0x0002,
    TEXTURE_BINDING: 0x0008,
    STORAGE_BINDING: 0x0010,
    RENDER_ATTACHMENT: 0x0020,
} as const;

const GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
} as const;

(globalThis as Record<string, unknown>).GPUBufferUsage = GPUBufferUsage;
(globalThis as Record<string, unknown>).GPUTextureUsage = GPUTextureUsage;
(globalThis as Record<string, unknown>).GPUShaderStage = GPUShaderStage;
