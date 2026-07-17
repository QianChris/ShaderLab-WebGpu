# Data-Driven Engine Refactor Plan

Eliminate the remaining hardcoded dispatch / closed enums / dead metadata in the engine so that a user can implement an arbitrary scenario (game / simulation / renderer) purely via JSON + .js assets:

- Custom **Component** / **System** / **Tool** / **script hooks**
- Declarative **BindingLayout** / **UniformLayout**
- Declarative **Buffer** (global on System, per-entity on Component)
- Declarative **render scripts** calling **Shaders**

Each step keeps `npm run build` green and is one git commit.

## Status

| Step | Status | Commit |
|------|--------|--------|
| 1 — System interface + SystemRegistry dispatch | ✅ done | `9b074f3` |
| 2 — Custom system script loader + demo8 | ✅ done | `64ebeab` |
| 3 — BufferRegistry: system-level globals | ✅ done | `a73d667` |
| 4 — resolveFrameResource via BufferRegistry | ✅ done | `4a909fe` |
| 5 — Per-entity component buffers | ⏸ deferred (needs Scene + SchemaRegistry refactor) | — |
| 6 — FrameContext GPU access (getBuffer/writeBuffer/dispatchCompute) | ✅ done (minimal) | `0f8f6ef` |
| 7 — gaussianSplat self-contained (loadFromScene moved to manager) | ✅ done (partial) | `62cdbed` |
| 8 — Tool scripts (source: scripts/x.js) | ✅ done | `57c3b01` |
| 9 — Phase behavior scripts | ⏸ deferred (RenderGraph.runPhase refactor) | — |
| 10 — Cleanup (depthView dead code / kind enum / needs validation) | ✅ done | `23b8b19` |

Deferred items (5, 9, full-7) require deeper refactors that risk breaking existing apps; they are documented below for a follow-up pass.

---

## Inventory of violations (mapped to steps)

| # | Violation | Step |
|---|-----------|------|
| V1 | `Engine.frame()` `switch(sys.name)` hardcoded dispatch | 1 |
| V2 | Built-in system `update` signatures not unified (`(time,dt)` / `(aspect)` / `()`) | 1 |
| V3 | `gaussianSplat` is an Engine-level special case (`if hasSystem(...)` in `loadApp` + dedicated `case`) | 1 (partial) → 7 (full) |
| V4 | `system.json` `buffers` / `ubos` / `needs` fields are dead metadata | 3, 4, 10 |
| V5 | `source: "scripts/x.js"` custom system loader not implemented | 2 |
| V6 | `ResourceManager.resolveFrameResource` closed-enum switch (`cameraUBO` / `lightUBO` / …) | 4 |
| V7 | ECS scripts (`ScriptComponent`) cannot touch GPU resources (no buffer/dispatch API) | 6 |
| V8 | `ToolSystem.TOOL_REGISTRY` closed enum (only `pick`) | 8 |
| V9 | `PhaseDecl.behavior` closed enum (`normal` / `shadow-clear` / `postprocess-chain`) | 9 |
| V10 | `PipelineEntry.kind` closed enum residue | 10 |
| V11 | `needs` not topologically validated | 10 |
| V12 | Dead code (`ResourceManager.depthView`) | 10 |

---

## Step 1 — Unify System interface + SystemRegistry (dispatch via registry)

**Goal**: kill the `switch(sys.name)` in `Engine.frame()`. Every system is dispatched through a registry by its `source` field. Built-in systems still TS-owned; their internals unchanged.

**New file `src/ecs/SystemRegistry.ts`**:
```ts
export interface FrameContext {
    scene: Scene; time: number; dt: number;
    aspect: number; cw: number; ch: number;
    canvas: HTMLCanvasElement;
    device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat;
    eventBus: EventBus;
    // cross-system refs (transitional — replaced by registry lookup in later steps)
    physics: PhysicsSystem | null;
    camera: CameraSystem;
    light: LightSystem;
    animation: AnimationSystem;
    input: InputSystem;
    script: ScriptSystem;
    splats: GaussianSplatManager | null;
    gsEntityEid: number | null;
    renderGraph: RenderGraph;
}
export interface System { update(ctx: FrameContext): void; dispose?(): void; }
class SystemRegistry {
    private builtins = new Map<string, System>();       // "builtin:<id>" -> instance
    registerBuiltin(id: string, sys: System): void;
    /** Resolve a SystemEntry (`source` field) to a System instance (or null if not loaded yet). */
    resolve(entry: SystemEntry): System | null;
}
export const systemRegistry = new SystemRegistry();
```

