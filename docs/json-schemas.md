# JSON Schema 锚定参考

本文档锚定引擎中**所有 JSON 声明**的 schema。每一项给出：字段表（类型/必填/默认/源码锚点）+ 最小示例 + 真实仓库示例 + 跨引用规则。非 JSON 代码规范（WGSL/脚本/插件 TS）见 [code-conventions.md](./code-conventions.md)。

> 标注约定：**必填** / 可选 / 默认 `X` / 类型 `T` / 锚点 `src/...:行号`。`fail-loud` = 缺失/重名/未注册一律 throw。

---

## 总览：有多少需要 JSON 定义的东西？

**30 类 JSON 声明**，分 6 层：

| 层 | 数量 | 说明 |
|----|------|------|
| **A. 插件声明字段** | 20（含 `meta`） | EnginePlugin 类的可选字段，TS 字面量或共置 JSON 填充 |
| **B. 插件共置 JSON 文件** | 12（core）+ 2（pbd） | 文件名约定（不强制），`init()` fetch 填字段；schema 同 A |
| **C. App 级 JSON** | 8 | `app.json`/`scene.json`/`render.json`/`tools.json`/`ui-config.json`/`graph.json`/app`components.json`/app`systems.json` |
| **D. Common 级 JSON** | 3 | `engine-config.json`/`systems.json`/`gltf-mapping.json` |
| **E. 管线/着色器 JSON** | 3 | 渲染管线 `PipelineConfig` / 计算管线 `ComputePipelineConfig` / 内嵌 `RendererDecl` |
| **F. 插件消费的资产 JSON** | 2 | sprite sheet / softbody asset（schema 由插件定，非引擎） |

**汇总表（按"声明名 → 位置 → owner → 消费者"）：**

| # | 声明 | 层 | scope/owner | 消费者（注册表/装载器） |
|---|------|----|-------------|--------------------------|
| A1 | `meta`（id, dependencies） | 插件 TS | `plugin:<id>` | PluginManager |
| A2 | `components` | 插件字段/JSON | `plugin:<id>` / `app:<id>` | SchemaRegistry |
| A3 | `uniformLayouts` | 插件字段/JSON | `plugin:<id>` | UniformLayoutRegistry |
| A4 | `bindLayouts` | 插件字段/JSON | resource-manager scoped | ResourceManager |
| A5 | `vertexSlots` | 插件字段/JSON | `plugin:<id>` | vertexSlots 模块 |
| A6 | `vertexInputs` | 插件字段/JSON | `plugin:<id>` | PipelineLoader |
| A7 | `samplers` | 插件字段/JSON | resource-manager scoped | ResourceManager |
| A8 | `blendPresets` | 插件字段/JSON | `plugin:<id>` | PipelineLoader |
| A9 | `fallbackTextures` | 插件字段/JSON | resource-manager scoped | ResourceManager |
| A10 | `vboPresets` | 插件字段/JSON | resource-manager scoped | ResourceManager |
| A11 | `meshes`（catalog） | 插件字段/JSON | generator ledger-tracked | PluginHostHelper |
| A12 | `renderTargets` | 插件字段/JSON | app-scoped（资源）+ render graph | ResourceManager + RenderGraph |
| A13 | `phases` | 插件字段/JSON | `plugin:<id>`（ledger） | RenderGraph |
| A14 | `systemDefs` | 插件 TS 字面量 | `plugin:<id>` | SystemRegistry + BufferRegistry |
| A15 | `pipelines`（虚拟） | 插件 TS 字段 | `plugin:<id>:` 前缀 | PipelineLoader |
| A16 | `shaders`（虚拟） | 插件 TS 字段 | `plugin:<id>:` 前缀 | PipelineLoader |
| A17 | `renderHooks` | 插件 TS 字段 | `plugin:<id>` | RenderGraph（3 hook map） |
| A18 | `meshGenerators` | 插件 TS 字段 | `plugin:<id>`（ledger） | Primitives 模块 |
| A19 | `toolTypes` | 插件 TS 字段 | `plugin:<id>`（ledger） | ToolRegistry |
| A20 | `valueAtoms` | 插件 TS 字段 | `plugin:<id>`（ledger） | valueResolver 模块 |
| C1 | `app.json` | app | `app:<id>` | Engine.loadApp |
| C2 | `scene.json` | app | app-scoped | Engine → Scene |
| C3 | `render.json` | app | app + common scoped | RenderGraph |
| C4 | `tools.json` | app | editor-scoped | ToolSystem |
| C5 | `ui-config.json` | app | editor-scoped | UIManager |
| C6 | `graph.json` | app | `'app'` | ShaderGraphRegistry |
| C7 | app `components.json` | app | `app:<id>` | SchemaRegistry |
| C8 | app `systems.json` | app | app-scoped | SystemRegistry |
| D1 | `engine-config.json` | common | engine-lifetime | Engine.init |
| D2 | common `systems.json` | common | engine-lifetime | Engine.init |
| D3 | `gltf-mapping.json` | common | engine-lifetime | Engine.loadGltf |
| E1 | 渲染管线 `.json` | 插件/app | 虚拟路径引用 | PipelineLoader |
| E2 | 计算管线 `.json` | 插件/app | 虚拟路径引用 | PipelineLoader |
| E3 | `RendererDecl`（内嵌） | 管线 JSON 内 | driven by PipelineDriver | PipelineDriver |
| F1 | sprite sheet JSON | app 资产 | SpriteSystem 缓存 | SpriteSystem（插件） |
| F2 | softbody asset JSON | app 资产 | PbdManager 装载 | PbdManager（插件） |

> **需要 JSON 定义不了的**：WGSL 着色器、游戏脚本（.js）、渲染脚本（.js）、着色器图节点 WGSL、插件 TS 代码本身、`renderHooks`/`meshGenerators`/`toolTypes`/`valueAtoms`（函数，TS-only）、`PhaseBehavior` 实现、自定义 value atom resolver。规范见 [code-conventions.md](./code-conventions.md)。

---

## A. 插件声明字段

`EnginePlugin`（`src/core/plugins/Plugin.ts:101`）的可选字段。可作 TS 字面量，或 `init()` fetch 共置 JSON 填充（`core` fetch 12 个 JSON）。声明由 `PluginHostHelper.applyDeclarations`（`src/core/PluginHost.ts`）合并进注册表，owner = `'plugin:<id>'`，卸载时按 owner 清扫。

### A1. `meta` — 插件身份与依赖

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `id` | string | **必填** | — | `Plugin.ts:27` |
| `dependencies` | string[] | 可选 | `[]` | `Plugin.ts:28` |

- `id` **必须等于目录名**（fail-loud at load）。
- `dependencies` 驱动拓扑装载（递归先装依赖；`stack` 做环检测）。

```ts
readonly meta = { id: 'sprite', dependencies: ['core'] };
```

### A2. `components` — ECS 组件 schema

数组，每项一个 `ComponentDef`。

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `SchemaRegistry.ts:21` |
| `mandatory` | boolean | 可选 | `false` | `SchemaRegistry.ts:22`（强制每个实体携带，如 `NameComponent`） |
| `fields` | `Record<string, FieldDef>` | **必填** | — | `SchemaRegistry.ts:25` |

