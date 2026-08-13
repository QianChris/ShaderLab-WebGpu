# PLAN.md — 设计同学可用的 Demo 搭建能力

> **版本**：v3.0（替代 v2.0 ComputeGraph v2 管线脚本编排器定位）
> **核心使命**：**让设计同学不写一行代码，用编辑器 + JSON 组合，搭出可判读的 3D/动画 demo 并交付静态图/视频**
> **设计哲学**：机制不变 · 缺什么补什么 · 编辑器层优先 · 新能力走插件平等装载链

---

## 〇、定位修订（vs v2）

### 0.1 改变的是什么

v2 计划（ComputeGraph 可视化编排器）面向 TA 用连线编排 hook 调用顺序，是渲染管线编排工具。但盘点工程现状后发现，**设计同学连"在画布上旋转视角、选中实体、拖拽移动"都做不到**——更紧迫的能力空白在编辑器可用性与内容侧资产链路，而非管线编排。

### 0.2 v3 的定位

本计划把工程主线从"管线编排工具"切回"设计同学搭 demo 的可用性闭环"。**机制层（ECS / RenderGraph / ResourceManager / PluginManager / PipelineDriver）已完备不动**，只在以下四条线补能力：

1. **编辑器交互层**（src/editor + src/ui）：视口相机、transform gizmo、场景层级树、资产浏览器、导出面板、时间轴
2. **内容资产链路**（src/core/gltf + gltf-mapping + assets/）：glTF 重写，保留层级/骨骼/动画/morph/KHR 扩展
3. **场景数据模型**（src/core/ecs/Scene）：补父子层级
4. **新能力插件**（public/plugins/<id>/）：骨骼动画（animation 插件）、可能的材质/prefab 资源对象

### 0.3 与 AGENTS.md 三条红线的对齐

| 红线 | 本计划如何遵守 |
| :--- | :--- |
| **引擎不依赖任何插件** | src/ 对 public/plugins/ 零 import 不变。glTF 重写在 src/core/gltf/ 内（纯机制，不引入插件知识）。编辑器交互在 src/editor + src/ui（编辑器层不属引擎机制）。animation/skinning 走插件装载链 |
| **所有插件平等** | 新增 animation 插件与 core 走同一条 `pluginManager.loadMany` 链，meta.id = 目录名，无 `builtin:` 特权。core 的 PbrShader 不为 skinning 留特例分支，animation 插件自带 SkinnedPbrPipeline |
| **fail-loud** | 缺资产、未注册工具、gltf schema 缺字段、未声明 skin/animation 的实体调 skinning 一律 throw，不静默回退 |

### 0.4 核心承诺

| 设计同学诉求 | 本计划提供的开箱即用 |
| :--- | :--- |
| 我想在画布上转视角看场景 | 编辑器视口相机：右键 orbit / 中键 pan / 滚轮 zoom |
| 我想选中物体拖动 | transform gizmo（move/rotate/scale 三模式），拖拽走 command bus 支持 undo |
| 我要把做好的 demo 截图/录屏交付 | 一键导出 PNG / WebM |
| 我有带骨骼动画的角色 glb 想用 | glTF 重写后保留层级 + 骨骼 + 动画 + morph，animation 插件播放 |
| 我有 100 个相同物体要摆 | prefab 实例化 + 场景层级树 |
| 我想拖一个模型到画布自动创建实体 | 资产浏览器拖拽创建 |
| 我想暂停粒子/物理调时间 | 时间轴 scrub + 单步推进（仅编辑器模式） |

**承诺不再包含**：
- ❌ PBR 材质高级扩展（clearcoat / sheen / transmission / volume）——按 AGENTS.md "渲染插件贡献协议"由独立 PR 贡献
- ❌ ComputeGraph 可视化编排器——转为独立子计划文档 `PLAN_compute_graph.md`（不在本计划排期内）
- ❌ 资产导入/格式转换工具——设计同学自带成品 glb/png
- ❌ 多人协作 / 云资产库


## 一、能力清单与分层归属

