# AGENTS.md — ShaderLab-WebGPU

## 项目目标

构建一个**数据驱动的图形引擎**。所有渲染管线、组件结构、场景数据均由 JSON 配置文件驱动，运行时从 `public/common/` 加载，无需硬编码。核心原则：**配置即逻辑，数据即场景**。

引擎 TS 代码只提供**机制**（解析器、调度器、执行器），不提供**内容**（固定值、闭枚举、固定流程分支）。所有可变参数、资源规格、执行顺序、绘制流程均由 JSON 声明。

## 构建 / 运行 / 测试

| 命令               | 用途                                         |
| ------------------ | -------------------------------------------- |
| `npm run dev`      | 启动 Vite 开发服务器（自动打开浏览器）       |
| `run.bat`          | Windows 下等同于 `npm run dev`               |
| `npm run build`    | `tsc` 类型检查，然后 `vite build` 到 `dist/` |
| `npm run preview`  | 本地预览生产构建                             |

当前**没有配置测试运行器、Linter 或格式化工具**。唯一的静态检查是 `tsc`（通过 `npm run build`）。添加新代码后，至少确保 `npm run build` 通过。

## 项目架构

深度设计文档见 `ARCHITECTURE.md`（子系统细节）。以下是 agent 常踩坑的结构要点。

```
src/
  main.ts             入口 — 启动引擎、两个编辑器面板、标签页、渲染循环
  Engine.ts           核心协调器：GPU 初始化 + 装配所有系统 + 帧循环（system order 由 engine-config.json 驱动）
  math.ts             mat4 / TRS / 相机矩阵纯函数
  ecs/
    Scene.ts          bitecs world 封装、实体 CRUD、字段读写、相机矩阵
    SchemaRegistry.ts  组件 Schema 注册表（模块单例）
    ScriptSystem.ts    .js 资产脚本（hooks 由 engine-config.json 声明）
    InputSystem.ts     指针/键盘输入 → EventBus + TimeInput UBO
    PhysicsSystem.ts   Rapier3D 物理（Transform ↔ 刚体同步、射线拾取、debug draw）
    CameraSystem.ts    收集 active Camera → cameraUBO（布局由 uniform-layouts.json 声明）
    LightSystem.ts     收集 LightComponent + ambient → lightUBO（含 shadow viewProj）
    AnimationSystem.ts 关键帧动画资产系统（setBaseDir/clear，assets 相对 app base）
  render/
    types.ts          渲染图 / 管线类型定义（PhaseDecl、PipelineEntry、ComputeBindingDecl 等）
    rendererDecl.ts   renderer 声明块类型（geometry/steps/bindings/compute 等）
    RenderGraph.ts    渲染图执行引擎（相位调度由 phases.json 驱动）
    ResourceManager.ts GPU 资源管理（模块单例）
    PipelineLoader.ts  从 JSON 加载渲染 / 计算管线（含 blend-presets 加载）
    UniformLayout.ts  std140 uniform 块布局（模块单例 uniformLayouts，支持 write/writeU32）
    Primitives.ts     网格生成器 + meshGenerators 注册表
    vertexSlots.ts    SoA 顶点槽定义（从 vertex-slots.json 加载）
    PipelineDriver.ts 声明式管线执行器（draw steps、bind groups）
    ParticleManager.ts GPU 粒子系统（UBO 布局由 uniform-layouts.json 声明）
    GaussianSplatManager.ts 3DGS 高斯泼溅管理器（PLY→storage buf + radix 排序 + model UBO）
    RenderScriptLoader.ts 渲染逃生舱脚本加载器
    valueResolver.ts  值源 mini-DSL（pack/const/script/transform/builtin/tag）
  events/
    EventBus.ts       轻量发布订阅（on/emit）
    eventTypes.ts     事件类型常量集中定义（EVENT_TYPES）
  tools/              可选交互工具（ToolSystem + SceneTool + PickTool）
  gltf/               GltfLoader（.glb → 网格 + PBR 材质 + 纹理）
  gs/                 3DGS PLY 解析器（SplatLoader.ts → centers/colors/covariances GPU 数组）
  editor/
    EditorPanel.ts    场景编辑器面板；PipelinePanel.ts 渲染图面板；dom.ts 工厂
  types/bitecs-legacy.d.ts  bitecs/legacy 环境类型声明
public/
  common/             引擎共用资产（所有 app 共享）
    engine-config.json  引擎级配置（路径、默认 app、computeTgs、alphaMode、systemOrder、scriptHooks）
    components.json   ECS 组件 Schema 定义（基础集，app 可 loadMore 追加）
    phases.json       渲染相位定义（name + order + behavior）
    vertex-slots.json SoA 顶点槽定义（location/format/stride/components）
    vertex-inputs.json 命名顶点输入布局（管线 vertex.input 引用）
    bind-layouts.json  命名 GPUBindGroupLayout（管线 bindLayout 引用）
    uniform-layouts.json 命名 uniform 块布局（含 camera/light/timeInput/particle* 引擎 UBO）
    samplers.json     命名 GPUSampler 描述符（fail-loud：未声明则 throw）
    render-targets.json 命名 render target（color/depth + size 声明 + transient 标志）
    blend-presets.json 命名混合状态（opaque/alpha/additive，可扩展）
    fallback-textures.json 命名 1x1 fallback 纹理（white/normal，可扩展）
    vbo-presets.json  命名 VBO（quad 等）
    meshes.json       预置网格目录（name + generator + params）
    gltf-mapping.json glTF → 组件字段映射声明
    systems.json      声明式 system 有序清单（name + def 指向 systems/<name>.json，数组顺序=帧运行顺序；app 可覆盖）
    systems/*.json    system 定义（source/components/ubos/buffers/needs）
    pipelines/*.json   管线配置（渲染 + 计算，内嵌 renderer 声明块）
    shaders/*.wgsl     WGSL 着色器
    scripts/render/*.js 渲染逃生舱脚本（value/geometry/compute 钩子）
    textures/*.png     纹理资产
  apps/<name>/        app-specific 资产（每个 demo 一套）
    app.json          app 清单（components/scene/render/systems/tools/gltf 声明）
    scene.json        场景实体数据
    render.json       渲染图配置（加载清单 + renderScripts + clearColor + post-process input/output）
    systems.json      app system 顺序覆盖（整体取代 common 列表；缺失 = 用 common 默认）
    systems/*.json    app 专属 system 定义（如 demo6 的 gaussianSplat）
    tools.json        可选交互工具配置（缺失 = 无工具，全部 opt-in）
    components.json   app 追加的组件定义（可选，如 demo6 的 GsComponent）
    scripts/*.js       app 脚本资产（导出 update(ctx)）
assets/               源素材（glb/skybox）— 不会被 serve！必须复制到 public/ 下才能加载

app 切换：URL `?app=<name>`（默认由 engine-config.json 的 defaultApp 指定）；引擎 `loadApp(name)` 读 `/apps/<name>/app.json`。
common 资产始终从 `/common/` 加载，app 资产从 `/apps/<name>/` 加载。
scene 里 ScriptComponent.script 用 web 根绝对路径（如 `apps/demo2/scripts/game.js`）。
```


