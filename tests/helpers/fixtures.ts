import type { RendererDecl } from '../../src/render/rendererDecl';
import type { RenderGraphData } from '../../src/render/types';

/** A minimal RendererDecl with a query, one bind group (object uniform), and one draw step. */
export const SIMPLE_RENDERER_DECL: RendererDecl = {
    phase: 'opaque',
    query: ['Transform', 'MeshComponent'],
    target: { color: 'scene', depth: 'sceneDepth' },
    bindGroups: [
        {
            group: 1,
            uniform: {
                layoutRef: 'object',
                binding: 0,
                writes: [{ member: 'model', value: 'transform.model' }],
            },
        },
    ],
    geometry: {
        steps: [
            {
                vertexBuffers: [{ slot: 0, source: 'meshSlots' }],
                indexBuffer: { mesh: 'MeshComponent.mesh' },
                draw: { type: 'drawIndexed' },
            },
        ],
    },
};

/** A transparent variant (same as SIMPLE but with transparent: true). */
export const TRANSPARENT_RENDERER_DECL: RendererDecl = {
    ...SIMPLE_RENDERER_DECL,
    transparent: true,
};

/** An instanced variant. */
export const INSTANCED_RENDERER_DECL: RendererDecl = {
    ...SIMPLE_RENDERER_DECL,
    instanced: true,
};

/** Minimal RenderGraphData for fromData/toData round-trip tests. */
export const SIMPLE_RENDER_DATA: RenderGraphData = {
    name: 'test',
    clearColor: [0.1, 0.2, 0.3, 1],
    phases: {
        opaque: [{ name: 'pbr', pipeline: 'core:pbr', enabled: true }],
        shadow: [],
        post: [],
    },
    multiView: false,
};

/** A component def used across tests. */
export const TEST_COMPONENT = {
    name: 'Speed',
    fields: { value: { type: 'f32' as const, default: 0 } },
};

/** A vec3 component def. */
export const TEST_VEC3_COMPONENT = {
    name: 'Position',
    fields: { pos: { type: 'vec3f' as const, default: [0, 0, 0] } },
};