| # | 能力 | 层 | 现状 | 目标 | 优先级 |
| :--: | :--- | :--- | :--- | :--- | :--: |
| 1 | 编辑器视口相机（orbit/pan/zoom） | src/editor | 缺（EditorInputManager 32 行只管 ToolSystem） | 独立 EditorCamera，不污染 player Camera 实体 | P0 |
| 2 | transform gizmo | src/editor + builtin ToolType | 缺 | builtin tooltype `transform-gizmo`，经 tools.json 装配 | P0 |
| 3 | 渲染结果导出（截图/录屏） | src/editor | 0 匹配 screenshot/capture/MediaRecorder | ExportPanel + GPU readback + captureStream | P0 |
| 4 | 场景父子层级 | src/core/ecs/Scene | 平铺 Map，无 parent | Transform 加 `parent` 字段 + 树 API + 递归 modelMatrix | P1 |
| 5 | glTF 重写（层级/骨骼/morph/动画/KHR） | src/core/gltf + gltf-mapping | 151 行烘焙变换、丢骨骼/动画/morph | 原生 JSON+bin 解析、保留节点树、发布 skin/animation/morph 资产 | P1 |
| 6 | 场景层级树 UI | src/ui/vue | 缺 | HierarchyPanel.vue，拖拽重排父子 | P1 |
| 7 | 资产浏览器拖拽创建 | src/ui/vue + src/host | AssetViewPanel 仅列表 | 扫 assets/ + 拖拽到画布 → host.dispatch(createEntity) | P1 |
| 8 | 骨骼动画系统 + WGSL skinning | 新插件 `animation` | 0 匹配 skeleton/jointMatrix | SkinningSystem + SkinnedPbrPipeline + AnimationPlayerComponent | P2 |
| 9 | 时间轴 UI + 帧控制 | src/ui/vue + src/core/Engine | EditMode 有 pause 但无 UI | TimelinePanel + Engine.setFrameTime / stepOnce | P2 |
| 10 | 材质资源对象 | 插件 + ResourceManager | PbrMaterial 实体内联 | MaterialAsset 注册表 + PbrMaterial.material 引用 | P2 |
| 11 | prefab / 实例复用 | src/core/ecs + 编辑器 | 缺 | Scene 支持 prefab 引用 + 实例化 | P2 |


## 二、设计哲学与红线

### 2.1 分层归属规则（能力落在哪一层）

```
src/editor/   编辑器交互（设计同学直接用，player 不装）
              → 视口相机 / gizmo / 导出 / 时间轴 / 层级树 / 资产浏览器
src/ui/vue/   Vue 面板（被 EditorOrchestrator 装入 sidebar tabs）
              → HierarchyPanel / ExportPanel / TimelinePanel / MaterialPanel
src/core/     引擎机制（无插件知识）
              → Scene 加父子层级 / GltfLoader 重写 / Engine 帧时间门控
src/host/     宿主桥（UI → Engine 命令通道）
              → AssetDropTarget / 新增 commands 走 EditorCommandBus
public/plugins/<id>/   新能力（声明式注册，与 core 平等）
              → animation（skinning + animation player）
public/apps/<name>/    组合（声明插件/资产/场景/工具）
              → app.json 扩展字段 / tools.json 装配 gizmo
public/common/         组合残留
              → gltf-mapping.json 扩展 skin/animation/morph 段
```

### 2.2 绝对红线（架构护栏）

| 禁止 | 原因 / 替代 |
| :--- | :--- |
| **src/editor 引入场景 Camera 实体做编辑器视口** | 污染 player 模式。编辑器视口相机是 RenderGraph 的独立 view 来源，不入 ECS |
| **core 的 PbrShader 为 skinning 加分支** | 违反"插件平等"。animation 插件自带 SkinnedPbrPipeline |
| **新工具直接挂在 EditorInputManager 硬编码** | 走 `registerToolType` + tools.json 装配，机制已有 |
| **Scene 加 parent 字段破坏老 scene.json** | 平滑迁移：`parent: { type: 'string', default: '' }`，空值=根节点 |
| **animation 插件重名 'animation' 系统** | 现有 'animation' 系统是 sprite 插件的 2D 帧动画。新系统叫 `skinning` + `skeletal-animation` |
| **glTF 重写引入新依赖（three/gltf-transform/...）** | 纯手写 JSON+bin 解析，src/ 不引入新 npm 包 |
| **截图走 OffscreenCanvas + drawImage（WebGPU 不支持）** | 走 GPU buffer readback + ImageBitmap |


## 三、分阶段路线图

### Phase 0 — 编辑器视口相机 + transform gizmo（P0，1.5 周）

