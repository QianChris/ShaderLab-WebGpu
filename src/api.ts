/**
 * @shaderlab/api — the single public surface between the engine and plugins.
 *
 * Plugins (public/plugins/<id>/index.ts) may import ONLY this module (plus
 * their own relative files). The PluginManager rewrites the bare specifier
 * '@shaderlab/api' to this module's URL at load time:
 *   dev:  /src/api.ts          (transformed on the fly by the Vite dev server)
 *   prod: /assets/engine-api.js (stable-named secondary Rollup entry; shares
 *          chunks with the main bundle, so singletons are the same instances)
 *
 * Surface stability: UNSTABLE until the plugin migration (PLAN_Plugin.md
 * Phase C) is complete, after which this file is the frozen contract.
 *
 * What belongs here:
 *   - the plugin base class + lifecycle/context types (src/plugins/Plugin.ts)
 *   - engine mechanism singletons (usage surface: scene field access, uniform
 *     layouts, GPU resources, buffers, events, math)
 *   - declaration types consumed by plugin declaration fields
 *   - third-party re-exports plugins are allowed to use (RAPIER, bitecs query API)
 * What does NOT belong here:
 *   - anything importing from public/plugins (the engine must never depend on
 *     a plugin; all engine→plugin calls go through the interfaces below)
 */

/* ── ECS mechanisms ────────────────────────────────────────────── */
export { Scene } from './ecs/Scene';
export type { SceneData, CameraView } from './ecs/Scene';
export { schemaRegistry, SchemaRegistry } from './ecs/SchemaRegistry';
export type { ComponentDef, FieldDef } from './ecs/SchemaRegistry';
export { systemRegistry } from './ecs/SystemRegistry';
export type {
    System,
    FrameContext,
    SystemDef,
    SystemBufferDecl,
} from './ecs/SystemRegistry';

/* ── Render mechanisms (usage surface) ─────────────────────────── */
export { resourceManager } from './render/ResourceManager';
export { bufferRegistry } from './render/BufferRegistry';
export { uniformLayouts } from './render/UniformLayout';
export type { UniformLayoutDecls } from './render/UniformLayout';
export { PipelineLoader } from './render/PipelineLoader';
export { VERTEX_SLOTS, SLOT_ORDER, isSlotName } from './render/vertexSlots';
export type { SlotName, SlotDef, VertexSlotDecls } from './render/vertexSlots';
export { meshEdges, isPbrMeshData } from './render/Primitives';
export type { MeshData, PbrMeshData, MeshGenerator } from './render/Primitives';
export { resolveValue, resolveString, resolveHandle } from './render/valueResolver';
export type { ValueContext, AtomResolver } from './render/valueResolver';
export type {
    PipelineConfig,
    ComputePipelineConfig,
    ComputeMeta,
    PhaseDecl,
    PipelineEntry,
    RenderGraphData,
    VertexInputDecls,
    BindLayoutDecls,
    BindEntryDecl,
    SamplerDecls,
} from './render/types';
export type { RendererDecl, RenderTargetDecls, RenderTargetSize } from './render/rendererDecl';
export type {
    GeometryHook,
    ComputeHook,
    GeometryHookContext,
    ComputeHookContext,
} from './render/PipelineDriver';

/* ── Events ────────────────────────────────────────────────────── */
export { EventBus } from './events/EventBus';
export type { EventHandler } from './events/EventBus';
export { EVENT_TYPES } from './events/eventTypes';
export type { EventType } from './events/eventTypes';

/* ── Tools ─────────────────────────────────────────────────────── */
export type { ToolConfig, ToolContext, SceneTool } from './tools/SceneTool';

/* ── Math ──────────────────────────────────────────────────────── */
export {
    buildCameraMatrices,
    mat4FromTRS,
    mat4OrthographicSym,
    mat4LookAt,
    mat4Perspective,
    mat4Mul,
    mat4Inverse,
    mat4TransformVec4,
    quatRotateVec3,
    normalMatrix,
} from './math';
export type { TRS } from './math';

/* ── Engine config type (read-only view for plugins) ──────────── */
export type { EngineConfig, SystemEntry, AppManifest } from './Engine';

/* ── Third-party re-exports (the only non-relative imports allowed
 *    in plugins go through here so the engine controls the version) ── */
export { default as RAPIER } from '@dimforge/rapier3d-compat';
export { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs/legacy';
export type { World, EntityId } from 'bitecs';
