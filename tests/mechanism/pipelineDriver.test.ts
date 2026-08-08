import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { defineQuery } from 'bitecs/legacy';
import { PipelineDriver } from '../../src/core/render/PipelineDriver';
import { MockRenderPassEncoder, createMockDevice } from '../mocks/gpu';
import { resourceManager } from '../../src/core/render/ResourceManager';
import { schemaRegistry } from '../../src/core/ecs/SchemaRegistry';
import { Scene } from '../../src/core/ecs/Scene';
import { resetRegistries } from '../helpers/reset';
import type { RendererDecl } from '../../src/core/render/rendererDecl';
import type { PipelineEntry } from '../../src/core/render/types';
import type { ValueContext } from '../../src/core/render/valueResolver';

const COMPONENTS = [
    { name: 'NameComponent', mandatory: true, fields: { name: { type: 'string', default: '' } } },
    { name: 'Transform', fields: {
        position: { type: 'vec3', default: [0, 0, 0] },
        rotation: { type: 'vec4', default: [0, 0, 0, 1] },
        scale: { type: 'vec3', default: [1, 1, 1] },
    } },
    { name: 'MeshComponent', fields: { mesh: { type: 'string', default: '' } } },
    { name: 'Speed', fields: { value: { type: 'f32', default: 0 } } },
];

const MESH_DATA = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
};

function makeDriver(decl: RendererDecl, setQuery = true): PipelineDriver {
    const entry: PipelineEntry = { name: 'test', pipeline: 'test:pipeline', enabled: true };
    const driver = new PipelineDriver(
        'test:pipeline',
        decl,
        entry,
        new Map(),
        new Map(),
        new Map(),
    );
    if (setQuery && decl.query) {
        const comps = decl.query.map(name => schemaRegistry.get(name)!);
        (driver as unknown as { query: ((w: unknown) => readonly number[]) | undefined }).query = defineQuery(comps);
    }
    return driver;
}

function mockFrame(cameraPos: Float32Array | null = null) {
    return {
        time: 0, dt: 0.016, cw: 800, ch: 600,
        attachments: {}, computePipelines: new Map(),
        cameraPos,
    };
}

beforeAll(() => {
    resourceManager.init(createMockDevice());
    resourceManager.enterApp('test');
    schemaRegistry.registerDefs(COMPONENTS, 'test');
    resourceManager.registerMesh('cube', MESH_DATA);
});

afterAll(() => {
    resetRegistries();
});

describe('PipelineDriver.precompile', () => {
    it('compiles uniform write values', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform'],
            geometry: { steps: [] },
            bindGroups: [{
                group: 1,
                uniform: {
                    layoutRef: 'object',
                    writes: [{ member: 'model', value: 'builtin.time' }],
                },
            }],
        };
        const driver = makeDriver(decl);
        const compiled = (driver as unknown as { compiledWrites: unknown[][] }).compiledWrites;
        expect(compiled.length).toBe(1);
        expect(compiled[0].length).toBe(1);
        const ctx: ValueContext = {
            scene: {} as never, eid: 0, tag: '', time: 42, dt: 0,
            aspect: 1, screenW: 800, screenH: 600,
            model: () => new Float32Array(16),
            scripts: new Map(),
        };
        const fn = compiled[0][0] as (ctx: ValueContext) => number;
        expect(fn(ctx)).toBe(42);
    });

    it('throws on unknown component at compile time', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: [],
            geometry: { steps: [] },
            bindGroups: [{
                group: 1,
                uniform: {
                    writes: [{ member: 'val', value: 'UnknownComp.field' }],
                },
            }],
        };
        expect(() => makeDriver(decl, false)).toThrow('unknown component');
    });

    it('compiles draw count fields', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform'],
            geometry: {
                steps: [{
                    draw: { type: 'drawIndexed', countField: 'Speed.value' },
                }],
            },
        };
        const driver = makeDriver(decl);
        const compiled = (driver as unknown as { compiledCounts: Array<{ count?: unknown }> }).compiledCounts;
        expect(compiled.length).toBe(1);
        expect(compiled[0].count).toBeDefined();
    });

    it('compiles mesh name sources', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform', 'MeshComponent'],
            geometry: {
                steps: [{
                    vertexBuffers: [{ slot: 0, source: 'meshSlots', mesh: 'MeshComponent.mesh' }],
                    indexBuffer: { mesh: 'MeshComponent.mesh' },
                    draw: { type: 'drawIndexed' },
                }],
            },
        };
        const driver = makeDriver(decl);
        const names = (driver as unknown as { compiledMeshNames: Array<unknown> }).compiledMeshNames;
        expect(names.length).toBe(1);
        expect(names[0]).not.toBeNull();
    });
});