## TypeScript / 代码风格

### 导入

- **仅相对导入** — 没有配置路径别名（`@/` 等）。
- 类型专用导入使用 `import type`：
  ```ts
  import type { Scene } from '../ecs/Scene';
  import { Engine } from './Engine';
  ```
- 导入顺序：外部库 → 内部模块 → 类型专用导入。

### 格式化

- **4 空格缩进**（不用 Tab）。
- 字符串使用**单引号**，语句末尾必须有分号。
- 多行对象/数组末尾加逗号。
- 行宽无硬限制，但建议保持在 ~120 列以内。

### 类型

- **`interface`** 用于数据结构和配置对象（如 `FieldDef`、`PipelineConfig`）。
- **`type`** 仅用于联合类型或映射/记录类型（如 `SceneData`）。
- 尽量避免 `any`，优先用 `unknown` + 类型守卫。
- 类型断言使用 `as`（禁止尖括号写法）。
- 非空断言 `!` 用于在 `init()` 方法中初始化的字段（两阶段初始化模式）。

### 命名

| 分类           | 命名规范                  | 示例                          |
| -------------- | ------------------------- | ----------------------------- |
| 类             | PascalCase                | `RenderGraph`、`Engine`       |
| 接口           | PascalCase                | `PipelineConfig`              |
| 变量/参数      | camelCase                 | `errorEl`、`entityData`       |
| 模块单例       | camelCase export const    | `resourceManager`、`schemaRegistry` |
| 常量           | UPPER_SNAKE_CASE          | `CENTERED_TRI`、`EDGE_SEGMENTS` |
| 文件名（类）   | PascalCase                | `RenderGraph.ts`、`Engine.ts` |