**目标**：设计同学在画布上能旋转视角、选中实体、拖拽移动/旋转/缩放。

#### 3.0.1 编辑器视口相机

- **新文件** `src/editor/input/ViewportCameraController.ts`
  - 维护一个独立的 `EditorCameraState { yaw, pitch, distance, target }`，不入 ECS
  - 监听 canvas pointer/wheel 事件：右键拖拽 → orbit（改 yaw/pitch）；中键拖拽 → pan（改 target）；滚轮 → zoom（改 distance）
  - 输出 `getViewMatrix(out)` / `getProjMatrix(aspect, out)`，写入预分配 Float32Array
- **Engine 接入**：`Engine` 加 `editorView: { view, proj, pos } | null`
  - `frame()` 在编辑器模式（host 检测）下，渲染器用 `editorView` 替代 `scene.getActiveCameras()`
  - 关键决策：**editor view 是 RenderGraph 的 `editorOverride` 入参**，由 `AppHost` 在编辑器层注入；player 模式不注入 → 走场景 Camera
  - `RenderGraph.execute()` 已支持多视图，新增 `executeEditorView(view, proj)` 路径
- **EditorOrchestrator** 在 `init()` 创建 `ViewportCameraController` 并 wire 到 canvas

#### 3.0.2 transform gizmo

- **新文件** `src/editor/input/TransformGizmoTool.ts`，实现 `SceneTool` 接口
  - 注册：`registerToolType('transform-gizmo', factory)`（src/editor/index 或 EditorOrchestrator init 时注册）
  - 模式：`move` / `rotate` / `scale`（按 W/E/R 切换，与 Blender 对齐）
  - 选中：canvas pointer-down → ray cast（先复用 physics 的 ray cast；若 physics 未装，走自定义 ray-AABB）
  - gizmo 渲染：新增管线 `editor:pipelines/GizmoPipeline.json` + WGSL，画三轴/三环/三立方
    - editor 管线走独立 `editor` owner（不是 app owner），随 editor 启动注册、卸载时清扫
  - 拖拽：根据 gizmo 轴向 + 鼠标增量 → 计算 delta TRS → 走 `SetFieldCommand`（支持 undo）
- **tools.json 装配**：app 的 tools.json 加 `{ "type": "transform-gizmo", "enabled": true }`

#### 3.0.3 验证

- demo1 编辑器：右键拖拽 orbit 视角 / 滚轮 zoom / 选中实体 + W 拖动 + Ctrl+Z 撤销
- `npm run verify` 通过
- 不破坏 player.html?app=demo1（player 无 editor view 注入）

---

### Phase 1 — 渲染结果导出（P0，1 周）

**目标**：设计同学能截图 / 录屏交付。

#### 3.1.1 截图（PNG）

- **新文件** `src/editor/ExportPanel.ts`（Native DOM 面板，与 EditorPanel 同级）
  - 按钮"截图 PNG" → `host.dispatch(new CaptureCommand('png'))`
- **Engine 机制**：`Engine.captureFrame(): Promise<Blob>`
  - 渲染器在帧末 `copyTextureToBuffer` swap chain texture → staging buffer → `mapAsync` → `ImageBitmap` → canvas → `toBlob('image/png')`
  - 分辨率选项：当前 DPR / 2× / 4×（超采样走 `passDescriptor` 改 viewport）
- **关键约束**：WebGPU swap chain texture 不能直接 `toBlob`；必须 GPU readback。staging buffer 复用，不每帧分配

#### 3.1.2 录屏（WebM）

- `ExportPanel` 按钮"录制 / 停止"
- `canvas.captureStream(60)` → `MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })` → chunks → Blob → download
- 录制期间在画布角显示 REC 红点 + 时长

#### 3.1.3 验证

- 截图保存为可在图像浏览器打开的 PNG
- 录屏 5 秒保存为可在 VLC/浏览器播放的 WebM
- `npm run verify` 通过

---

### Phase 2 — glTF 重写 + 场景父子层级（P1，3 周）

**目标**：保留 glTF 节点层级、骨骼数据、动画、morph、KHR 材质扩展。

#### 3.2.1 场景父子层级（先做，是 glTF 层级落地的前提）