**`FieldDef`：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `type` | `'f32'\|'i32'\|'u32'\|'u8'\|'bool'\|'string'\|'vec2'\|'vec3'\|'vec4'` | **必填** | — | `vec` 展开 SoA `_x/_y/_z/_w`；`string` 走字符串表；`bool` 存 `u8` |
| `default` | number\|number[]\|string | **必填** | — | 标量→标量；vec→`number[]`；`string`→字符串 |
| `options` | string[] | 可选 | — | 闭合枚举（UI 下拉）；仅 UI 元数据，存原始数 |
| `role` | string | 可选 | — | 语义提示。已知：`'color'`/`'mesh'`/`'texture'`/`'shader'`/`'buffer'`/`'extra'`/`'viewport'`；开放，插件可加 |

- 跨 owner 重名 throw；`schemaRegistry.registerDefs(defs, owner)`。
- `role` 供 renderer 泛型取用（`schemaRegistry.getFieldByRole`/`isRenderTag`：任何带 `role` 的字段都算 render tag）。

```json
[
  { "name": "Camera", "fields": {
    "fov":    { "type": "f32", "default": 60 },
    "near":   { "type": "f32", "default": 0.1 },
    "far":    { "type": "f32", "default": 100 },
    "active": { "type": "bool", "default": false },
    "viewport": { "type": "vec4", "default": [0, 0, 1, 1], "role": "viewport" } } }
]
```

> app 级 `components.json` schema 完全相同，owner `'app:<id>'`。

### A3. `uniformLayouts` — std140 uniform 块布局

`Record<name, UniformMemberDecl[]>`。

**`UniformMemberDecl`：**

| 字段 | 类型 | 必填 | 锚点 |
|------|------|------|------|
| `name` | string | **必填** | `UniformLayout.ts:14` |
| `type` | `'f32'\|'i32'\|'u32'\|'vec2f'\|'vec3f'\|'vec4f'\|'mat3x3f'\|'mat4x4f'` | **必填** | `UniformLayout.ts:15` |

- std140 对齐 baked in `TYPE_INFO`（`UniformLayout.ts:26-35`）：`vec3f` 对齐 16 大小 12；`mat3x3f` = 48 字节（3 列 × vec3 padded）；`mat4x4f` = 64 字节；块大小向上取整 16。
- 跨 owner 重名 throw；`uniformLayouts.load(decls, owner)`。
- 被 `bind-layouts.json` `resource`（UBO 名）+ 管线 `bindGroups.uniform.layoutRef` 引用。

```json
{
  "camera": [
    { "name": "vp",   "type": "mat4x4f" },
    { "name": "ivp",  "type": "mat4x4f" },
    { "name": "pos",  "type": "vec4f" },
    { "name": "view", "type": "mat4x4f" },
    { "name": "proj", "type": "mat4x4f" } ]
}
```

### A4. `bindLayouts` — GPUBindGroupLayout 声明

`Record<name, { entries: BindEntryDecl[] }>`。

**`BindEntryDecl`：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `binding` | number | **必填** | — | `@binding(N)` |
| `visibility` | `('vertex'\|'fragment'\|'compute')[]` | **必填** | — | 可见 shader 阶段 |
| `buffer` | `'uniform'\|'storage'\|'read-only-storage'` | 四选一 | — | 与 sampler/texture/storageTexture 互斥 |
| `sampler` | `'filtering'\|'comparison'\|'non-filtering'` | 四选一 | — | |
| `texture` | GPUTextureSampleType | 四选一 | — | 如 `'float'`/`'depth'` |
| `viewDimension` | GPUTextureViewDimension | 可选 | `'2d'` | `'2d-array'`/`'cube-array'` 用于分层阴影 |
| `storageTexture` | `{ format; access? }` | 四选一 | — | |
| `resource` | string | 可选 | — | 运行时资源名，帧 bind group 自动装配。形式：`"sampler:<name>"` / `"<uboName>"`（匹配 uniform-layouts）/ `"<storageBufferName>"` / `"shadowDepth2DArray"`/`"shadowPoint2DArray"`（遗留阴影视图） |

- `resourceManager.loadBindLayouts(decls)`——**无 per-name owner**，由 resource-manager `enterApp` owner 上下文 scope。
- 被 `pipeline.bindLayout[]`（`@group` 顺序）引用；`resource` 解析对 `uniformLayouts` + `samplers` + `systemDefs.buffers`。

```json
"frame": { "entries": [
  { "binding": 0, "visibility": ["vertex","fragment"], "buffer": "uniform", "resource": "camera" },
  { "binding": 1, "visibility": ["vertex","fragment"], "buffer": "uniform", "resource": "light" },
  { "binding": 3, "visibility": ["fragment"], "texture": "depth", "viewDimension": "2d-array", "resource": "shadowDepth2DArray" },
  { "binding": 4, "visibility": ["fragment"], "sampler": "comparison", "resource": "sampler:shadow" }
] }
```

### A5. `vertexSlots` — SoA 顶点属性槽

`Record<name, SlotDef>`。

| 字段 | 类型 | 必填 | 锚点 |
|------|------|------|------|
| `location` | number | **必填** | `vertexSlots.ts:5`（`@attribute` shaderLocation） |
| `format` | GPUVertexFormat | **必填** | `vertexSlots.ts:6`（如 `'float32x3'`/`'uint16x4'`） |
| `stride` | number | **必填** | `vertexSlots.ts:7`（每顶点字节数 = arrayStride） |
| `components` | number | **必填** | `vertexSlots.ts:8`（元素数 1-4） |

- 跨 owner 重名**和**跨槽 `location` 冲突都 throw。
- `SLOT_ORDER` 全局驱动 `MeshComponent` GPU 句柄解析（`h${SlotName}` 字段，`Engine.resolveHandles`）。

```json
{
  "Pos":     { "location": 0, "format": "float32x3", "stride": 12, "components": 3 },
  "Normal":  { "location": 1, "format": "float32x3", "stride": 12, "components": 3 },
  "UV":      { "location": 2, "format": "float32x2", "stride": 8,  "components": 2 }
}
```

### A6. `vertexInputs` — 命名顶点输入配置

`Record<name, { slots: SlotName[] }>`。

- `slots` 引用 `vertex-slots.json` 名；`PipelineLoader.buildSlotLayouts` 装配 `GPUVertexBufferLayout[]`（`stepMode: 'vertex'`）。
- 跨 owner 重名 throw。
- 被 `pipeline.vertex.input` 引用。

```json
{
  "pos3":       { "slots": ["Pos"] },
  "pbr_static": { "slots": ["Pos","Normal","UV","Tangent"] },
  "skinned":    { "slots": ["Pos","Normal","UV","JointIndex","JointWeight","Tangent"] }
}
```

### A7. `samplers` — 命名 GPUSampler 描述

`Record<name, SamplerDecl>`。字段即 `GPUSamplerDescriptor` 的子集：

| 字段 | 类型 | 默认 |
|------|------|------|
| `addressModeU/V/W` | `'clamp-to-edge'\|'repeat'\|'mirror-repeat'` | — |
| `magFilter`/`minFilter` | `'linear'\|'nearest'` | — |
| `mipmapFilter` | GPUMipmapFilterMode | — |
| `compare` | GPUCompareFunction | —（阴影 sampler 用 `'less'`） |

- 无 per-name owner；被 `bind-layouts.json` `resource: "sampler:<name>"` + 管线 `bindGroups.samplers[]` `{ binding, name }` 引用。

```json
{
  "default": { "addressModeU": "repeat", "addressModeV": "repeat", "magFilter": "linear", "minFilter": "linear" },
  "shadow":  { "addressModeU": "clamp-to-edge", "addressModeV": "clamp-to-edge", "addressModeW": "clamp-to-edge", "compare": "less" }
}
```