**Each built-in system** gains `update(ctx: FrameContext)` that delegates to the existing method:
- `InputSystem.update(ctx)` → `this.update(ctx.time, ctx.dt)`
- `ScriptSystem.update(ctx)` → `this.update(ctx.time, ctx.dt)`
- `PhysicsSystem.update(ctx)` → `this.update(ctx.time, ctx.dt)`
- `CameraSystem.update(ctx)` → `this.update(ctx.aspect)`
- `LightSystem.update(ctx)` → `this.update()`
- `AnimationSystem.update(ctx)` → `this.update(ctx.time, ctx.dt)`
- `RenderGraph` gets `update(ctx)` → `this.execute(ctx.device, ctx.context, ctx.format, ctx.scene, ctx.time, ctx.dt)`
- `GaussianSplatManager.update(ctx)` → the current `case 'gaussianSplat'` body

**`Engine.init()`**: after creating all built-in systems, `systemRegistry.registerBuiltin('input', this.inputSystem)` etc. for the 7 built-ins.

**`Engine.frame()`** becomes:
```ts
const ctx: FrameContext = { ... };
for (const sys of this.activeSystems) {
    const impl = systemRegistry.resolve(sys);
    impl?.update(ctx);
}
requestAnimationFrame(this.frame);
```

The `switch` is gone. The `if (this.hasSystem('gaussianSplat'))` in `loadApp` still creates the manager (Step 7 removes that), but it also calls `systemRegistry.registerBuiltin('gaussianSplat', mgr)` so dispatch works.

---

## Step 2 — Custom system script loader (`source: "scripts/x.js"`)

**Goal**: a user writes `apps/myApp/systems/foo.json` with `source: "scripts/foo.js"` and the engine loads it as a system. No TS change needed for new systems.

**`SystemRegistry` extends**:
- Map `source: "scripts/<path>.js"` → fetch text → Blob URL → dynamic `import(/* @vite-ignore */ blobUrl)` (mirror `ScriptSystem.load`).
- Module exports `init?(ctx)`, `update(ctx)`, `dispose?(ctx)` (hooks declared in `engine-config.json` `systemHooks`, default `["init","update"]`).
- Cache the loaded module per app (`clear()` on `unloadCurrentApp`).

**`Engine`**: load `engine-config.json` `systemHooks`, pass to SystemRegistry. `unloadCurrentApp` calls `systemRegistry.clearScripts()`.

**Demo**: ship a trivial `apps/demo7_customSystem/` showing a JS-driven system that updates an entity field each frame (no TS).

---

## Step 3 — BufferRegistry: system-level global buffers (data-driven)

**Goal**: `system.json` `ubos: ["camera"]` and `buffers: ["mySsbo"]` are actually consumed. The engine allocates the named UBO / storage buffer per-app from `uniform-layouts.json` layouts.

**New `src/render/BufferRegistry.ts`** (module singleton):
```ts
interface SystemBufferDecl {
    layout?: string;      // uniform-layouts.json name (UBO)
    size?: number;        // explicit byte size (storage)
    usage: GPUBufferUsage;
    label: string;
}
class BufferRegistry {
    private buffers = new Map<string, GPUBuffer>();
    private owners = new Map<string, string>();
    /** Called by Engine on app enter with the merged system defs. */
    allocateFor(systems: SystemEntry[], defs: Map<string, SystemDef>): void;
    get(name: string): GPUBuffer;
    has(name: string): boolean;
    write(name: string, data: BufferSource): void;
    exitApp(appId: string): void;
}
```