### 类结构

成员排列顺序：公有字段 → 私有字段 → 构造函数 → 公有方法 → 私有方法。公有方法不显式写 `public`（默认即公有）。

```ts
export class Example {
    device!: GPUDevice;          // ! 表示两阶段初始化
    private canvas: HTMLCanvasElement;

    constructor(canvas: HTMLCanvasElement) { ... }

    async init(): Promise<void> { ... }

    private frame = (): void => { ... };  // 箭头函数绑定 this 给 rAF 回调
}
```

### 错误处理

- 入口函数用 `try/catch` 包裹最外层（`main.ts`）。
- 不可恢复的错误用 `throw new Error(...)`（不使用自定义错误类）。

### ECS（bitecs）模式

- 组件通过 `bitecs/legacy` 的 `defineComponent(schema)` 定义。
- 实体存储采用 Structure-of-Arrays 布局 — 直接索引类型化数组：`(comp as any)[scalarName][eid]`。
- 查询通过 `defineQuery([...components])` 构建，返回 `(world) => EntityId[]`。
- 字符串通过整数索引存储到字符串表中（bitecs 不原生支持字符串）。
- 复合类型会被展开：`vec3` → `_x`、`_y`、`_z` 三个独立的 `f32` 标量。
- 字段可带 `role` 元数据（如 `"role": "color"` / `"extra"`）；renderer 通过 `schemaRegistry.getFieldByRole()` 按语义取字段，`isRenderTag()` 判定是否渲染 tag，故新增渲染 tag 组件无需改 `Scene.ts`。
- 组件默认值在 `components.json` 中声明，`SchemaRegistry.getFieldDefault(compName, field)` 可读取——TS 中**不要重复硬编码默认值**。

### 模块单例

`SchemaRegistry`、`ResourceManager`、`uniformLayouts`（UniformLayout.ts）在模块作用域以单例导出。直接导入使用，无需再实例化。其他类（Scene、RenderGraph、Engine、各 System）按会话实例化。

### WebGPU