- **Scene.ts 改动**：
  - `components.json` 的 Transform 加 `parent: { type: 'string', default: '' }`（引用父 entity key）
  - Scene 加 `getChildren(key): string[]` / `getParent(key): string` / `setParent(childKey, parentKey)`
  - `getModelMatrix(eid, out)` 改为**递归**：先算父 modelMatrix，再 `mat4MulInto(parentMat, localMat, out)`
    - 缓存策略：每帧 `invalidateWorldMatrices()` 标脏，首次访问时计算并缓存；父变则子标脏
    - 防环：`setParent` 时 DFS 检测 child→parent 链是否回环，回环 throw
  - `toJSON()` 写 parent 字段；`loadSceneData` 读 parent 字段后 `setParent`
- **validate-config.mjs**：扫描 scene.json 父子引用闭环，fail-loud
- **测试**：`tests/unit/sceneHierarchy.test.ts`（树构造、递归 modelMatrix、环检测）

#### 3.2.2 glTF 重写

- **GltfLoader.ts 重写**（仍位于 `src/core/gltf/`，纯机制）：
  - 删除 `import { GLTFLoader } from 'three/...'` 与 `@types/three`
  - 删除 `package.json` 的 `three` 与 `@types/three` 依赖
  - 纯手写 JSON + binary buffer 解析（glTF 2.0 核心 spec ~3 周可接受）
  - **保留节点树**：每个 node 保留 `parent`/`children` 索引，loadGltf 时按 `scene` 字段递归创建 Scene 实体并 `setParent`
  - **解析 skin**：joints 列表 + inverseBindMatrices accessor + skeleton root
  - **解析 animations**：channels（target node + path）+ samplers（input/output accessor + interpolation）
  - **解析 morph targets**：每个 primitive 的 `targets` 字段
  - **解析 KHR_materials_* 扩展**：clearcoat/sheen/transmission/volume/unlit/emissive_strength/ior/specular → 扩展 material 字段表
- **GltfTypes.ts 扩展**：新增 `GltfSkin` / `GltfAnimation` / `GltfMorphTarget` / `GltfMaterialExtension` 类型
- **gltf-mapping.json 扩展**：
  ```json
  {
    "transform": { ... + "parent": "parent" },
    "skin": {
      "component": "SkeletonComponent",
      "fields": { "rootJoint": "rootJoint", "jointCount": "jointCount" }
    },
    "animation": { "assetNamespace": "animations" },
    "morph": {
      "component": "MorphComponent",
      "fields": { "weightCount": "weightCount" }
    }
  }
  ```
  - skin/animation/morph 段是可选的：缺段→该 glb 的对应能力不落地，不 throw（设计同学可能只想要静态模型）
  - 但 gltf-mapping.json 声明了 skin 段而 glb 无 skin → 警告，不 throw
- **loadGltf 行为**：
  - 节点树创建为带 parent 的 Scene 实体（key 用 `node.name` 或 `<gltfName>_node<index>`）
  - skin 数据发布到 `resourceManager.registerSkin(name, { joints, inverseBindMatrices, skeletonRoot })`
  - animations 发布到 `resourceManager.registerAnimation(name, { channels, samplers, duration })`
  - morph 数据随 primitive mesh 一起存（扩展 `PbrMeshData` 加 `morphTargets?`）

#### 3.2.3 验证

- 加载 `DamagedHelmet.glb`（静态 PBR）：画面与现状等价
- 加载带骨骼的 glb（如 CesiumMan）：节点树显示父子层级，skin 数据进 ResourceManager（动画播放靠 Phase 4 animation 插件，此阶段仅验证数据落地）
- 加载带 morph 的 glb：morph 数据进 ResourceManager
- `npm run verify` 通过；`tests/unit/gltfLoader.test.ts` 覆盖节点树/skin/animation/morph/KHR 扩展解析


---

### Phase 3 — 场景层级树 + 资产浏览器拖拽创建（P1，2 周）

**目标**：设计同学看到场景树、拖拽模型到画布自动创建实体。

#### 3.3.1 场景层级树

- **新文件** `src/ui/vue/panels/HierarchyPanel.vue`
  - 用 Scene 新 API（`getChildren`/`getParent`）渲染树
  - 拖拽重排父子：拖子到新父 → `host.dispatch(new SetParentCommand(child, newParent))`
  - 选中同步 EditorPanel.select（经 eventBus）
- **EditorUILayer**：在 `tabs` 数组加 `{ id: 'hierarchy', label: 'Hierarchy' }`
- **EditorCommandBus**：新增 `SetParentCommand`（undo 把 parent 改回原值）