**Migration** (incremental):
1. system.json `ubos` field gains an optional `layout` reference (default = same name in `uniform-layouts.json`).
2. Engine.loadApp: after `enterApp(name)`, call `bufferRegistry.allocateFor(activeSystems, defs)`.
3. The 4 existing engine UBOs (`camera`/`light`/`timeInput`/`pointShadowFaces`) are migrated to the registry — their `_camUBO` getters in ResourceManager delegate to `bufferRegistry.get('camera')`.

**Engine UBO getters stay** as thin wrappers (so existing system code compiles); the storage backing them moves to BufferRegistry. The migration is invisible to existing systems.

---

## Step 4 — Frame resource resolution via BufferRegistry (remove switch)

**Goal**: `bind-layouts.json` `resource: "myUbo"` / `"mySsbo"` is resolved through BufferRegistry — no more closed enum in `ResourceManager.resolveFrameResource`.

**`ResourceManager.resolveFrameResource`** becomes:
```ts
private resolveFrameResource(entry: BindEntryDecl): GPUBindingResource {
    const name = entry.resource ?? '';
    if (name.startsWith('sampler:')) return this.namedSampler(name.slice(8));
    if (name.startsWith('texture:')) return this.textureView(this.namedTexture(name.slice(8)));
    if (name.startsWith('renderTarget:')) return this.renderTargetView(name.slice(11), ...);
    const buf = bufferRegistry.get(name);
    if (buf) return { buffer: buf };
    throw new Error(`Unknown frame resource '${name}'`);
}
```

Existing `cameraUBO` / `lightUBO` / etc. names still work because they're allocated in BufferRegistry (Step 3) under those names. `shadowDepth2DArray` / `shadowPoint2DArray` move into a "named texture view" registry (sister to BufferRegistry) — also allocated from `render-targets.json`.

**Old hardcoded getters** (`_camUBO`, `_lightUBO`, `_timeInputUBO`, `_pointShadowFaceUBO`) removed. Callers go through `bufferRegistry.get('camera')` etc.

---

## Step 5 — Per-entity component buffers

**Goal**: a Component can declare a per-entity GPU buffer (e.g. `velocitySsbo` for instanced skinning). Engine allocates/frees it with the entity's lifetime; pipelines bind it via a new bind source.

**`components.json` schema extension**:
```json
{
  "name": "TrailComponent",
  "fields": { "head": { "type": "u32" } },
  "buffers": [
    { "name": "trail", "layout": "trailVertex", "usage": "storage|vertex", "capacity": 1024 }
  ]
}
```

**Scene.ts**: per-entity buffer map `Map<eid, Map<bufferName, GPUBuffer>>`. `createEntity` allocates (using `uniform-layouts.get(layout).byteSize * capacity`); `removeEntity` destroys. Exposed via `scene.getEntityBuffer(eid, name)`.

**`rendererDecl.ts`** `BindGroupDecl` new source:
```ts
textures?: { binding; source; fallback }[];   // existing
buffers?: { binding; source: 'component:Comp.field' | 'global:name' }[];  // new
```

**PipelineDriver.buildEntries** handles `buffers` entries — resolves per-entity or global buffer, replaces the implicit `bg_${path}_${group}_${eid}` cache key (which becomes redundant once the buffer identity is stable).

---

## Step 6 — SystemContext with GPU access

**Goal**: a custom system script can write to a named buffer, dispatch a compute pipeline, and record into the per-frame command encoder — not just mutate ECS fields.

**Extend `System.update(ctx)` ctx** (script systems get a `SystemContext` that superset of `FrameContext`):
```ts
interface SystemContext extends FrameContext {
    getBuffer(name: string): GPUBuffer;
    writeBuffer(name: string, data: BufferSource): void;
    dispatch(pipelineName: string, count: number, extraEntries?: GPUBindGroupEntry[]): void;
    /** Scoped encoder for the current frame's compute stage (closed by renderGraph.execute). */
    encoder(): GPUCommandEncoder;
}
```