- **引擎级配置**：`engine-config.json` 声明 `dataRoot`、`appsRoot`、`defaultApp`、`computeTgs`（引擎默认 workgroup size）、`alphaMode`、`renderScriptsSubdir`（渲染逃生舱脚本子目录）、`systemOrder`（**遗留回退**：仅当 `systems.json` 缺失时被 `Engine.init()` 用作默认顺序；正常运行顺序已由 `common/systems.json` + app `systems.json` 覆盖，见下文 Systems 节）、`scriptHooks`（脚本生命周期钩子名）。Engine.init() 最先加载。
- **渲染相位**：`phases.json` 声明相位 `name` + `order` + `behavior`（`normal`/`shadow-clear`/`postprocess-chain`）。RenderGraph 按 `order` 排序迭代，按 `behavior` tag 分派特殊逻辑。`RenderPhase` 为 `string`，新增相位只加 JSON 不改 TS。
- **顶点槽**：`vertex-slots.json` 声明每个槽的 `location`/`format`/`stride`/`components`。`vertexSlots.ts` 从 JSON 加载到 `VERTEX_SLOTS` / `SLOT_ORDER`。`SlotName` 为 `string`。WGSL `@location` 必须与 JSON 一致。
- 管线绑定组布局二选一：简单管线用 `"layout": "auto"`；PBR/材质管线用 `"bindLayout": ["frame", "object", ...]` 引用 `bind-layouts.json` 里的命名布局（按 `@group` 顺序）。
- **frame bind group 绑定**：PipelineDriver 按 `bindLayout[0]` 名绑定——`"frame"` → `frameBindGroup()`，`"frameShadow"` → `frameShadowBindGroup()`。RenderGraph 不再特例 `setBindGroup(0,...)`。几何 hook 调用前也会先 `bindGroups()` 确保 frame 绑定。
- **uniform 块布局数据驱动**：CPU 端字节偏移**不要手写魔数**，在 `uniform-layouts.json` 声明成员（std140 对齐由 `UniformLayout` 计算），各 System 用 `uniformLayouts.get(name).write(buf, 'field', value)` 按名写入。引擎 UBO（camera/light/timeInput/particle*）全部走此机制。u32 字段用 `layout.writeU32(u32View, 'field', value)`。
- **render target size 声明**：`render-targets.json` 条目支持 `size: { type: "viewport", scale?: number }` 或 `{ type: "fixed", w, h }`。省略 = viewport 全尺寸。`transient: true` 标记后处理乒乓用临时目标。shadow map 走声明路径（`shadowDepth` 条目带 fixed size）。
- **混合状态**：`blend-presets.json` 声明命名混合状态，`PipelineLoader.loadBlendPresets()` 加载，`PipelineLoader.resolveBlend(name)` 按名查表。`BlendPreset` 为 `string`。
- **fallback 纹理**：`fallback-textures.json` 声明 1x1 纹理（pixel + format），`ResourceManager.loadFallbackTextures()` 加载，`fallbackTextureView(name)` 按名取。`fallback` 字段为 `string`。
- **命名 VBO**：`vbo-presets.json` 声明顶点数据，`ResourceManager.loadVboPresets()` 加载，`getNamedVBO(name)` 按名取。
- **网格目录**：`meshes.json` 声明 `name` + `generator` + `params`，`meshGenerators` 注册表（Primitives.ts）提供生成器函数。app 可追加 `meshes.json`。
- **sampler fail-loud**：`namedSampler(name)` 未在 `samplers.json` 声明则 throw（不再静默回退）。
- **几何声明式 draw steps**：`renderer.geometry` 用 `steps: [{ vertexBuffers, indexBuffer, draw }]` 声明绘制流程，或 `hook: "name"` 用逃生舱。`PipelineDriver.emitGeometry` 泛型迭代 steps，无 switch 分支。`source` 闭枚举已移除。
- **后处理链动态路由**：`runPostChain` 动态路由——第一个启用的 pass 从 `scene` 读，最后一个写 `screen`，中间 pass 在 transient 目标间交替。render.json 条目的 `input`/`output` 为可选提示，不影响运行时路由。`sceneIsScreen` 由是否有 post-process 派生。
- **COMPUTE_TGS 单一源**：引擎默认 workgroup size 在 `engine-config.json` 的 `computeTgs`，`PipelineLoader.defaultWorkgroupSize` 设此值。管线 JSON 的 `workgroupSize` 覆盖之。TS 中**不要硬编码 `/64`**——用 `PipelineLoader.getComputeMeta(path).workgroupSize`。
- **compute 声明式绑定**：pipeline JSON 声明 `workgroupSize`、`countField`、`bindings[]`（`source`: `storage`/`uniform`/`timeInput`，storage 用 `key`+`stride` 或 `strideLayout`）。`strideLayout` 引用 `uniform-layouts.json` 布局名的 `byteSize` 作为 per-item 大小。
- 缓冲区使用 `COPY_DST` 标志以便 `writeBuffer` 更新。
- 着色器放在 `public/common/shaders/*.wgsl`，管线配置放在 `public/common/pipelines/*.json`。

### Systems（声明式 system 注册）

- `common/systems.json` 是**有序数组**，每项 `{ name, def }`，`def` 指向 `common/systems/<name>.json`（省略 = 同）。**数组顺序 = 帧循环运行顺序**，重排数组即控制系统更新次序。
- **app 可覆盖**：app 在 `app.json` 声明 `systems`（默认 `systems.json`），文件存在则**整体取代** common 的列表作为该 app 的运行顺序（app 只列自己想跑的 system；引用 common 的用 bare `{ "name": "input" }`，省略 `def` 即解析到 common；app 自己的 system 用相对 `def`）。文件缺失 = 用 common 默认；`unloadCurrentApp()` 恢复 common。
- system 定义 JSON 字段：`source`（`builtin:<id>` 内置 / `scripts/<path>.js` 自定义）、`components`（声明依赖的 Component 名）、`ubos`（拥有/写入的命名 UBO，名引自 `uniform-layouts.json`）、`buffers`（拥有的命名 storage buffer）、`needs`（必须先于此运行的其它 system 名）、可选 `requires`（如 `wasm:rapier`）。
- common 默认 7 个 system：`input`/`script`/`physics`/`camera`/`light`/`animation`/`render`。
- **接线状态**：`Engine.init()` 已加载 `common/systems.json`、`loadApp()` 已按 app `systems.json` 覆盖、`Engine.frame()` 按 `activeSystems` 名分派（仍硬编码 `switch(sys.name)`，内置 system 写死在 `src/ecs/*System.ts`，用户接受内置硬编码）。`engine-config.json.systemOrder` 仅作 systems.json 缺失时的回退。**`def` 元数据（components/ubos/buffers/needs）尚未被引擎消费**（仅声明，供文档与未来校验）；`source:"scripts/..."` 的**自定义 system 加载器**（仿 ScriptSystem 的 Blob URL）尚未实现，需新建 `SystemRegistry`。
- 内置 system 的 `update` 签名不统一（`CameraSystem.update(aspect)`、`LightSystem.update()`、其它 `update(time,dt)`），`Engine.frame()` 的 `switch` 按 `case` 分派。统一 `System` 接口 + 注册表是后续重构项。
- `gaussianSplat` 是"app 专属 system"的范例：不在 common 默认集合，由 `demo6_3dgsViewer` 的 `systems.json` 引入（详见"动画与高斯泼溅"节）。