#### 3.3.2 资产浏览器扩展

- **AssetViewPanel.vue 扩展**：
  - 扫描 `assets/models/`、`assets/textures/`、`assets/spritesheets/`（经 ProjectFS.readdir 或 fetch manifest.json）
  - 缩略图列表（模型用静态预览图，纹理用 image）
- **新文件** `src/host/AssetDropTarget.ts`
  - 监听 canvas `dragover`/`drop` 事件
  - 按 MIME 分发：
    - `MIME_MESH`（.glb/.gltf）→ 创建实体：Transform + MeshComponent（mesh 名暂空，loadGltf 后 resolveHandles 填）+ PbrMaterial
    - `MIME_TEXTURE`（.png/.jpg）→ 创建实体：Transform + MeshComponent（mesh='plane'）+ PbrMaterial.texBaseColor = handle
  - 走 `host.dispatch(new CreateEntityFromAssetCommand(...))` 支持 undo
- **EditorCommandBus**：新增 `CreateEntityFromAssetCommand`

#### 3.3.3 验证

- 拖一个 glb 到画布 → 自动创建实体 + 模型加载 + 渲染
- 层级树显示父子，拖拽重排即时生效，undo 正常
- `npm run verify` 通过


---

### Phase 4 — 骨骼动画系统 + 时间轴 UI（P2，4 周）

**目标**：角色 glb 的骨骼动画播放，时间轴可暂停/scrub。

#### 3.4.1 animation 插件

- **新目录** `public/plugins/animation/`
  - `meta = { id: 'animation', dependencies: ['core'] }`
  - **组件**（components.json）：
    - `SkeletonComponent`：`rootJoint: u32` / `jointCount: u32` / `skinAsset: string`（引用 ResourceManager 注册的 skin）
    - `AnimationPlayerComponent`：`clip: string`（animation 资产名）/ `time: f32` / `playing: bool` / `loop: bool` / `speed: f32`
    - `MorphComponent`：`weights: vecN`（动态）/ `targetCount: u32`
  - **系统**：
    - `SkinningSystem`（name=`skinning`，`after: ['script']`，`before: ['render']`）
      - 对每个有 SkeletonComponent 的实体：取 skinAsset → 计算 joint matrices（每帧 sample 当前 AnimationPlayer 的 clip）
      - 写入 storage buffer（`array<mat4x4f>`，每个 skeleton 一个）
      - 通过 `ctx.registerGpuResourceSet('animation.skeletons', [...])` 发布
    - `AnimationSamplerSystem`（name=`skeletal-animation`，`after: ['input']`）
      - 推进 AnimationPlayerComponent.time（dt × speed）
      - sample clip 的 channel samplers → 写 SkeletonComponent 的 joint 局部 TRS（CPU 侧）
  - **管线**：
    - `animation:pipelines/SkinnedPbrPipeline.json`：复制 core:PbrPipeline，bindGroups 加一个 storage buffer 组（`animation.skeletons` 资源集）+ vertex input 加 `jointIndex`/`jointWeight`
  - **WGSL**：`animation/shaders/SkinnedPbr.wgsl`：复制 core:PbrShader，vertex 加 skinning 变换：
    ```wgsl
    @group(N) @binding(0) var<storage, read> jointMatrices: array<mat4x4f>;
    @builtin(instance_index) @builtin(vertex_index) ...
    let skinMat = jointMatrices[jointIndex.x] * jointWeight.x + ...;
    pos = skinMat * pos;
    ```
  - **声明装配**：app.json 的 plugins 加 `'animation'`，scene.json 给角色实体挂 SkeletonComponent + AnimationPlayerComponent
  - **关键约束**：animation 不改 core:PbrShader。SkinnedPbrPipeline 是独立管线，与 core:PbrPipeline 平行。无 skin 的实体仍走 core:PbrPipeline

#### 3.4.2 时间轴 UI + 帧控制

- **新文件** `src/ui/vue/panels/TimelinePanel.vue`
  - 播放/暂停/单步/跳到首尾/scrub bar
  - 显示当前 time + dt + frame index