### A8. `blendPresets` — 命名混合预设

`Record<name, GPUBlendState>`。每个 preset 即 WebGPU `GPUBlendState`：

```json
{
  "color": { "srcFactor": "src-alpha", "dstFactor": "one-minus-src-alpha", "operation": "add" },
  "alpha": { "srcFactor": "one", "dstFactor": "one-minus-src-alpha", "operation": "add" }
}
```

- 跨 owner 重名 throw。被 `pipeline.blend`（字符串名 OR 内联 `GPUBlendState`）引用。`core` 提供 `opaque`/`alpha`/`additive`/`premultiplied` 四个。

### A9. `fallbackTextures` — 1 像素占位纹理

`Record<name, { pixel: number[4]; format: GPUTextureFormat }>`。

- `pixel` = RGBA 字节（长 4）。被管线 `bindGroups.textures[].fallback` 引用（组件纹理句柄为 0 时用）。

```json
{
  "white":  { "pixel": [255, 255, 255, 255], "format": "rgba8unorm" },
  "normal": { "pixel": [128, 128, 255, 255], "format": "rgba8unorm" }
}
```

### A10. `vboPresets` — 静态顶点缓冲

`Record<name, { data: number[]; format: string; stride: number }>`。

- `data` = 摊平顶点字节；`format` = `GPUVertexFormat`；`stride` = 每顶点字节。
- 被管线 `renderer.geometry.steps[].vertexBuffers[]` `{ source: "vbo", vbo: "<name>" }` 引用。

```json
{ "quad": { "data": [-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1], "format": "float32x2", "stride": 8 } }
```

### A11. `meshes` — Mesh catalog（generator 调用）

数组，每项：

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `Plugin.ts:36` |
| `generator` | string | **必填** | — | `Plugin.ts:37`（已注册的 generator 名） |
| `params` | `Record<string, number>` | 可选 | — | `Plugin.ts:38` |

- catalog 项本身不 owner-tracked，但引用的 generator 是（`meshGenerators` ledger）。未知 generator throw。
- 被场景 `MeshComponent.mesh` + `gltf-mapping.json` `mesh.field` 引用。

```json
[
  { "name": "cube", "generator": "cube" },
  { "name": "icosphere", "generator": "icosphere", "params": { "subdivisions": 1 } },
  { "name": "pbr_cube", "generator": "pbrCube" }
]
```

> 引擎内置 generator（`Engine.ts:195-200` 注册）：`triangle`/`cube`/`icosphere`/`uvsphere`/`pbrCube`/`pbrIcosphere`/`pbrUvSphere`/`pbrPlane`。

### A12. `renderTargets` — 命名离屏 target

`Record<name, RenderTargetDecl>`。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `kind` | `'color'\|'depth'` | **必填** | — | |
| `format` | GPUTextureFormat\|`'default'` | 可选 | color=`bgra8unorm`/`'default'`=swapchain；depth=`depth24plus` | |
| `clearColor` | `[r,g,b,a]` | 可选 | — | |
| `size` | `RenderTargetSize` | 可选 | viewport-sized | |
| `transient` | boolean | 可选 | `false` | 后处理 ping-pong 用 |
| `dimension` | `'2d'\|'2d-array'\|'cube-array'` | 可选 | `'2d'` | 分层阴影 |
| `arrayLayers` | number | 可选 | — | `'2d-array'`/`'cube-array'` 用；`'cube-array'` = cube 数（×6 面） |

**`RenderTargetSize`：** `{ type: 'viewport'\|'fixed'; scale?: number; w?: number; h?: number }`（viewport 默认 scale=1）。

- 由 `resourceManager.loadRenderTargets` + `RenderGraph.mergeRenderTargets` 双注册。render graph 重名 throw。
- 被管线 `renderer.target.color/depth` + 后处理 `input/output` 引用。特殊名：`"screen"` = swapchain，`"none"` = 无 target。

```json
{
  "scene":          { "kind": "color", "format": "default", "size": { "type": "viewport" } },
  "sceneDepth":     { "kind": "depth", "format": "depth24plus", "size": { "type": "viewport" } },
  "shadowDepth2D":  { "kind": "depth", "format": "depth24plus", "size": { "type": "fixed", "w": 2048, "h": 2048 }, "dimension": "2d-array", "arrayLayers": 4 },
  "ppA":            { "kind": "color", "format": "default", "size": { "type": "viewport" }, "transient": true }
}
```

### A13. `phases` — 渲染相位声明

数组，每项：

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `types.ts:23`（唯一） |
| `order` | number | **必填** | — | `types.ts:24`（升序排） |
| `behavior` | string | **必填** | — | `types.ts:25`（已注册的 PhaseBehavior 名；缺省运行时 `'normal'`） |

- `RenderGraph.addPhases` 重名 throw。被 `render.json` `phases` 键（必须存在）+ 管线 `renderer.phase` 引用。
- behavior 名在 execute 时 `RenderGraph.behaviorFor` 查表，未注册 throw。
- 默认 behavior：`normal`/`shadow-clear`/`postprocess-chain`（`src/core/render/phaseBehaviors.ts`）。

```json
[
  { "name": "Preprocess",  "order": 10, "behavior": "normal" },
  { "name": "Shadow",      "order": 30, "behavior": "shadow-clear" },
  { "name": "Opaque",       "order": 40, "behavior": "normal" },
  { "name": "Postprocess",  "order": 70, "behavior": "postprocess-chain" }
]
```

### A14. `systemDefs` — 系统元数据

数组，每项 `SystemDef`：

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `SystemRegistry.ts:67` |
| `source` | string | **必填** | — | `:68`（插件: `'plugin:<id>'`；脚本: `'<path>.js'`；遗留 `builtin:` 前缀忽略） |
| `components` | string[] | 可选 | `[]` | `:69` 读取的组件 |
| `ubos` | string[] | 可选 | `[]` | `:70`（必须匹配 uniform-layouts 名）→ BufferRegistry 分配 |
| `buffers` | `SystemBufferDecl[]` | 可选 | `[]` | `:71`（storage buffer 显式） |
| `needs` | string[] | 可选 | `[]` | `:72`（软顺序约束，仅警告） |
| `requires` | string[] | 可选 | `[]` | `:73`（特性需求，如 `'wasm:rapier'`，不强制） |
| `after` | string[] | 可选 | `[]` | `:74`（autoInsert：插到这些 system 之后） |
| `before` | string[] | 可选 | `[]` | `:75`（autoInsert：插到这些 system 之前） |

**`SystemBufferDecl`：**

| 字段 | 类型 | 必填 | 默认 |
|------|------|------|------|
| `name` | string | **必填** | — |
| `layout` | string | 可选 | —（uniform-layouts 名 → size = byteSize × count） |
| `size` | number | 可选 | —（显式字节 × count；与 `layout` 互斥） |
| `count` | number | 可选 | `1` |
| `scope` | `'app'\|'common'` | 可选 | `'app'`（`'common'` = 引擎寿命） |
| `usage` | string[] | 可选 | storage 默认 `['storage','copy_dst']`；UBO 默认 `['uniform','copy_dst']` |

- 跨 owner 重名 throw；`systemRegistry.addDef(def, owner)`。实现由 `setup()` 里 `ctx.registerSystem(name, instance)` 单独注册。
- TS 字面量（无共置 JSON 约定，因为 `source` 必须是 `plugin:<id>`）。
- `after`/`before` 仅当 app **无**自带 `systems.json` 时驱动 autoInsert。