### 相机与灯光（专用 System）

- `CameraSystem` 每帧收集 active `Camera` 实体 → 写 `cameraUBO`（布局声明在 `uniform-layouts.json` 的 `camera` 条目）；`LightSystem` 收集所有 `LightComponent`（数量由 `uniform-layouts.json` 的 `light` 条目中 `lightN_*` 成员数派生）+ `EnvironmentComponent` ambient → 写 `lightUBO`。两者在 `Engine.frame()` 中于 `renderGraph.execute()` **之前**调用（系统顺序当前由 `engine-config.json` 的 `systemOrder` 驱动，设计上改由 `systems.json` 驱动，见 Systems 节）。
- 灯光方向/位置**从 Transform 派生**（本地 -Z 轴经四元数旋转），编辑器 gizmo、shadow 相机、光照方向三者共用同一数据源。
- `LightComponent` 每盏灯的 UBO 已预留 `viewProj: mat4x4f`（方向光用 `mat4LookAt + mat4OrthographicSym` 算 light-space 矩阵），为后续 ShadowMap pass 铺路。`shadowStrategy` 字段声明阴影相机策略（`origin-look`/`follow-entity`/`cube-map`）。

### 动画与高斯泼溅（专用 System）

- `AnimationSystem`（`ecs/AnimationSystem.ts`）是关键帧动画资产系统，在 common `systems.json` 中位于 `light` 与 `render` 之间。与 `ScriptSystem` 同样按 app base 解析资产（`setBaseDir(base)` / `clear()`），app 切换时由 `unloadCurrentApp()` 清空。
- **高斯泼溅（3DGS）是 app 专属功能（`demo6_3dgsViewer`），不在 common 默认 system 集合中**。跨三个模块：`gs/SplatLoader.ts` 解析 3DGS PLY（binary little-endian；输出 `centers`/`colors`/`covariances` GPU-ready 数组，SH 解码与协方差已在 CPU 端算好）；`render/GaussianSplatManager.ts` 持有 storage buffers（centers/colors/cov）+ radix 排序 index buffer + model UBO，挂到 `RenderGraph.splats`（与 `RenderGraph.physics` 同模式）；`GsComponent`（`ply`/`count` 字段）声明在 `apps/demo6_3dgsViewer/components.json`（**app 专属组件，非 common**），由 demo6 的 `app.json` `components` 字段加载。
- demo6 通过自己的 `systems.json` 覆盖 common 顺序，加入 `gaussianSplat` system（`needs:["camera"]`）。`Engine.loadApp()` 仅当 `activeSystems` 含 `gaussianSplat` 时才实例化 `GaussianSplatManager` + 设置 `renderGraph.splats` + 遍历 GsComponent 实体加载 ply；其它 app 这部分全为 null，零开销。
- frame 循环有独立 `case 'gaussianSplat'`：`setModel(Transform)` + `sort(cameraView, cameraPos)`，排在 `render` 之前、`camera` 之后（splat 排序依赖 `CameraSystem.lastView/lastPos`）。
- **单 splat 限制**：`Engine.gsEntityEid` 只跟踪一个 GsComponent 实例；场景含多个时 manager 用最后一个并 warn。新增多 splat 支持需改 manager，非纯 JSON。
- 渲染端走命名 `"splat"` bind group layout（`read-only-storage`）+ model UBO（binding 4），渲染逃生舱脚本见 `common/scripts/render/splat.js`（`!splats || !splats.ready` 守卫，故非 splat app 零影响）。运行时依赖 `@d5techs/d5-gaussian-splat-lib`（仅类型/语义对齐，加载走自有 `SplatLoader`）。参考 app：`demo6_3dgsViewer`。

