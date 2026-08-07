# App 开发指南（Agent 友好）

本指南面向写**组合层**的 Agent/开发者：用纯 JSON 摆场景、挂管线、选插件，引擎零改动。能力不够时再去写 [插件](./plugin-development.md)。

> 字段级 schema 全在 [json-schemas.md](./json-schemas.md)。本指南讲**流程 + 模式 + 陷阱**。

## 一、App 是什么

一个 app = `public/apps/<name>/` 下的一个目录，至少有 `app.json`。其余文件由 `app.json` 引用。

```
public/apps/myapp/
├── app.json           # 必需：清单（选插件/场景/渲染/工具/UI）
├── scene.json         # 实体数据（默认名，可改）
├── render.json        # 渲染图（默认名）
├── components.json    # 可选：app 私有组件 schema
├── systems.json       # 可选：覆写系统顺序（不提供则用 common + autoInsert）
├── tools.json         # 可选：交互工具（仅编辑器加载）
├── ui-config.json     # 可选：自定义 UI 脚本（仅编辑器加载）
├── graph.json         # 可选：着色器图（render.json 用 kind:"shaderGraph" 引用）
├── pipelines/         # 可选：app 私有管线 JSON
├── shaders/           # 可选：app 私有 WGSL
└── scripts/           # 可选：游戏脚本 .js（ScriptComponent 引用）
```

切 app 时：app 级插件逆拓扑卸载 → owner `'app:<name>'`/`'plugin:<id>'` 清扫 → 新 app 装载。

## 二、最小可运行 app

三步：

**1. `public/apps/hello/app.json`：**
```json
{
  "name": "hello",
  "scene": "scene.json",
  "render": "render.json"
}
```

**2. `scene.json`（一个旋转立方体）：**
```json
{
  "Cube": {
    "Transform": { "position": [0, 0, -4], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
    "MeshComponent": { "mesh": "cube" },
    "TestMeshRender": { "color": [0.9, 0.4, 0.2, 1] },
    "Camera": { "fov": 60, "near": 0.1, "far": 100, "active": 1, "viewport": [0, 0, 1, 1] }
  }
}
```

**3. `render.json`（一条 PBR 管线 + 屏幕 target）：**
```json
{
  "name": "MainRenderGraph",
  "clearColor": [0.06, 0.06, 0.14, 1.0],
  "phases": {
    "Opaque": [
      { "name": "PbrSolid", "pipeline": "core:pipelines/PbrPipeline.json", "enabled": true }
    ]
  }
}
```

访问 `/apps/hello/app.json`（或编辑器切 app）即可。`core` 插件提供 PBR 管线、`cube` mesh、相机/光照系统都已就绪。

## 三、装载流程（Engine.loadApp）

理解流程有助于定位 fail-loud 错误：

1. 读 `app.json` → 解析字段。
2. 装载 app 级 `plugins[]`（逆拓扑卸载旧 app 的插件 → 装新插件：fetch → sucrase 剥类型 → Blob import → `init` → `applyDeclarations` → `setup`）。
3. 装载 app 级 `components[]`（`schemaRegistry.loadMore(url, 'app:<name>')`）。
4. 解析系统顺序：app 有 `systems.json` → 显式覆写；否则用 `common/systems.json` + `autoInsert`（把声明 `after`/`before` 的未列出 system 自动插入）。
5. 分配 buffers（`BufferRegistry.allocateFor(systems, appId)`）。
6. 加载 `scene` → `Scene.createEntity` 每个实体 → `resolveHandles` 填 `MeshComponent` GPU 句柄。
7. 加载 `render` → `RenderGraph.fromData` → `compile`（编译所有管线、着色器、shaderGraph、renderScripts）。
8. 广播 `appLoaded`（拓扑序）给所有插件；UIManager 装载 `ui` 脚本；编辑器装载 `tools`。

**任意一步失败 → throw，app 不进入活跃状态。** 排查顺序：看 throw 信息 → 检查对应 JSON 字段。

## 四、app.json 字段速查