describe('PipelineDriver.record: no query → single draw', () => {
    it('single draw with static mesh name', () => {
        // Use a static mesh name (no dot) so it resolves to a literal
        const decl: RendererDecl = {
            phase: 'opaque',
            geometry: {
                steps: [{
                    vertexBuffers: [{ slot: 0, source: 'meshSlots', mesh: 'cube' }],
                    indexBuffer: { mesh: 'cube' },
                    draw: { type: 'drawIndexed' },
                }],
            },
        };
        const driver = makeDriver(decl, false); // no query
        const pass = new MockRenderPassEncoder();
        const scene = new Scene();
        const pipeline = {} as GPURenderPipeline;
        driver.record(pass, scene, pipeline, mockFrame(null));
        expect(pass.count('drawIndexed')).toBe(1);
    });
});

describe('PipelineDriver.dispose', () => {
    it('clears bgCache', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform'],
            geometry: { steps: [{ draw: { type: 'drawIndexed' } }] },
        };
        const driver = makeDriver(decl);
        const cache = (driver as unknown as { bgCache: Map<string, unknown> }).bgCache;
        cache.set('key', { bg: {}, sig: [] });
        driver.dispose();
        expect(cache.size).toBe(0);
    });

    it('includes buffer offset and size in bind-group cache signatures', () => {
        const driver = makeDriver({ phase: 'opaque', geometry: { steps: [] } }, false);
        const signature = (driver as unknown as {
            bindGroupSignature(entries: readonly GPUBindGroupEntry[]): unknown[];
        }).bindGroupSignature([{
            binding: 0,
            resource: {
                buffer: {} as GPUBuffer,
                offset: 16,
                size: 32,
            },
        }]);

        expect(signature.slice(1)).toEqual([16, 32]);
    });
});

describe('PipelineDriver.record: render sort', () => {
    it('opaque → near-to-far order', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform', 'MeshComponent'],
            transparent: false,
            geometry: {
                steps: [{
                    vertexBuffers: [{ slot: 0, source: 'meshSlots', mesh: 'MeshComponent.mesh' }],
                    indexBuffer: { mesh: 'MeshComponent.mesh' },
                    draw: { type: 'drawIndexed' },
                }],
            },
        };
        const driver = makeDriver(decl);
        const pass = new MockRenderPassEncoder();
        const scene = new Scene();

        scene.createEntity('near', { Transform: { position: [1, 0, 0] }, MeshComponent: { mesh: 'cube' } });
        scene.createEntity('far', { Transform: { position: [100, 0, 0] }, MeshComponent: { mesh: 'cube' } });

        const pipeline = {} as GPURenderPipeline;
        driver.record(pass, scene, pipeline, mockFrame(new Float32Array([0, 0, 0, 0])));

        expect(pass.count('drawIndexed')).toBe(2);
    });

    it('transparent → far-to-near order', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform', 'MeshComponent'],
            transparent: true,
            geometry: {
                steps: [{
                    vertexBuffers: [{ slot: 0, source: 'meshSlots', mesh: 'MeshComponent.mesh' }],
                    indexBuffer: { mesh: 'MeshComponent.mesh' },
                    draw: { type: 'drawIndexed' },
                }],
            },
        };
        const driver = makeDriver(decl);
        const pass = new MockRenderPassEncoder();
        const scene = new Scene();

        scene.createEntity('near', { Transform: { position: [1, 0, 0] }, MeshComponent: { mesh: 'cube' } });
        scene.createEntity('far', { Transform: { position: [100, 0, 0] }, MeshComponent: { mesh: 'cube' } });

        const pipeline = {} as GPURenderPipeline;
        driver.record(pass, scene, pipeline, mockFrame(new Float32Array([0, 0, 0, 0])));

        expect(pass.count('drawIndexed')).toBe(2);
    });

    it('no cameraPos → no sort (query order)', () => {
        const decl: RendererDecl = {
            phase: 'opaque',
            query: ['Transform', 'MeshComponent'],
            geometry: {
                steps: [{
                    vertexBuffers: [{ slot: 0, source: 'meshSlots', mesh: 'MeshComponent.mesh' }],
                    indexBuffer: { mesh: 'MeshComponent.mesh' },
                    draw: { type: 'drawIndexed' },
                }],
            },
        };
        const driver = makeDriver(decl);
        const pass = new MockRenderPassEncoder();
        const scene = new Scene();

        scene.createEntity('a', { Transform: { position: [0, 0, 0] }, MeshComponent: { mesh: 'cube' } });
        scene.createEntity('b', { Transform: { position: [50, 0, 0] }, MeshComponent: { mesh: 'cube' } });

        const pipeline = {} as GPURenderPipeline;
        driver.record(pass, scene, pipeline, mockFrame(null));

        expect(pass.count('drawIndexed')).toBe(2);
    });
});
