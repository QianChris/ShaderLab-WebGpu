# ARCHITECTURE.md — ShaderLab-WebGPU

## 概述

数据驱动的 WebGPU 图形引擎。渲染管线、ECS 组件结构、场景数据、脚本逻辑全部由 JSON / WGSL / JS 资产文件驱动，运行时从 `public/common/` 加载。核心原则：**配置即逻辑，数据即场景**。

- 无框架（原生 DOM 编辑器）、无路径别名（仅相对导入）、无测试运行器。
- 唯一静态检查：`npm run build`（`tsc` + `vite build`）。

## 启动流程

`main.ts` → 检查 WebGPU → `new Engine(canvas)` → `engine.init()` → `engine.loadApp(defaultApp)` → 挂载编辑器面板 → `engine.startLoop()`。

```
main.ts
  └─ Engine.init()
       ├─ 加载 engine-config.json                    路径/默认app/computeTgs/alphaMode/systemOrder/scriptHooks
       ├─ schemaRegistry.load(dataRoot + '/components.json')   组件 Schema
       ├─ RAPIER.init()                                  物理 WASM
       ├─ 加载 vertex-inputs / bind-layouts / uniform-layouts / samplers
       │        vertex-slots / phases / vbo-presets / blend-presets / fallback-textures / meshes
       ├─ requestAdapter / requestDevice                 GPU 初始化
       ├─ resourceManager.init(device) + loadBindLayouts/loadSamplers/loadVboPresets/loadFallbackTextures
       │        PipelineLoader.loadBlendPresets + loadVertexSlots
       ├─ 加载 meshes.json → meshGenerators 注册表
       ├─ 加载 gltf-mapping.json
       └─ new Scene / RenderGraph(setPhases) / EventBus / 各 System（Script/Input/Physics/Camera/Light/Tool）
  └─ Engine.loadApp(name)
       ├─ app.json → 读 manifest（components/scene/render/tools/gltf）
       ├─ scene.json  → scene.createEntity(...) → resolveHandles()
       ├─ render.json → renderGraph.fromData() + loadRenderTargets() + compile()
       └─ tools.json  → toolSystem.loadFromFile()
```

## 目录结构