- **Engine 帧时间门控**：
  - `Engine` 加 `editorMode: 'edit' | 'play' | 'pause'`（与 EditorCommandBus.EditMode 对齐）
  - `frame()`：`editorMode === 'pause'` → 跳过系统 update，仍 rAF + 渲染（让 scrub 可见）
  - `Engine.setFrameTime(t)`：scrub 时直接设 `startTime`/`lastTime` 使下一帧 time=t
  - `Engine.stepOnce()`：单步推进一帧（临时切 play 一帧再回 pause）
- **关键约束**：player 模式不装 TimelinePanel，照常 rAF；只有编辑器层才能 pause

#### 3.4.3 验证

- 加载 CesiumMan.glb，挂 AnimationPlayerComponent，播放 Walk 动画
- 暂停 → scrub 时间 → 角色姿态随时间变化可见
- `npm run verify` 通过；新增 `tests/mechanism/skinning.test.ts` 覆盖 joint matrix 计算


---

### Phase 5 — 材质资源对象 + prefab / 实例复用（P2，3 周）

**目标**：设计同学复用材质、摆 100 个相同物体。

#### 3.5.1 材质资源对象

- **ResourceManager 扩展**：
  - `registerMaterial(name, PbrMaterialData)` / `materialRegistry: Map<string, PbrMaterialData>`（owner-tagged）
  - `getMaterial(name)` / `removeMaterialsByOwner(owner)`（owner 清扫一致）
- **PbrMaterial 改动**（components.json）：
  - 加 `material: { type: 'string', default: '' }` 字段（引用材质资源名）
  - 实体可二选一：要么内联字段（兼容老 scene.json），要么 `material` 引用资源
- **PbrPipeline / PipelineDriver 检测**：`material` 字段非空 → 从 registry 读；否则读实体内联字段
- **新文件** `src/ui/vue/panels/MaterialPanel.vue`
  - 材质列表 + 创建/编辑/预览材质球（小球预览走独立 mini render pass）
  - 改材质 → `host.dispatch(new SetMaterialAssetCommand(...))`

#### 3.5.2 prefab / 实例复用

- **Scene 支持 prefab**：
  - `components.json` 加 `PrefabComponent`：`prefab: string`（引用 prefab.json 路径）+ `overrideFields: string`（JSON 字符串，覆盖 prefab 的某些字段）
  - `Scene.loadSceneData`：遇到 PrefabComponent → fetch prefab.json → 深拷贝 + 改 entity key 后缀（`<key>__<n>`）→ 应用 overrideFields → 创建实例
  - prefab.json 是普通 scene.json 子集（一个根实体的 entity 数据）
- **EditorCommandBus**：`CreatePrefabInstanceCommand(prefabPath, position)`
- **编辑器**：选中 prefab 实例 → 检查器显示"来自 prefab: <name>" + 可覆盖字段；"应用所有到 prefab 源"按钮

#### 3.5.3 验证

- 创建一个材质 `Gold`，赋给 3 个不同实体的 `material` 字段 → 改 `Gold.roughness` 即时生效
- 摆 100 个相同 cube 通过 prefab（scene.json 一个 prefab 引用 + 100 个 PrefabComponent 实例）
- `npm run verify` 通过


---

### Phase 6+ — 不做的事（明确边界）

| 不做 | 原因 |
| :--- | :--- |
| PBR 高级扩展（clearcoat/sheen/transmission/volume/ior/specular） | 按 AGENTS.md "渲染插件贡献协议"由独立 PR 贡献，一个 PR 一个能力 |
| ComputeGraph 可视化编排器 | 转入独立子计划 `PLAN_compute_graph.md`，本计划优先级更高 |
| 资产导入/格式转换（fbx→glb、psd→png） | 设计同学自带成品资产 |
| 多人协作 / 云资产库 | 超出本计划范围 |
| 编辑器视口正交/透视切换 | Phase 0 的 ViewportCameraController 已含 fov 控制，正交模式延后 |
| 物理 scrub（暂停后物理状态可回退） | 物理 scrub 破坏 Rapier 确定性，本计划仅做视觉 scrub |
| 节点式管线编辑器（vue-flow 编 RenderGraph） | 与 ComputeGraph 重叠，归入子计划 |


## 四、验证标准（Definition of Done）