| 字段 | 必需 | 默认 | 说明 |
|------|------|------|------|
| `name` | 可选 | 目录名 | 显示名（不强校验） |
| `plugins` | 可选 | `[]` | app 级插件 id 数组（切 app 卸载） |
| `components` | 可选 | `[]` | app 私有组件 schema 文件路径数组（相对 app base 或绝对） |
| `scene` | 可选 | `scene.json` | 场景文件 |
| `render` | 可选 | `render.json` | 渲染图文件 |
| `systems` | 可选 | `systems.json` | 系统顺序覆写；**缺失则用 common + autoInsert** |
| `tools` | 可选 | — | 交互工具配置（仅编辑器） |
| `gltf` | 可选 | `[]` | glTF 模型路径数组（需 `common/gltf-mapping.json`） |
| `ui` | 可选 | — | app 自定义 UI 配置（仅编辑器，UIManager 消费） |

> 字段级细节见 [json-schemas.md §C1](./json-schemas.md#c1-appjson)。

## 五、scene.json（实体数据）

结构：`{ <entityKey>: { <componentName>: { <fieldName>: <value> } } }`

- 顶层 key = 实体名（→ `NameComponent.name`，必须唯一）。
- 二层 key = 组件名（必须在 `schemaRegistry` 注册——core 的 `components.json` 或 app 的 `components.json`——否则 throw）。
- 三层 key = 字段名（按组件 schema；省略字段用 schema 默认值）。
- 值类型：标量→标量；`vec2/3/4`→`number[]`；`string`→字符串；`bool`→`0`/`1`（存为 u8）。

**示例（多组件实体，demo1）：**
```json
"FallingCube": {
  "Transform": { "position": [-1, 3, -2], "rotation": [0.2, 0.1, 0, 0.97], "scale": [0.5, 0.5, 0.5] },
  "MeshComponent": { "mesh": "cube" },
  "TestMeshRender": { "color": [0.9, 0.4, 0.2, 1] },
  "RigidBodyComponent": { "bodyType": "dynamic" },
  "ColliderComponent": { "shape": "cuboid", "halfExtents": [0.25, 0.25, 0.25], "restitution": 0.4 }
}
```

**陷阱：**
- `NameComponent` 自动加到每个实体（mandatory），不要手写。
- 字段名拼错 → throw（fail-loud）。组件名拼错 → throw。
- mesh 名（`MeshComponent.mesh`）必须在 `core/meshes.json` 或 glTF 资产里存在；装载后 `resolveHandles` 填 `hPos/hNormal/...` 句柄字段，**不要手写这些 `h*` 字段**。
- `bool` 字段用数字 `0/1`，不是 `true/false`。

## 六、render.json（渲染图）

结构：`{ name, clearColor?, phases: { <phaseName>: [ <PipelineEntry> ] }, multiView?, renderScripts? }`

```json
{
  "name": "MainRenderGraph",
  "clearColor": [0.06, 0.06, 0.14, 1.0],
  "phases": {
    "Preprocess": [],
    "Compute": [],
    "Opaque": [
      { "name": "PbrSolid", "pipeline": "core:pipelines/PbrPipeline.json", "enabled": true }
    ],
    "Transparent": [],
    "Skybox": [],
    "Postprocess": []
  }
}
```

**关键规则：**
- `phases` 的每个 key **必须**在 `core/phases.json` 注册（9 个相位：Preprocess/Compute/Shadow/GBuffer/Opaque/Skybox/Transparent/Postprocess/UI），否则 throw。可以省略某个相位（用 `Partial<PhaseMap>`），但不能写未注册的相位名。
- `PipelineEntry.pipeline` 路径解析：
  - `core:pipelines/X.json` → `/plugins/core/pipelines/X.json`（虚拟路径）
  - `pipelines/Y.json` → 相对 app base
  - `/abs/path.json` → 绝对
  - `graph.json` + `kind: "shaderGraph"` → 着色器图
- `enabled: false` 的 entry 仍编译（热重载友好），但跳过 driver。
- `multiView: true` → 每个活跃 Camera 独立渲染自己的 viewport（见 demo7）。

**PipelineEntry 字段：**

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 必需 | 实例名（相位内唯一） |
| `pipeline` | 必需 | 管线路径/虚拟 ref/graph.json |
| `enabled` | 必需 | `false` 仍编译但不画 |
| `kind` | 可选 | `"compute"` / `"shaderGraph"` / 自由标签 |
| `params` | 可选 | 后处理参数（`fullscreenParam` bind group） |
| `input`/`output` | 可选 | 后处理源/目标 target（`scene`/`ppA`/`ppB`/`screen`） |

> 后处理链由 `postprocess-chain` 相位行为驱动：第一个 enabled 读 `scene`，最后一个写 `screen`，中间在 `ppA`/`ppB` 之间 ping-pong（`render-targets.json` 的 `transient: true`）。

## 七、系统顺序（systems.json）

**两种模式：**

### 模式 A：用默认顺序 + autoInsert（推荐，简单 app）
不写 `systems.json`。引擎用 `common/systems.json`（`input/script/physics/camera/light/animation/render`），然后把声明了 `after`/`before` 的未列出 system 自动插入。例如 app 用了 `splat` 插件（`before: ['camera']`）和 `orbit` 插件（`after: ['animation']`），无需写 systems.json 就能正确插入。

### 模式 B：显式覆写（精确控制）
写 `public/apps/<name>/systems.json`：
```json
[
  { "name": "input" },
  { "name": "orbitCamera" },
  { "name": "script" },
  { "name": "physics" },
  { "name": "camera" },
  { "name": "light" },
  { "name": "animation" },
  { "name": "gaussianSplat" },
  { "name": "render" }
]
```
**带自带 systems.json → 不自动插入**，所有 system 必须显式列出（demo6 这样做）。`name` 必须能被 `systemRegistry.resolve` 解析（插件已 `registerSystem`），否则 `assertSystemsResolve` throw。

**陷阱：**
- `needs` 不驱动自动插入（仅顺序验证警告）；`after`/`before` 才驱动。
- 系统顺序权永远在 systems.json，插件只提供实现。
- 引擎级常驻插件（core/physics/particles/sprite）的系统默认在 common/systems.json 里；app 级插件的系统靠 autoInsert 或显式列。

## 八、常见模式

### 8.1 加一个 PBR 物体
scene.json 加实体：`Transform` + `MeshComponent.mesh` + `PbrMaterial`（baseColor/metallic/roughness/各贴图句柄）。render.json Opaque 相位挂 `core:pipelines/PbrPipeline.json`。见 demo1。

### 8.2 加后处理
render.json `Postprocess` 相位按顺序列管线，`input`/`output` 在 `scene`/`ppA`/`ppB`/`screen` 间串。`core` 提供 Tint/Invert/Greyscale 三条。见 demo1。

### 8.3 加阴影
Opaque/Skybox 里画场景，`Shadow` 相位挂 `core:pipelines/ShadowPipeline.json`（`shadow-clear` 行为会清深度+画阴影）。scene.json 加 `LightComponent`（type=directional/point）。见 demo3。

### 8.4 加粒子
scene.json 加 `ParticleSystemComponent`（maxParticles/gravity/drag）+ `EmitterComponent`（shape/rate/direction...）。render.json `Transparent` 相位挂 `particles:pipelines/ParticlePipeline.json`。见 demo1。

### 8.5 加游戏脚本
写 `scripts/foo.js`（`export function init(ctx)` / `export function update(ctx)`）。scene.json 实体加 `ScriptComponent: { script: "scripts/foo.js", enabled: 1 }`。脚本 API 见 [code-conventions.md §游戏脚本](./code-conventions.md#游戏脚本scriptcomponent)。

### 8.6 加自定义 UI HUD
写 `ui/hud.js`（`export default function mount(container, host) { ...; return () => unmount; }`）。`ui-config.json` 列条目。app.json `ui` 指向它。仅编辑器加载。见 demo1。

### 8.7 加交互工具
app.json `tools` 指向 `tools.json`。`tools.json` 列 `{ type: "pick", enabled: true, ... }`（type 由插件注册，physics 提供 `pick`）。仅编辑器加载。见 demo1。

### 8.8 用 app 私有组件
写 `components.json`（schema 同 core 的）。app.json `components: ["components.json"]`。owner `'app:<name>'`，切 app 清扫。见 demo2 的 GameStateComponent。

### 8.9 用 app 私有管线/着色器
`public/apps/<name>/pipelines/X.json` + `shaders/X.wgsl`。render.json `pipeline: "pipelines/X.json"`（相对 app base）。着色器引用相对管线文件目录（`../shaders/X.wgsl`）。见 demo5 的 GBuffer/DeferredLight。

### 8.10 用着色器图（compute 节点图）
写 `graph.json`（data/shader/if/foreach/loop 节点 + edges）。render.json Compute 相位 `{ pipeline: "graph.json", kind: "shaderGraph", enabled: true }`。见 demo10。schema 见 [json-schemas.md §C6](./json-schemas.md#c6-graphjson)。

### 8.11 用 app 私有插件
写 `public/plugins/myfx/index.ts`（见 [plugin-development.md](./plugin-development.md)）。app.json `plugins: ["myfx"]`。切 app 逆拓扑卸载。

### 8.12 加载 glTF
app.json `gltf: ["../../assets/models/X.glb"]`。路径相对 app base。`common/gltf-mapping.json` 把 glTF 字段映射到 `Transform`/`MeshComponent`/`PbrMaterial`。见 demo1。

## 九、调试与 fail-loud 触发点

| 错误信息 | 原因 | 修复 |
|----------|------|------|
| `Unknown component 'X'` | scene.json 用了未注册的组件 | 检查 `core/components.json` 或 app `components.json` 是否声明 |
| `Unknown phase 'X'` | render.json phases 键拼错 | 必须 9 个相位之一 |
| `Phase behavior 'X' not registered` | phases.json `behavior` 名错 | `normal`/`shadow-clear`/`postprocess-chain` 或插件注册的名 |
| `System 'X' did not resolve` | systems.json 列了未注册的 system | 检查插件是否 `registerSystem` 该名 |
| `cross-owner re-register 'X'` | 重名声明 | 组件/管线/uniform 名跨 owner 冲突 |
| `mesh generator 'X' unknown` | meshes.json 引用未知 generator | core 提供 triangle/cube/icosphere/uvsphere/pbrCube/pbrIcosphere/pbrUvSphere/pbrPlane |
| `tool type 'X' unknown` | tools.json 用未注册工具类型 | 检查插件是否 `registerToolType` 该名 |
| `bare import ... not allowed` | 插件 TS 用了裸导入 | 只能 `@shaderlab/api` + 相对 `.ts` |
| fetch 报 SPA fallback | 插件 `init` fetch 共置文件 404 | 检查文件路径/扩展名 |

**校验命令：**
- `npm run dev` → 浏览器开 app，看 console
- `node scripts/validate-config.mjs` → 静态校验组合层（场景组件、管线引用、hook 可达、插件存在等）
- `node scripts/smoke-plugin-loader.mjs` → 插件装载冒烟
- `npm run verify` → 一键全量（build + check:plugins + test + validate + smoke）

## 十、Agent 操作清单（写新 app 时）

1. 决定 app 名 → 建 `public/apps/<name>/`。
2. 列出需要的插件（engine 级常驻无需列；app 级写进 `app.json` `plugins`）。
3. 写 `app.json`（至少 name/scene/render）。
4. 写 `scene.json`（实体；相机实体必须有 `Camera.active: 1`）。
5. 写 `render.json`（至少一个 Opaque 管线 + 屏幕 target；不画就空数组相位）。
6. 如需 app 私有组件 → `components.json` + app.json `components`。
7. 如需 app 私有管线/着色器 → `pipelines/` + `shaders/`。
8. 如需游戏脚本 → `scripts/*.js`（**.js 不是 .ts**）。
9. 如需自定义 UI → `ui-config.json` + `ui/*.js` + app.json `ui`。
10. 如需工具 → `tools.json` + app.json `tools`。
11. 如需覆写系统顺序 → `systems.json`（否则靠 autoInsert）。
12. 跑 `npm run verify`；浏览器看效果。

**最简参考**：demo1（最全）/ demo2（脚本+私有组件）/ demo7（multiView）。