**Engine.frame()**: opens a compute encoder at the start of the frame, passes it via ctx. Render phase closes + submits it before render passes begin. (Mirrors the existing compute stage in `RenderGraph.executeSingle`, but lifted to a frame-level scope.)

**Demo**: `demo8_gpuSystem/` — a JS system that dispatches a compute shader to fill a storage buffer, then a render pipeline draws it. Zero TS.

---

## Step 7 — Refactor `gaussianSplat` as a self-contained system

**Goal**: remove `if (this.hasSystem('gaussianSplat'))` from `Engine.loadApp` and the `gsEntityEid` field on Engine. The splat manager is a regular system whose `init(ctx)` loads the ply from a GsComponent entity.

**Approach** (depends on Step 6):
- Move `GaussianSplatManager` to implement `System` fully: `init(ctx)` scans the scene for `GsComponent` entities, loads the ply (using `ctx.scene` + the app base dir — exposed via `ctx.appBase`).
- Move `gsEntityEid` onto the manager.
- The `renderGraph.splats` reference is set by the system's `init` (the system accesses `ctx.renderGraph`).
- `Engine.loadApp` removes the entire splat branch.
- `demo6_3dgsViewer` `systems.json` adds `gaussianSplat` with `def` pointing at a system.json that declares `source: "builtin:gaussianSplat"` (or a `.js` system that wraps the manager — proving the script path works).

---

## Step 8 — Tool scripts (`source: "scripts/x.js"`)

**Goal**: tools.json entries support a script source in addition to the builtin `type` lookup.

**`tools.json` schema**:
```json
[
  { "type": "pick", "enabled": true },                            // existing
  { "source": "scripts/myTool.js", "enabled": true }             // new
]
```

**`ToolSystem`** gains a script loader (mirror ScriptSystem): fetch → Blob URL → dynamic import. The script exports `attach(ctx)` / `detach(ctx)` / `onEvent(type, payload)` (subscribes via `ctx.bus`).

The closed `TOOL_REGISTRY` becomes a fallback for builtins; new tools added without TS.

---

## Step 9 — Phase behavior scripts

**Goal**: `phases.json` `behavior` accepts `"script:<path>"`. The closed enum becomes a set of builtin scripts.

**`phases.json`**:
```json
[
  { "name": "Shadow", "order": 10, "behavior": "builtin:shadow-clear" },
  { "name": "Opaque",  "order": 20, "behavior": "normal" },
  { "name": "Post",    "order": 90, "behavior": "builtin:postprocess-chain" }
]
```

**`RenderGraph.runPhase`** dispatches via `phaseBehaviorRegistry`: looks up the behavior name → if a builtin script handler exists, calls it; else throws. Users can register a new behavior via a script (mirror render scripts).

The three existing behaviors become data — `RenderGraph` no longer has the `if (phase.behavior === 'shadow-clear')` switch; each behavior is a function `(encoder, drivers, scene, frame, ...) => void` registered at engine init.

---

## Step 10 — Cleanup & validation

- **V10**: remove `PipelineEntry.kind` closed enum (verify no consumers; the field is already commented as legacy).
- **V11**: `SystemRegistry.loadSystems` validates `needs` topologically — emit `console.error` and skip the unresolvable system.
- **V12**: delete `ResourceManager.depthView` dead method + the `_depthTex`/`_depthW`/`_depthH` fields.
- Update `AGENTS.md` "接线状态" section to reflect the new state (custom systems, buffer registry, etc.).
- Add a top-level `docs/data-driven-checklist.md` describing what a user needs to add a new system / tool / buffer (one-line per file).

---

## Execution order

```
Step 1  ─→ Step 2 ─→ Step 6 ─→ Step 7
                 ↘
Step 3 ─→ Step 4 ─→ Step 5
Step 8  (independent)
Step 9  (independent)
Step 10 (after all others)
```

Step 1 first (foundation). Steps 3→4 and 2→6→7 are independent tracks. Steps 8, 9 independent. Step 10 last.

Each step ends with:
1. `npm run build` passes.
2. `git add -A && git commit -m "<message>"` (message matches repo style: `refactor: <summary>`).