### 物理（Rapier3D）

- `@dimforge/rapier3d-compat` 是 WASM，必须 `await RAPIER.init()`（在 `Engine.init()` 中）后才能用。
- 由 `ColliderComponent`（+ 可选 `RigidBodyComponent`）驱动；`PhysicsControllerComponent` 单例控制 gravity/timestep/ground/debug。
- **默认值从 schema 读**：`PhysicsSystem.defaultParams()` 从 `schemaRegistry.getFieldDefault('PhysicsControllerComponent', ...)` 读取，不重复硬编码。
- **shape/bodyType 查找表**：`BODY_DESC_BUILDERS` / `COLLIDER_BUILDERS` 按名字查表，不 switch。新增 shape 只加表项。
- 固定步长累加器推进；`dynamic`/`kinematicVelocity` 刚体把位姿写回 `Transform`，`fixed`/`kinematicPosition` 从 `Transform` 读入。改组件字段会触发 `signature()` 变化并重建刚体。

### 脚本与事件

- 脚本 `.js` 资产通过 `fetch` 文本 → Blob URL → 动态 `import(/* @vite-ignore */ ...)` 加载（绕过 Vite transform），故必须写标准 ES module。
- **脚本钩子声明化**：钩子名由 `engine-config.json` 的 `scriptHooks` 声明（默认 `["init", "update"]`）。ScriptSystem 按声明遍历钩子，新增 `lateUpdate` 等只需改 JSON。
- `ScriptContext` 提供 `on(type, handler)` 订阅 `EventBus`；输入（`InputSystem`）与工具（`PickTool`）都通过 `EventBus` 通信，不直接耦合。
- **事件类型集中化**：`src/events/eventTypes.ts` 的 `EVENT_TYPES` 常量是引擎内部事件的单一来源（`MOUSE_MOVE`/`MOUSE_DOWN`/`MOUSE_UP`/`WHEEL`/`COLLISION`）。emitter/consumer 引用常量，不写字面量。

### 无框架原则

编辑器 UI 是纯原生 DOM 命令式实现。使用 `EditorPanel.ts` 中的工厂函数 `ce(tag, cls?, text?)` 创建元素。不使用 React/Vue/Svelte。

## 添加新功能

1. **新组件类型**：在 `public/common/components.json`（或 app 的 `components.json`）中添加定义，`SchemaRegistry` 会自动解析。
2. **新渲染相位**：在 `public/common/phases.json` 加条目（`name` + `order` + `behavior`），零 TS 改动。
3. **新顶点槽**：在 `vertex-slots.json` 加定义 + `vertex-inputs.json` 引用，零 TS 改动。
4. **新混合模式 / fallback 纹理 / VBO / mesh preset**：加对应 JSON 条目，零 TS 改动。
5. **新 uniform 块**：在 `uniform-layouts.json` 声明成员，用 `uniformLayouts.get(name).write(...)`，同步改 WGSL struct。
6. **新引擎 UBO**：在 `uniform-layouts.json` 加条目，改对应 System 用 `layout.write()`，ResourceManager UBO getter 用 `layout.byteSize`。零魔数。
7. **新 render target**：在 `render-targets.json` 加条目（带 `size` 声明），零 TS 改动。
8. **新绘制方式**：在管线 JSON 的 `renderer.geometry.steps` 声明 vertexBuffers + indexBuffer + draw。`PipelineDriver.emitGeometry` 泛型执行，无 switch。
9. **新脚本钩子**：在 `engine-config.json` 的 `scriptHooks` 加名字，脚本导出同名函数。
10. **改系统顺序 / 加 system**：重排 `common/systems.json` 数组即可（纯 JSON、零 TS 改动）；app 在自己的 `systems.json` 覆盖顺序（如 demo6 加 `gaussianSplat`）。**新增内置 system** 仍须在 `Engine.frame()` 的 `switch(sys.name)` 加 `case`（无 case 的名字静默跳过）；`source:"scripts/..."` 的自定义 system 加载器尚未实现（需 `SystemRegistry`）。
11. 任何改动后，运行 `npm run build` 通过类型检查。