```
src/
  main.ts             入口 — 启动引擎、编辑器、标签页切换、渲染循环
  Engine.ts           核心协调器（GPU 初始化、场景时间、帧循环；systemOrder 从 engine-config.json）
  math.ts             mat4 / TRS / 相机矩阵 / lookAt / 正交投影 / 四元数旋转（纯函数）
  ecs/
    Scene.ts          ECS 场景管理（bitecs world，实体 CRUD、字段读写、相机矩阵）
    SchemaRegistry.ts  组件 Schema 注册表（模块单例，从 JSON 解析字段定义 + role 元数据）
    ScriptSystem.ts    脚本系统（加载 .js 资产，hooks 由 engine-config.json 声明）
    InputSystem.ts     指针/键盘输入 → EventBus + TimeInput UBO
    PhysicsSystem.ts   Rapier3D 物理（Transform ↔ 刚体同步、射线拾取、debug draw）
    CameraSystem.ts    收集 active Camera → cameraUBO（uniform-layouts.json 的 'camera' 布局）
    LightSystem.ts     收集 LightComponent + ambient → lightUBO（含 shadow viewProj）
    AnimationSystem.ts 精灵动画系统
  render/
    types.ts          渲染管线 / 渲染图类型定义（PhaseDecl、PipelineEntry、ComputeBindingDecl 等）
    RenderGraph.ts    渲染图执行引擎（相位调度由 phases.json 驱动）
    ResourceManager.ts GPU 资源管理（VBO/UBO/SSBO/纹理/绑定组，模块单例）
    PipelineLoader.ts  从 JSON 加载 WebGPU 渲染 / 计算管线（含 blend-presets 加载）
    UniformLayout.ts  std140 uniform 块布局（模块单例 uniformLayouts，支持 write/writeU32）
    Primitives.ts     网格生成器（triangle/cube/icosphere/uvsphere）+ meshGenerators 注册表
    vertexSlots.ts    SoA 顶点槽定义（从 vertex-slots.json 加载到 VERTEX_SLOTS/SLOT_ORDER）
    PipelineDriver.ts 声明式管线执行器（draw steps、bind groups）
    ParticleManager.ts GPU 粒子系统（UBO 布局由 uniform-layouts.json 声明）
    RenderScriptLoader.ts 渲染逃生舱脚本加载器
    valueResolver.ts  值源 mini-DSL（pack/const/script/transform/builtin/tag）
  events/
    EventBus.ts       轻量发布订阅（on/emit）
    eventTypes.ts     事件类型常量集中定义（EVENT_TYPES）
  tools/              可选交互工具（ToolSystem + SceneTool + PickTool）
  gltf/               GltfLoader（.glb → 网格 + PBR 材质 + 纹理）
  editor/
    EditorPanel.ts    场景编辑器面板（实体列表 + 组件字段编辑）
    PipelinePanel.ts  渲染图面板（按相位显示条目 + 启用开关 + 参数）
    dom.ts            DOM 工厂 ce() + 可拖拽浮点字段 makeFloatField()
  types/
    bitecs-legacy.d.ts bitecs/legacy 环境类型声明
public/common/
  engine-config.json   引擎级配置（dataRoot/appsRoot/defaultApp/computeTgs/alphaMode/systemOrder/scriptHooks）
  components.json       ECS 组件 Schema 定义
  phases.json           渲染相位定义（name + order + behavior）
  vertex-slots.json     SoA 顶点槽定义（location/format/stride/components）
  vertex-inputs.json    命名顶点输入布局
  bind-layouts.json     命名 GPUBindGroupLayout
  uniform-layouts.json  命名 uniform 块布局（std140，含 camera/light/timeInput/particle*）
  samplers.json         命名 GPUSampler 描述符
  render-targets.json   命名 render target（color/depth + size + transient）
  blend-presets.json    命名混合状态（opaque/alpha/additive）
  fallback-textures.json 命名 1x1 fallback 纹理
  vbo-presets.json      命名 VBO（quad 等）
  meshes.json           预置网格目录（name + generator + params）
  gltf-mapping.json     glTF → 组件字段映射声明
  pipelines/*.json      管线配置（渲染 + 计算，内嵌 renderer 声明块）
  shaders/*.wgsl        WGSL 着色器
  scripts/render/*.js   渲染逃生舱脚本（value/geometry/compute 钩子）
  textures/*.png        纹理资产
public/apps/<name>/
  app.json              app 清单
  scene.json            场景实体数据
  render.json           渲染图配置（加载清单 + renderScripts + clearColor + post-process input/output）
  tools.json            可选交互工具配置
  components.json       app 追加的组件定义（可选）
  scripts/*.js           app 脚本资产
assets/                  源素材（skybox png、glb 模型）— 需复制到 public/ 才能被 serve
```

## 核心子系统

### 1. ECS（bitecs/legacy）

- **SchemaRegistry**（模块单例）：从 `components.json` 解析组件定义并 `defineComponent(schema)`。
  - 标量类型映射：`f32/i32/u32/u8/bool` → bitecs Types。
  - 复合类型展开：`vec2/vec3/vec4` → `field_x/_y/_z/_w` 多个 f32 标量。
  - 字符串：bitecs 不支持字符串，存为 `_str_<field>`（ui32 索引），实际值放在模块内的 `stringTables` 字符串表中。
  - 提供 composite 读写（`getComposite/setComposite`）、批量读写（`readAllFields/setAllFields`）、标量访问（渲染器用）。
  - `getFieldDefault(compName, field)` 读取 JSON 声明的默认值——TS 中不重复硬编码。
- **Scene**：包装一个 bitecs `world`，维护 `entityKeyMap`（名字→eid）和 `entityTags`。
  - `createEntity` 强制附加 `NameComponent`，按 JSON 附加其余组件。
  - 提供 `getField/setField/toggleComponent/hasComponent`、模型矩阵 `getModelMatrix`、激活相机矩阵 `getActiveCamera`。
  - `getEnvironmentAmbient()` / `getEnvironmentClearColor()` 返回实体值或 schema 默认值（单一真相源）。
  - `toJSON()` 序列化整个场景（编辑器 Save 用）。
- **实体存储**：Structure-of-Arrays，直接索引类型化数组 `(comp as any)[scalarName][eid]`。

### 2. 渲染图（RenderGraph）

**相位声明化**：`phases.json` 声明相位 `name` + `order` + `behavior`（`normal`/`shadow-clear`/`postprocess-chain`）。RenderGraph 按 `order` 排序迭代，按 `behavior` tag 分派特殊逻辑。`RenderPhase` 为 `string`。

> 相机与灯光 uniform 由 `CameraSystem` / `LightSystem` 在 `execute()` **之前**写入（系统顺序由 `engine-config.json` 的 `systemOrder` 驱动）。