```ts
systemDefs = [
    { name: 'input',  source: 'plugin:core', components: [], ubos: ['timeInput'], buffers: [], needs: [] },
    { name: 'camera', source: 'plugin:core', components: ['Camera','Transform'], ubos: ['camera'], buffers: [], needs: ['physics'] },
    { name: 'gaussianSplat', source: 'plugin:splat', components: ['GsComponent','Transform'], ubos: [], buffers: [], needs: [], before: ['camera'] },
];
```

### A15. `pipelines` — 虚拟渲染/计算管线配置

`Record<key, PipelineConfig | ComputePipelineConfig>`。

- key 可 `'<id>:<name>'`（显式）或 `'<name>'`（自动加 `<id>:` 前缀）。
- `PipelineLoader.registerVirtualConfig(key, config)`，重复 throw，按前缀 sweep。
- **仓库内无插件用此字段**——全用文件 `pipelines/*.json` + `render.json` 虚拟 ref `<id>:pipelines/X.json`。
- schema 见 [E1](#e1-渲染管线-json--pipelineconfig) / [E2](#e2-计算管线-json--computepipelineconfig)。

```ts
pipelines = {
  'myfx:myPipe': { name: 'MyPipe', vertex: {...}, fragment: {...}, primitive: {...}, depthStencil: false, layout: 'auto' }
}
```

### A16. `shaders` — 虚拟 WGSL 源

`Record<key, string>`（key 同 A15 约定，value = WGSL 源串）。

- `PipelineLoader.registerVirtualShader(key, src)`，重复 throw。
- **仓库内无插件用此字段**——全用共置 `shaders/*.wgsl` 文件，管线 JSON 相对路径引用。

```ts
shaders = { 'myfx:myShader.wgsl': '@vertex fn vs() {...}' }
```

### A17. `renderHooks` — Value/Geometry/Compute hook

`Record<name, GeometryHook | ComputeHook | ValueHook>`（TS-only，函数不能 JSON）。

```ts
type ValueHook    = (ctx: ValueContext) => number | number[];
type GeometryHook = (pass: GPURenderPassEncoder, ctx: GeometryHookContext) => void;
type ComputeHook  = (encoder: GPUCommandEncoder, ctx: ComputeHookContext) => void;
```

- 同一 `name` 注册进**三个** hook 命名空间（value/geometry/compute）；由 JSON 引用方决定上下文。
- 被管线 JSON 引用：`uniform.writes[].value: "script:<name>"`（value）/ `geometry.hook: "<name>"`（geometry）/ `compute.script: "<name>"`（compute）。
- 与 render-scripts（`render.json` `renderScripts`）共享命名空间；插件 hook 优先。

```ts
renderHooks = {
    'particles.simulate': particleHooks.simulate,   // ComputeHook
    'particles.draw': particleHooks.draw,           // GeometryHook
};
```

> hook ctx 接口见 [code-conventions.md §渲染脚本](./code-conventions.md#渲染脚本renderscriptloader)。

### A18. `meshGenerators` — 程序化 mesh generator

`Record<name, MeshGenerator>`（TS-only）。

```ts
type MeshGenerator = (params: Record<string, number>) => MeshData | PbrMeshData;
```

- ledger-tracked；被 `meshes` catalog `generator` 字段引用；未知 throw。
- **仓库内无插件用此字段**——引擎内置 8 个（`Engine.ts:195-200`）。

### A19. `toolTypes` — 交互工具工厂

`Record<name, ToolFactory>`（TS-only）。

```ts
type ToolFactory = (config: ToolConfig, ctx: ToolContext) => SceneTool;
```

- 重名 throw；被 `tools.json` `type` 引用。
- 例：physics `ctx.registerToolType('pick', (config, tctx) => new PickTool(config, tctx))`。

### A20. `valueAtoms` — 自定义值解析原子

`Record<namespace, Record<atomName, AtomResolver>>`（TS-only）。

```ts
type AtomResolver = (ctx: ValueContext) => number | ArrayLike<number>;
```

- 被值源串 `<ns>.<atom>` 引用（如 `builtin.time`/`transform.model`/`tag.color`）。
- **仓库内无插件注册自定义 atom**——引擎内置 `builtin.*`/`transform.*`/`tag.*`（`valueResolver.ts:38-59`）。
- 值源 mini-DSL 语法见 [code-conventions.md §值原子](./code-conventions.md#值原子value-atom--mini-dsl)。

---

## B. 插件共置 JSON 文件

`core` 的 `init()` fetch 12 个（`public/plugins/core/index.ts:42-63`）；`pbd` fetch 2 个。文件名是**约定**（作者选），不强制。

| 文件（core） | 填充字段 | schema 源 |
|---|---|---|
| `components.json` | `components` | A2 |
| `uniform-layouts.json` | `uniformLayouts` | A3 |
| `bind-layouts.json` | `bindLayouts` | A4 |
| `vertex-slots.json` | `vertexSlots` | A5 |
| `vertex-inputs.json` | `vertexInputs` | A6 |
| `samplers.json` | `samplers` | A7 |
| `blend-presets.json` | `blendPresets` | A8 |
| `fallback-textures.json` | `fallbackTextures` | A9 |
| `vbo-presets.json` | `vboPresets` | A10 |
| `meshes.json` | `meshes` | A11 |
| `render-targets.json` | `renderTargets` | A12 |
| `phases.json` | `phases` | A13 |

> `public/plugins/pbd/components.json` 存在但 **未被 `pbd/index.ts` 装载**（其 `init` 只 fetch uniform-layouts + bind-layouts；`components` 是 TS 字面量）。疑似遗留文档文件。

---

## C. App 级 JSON 文件

位于 `public/apps/<name>/`，由 `app.json` 引用。

### C1. `app.json` — App 清单

**位置**：`public/apps/<name>/app.json`（**必需**，`Engine.loadApp` 缺失 throw）。

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | 可选 | 目录名 | `Engine.ts:31` |
| `plugins` | string[] | 可选 | `[]` | `:32`（app 级插件，切 app 卸载） |
| `components` | string[] | 可选 | `[]` | `:33`（app 私有组件 schema 文件路径，相对 app base 或绝对） |
| `scene` | string | 可选 | `scene.json` | `:34` |
| `render` | string | 可选 | `render.json` | `:35` |
| `systems` | string | 可选 | `systems.json` | `:36`（缺失则用 common + autoInsert） |
| `tools` | string | 可选 | — | `:37`（交互工具配置，仅编辑器） |
| `gltf` | string[] | 可选 | `[]` | `:38`（glTF 路径，需 gltf-mapping.json） |
| `ui` | string | 可选 | — | `:39`（UIManager 消费，非 Engine） |

```json
{
  "name": "demo1",
  "scene": "scene.json",
  "render": "render.json",
  "tools": "tools.json",
  "ui": "ui-config.json",
  "gltf": ["../../assets/models/DamagedHelmet.glb"]
}
```

### C2. `scene.json` — 场景实体数据

**类型**：`Record<entityKey, Record<componentName, Record<fieldName, unknown>>>`（`Scene.ts:6`）。

- 顶层 key = 实体名（→ `NameComponent.name`，必须唯一，自动加）。
- 二层 key = 组件名（必须已注册，否则 throw）。
- 三层 key = 字段名（按组件 schema；省略用默认）。
- 值：标量→标量；`vec2/3/4`→`number[]`；`string`→字符串；`bool`→`0`/`1`。

```json
{
  "FallingCube": {
    "Transform": { "position": [-1, 3, -2], "rotation": [0.2, 0.1, 0, 0.97], "scale": [0.5, 0.5, 0.5] },
    "MeshComponent": { "mesh": "cube" },
    "TestMeshRender": { "color": [0.9, 0.4, 0.2, 1] },
    "RigidBodyComponent": { "bodyType": "dynamic" },
    "ColliderComponent": { "shape": "cuboid", "halfExtents": [0.25, 0.25, 0.25], "restitution": 0.4 }
  }
}
```

> 装载后 `Engine.resolveHandles` 填 `MeshComponent` 的 `hPos`/`hNormal`/... 句柄字段——**不要手写这些 `h*` 字段**。

### C3. `render.json` — 渲染图数据

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `types.ts:153` |
| `clearColor` | `[r,g,b,a]` | 可选 | EnvironmentComponent.clearColor 或深蓝 | `:154` |
| `phases` | `Partial<Record<phaseName, PipelineEntry[]>>` | **必填** | — | `:155`（键必须存在于 phases.json，否则 throw） |
| `multiView` | boolean | 可选 | `false` | `:156`（分屏：每活跃 Camera 独立视口） |
| `renderScripts` | string[] | 可选 | `[]` | `Engine.ts:343`（**未在 TS 接口声明但消费**；渲染逃生舱脚本文件） |

**`PipelineEntry`：**

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `types.ts:134`（相位内唯一） |
| `pipeline` | string | **必填** | — | `:135`（`<id>:pipelines/X.json` / `pipelines/Y.json` / `/abs` / `graph.json`） |
| `enabled` | boolean | **必填** | — | `:136`（false 仍编译但不画） |
| `kind` | string | 可选 | — | `:137`（`'compute'`/`'shaderGraph'`/自由标签） |
| `params` | `Record<string, number[]>` | 可选 | — | `:138`（后处理参数，`fullscreenParam` bind group） |
| `texture` | string | 可选 | — | `:139`（遗留纹理资产） |
| `input` | string | 可选 | — | `:140`（后处理源 target，默认 `scene`/前一输出） |
| `output` | string | 可选 | — | `:141`（后处理目标 target，默认下一 transient 或 `screen`） |

```json
{
  "name": "MainRenderGraph",
  "clearColor": [0.06, 0.06, 0.14, 1.0],
  "phases": {
    "Opaque": [
      { "name": "PbrSolid", "pipeline": "core:pipelines/PbrPipeline.json", "enabled": true }
    ],
    "Postprocess": [
      { "name": "Tint", "pipeline": "core:pipelines/TintPipeline.json", "enabled": false, "params": { "tint": [1.0, 0.6, 0.4, 1.0] }, "input": "scene", "output": "ppA" },
      { "name": "Invert", "pipeline": "core:pipelines/InvertPipeline.json", "enabled": false, "input": "ppA", "output": "screen" }
    ]
  }
}
```

### C4. `tools.json` — 交互工具配置

数组，每项 `ToolConfig`（`SceneTool.ts:4-13`）。**仅编辑器加载**。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `type` | string | 二选一 | — | 已注册工具类型（如 `'pick'`）；与 `source` 互斥 |
| `source` | string | 二选一 | — | 脚本路径（`scripts/myTool.js`）；与 `type` 互斥 |
| `enabled` | boolean | 可选 | `true` | false 跳过 |
| 其他 | unknown | 可选 | — | 工具特定字段（如 `button`/`selectEvent`） |

```json
[
  { "type": "pick", "enabled": true, "button": 0, "selectEvent": "pick" }
]
```

### C5. `ui-config.json` — App 自定义 UI 脚本

数组，每项（`UIManager.ts:74-78`）。**仅编辑器加载**，player 不加载。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `id` | string | **必填** | — | 层标识（DOM container id） |
| `source` | string | **必填** | — | 脚本路径（`ui/demoHUD.js`），Blob import |
| `container` | string | 可选 | — | CSS selector；缺省则建 `<div id="ui-<id>">` |

- 模块 default export 必须是 `mount(container: HTMLElement, host: AppHost) => () => void`（返回 unmount）。

```json
[
  { "id": "demo-hud", "source": "ui/demoHUD.js", "container": "#hud-container" }
]
```

### C6. `graph.json` — 着色器图（compute 节点图）

由 `render.json` `kind: "shaderGraph"` entry 引用。`ShaderGraph`（`shaderGraph.ts:32`）：

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `:33`（注册名） |
| `query` | string[] | 可选 | `[]` | `:34`（实体必须有的组件） |
| `nodes` | `ShaderGraphNode[]` | **必填** | — | `:35` |
| `edges` | `ShaderGraphEdge[]` | **必填** | — | `:36` |

**节点 5 变体（`type` 区分）：**

| type | 额外字段 |
|------|----------|
| `data` | `source`（`'Component.field'` u32 句柄 或 `'buffer:<name>'`）/ `kind`（`'storage'\|'uniform'\|'vertex'`）/ `stride?` / `allocCount?`（值源，懒分配输出 storage buffer） |
| `shader` | `shader`（WGSL ref）/ `entryPoint` / `workgroupSize?`（默认 64）/ `count`（值源，dispatch 数） |
| `if` | `condition`（标量组件字段，非零=true） |
| `foreach` | `count`（组件字段）/ `index?`（值源覆盖 `vctx.eid`） |
| `loop` | `iterations`（数字字面量或组件字段） |

节点都有可选 `position?: { x, y }`（仅编辑器布局）。

**边 `ShaderGraphEdge`：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | **必填** | |
| `source` | string | **必填** | |
| `sourceHandle` | `'out'\|'body'\|'next'` | **必填** | `out`=数据/buffer；`body`=控制体；`next`=续接 |
| `target` | string | **必填** | |
| `targetHandle` | string | **必填** | `'in:<binding>'`（shader 绑定槽）或 `'body'` |

```json
{
  "name": "DemoGraph",
  "query": ["GraphDemoComponent"],
  "nodes": [
    { "id": "out",       "type": "data",   "source": "buffer:graphOut", "kind": "storage", "stride": 4, "allocCount": "GraphDemoComponent.count" },
    { "id": "ifEnabled", "type": "if",     "condition": "GraphDemoComponent.enabled" },
    { "id": "loopIters", "type": "loop",   "iterations": "GraphDemoComponent.iterations" },
    { "id": "counter",   "type": "shader", "shader": "shaders/Counter.wgsl", "entryPoint": "main", "workgroupSize": 64, "count": "GraphDemoComponent.count" }
  ],
  "edges": [
    { "id": "e1", "source": "out",       "sourceHandle": "out",  "target": "counter",   "targetHandle": "in:0" },
    { "id": "e2", "source": "ifEnabled",  "sourceHandle": "body", "target": "loopIters", "targetHandle": "body" },
    { "id": "e3", "source": "loopIters",  "sourceHandle": "body", "target": "counter",   "targetHandle": "body" }
  ]
}
```

> 着色器契约见 [code-conventions.md §着色器图](./code-conventions.md#着色器图shader-graph)。

### C7. App `components.json` — App 私有组件 schema

schema 同 [A2](#a2-components--ecs-组件-schema)，owner `'app:<name>'`，切 app 清扫。由 `app.json` `components[]` 引用。

```json
[
  { "name": "GameStateComponent", "fields": {
    "ballSpeed": { "type": "f32", "default": 18.0 },
    "score":     { "type": "u32", "default": 0 } } }
]
```

### C8. App `systems.json` — 系统顺序覆写

数组，每项：

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `Engine.ts:52`（必须能 resolve） |
| `def` | string | 可选 | `systems/<name>.json` | `:53`（system def 文件路径） |

- **带自带 systems.json → 显式覆写优先，不自动插入**（所有 system 必须显式列）。
- `assertSystemsResolve` 在 app 装载时校验所有 `name` 能 resolve，否则 throw。

```json
[
  { "name": "input" }, { "name": "orbitCamera" }, { "name": "script" },
  { "name": "physics" }, { "name": "camera" }, { "name": "light" },
  { "name": "animation" }, { "name": "gaussianSplat" }, { "name": "render" }
]
```

---

## D. Common 级 JSON

位于 `public/common/`。

### D1. `engine-config.json` — 引擎配置

`Engine.init` 装载一次。缺失 → 警告 + 用 `DEFAULT_ENGINE_CONFIG`；malformed → throw。

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `dataRoot` | string | **必填** | `/common` | `Engine.ts:59` |
| `appsRoot` | string | **必填** | `/apps` | `:60` |
| `defaultApp` | string | **必填** | `demo1` | `:61` |
| `renderScriptsSubdir` | string | **必填** | `scripts` | `:62`（dataRoot 下的渲染脚本子目录） |
| `computeTgs` | number | **必填** | `64` | `:63`（默认 compute workgroup size） |
| `alphaMode` | GPUCanvasAlphaMode | **必填** | `premultiplied` | `:64` |
| `systemOrder` | string[] | **必填** | `[input,script,physics,camera,light,animation,render]` | `:65`（仅 systems.json 缺失时的兜底） |
| `scriptHooks` | string[] | **必填** | `[init,update]` | `:66`（脚本系统可导出的 hook） |
| `pluginsRoot` | string | 可选 | `/plugins` | `:67` |
| `plugins` | string[] | 可选 | `[]` | `:68`（引擎级常驻插件） |

```json
{
    "dataRoot": "/common",
    "appsRoot": "/apps",
    "defaultApp": "demo1",
    "renderScriptsSubdir": "scripts",
    "computeTgs": 64,
    "alphaMode": "premultiplied",
    "systemOrder": ["input", "script", "physics", "camera", "light", "animation", "render"],
    "scriptHooks": ["init", "update"],
    "pluginsRoot": "/plugins",
    "plugins": ["core", "physics", "particles", "sprite"]
}
```

### D2. `systems.json`（common）— 默认帧顺序

schema 同 [C8](#c8-app-systemsjson--系统顺序覆写)。`Engine.init` 装载为 `commonSystems`；app 无自带 systems.json 时用它 + autoInsert。

```json
[
  { "name": "input" }, { "name": "script" }, { "name": "physics" },
  { "name": "camera" }, { "name": "light" }, { "name": "animation" },
  { "name": "render" }
]
```

### D3. `gltf-mapping.json` — glTF → 组件字段映射

`Engine.init` 装载。app 用 `gltf` 时必需，否则 `Engine.loadGltf` throw。

| 字段 | 类型 | 必填 | 锚点 |
|------|------|------|------|
| `transform.component` | string | **必填** | `Engine.ts:22` |
| `transform.fields` | `Record<gltfField, compField>` | **必填** | `:23`（键：`position`/`rotation`/`scale`） |
| `mesh.component` | string | **必填** | `:25` |
| `mesh.field` | string | **必填** | `:26`（组件 mesh 名字段） |
| `material.component` | string | **必填** | `:28` |
| `material.fields` | `Record<gltfScalar, compField>` | **必填** | `:29`（如 `baseColorFactor → baseColor`） |
| `material.textures` | `Record<gltfTexSlot, compTexField>` | **必填** | `:30`（如 `baseColorTexture → texBaseColor`） |

```json
{
  "transform": { "component": "Transform", "fields": { "position": "position", "rotation": "rotation", "scale": "scale" } },
  "mesh": { "component": "MeshComponent", "field": "mesh" },
  "material": {
    "component": "PbrMaterial",
    "fields": { "baseColorFactor": "baseColor", "metallicFactor": "metallic", "roughnessFactor": "roughness", "aoStrength": "ao", "emissiveFactor": "emissive" },
    "textures": { "baseColorTexture": "texBaseColor", "metallicRoughnessTexture": "texMetalRough", "occlusionTexture": "texOcclusion", "emissiveTexture": "texEmissive", "normalTexture": "texNormal" }
  }
}
```

---

## E. 管线 / 着色器 JSON

位于 `public/plugins/<id>/pipelines/`、`public/apps/<name>/pipelines/`。由 `render.json` 经虚拟路径或相对路径引用。

### E1. 渲染管线 JSON — `PipelineConfig`

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `types.ts:33` |
| `vertex` | `{ shader; entryPoint; input? }` | **必填** | — | `:34`（`shader`=相对/虚拟 ref；`input`=vertex-inputs.json 名） |
| `fragment` | `{ shader; entryPoint }` | 可选 | — | `:35`（省略=仅深度） |
| `primitive` | `{ topology; cullMode; frontFace? }` | **必填** | — | `:37`（`topology`=`triangle-list`/`line-list`/`point-list`...；`cullMode`=`none`/`front`/`back`；`frontFace` 默认 `ccw`） |
| `vertexLayouts` | `VertexLayoutConfig[]` | 可选 | — | `:41`（显式 `GPUVertexBufferLayout[]`，`vertex.input` 缺席时用） |
| `vertexLayout` | `VertexLayoutConfig` | 可选 | — | `:44`（单 layout） |
| `depthStencil` | `{ format?; ... } \| false` | **必填** | — | `:46`（`false`=无深度） |
| `blend` | string \| `GPUBlendState` | 可选 | — | `:48`（预设名 OR 内联） |
| `targets` | `{ format? }[]` | 可选 | — | `:49`（MRT 每 target 格式；`'default'`=swapchain） |
| `bindLayout` | string[] | 可选 | — | `:51`（命名 bind group layout，`@group` 顺序） |
| `layout` | `'auto' \| GPUPipelineLayoutDescriptor` | 可选 | `'auto'`（bindLayout 缺席时） | `:52` |
| `renderer` | `RendererDecl` | 可选 | — | `:53`（声明式 draw 块，见 [E3](#e3-rendererdecl--声明式-renderer-块内嵌于管线-json)） |

**`VertexLayoutConfig`：** `{ arrayStride; stepMode?='vertex'; attributes: { format; offset; shaderLocation }[] }`。

```json
{
  "name": "TestMeshPipeline",
  "vertex": { "shader": "../shaders/TestMesh.wgsl", "entryPoint": "vs", "input": "pos3" },
  "fragment": { "shader": "../shaders/TestMesh.wgsl", "entryPoint": "fs" },
  "primitive": { "topology": "triangle-list", "cullMode": "none" },
  "depthStencil": { "format": "depth24plus", "depthWriteEnabled": true, "depthCompare": "less" },
  "bindLayout": ["frame", "object"],
  "renderer": { "query": ["MeshComponent","TestMeshRender"], "phase": "Opaque",
                "target": { "color": "scene", "depth": "sceneDepth" }, "tag": "TestMeshRender",
                "geometry": { "steps": [{ "vertexBuffers": [{ "slot": 0, "source": "meshSlots", "mesh": "MeshComponent.mesh" }], "indexBuffer": { "mesh": "MeshComponent.mesh" }, "draw": { "type": "drawIndexed", "countField": "MeshComponent.indexCount" } }] },
                "bindGroups": [{ "group": 1, "uniform": { "layoutRef": "perEntity", "writes": [{ "member": "model", "value": "transform.model" }, { "member": "color", "value": "tag.color" }] } }] }
}
```

> `renderer` 块完整 schema 见 [E3](#e3-rendererdecl--声明式-renderer-块内嵌于管线-json)。

### E2. 计算管线 JSON — `ComputePipelineConfig`

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `name` | string | **必填** | — | `types.ts:55` |
| `compute` | `{ shader; entryPoint }` | **必填** | — | `:56` |
| `workgroupSize` | number | 可选 | `engine-config.computeTgs`(64) | `:57`（**CPU dispatch 数学用**；GPU 用 shader 的 `@workgroup_size`——二者应一致） |
| `bindLayout` | string[] | 可选 | — | `:58` |
| `layout` | `'auto' \| ...` | 可选 | `'auto'` | `:59` |
| `countField` | string | 可选 | `count` | `:60`（per-item count 读自该组件字段） |
| `bindings` | `ComputeBindingDecl[]` | 可选 | — | `:61`（声明式 `@group(0)` 绑定；`ctx.dispatchCompute(name, count, undefined, eid)` 自动解析） |

**`ComputeBindingDecl`：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `binding` | number | **必填** | — | `@binding(N)` |
| `source` | `'storage'\|'uniform'\|'timeInput'\|'storageTexture'\|'texture'` | **必填** | — | storage=per-entity SSBO；uniform=打包 UBO；timeInput=全局 TimeInput UBO；storageTexture=写/读写 storage 纹理；texture=只读采样纹理 |
| `key` | string | 可选 | — | buffer 缓存 key 前缀（后缀实体 id） |
| `stride` | number | 可选 | — | storage：每项字节 |
| `strideLayout` | string | 可选 | — | storage：uniform-layouts 名，byteSize × count |
| `pack` | string[] | 可选 | — | uniform：打包值（组件字段名或 `$time`/`$count`/数字字面量） |
| `texture` | string | 可选 | — | storageTexture/texture：纹理引用。`renderTarget:<name>`（仅 texture；render target 无 STORAGE_BINDING 用法故 storageTexture 引用会 throw）/ `asset:<path>`（相对 dataRoot）/ `<Component>.<field>`（per-eid u32 句柄）/ `<namedKey>`（resourceManager.getTexture key） |
| `access` | `GPUStorageTextureAccess` | 可选 | `'write-only'` | storageTexture：访问模式 |
| `viewDimension` | `GPUTextureViewDimension` | 可选 | `'2d'` | storageTexture/texture：视图维度 |

> **纹理大小无需额外 UBO**：WGSL `textureDimensions(myStorageTex)` 在 shader 内直接查询 storage 纹理尺寸。其他标量参数（笔刷颜色/半径等）走 `uniform` source 的 `pack`。
> **解析器**：`resolveComputeBindings(bindings, ctx)`（`src/core/render/computeBindings.ts`，经 `@shaderlab/api` 导出）按 per-eid 上下文解析所有 source 为 `GPUBindGroupEntry[]`。`Engine.dispatchCompute` 在 `entries` 缺席 + `eid` 提供 + pipeline 有 `bindings` 时自动调用。

```json
{
  "name": "ParticleSimPipeline",
  "compute": { "shader": "../shaders/ParticleSim.wgsl", "entryPoint": "main" },
  "workgroupSize": 64,
  "bindLayout": ["particleSim"]
}
```

**storageTexture 示例（GPU 端纹理编辑）**：
```json
{
  "name": "PaintComputePipeline",
  "compute": { "shader": "../shaders/Paint.wgsl", "entryPoint": "main" },
  "workgroupSize": 8,
  "bindLayout": ["textureEditCompute"],
  "countField": "CanvasComponent.width",
  "bindings": [
    { "binding": 0, "source": "storageTexture", "texture": "CanvasComponent.texHandle", "access": "read-write" },
    { "binding": 1, "source": "uniform", "key": "brush", "pack": ["BrushComponent.color", "BrushComponent.radius", "BrushComponent.opacity"] },
    { "binding": 2, "source": "timeInput" }
  ]
}
```

### E3. `RendererDecl` — 声明式 renderer 块（内嵌于管线 JSON）

| 字段 | 类型 | 必填 | 默认 | 锚点 |
|------|------|------|------|------|
| `query` | string[] | 可选 | — | `rendererDecl.ts:10`（实体必须有的组件；省略=画一次 fullscreen） |
| `phase` | string | **必填** | — | `:11`（phases.json 名） |
| `target` | `{ color?: string\|string[]; depth?: string }` | 可选 | `screen` | `:12`（`screen`=swapchain，`none`=无，否则 render-targets.json 名；color[] for MRT） |
| `tag` | string | 可选 | — | `:13`（render-tag 组件，其 `role:'color'/'extra'` 字段被 `tag.color`/`tag.extra` 读） |
| `filter` | `{ component; field; value }` | 可选 | — | `:14`（per-entity 过滤：字段 ≠ 值则跳过） |
| `transparent` | boolean | 可选 | `false` | `:15`（true=远→近 painter's；默认近→远 early-z） |
| `instanced` | boolean | 可选 | `false` | `:16`（true=所有匹配实体 batch 成一次 `drawIndexed`，storage buffer of mat4；shader 须用 `@builtin(instance_index)` 索引） |
| `postProcess` | boolean | 可选 | `false` | `:17`（参与后处理 ping-pong，读 `$framebuffer`） |
| `geometry` | `GeometryDecl` | **必填**（无 hook 时） | — | `:18`（见下） |
| `bindGroups` | `BindGroupDecl[]` | 可选 | — | `:19`（per-draw bind group；group 0=frame 自动绑定当 `bindLayout[0]='frame'`） |
| `compute` | `{ script: string }` | 可选 | — | `:20`（compute stage，`script:<hookName>`） |
| `aux` | `Record<string, string>` | 可选 | — | `:21`（辅助资源经 `ctx.aux` 传 hook；`.json` 结尾值预装载为计算管线） |

**`GeometryDecl`：** `{ hook?: string } | { steps?: DrawStep[] }`（互斥）。

**`DrawStep`：** `{ vertexBuffers?: VertexBufferBinding[]; indexBuffer?: IndexBufferBinding; draw?: DrawCall }`。

| 子结构 | 字段 |
|--------|------|
| `VertexBufferBinding` | `slot`(必填) / `source`(`'meshSlots'\|'vbo'\|'meshField'` 必填) / `mesh?`(默认 `MeshComponent.mesh`) / `field?`(`meshField` 命名 buffer 如 `edgeBuffer`/`pointBuffer`) / `vbo?`(命名 VBO) |
| `IndexBufferBinding` | `mesh?`(默认 `MeshComponent.mesh`) |
| `DrawCall` | `type`(`'draw'\|'drawIndexed'` 必填) / `vertexCount?`(draw 默认 3) / `countField?`(值源，覆盖静态) / `instanceCount?`(draw 默认 1) / `instanceCountField?`(值源) |

**`BindGroupDecl`：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `group` | number | **必填** | — | `@group` 索引；layout = `pipeline.bindLayout[group]` |
| `uniform` | `{ layoutRef; binding?=0; writes: { member; value }[] }` | 可选 | — | `layoutRef`=uniform-layouts.json 名；`value`=值源 mini-DSL |
| `samplers` | `{ binding; name?='default' }[]` | 可选 | — | |
| `textures` | `{ binding; source; fallback? }[]` | 可选 | — | `source`=`Comp.field`(tex 句柄)\|`renderTarget:<name>`\|`asset:<path>`\|`builtin:...`；`fallback`=fallback-textures.json 名 |
| `resources` | `{ binding; source }[]` | 可选 | — | 共享 GPU 资源；`source` 必须为 `resource:<name>`，类型必须与 bind layout binding 匹配 |

**值源 mini-DSL**（`value`/`source`/`countField`/`instanceCountField` 串）：

| 形式 | 解析为 |
|------|--------|
| `Comp.field` | 组件字段（标量或向量） |
| `pack:a,b,c,0` | 拼接各 atom 的扁平 `number[]` |
| `const:a,b,c` | 数字字面量数组 |
| `<number>` | 数字字面量 |
| `transform.model` / `transform.normalMatrix` | 实体变换矩阵 |
| `builtin.entityId\|time\|dt\|aspect\|screenW\|screenH` | 引擎内置 |
| `tag.color` / `tag.extra` | render-tag 组件字段 |
| `script:<name>` | 逃生舱 hook |
| 纹理源额外：`renderTarget:<name>` / `asset:<path>`（按 dataRoot） | |

> 完整 mini-DSL 语义见 [code-conventions.md §值原子](./code-conventions.md#值原子value-atom--mini-dsl)。

**完整示例（PbrPipeline 的 renderer 块）：**
```json
"renderer": {
  "query": ["MeshComponent","PbrMaterial"],
  "phase": "Opaque",
  "target": { "color": "scene", "depth": "sceneDepth" },
  "geometry": {
    "steps": [{ "vertexBuffers": [{ "slot": 0, "source": "meshSlots", "mesh": "MeshComponent.mesh" }],
                "indexBuffer": { "mesh": "MeshComponent.mesh" },
                "draw": { "type": "drawIndexed", "countField": "MeshComponent.indexCount" } }]
  },
  "bindGroups": [
    { "group": 1, "uniform": { "layoutRef": "pbrObject", "writes": [
        { "member": "model",        "value": "transform.model" },
        { "member": "normalMatrix", "value": "transform.normalMatrix" },
        { "member": "entityId",     "value": "builtin.entityId" } ] } },
    { "group": 2, "uniform": { "layoutRef": "pbrMaterial", "writes": [
        { "member": "matParams", "value": "pack:PbrMaterial.metallic,PbrMaterial.roughness,PbrMaterial.ao,PbrMaterial.shadowReceive" },
        { "member": "emissive",  "value": "pack:PbrMaterial.emissive,0" } ] },
      "samplers": [{ "binding": 1, "name": "default" }],
      "textures": [
        { "binding": 2, "source": "PbrMaterial.texBaseColor", "fallback": "white" },
        { "binding": 3, "source": "PbrMaterial.texMetalRough", "fallback": "white" }
      ] }
  ]
}
```

**hook + aux + compute 示例（pbd）：**
```json
"renderer": {
  "query": ["PbdSoftBodyComponent"],
  "phase": "Opaque",
  "target": { "color": "scene", "depth": "sceneDepth" },
  "geometry": { "hook": "pbd.draw" },
  "compute": { "script": "pbd.simulate" },
  "aux": {
    "predict": "pbd:pipelines/PbdPredictPipeline.json",
    "solve":   "pbd:pipelines/PbdSolvePipeline.json",
    "apply":   "pbd:pipelines/PbdApplyPipeline.json",
    "integrate": "pbd:pipelines/PbdIntegratePipeline.json"
  }
}
```

---

## F. 插件消费的资产 JSON

schema 由插件定（非引擎），引擎不消费。

### F1. Sprite sheet JSON — `SheetData`

**位置**：app 私有，由 `SpriteSheetComponent.sheet` 引用（如 `public/apps/demo4_spriteSheet/sheets/spritesheet.json`）。

| 字段 | 类型 | 必填 | 锚点 |
|------|------|------|------|
| `texture` | string | **必填** | `SpriteSystem.ts:7`（纹理路径，相对 app base 或绝对） |
| `columns` | number | **必填** | `:8`（网格列数） |
| `rows` | number | **必填** | `:9`（网格行数） |
| `animations` | `SheetAnimation[]` | **必填** | `:10` |

**`SheetAnimation`：** `{ name; row; frames; fps; loop: 'pingpong'\|'loop'\|'once' }`。

```json
{
  "texture": "textures/spritesheet.webp",
  "columns": 8, "rows": 9,
  "animations": [
    { "name": "row0", "row": 0, "frames": 6, "fps": 6, "loop": "loop" },
    { "name": "row5", "row": 5, "frames": 8, "fps": 6, "loop": "pingpong" }
  ]
}
```

### F2. PBD softbody 资产 JSON

**位置**：app 私有，由 `PbdSoftBodyComponent.asset` 引用（如 `public/apps/demo9_softBody/softbody_asset.json`）。

- 由 `generate_softbody.py`/`.mjs` 预烘焙。
- **schema 未在引擎 TS 接口锚定**——由 `PbdManager.loadAsset` 消费，含粒子位置/表面索引/簇拓扑。具体字段以烘焙脚本为准。
- **状态：需进一步验证**——如要写新 softbody 资产，看 `public/plugins/pbd/PbdManager.ts` 的 `loadAsset` 实现。

---

## 跨切约定

### 虚拟路径

| 形式 | 解析 |
|------|------|
| `<plugin>:<rest>` | `PipelineLoader.pluginRef` 正则 `/^([A-Za-z0-9_-]+):(?!\/)(.+)$/` → `/plugins/<plugin>/<rest>` |
| `renderTarget:<name>` | 纹理源前缀 → 命名渲染目标 |
| `asset:<path>` | 纹理源前缀 → 按 `engine-config.dataRoot` |
| `sampler:<name>` | bind-layouts `resource` 前缀 → 命名 sampler |
| `buffer:<name>` | 着色器图 data node `source` 前缀 → BufferRegistry 命名 buffer |
| `script:<baseName>.<export>` | 值源前缀 → render hook（render-scripts 文件或插件 `renderHooks`） |

### owner 标签与清扫

所有注册带 owner（`'engine'` | `'app:<id>'` | `'plugin:<id>'`）。跨 owner 重名 throw。卸载：
- app 卸载 → sweep `'app:<id>'` owner（组件/hook/driver/GPU 资源）
- 插件卸载 → sweep `'plugin:<id>'` owner（一切该插件注册的）

`PluginHostHelper.sweepOwner`（`src/core/PluginHost.ts:124-153`）编排：`ResourceManager.exitApp` / `BufferRegistry.exitApp` / `SystemRegistry.removeDefsByOwner` + `removeSystemsByOwner` / `SchemaRegistry.removeOwner` / `UniformLayoutRegistry.removeOwner` / `removeVertexSlotsByOwner` / `PipelineLoader.removeVirtualsByPrefix` + `removeInputsByOwner` + `removeBlendPresetsByOwner` / `RenderGraph.removeHooksByOwner` + `removePhaseBehaviorsByOwner` / attachments / 开放注册表（tools/generators/atoms/phases 经 `PluginLedger`）。

### fail-loud 触发点

- 缺声明文件（`init` fetch）throw（core 的 `load()` helper 查 `content-type` 防 Vite SPA fallback）
- 未知组件（scene.json）throw
- 未知相位键（render.json）throw（必须存在于 phases.json）
- 未知相位 behavior throw（execute 时）
- 未解析 system 名（systems.json）throw（`assertSystemsResolve`）
- 跨 owner 重名 throw
- 未知 mesh generator throw（meshes catalog）
- 未知 tool type throw（tools.json）
