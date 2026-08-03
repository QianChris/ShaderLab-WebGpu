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
 *   - the plugin base class + lifecycle/context types (src/core/plugins/Plugin.ts)
 *   - engine mechanism singletons (usage surface: scene field access, uniform
 *     layouts, GPU resources, buffers, events, math)
 *   - declaration types consumed by plugin declaration fields
 *   - third-party re-exports plugins are allowed to use (RAPIER, bitecs query API)
 * What does NOT belong here:
 *   - anything importing from public/plugins (the engine must never depend on
 *     a plugin; all engine→plugin calls go through the interfaces below)
 */

/* ── Plugin system ─────────────────────────────────────────────── */
export { EnginePlugin } from './core/plugins/Plugin';
export type {
    PluginMeta,
    PluginContext,
    ValueHook,
    MeshCatalogEntry,
    FallbackTextureDecls,
    VboPresetDecls,
} from './core/plugins/Plugin';
export type { ToolFactory } from './core/tools/ToolRegistry';

/* ── ECS mechanisms ────────────────────────────────────────────── */
export { Scene } from './core/ecs/Scene';
export type { SceneData, CameraView } from './core/ecs/Scene';
export { schemaRegistry, SchemaRegistry } from './core/ecs/SchemaRegistry';
export type { ComponentDef, FieldDef } from './core/ecs/SchemaRegistry';
export { systemRegistry } from './core/ecs/SystemRegistry';
export type {
    System,
    FrameContext,
    SystemDef,
    SystemBufferDecl,
} from './core/ecs/SystemRegistry';

/* ── Render mechanisms (usage surface) ─────────────────────────── */
export { resourceManager } from './core/render/ResourceManager';
export { bufferRegistry } from './core/render/BufferRegistry';
export { uniformLayouts, UniformLayout } from './core/render/UniformLayout';
export type { UniformLayoutDecls, UniformMemberDecl, UniformMemberType } from './core/render/UniformLayout';
export { PipelineLoader } from './core/render/PipelineLoader';
export { VERTEX_SLOTS, SLOT_ORDER, isSlotName } from './core/render/vertexSlots';
export type { SlotName, SlotDef, VertexSlotDecls } from './core/render/vertexSlots';
export { meshEdges, isPbrMeshData } from './core/render/Primitives';
export type { MeshData, PbrMeshData, MeshGenerator } from './core/render/Primitives';
export { resolveValue, resolveString, resolveHandle } from './core/render/valueResolver';
export type { ValueContext, AtomResolver } from './core/render/valueResolver';
export type {
    PipelineConfig,
    ComputePipelineConfig,
    ComputeMeta,
    PhaseDecl,
    PhaseBehavior,
    PhaseBehaviorContext,
    DriverFrame,
    ViewportRect,
    IRenderer,
    PipelineEntry,
    RenderGraphData,
    VertexInputDecls,
    BindLayoutDecls,
    BindEntryDecl,
    SamplerDecls,
} from './core/render/types';
export type { RendererDecl, RenderTargetDecls, RenderTargetSize } from './core/render/rendererDecl';
export type {
    GeometryHook,
    ComputeHook,
    GeometryHookContext,
    ComputeHookContext,
} from './core/render/PipelineDriver';

/* ── Events ────────────────────────────────────────────────────── */
export { EventBus } from './core/events/EventBus';
export type { EventHandler } from './core/events/EventBus';
export { EVENT_TYPES } from './core/events/eventTypes';
export type { EventType } from './core/events/eventTypes';

/* ── Tools ─────────────────────────────────────────────────────── */
export type { ToolConfig, ToolContext, SceneTool } from './editor/input/SceneTool';

/* ── Math ──────────────────────────────────────────────────────── */
export {
    buildCameraMatrices,
    buildCameraMatricesInto,
    mat4FromTRS,
    mat4FromTRSInto,
    mat4OrthographicSym,
    mat4OrthographicSymInto,
    mat4LookAt,
    mat4LookAtInto,
    mat4Perspective,
    mat4PerspectiveInto,
    mat4Mul,
    mat4MulInto,
    mat4Inverse,
    mat4InverseInto,
    mat4TransformVec4,
    quatRotateVec3,
    normalMatrix,
    normalMatrixInto,
} from './core/math';
export type { TRS } from './core/math';

/* ── Engine config type (read-only view for plugins) ──────────── */
export type { EngineConfig, SystemEntry, AppManifest } from './core/Engine';

/* ── Third-party re-exports (the only non-relative imports allowed
 *    in plugins go through here so the engine controls the version) ── */
export { default as RAPIER } from '@dimforge/rapier3d-compat';
export { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs/legacy';
export type { World, EntityId } from 'bitecs';