每帧 `execute()`：
1. shadow-clear：若 `shadow-clear` 相位无活跃 driver，清空 shadow map（按 behavior tag 分派，不字符串等值）。
2. compute stage：对每个 driver 的 `compute` 块（script hook）调用。
3. 按 `phaseList` 顺序迭代各相位：`normal` 行为走 `runPhase`（合并连续 driver 共享 target 的 render pass），`postprocess-chain` 行为走 `runPostChain`。
4. **frame bind group**：不再由 RenderGraph 统一 `setBindGroup(0,...)`，而是由 PipelineDriver 按 `bindLayout[0]` 名绑定（`"frame"` → `frameBindGroup()`，`"frameShadow"` → `frameShadowBindGroup()`）。几何 hook 调用前也先 `bindGroups()` 确保 frame 绑定。

**后处理链动态路由**：`runPostChain` 动态路由——第一个启用的 pass 从 `scene` 读，最后一个写 `screen`，中间 pass 在 transient 目标间交替。render.json 条目的 `input`/`output` 为可选提示，不影响运行时路由。`sceneIsScreen` 由是否有 post-process 派生。

**几何声明式 draw steps**：`renderer.geometry` 用 `steps: [{ vertexBuffers, indexBuffer, draw }]` 声明绘制流程，或 `hook: "name"` 用逃生舱。`PipelineDriver.emitGeometry` 泛型迭代 steps：
- `vertexBuffers`：每项 `source` 为 `meshSlots`（绑定 SoA 槽）、`vbo`（命名 VBO）、`meshField`（mesh 上具名缓冲）。
- `indexBuffer`：`mesh` 引用 mesh 名，绑定 index buffer。
- `draw`：`type` 为 `draw`（vertexCount + instanceCount）或 `drawIndexed`（countField）。count 解析为 0 时自动回退到 mesh 对象的 indexCount/edgeCount/pointCount。

**uniform 块布局数据驱动**：CPU 端字节偏移不手写，在 `uniform-layouts.json` 声明成员，`UniformLayout`（模块单例 `uniformLayouts`）按 std140 对齐规则算偏移，各 System 用 `layout.write(buf, 'field', value)` 按名写入。u32 字段用 `layout.writeU32(u32View, 'field', value)`。当前块：`perEntity`、`pbrObject`、`pbrMaterial`、`spriteEntity`（逐管线）；`camera`、`timeInput`、`light`、`particleLayout`、`particleEmit`、`particleSim`（引擎 UBO）。

**compute 声明式绑定**：compute pipeline JSON 声明 `workgroupSize`、`countField`、`bindings[]`。每个 binding 的 `source`：`storage`（每实体 SSBO，`key`+`stride` 或 `strideLayout` 引用 uniform-layout 的 byteSize）/ `uniform`（`pack` 列出组件字段或 `$count`/`$time` 内建量）/ `timeInput`（全局 UBO）。

### 3. ResourceManager（模块单例）

按需创建 & 缓存 GPU 资源：
- `getMesh` — 懒构建网格 GPU 缓冲（SoA slots/index/edgeBuffer/pointBuffer）。
- `getUniform(key, data)` — uniform 缓冲，`writeBuffer` 更新。
- `getStorageBuffer(key, size)` — STORAGE|VERTEX|COPY_DST 缓冲（粒子/debug），不足则重建。
- `loadTexture(url)` / `uploadTextureFromImage` — 缓存复用；`textureHandle` 句柄表。
- `colorTarget` / `namedColorTargetView` / `namedDepthTargetView` — 离屏目标（size 从 render-targets.json 声明解析）。
- `shadowMapView()` — 走 `namedDepthTargetView('shadowDepth')`，size 从 render-targets.json 声明。
- UBO 单例：`cameraUBO` / `lightUBO` / `timeInputUBO` — size 由 `uniformLayouts.get(name).byteSize` 推导。
- `loadVboPresets` / `getNamedVBO(name)` — 从 `vbo-presets.json` 加载命名 VBO。
- `loadFallbackTextures` / `fallbackTextureView(name)` — 从 `fallback-textures.json` 加载 1x1 纹理。
- `loadBindLayouts` / `namedLayout` / `pipelineLayout` — 从 `bind-layouts.json` 构建命名绑定组布局。
- `loadSamplers` / `namedSampler(name)` — 从 `samplers.json` 构建命名 sampler（**fail-loud**：未声明则 throw）。
- `loadRenderTargets` — 从 `render-targets.json` 加载目标声明（含 size 策略）。
- 绑定组工厂：`frameBindGroup` / `frameShadowBindGroup` / `genericBindGroup` / `fullscreenBindGroup`。