| 阶段 | 冻结标准 |
| :--- | :--- |
| Phase 0 | demo1 编辑器能 orbit / 选中实体 / W 拖动 / Ctrl+Z 撤销；player 模式不破；`npm run verify` 通过 |
| Phase 1 | 截图保存为可打开 PNG；录屏保存为可播 WebM；`npm run verify` 通过 |
| Phase 2 | 加载带骨骼的 glb，节点树 + skin 数据落地；`DamagedHelmet` 画面与重写前等价；`npm run verify` 通过 |
| Phase 3 | 拖 glb 到画布自动创建实体；层级树显示父子；`npm run verify` 通过 |
| Phase 4 | CesiumMan 骨骼动画播放；暂停/scrub 可见姿态变化；`npm run verify` 通过 |
| Phase 5 | 100 个 prefab 实例正常渲染；材质资源对象编辑即时生效；`npm run verify` 通过 |
| **交付** | 设计同学照文档 30 分钟内搭出第一个含模型 + 动画 + 截图的 demo；`npm run verify` 全绿 |


## 五、风险与应对

| 风险 | 应对 |
| :--- | :--- |
| **editor view 注入破坏 RenderGraph 多视图** | editor view 是 RenderGraph 的一个独立 view 来源，与场景 Camera 互斥（编辑器模式走 editor view，player 走场景 Camera）；机制测试覆盖双模式 |
| **GPU readback 截图性能差** | staging buffer 复用；截图分辨率选项；不每帧分配 |
| **three.js 移除后 glb 解析工作量超预期** | 分子阶段：先节点树 + 静态 PBR（Phase 2a，1 周）→ 骨骼/动画/morph（Phase 2b，2 周）→ KHR 扩展（Phase 2c，可延后） |
| **Scene 加 parent 破坏老 scene.json** | `parent` 字段 default `''`，老数据空值=根节点；toJSON 仅在非空时写 |
| **animation 插件依赖 core 改 skinning 分支** | 不改。animation 自带 SkinnedPbrPipeline + SkinnedPbr.wgsl，core:PbrShader 零改动 |
| **时间轴 scrub 破坏物理确定性** | 仅编辑器模式可 pause；物理 scrub 不在承诺内（Phase 6+ 不做项） |
| **prefab 实例字段 override 覆盖语义复杂** | Phase 5 简化：overrideFields 是 JSON 字符串，整体替换字段，不支持字段级 diff |
| **gizmo 渲染管线与场景管线深度冲突** | gizmo 走独立 `editor` owner + 独立 phase `EditorOverlay`（perCamera:false，最后画），不进 Opaque/Transparent |
| **资产浏览器扫目录需要后端支持** | dev 走 Vite 的 `import.meta.glob`；连接项目走 ProjectFS.readdir；离线走 IndexedDB manifest |


## 六、与原 ComputeGraph v2 计划的关系

本计划覆写 PLAN.md 后，原 ComputeGraph v2（管线脚本可视化编排器）的内容转入独立子计划文档 `PLAN_compute_graph.md`。两计划的关系：

- **本计划（v3）优先级高于 ComputeGraph**：设计同学搭 demo 的能力空白更紧迫
- **ComputeGraph 依赖本计划的 Phase 0 gizmo / Phase 2 glTF / Phase 4 时间轴** 作为前置（节点图编辑器需要 gizmo 选中实体、glTF 资产、时间轴 scrub 调试）
- **ComputeGraph 不阻塞本计划任何阶段**：本计划不引用 ComputeGraph 任何产物
- 原 ComputeGraph v2 文档已备份至 git 历史，需保留时从 `git log PLAN.md` 取回


## 七、工期总览

| 阶段 | 工期 | 累计 |
| :--- | :---: | :---: |
| Phase 0 — 编辑器视口 + gizmo | 1.5 周 | 1.5 周 |
| Phase 1 — 渲染导出 | 1 周 | 2.5 周 |
| Phase 2 — glTF 重写 + Scene 层级 | 3 周 | 5.5 周 |
| Phase 3 — 层级树 + 资产浏览器 | 2 周 | 7.5 周 |
| Phase 4 — 骨骼动画 + 时间轴 | 4 周 | 11.5 周 |
| Phase 5 — 材质资源 + prefab | 3 周 | 14.5 周 |
| **总计** | **14.5 周** | |

可并行：Phase 1 与 Phase 2a 互不依赖（不同人可并行）；Phase 3 依赖 Phase 2 的 Scene 层级；Phase 4 依赖 Phase 2 的 glTF skin 数据；Phase 5 与 Phase 4 可并行。