### 4. 粒子系统

- 粒子 UBO 布局声明在 `uniform-layouts.json`：`particleLayout`（per-particle stride = 5×vec4f = 80B）、`particleEmit`（8×vec4f = 128B）、`particleSim`（header + 8 force fields = 416B）。MAX_FIELDS 从 `particleSim` 布局的 `fieldN_*` 成员数派生。
- Compute 阶段由 `renderer.compute.script` 声明（逃生舱 hook），workgroup size 从 `PipelineLoader.getComputeMeta(path).workgroupSize` 读取（单一源）。
- Draw 阶段由 `renderer.geometry.hook` 声明（逃生舱 hook），用 `drawIndirect` 从 sim 填充的 indirect args 绘制。
- 两个 compute pipeline（emit/sim）通过 `renderer.aux` 声明，在 compile 时预加载。

### 5. 脚本系统

- **ScriptComponent**：`script`(string，资产路径如 `apps/demo2/scripts/game.js`) / `enabled`(bool)。
- **ScriptSystem**：每帧查询带 `ScriptComponent` 的实体；首次遇到某脚本路径时 `fetch` 源码文本 → 构造 Blob URL → `import()`（绕过 Vite 的模块 transform）→ 缓存 module。
- **脚本钩子声明化**：钩子名由 `engine-config.json` 的 `scriptHooks` 声明（默认 `["init", "update"]`）。ScriptSystem 按声明遍历钩子——`init` 仅首次调用，其余每帧调用。新增 `lateUpdate` 等只需改 JSON。
- **ScriptContext**：`{ eid, scene, time, dt, aspect, physics, getField(comp,field), setField(comp,field,value), on(type,handler), emit(type,payload) }`。

### 6. 天空盒

- `SkyboxPipeline` 在 Skybox 相位运行，全屏三角形采样 equirect 纹理背景。
- 几何声明为 `steps: [{ draw: { type: "draw", vertexCount: 3 } }]`（VS 合成顶点）。

### 7. 编辑器（原生 DOM）

- **EditorPanel**：遍历 SchemaRegistry 自动渲染实体列表与组件字段（新组件无需改 UI）。支持增删实体、勾选启用组件、编辑字段、Save/Load JSON。
- **PipelinePanel**：按相位遍历渲染图条目（`getPhaseNames()` 从 phases.json 派生），显示启用开关与 `params`。
- **dom.ts**：`ce(tag, cls?, text?)` 元素工厂；`makeFloatField` 可拖拽调值 / 双击输入。

### 8. 相机与灯光（专用 System）

- **CameraSystem**：每帧收集 active `Camera` 实体（`Scene.getActiveCamera`），用 `uniformLayouts.get('camera')` 写入 `cameraUBO`。
- **LightSystem**：每帧收集所有 `LightComponent`（数量由 `uniform-layouts.json` 的 `light` 条目中 `lightN_*` 成员数派生）+ `EnvironmentComponent` ambient，用 `uniformLayouts.get('light')` 写入 `lightUBO`。
  - **LightComponent** 字段：`type`（directional/point）、`color`、`intensity`、`range`、`castShadow`、`shadowOrtho/Near/Far`、`shadowStrategy`（origin-look/follow-entity/cube-map）。
  - 灯光方向/位置**从 Transform 派生**：本地 -Z 轴经四元数旋转（`quatRotateVec3`）。
  - 每盏灯 UBO 预留 `viewProj: mat4x4f`：方向光用 `mat4LookAt + mat4OrthographicSym` 算 light-space 矩阵。
- 两者在 `Engine.frame()` 里于 `renderGraph.execute()` **之前**调用，顺序由 `engine-config.json` 的 `systemOrder` 驱动。

### 9. 物理（Rapier3D）

- `@dimforge/rapier3d-compat` 是 WASM，必须 `await RAPIER.init()` 后才能用。
- 由 `ColliderComponent`（+ 可选 `RigidBodyComponent`）驱动；`PhysicsControllerComponent` 单例控制 gravity/timestep/ground/debug。
- **默认值从 schema 读**：`PhysicsSystem.defaultParams()` 从 `schemaRegistry.getFieldDefault('PhysicsControllerComponent', ...)` 读取，不重复硬编码。gravity 在 `attach()` 时从 schema 读。
- **shape/bodyType 查找表**：`BODY_DESC_BUILDERS` / `COLLIDER_BUILDERS` 按名字查表，不 switch。新增 shape 只加表项。
- **ground 尺寸声明化**：`groundHalfExtent` / `groundThickness` 在 `PhysicsControllerComponent` 中声明。
- 固定步长累加器推进；`dynamic`/`kinematicVelocity` 刚体把位姿写回 `Transform`，`fixed`/`kinematicPosition` 从 `Transform` 读入。改组件字段会触发 `signature()` 变化并重建刚体。

## 帧循环（Engine.frame）

系统顺序由 `engine-config.json` 的 `systemOrder` 声明（默认 `["input", "script", "physics", "camera", "light", "animation", "render"]`）。Engine 按 `switch(sys)` 分派：

```
performance.now() → 计算 time（秒，自启动）与 dt
  for (sys of engineConfig.systemOrder):
    ├─ input → inputSystem.update(time, dt)               输入 → TimeInput UBO
    ├─ script → scriptSystem.update(time, dt)              脚本逻辑（hooks 由 scriptHooks 声明）
    ├─ physics → physicsSystem.update(time, dt)             物理步进
    ├─ camera → cameraSystem.update(aspect)                 写 cameraUBO
    ├─ light → lightSystem.update()                         写 lightUBO
    ├─ animation → animationSystem.update(time, dt)         精灵动画
    └─ render → renderGraph.execute(device, ctx, ...)       GPU 渲染
  requestAnimationFrame(frame)
```

## WebGPU 约定

- 管线绑定组布局二选一：`layout: 'auto'`（简单管线）或 `bindLayout: [...]` 引用 `bind-layouts.json` 命名布局。
- **frame bind group**：PipelineDriver 按 `bindLayout[0]` 名绑定——`"frame"` → `frameBindGroup()`，`"frameShadow"` → `frameShadowBindGroup()`。RenderGraph 不再特例 `setBindGroup(0,...)`。
- uniform 块 CPU 布局在 `uniform-layouts.json` 声明，`UniformLayout` 按 std140 算偏移，各 System 用 `layout.write()` / `layout.writeU32()` 按名写字段（勿手写魔数）。
- **render target size**：`render-targets.json` 条目支持 `size: { type: "viewport", scale?: number }` 或 `{ type: "fixed", w, h }`。
- **COMPUTE_TGS 单一源**：引擎默认 workgroup size 在 `engine-config.json` 的 `computeTgs`，管线 JSON 的 `workgroupSize` 覆盖之。TS 中不硬编码 `/64`。
- sampler 在 `samplers.json` 声明（`namedSampler` **fail-loud**：未声明则 throw）。
- 场景 clear color 单一真相源：`components.json` 的 `EnvironmentComponent.clearColor` 默认值；`render.json` 的 `clearColor` 覆盖之。
- 缓冲带 `COPY_DST` 以便 `writeBuffer` 更新。
- 着色器 `public/common/shaders/*.wgsl`，管线配置 `public/common/pipelines/*.json`。

## 添加新功能

1. **新组件类型**：`components.json` 加定义（渲染 tag 字段带 `role`）→ `SchemaRegistry` 自动解析，编辑器自动显示。
2. **新渲染相位**：`phases.json` 加条目（`name` + `order` + `behavior`），零 TS 改动。
3. **新顶点槽**：`vertex-slots.json` 加定义 + `vertex-inputs.json` 引用，零 TS 改动。
4. **新混合模式 / fallback 纹理 / VBO / mesh preset**：加对应 JSON 条目，零 TS 改动。
5. **新 uniform 块**：在 `uniform-layouts.json` 声明成员，用 `uniformLayouts.get(name).write(...)`，同步改 WGSL struct。
6. **新引擎 UBO**：在 `uniform-layouts.json` 加条目，改对应 System 用 `layout.write()`，ResourceManager UBO getter 用 `layout.byteSize`。
7. **新 render target**：在 `render-targets.json` 加条目（带 `size` 声明），零 TS 改动。
8. **新绘制方式**：在管线 JSON 的 `renderer.geometry.steps` 声明 vertexBuffers + indexBuffer + draw。`PipelineDriver.emitGeometry` 泛型执行，无 switch。
9. **新脚本钩子**：在 `engine-config.json` 的 `scriptHooks` 加名字，脚本导出同名函数。
10. **新系统 / 改系统顺序**：在 `engine-config.json` 的 `systemOrder` 加名字，Engine.frame() 按 `switch(sys)` 分派。
11. 任何改动后运行 `npm run build` 过类型检查。
