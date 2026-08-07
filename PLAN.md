# ShaderLab 编辑器优化计划（最终执行版）

> 本计划合并 PLAN1（任务清单式）与 PLAN2（方案设计式）之长，并**纠正两者对节点编辑器现状的共同误判**。
> 所有"现状"声明均经逐文件核对（2026-08-03），附代码坐标。
> 架构基准：`src/core`（引擎）↔ `src/host`（AppHost 宿主）↔ `src/ui` + `src/editor`（编辑器），命令/事件双通道。

---

## 一、现状基线（已核实，实施前不再复查）

| 模块 | 状态 | 证据 |
|------|------|------|
| 三层分离 + 命令/事件双通道 | ✅ 成熟 | `AppHost.ts:9-18`、`main.ts:27-38` |
| EditorPanel schema 反射 | ✅ 就绪 | `EditorPanel.ts:178` `renderField` 按 `fd.type` 分派 string/bool/f32/u32/vec2-4；**未分派 role** |
| PipelinePanel（原生 DOM） | ✅ 就绪 | `PipelinePanel.ts`，含 undo/redo、PatchRenderGraphCommand |
| role 字段基础设施 | ✅ 已有 | `SchemaRegistry.ts:7` `role?:string` + `getFieldByRole`/`isRenderTag`；`components.json` 已用 color/extra/viewport（供 renderer） |
| ResourceManager 枚举/句柄 | ⚠️ 半成 | `getMeshNames`/`getTextureNames`/`textureHandle` 在；**无 `getMeshHandle`** |
| AssetViewPanel | ⚠️ 骨架 | 扁平类型分类，无文件夹视图；Pipeline 类有预览，Mesh/Texture/Shader 预览"not yet implemented"；无拖拽 |
| 脚本/Shader 编辑 | ✅ 内存热重载 | `ScriptEditorPanel.vue:91`/`WgslEditorPanel.vue:29` 仅 dispatch reload 命令；无创建、无持久化 |
| 节点编辑器 | ⚠️ **半交互**（非只读） | `PipelineNodeEditor.vue` **已有**：`addNode`(L101)、`removeNode`(L131)、inspector(L226)、`commitParams`→`MutateShaderGraphCommand`(L141)。**缺失**：`@connect`、`@nodes-change`、Palette、连线约束 |
| 命令体系 | ✅ 齐全 | SetField/MutateRenderGraph/PatchRenderGraph/MutatePipelineConfig/Reload{System,Gameplay,Render}Script/HotReloadShader/MutateShaderGraph/RegisterShaderGraph 全在 |
| ShaderGraphExecutor | ✅ 运行 | `shaderGraph.ts:122`；值源编译已缓存(L230)，求值结果未按帧缓存 |
| EditorUILayer | ⚠️ 420 行臃肿 | `EditorUILayer.ts` 混 layout(resizer/tab) + orchestration(bus/Vue 挂载/面板) |
| PreviewManager / ProjectFS / templates | ❌ 全无 | 源码零实现，全新建设 |

---

## 二、关键决策（路线裁决）

1. **不做全量 Vue 化前置**。`EditorPanel`/`PipelinePanel` 原生 DOM 运行良好（反射、虚拟滚动、undo/redo 齐备），全量重写为 Vue 组件（PLAN2 的 1 周前置）回归风险高且不解锁任何真实缺口。**资源 role 渲染直接在原生 `EditorPanel.renderField` 内分派**，复用已有 `dom.ts` 工厂。
2. **采纳 PLAN2 的方案深度**：role 扩展、PreviewManager 分类型策略、Mesh 句柄化、ProjectFS 三后端、模板引擎。
3. **节点图按真实现状收窄**：在已有增删/inspector/Command 同步之上，只补 `@connect` + `@nodes-change` + Palette + 连线约束（PLAN2 原 2 周 → 约 1 周）。
4. **EditorUILayer 拆分**作为轻量前置（非 PLAN2 的全量 Vue 化），降低后续接入拖拽/预览时的改造成本。

---

## 三、分阶段实施

### Phase 0：轻量前置（0.5 周）

**0.1 拆分 `EditorUILayer` → `EditorLayout` + `EditorOrchestrator`**
- `src/ui/layers/EditorLayout.ts`：DOM 框架（toolbar/tab shell/resizer/findOrCreate/docTabHandler）
- `src/ui/layers/EditorOrchestrator.ts`：挂载面板、绑定 CommandBus、Vue 面板挂载/卸载、app 切换、picking 订阅
- `src/ui/layers/EditorUILayer.ts`：瘦身为实现 `UILayer` 的薄壳，组合上述两者
- 保留 `dispatch(cmd)` 委托入口（`AppHost` 依赖它）

**0.2 抽取 `AppHost.loadAppUI` → `src/host/UIManager.ts`**
- 迁移 `AppHost.ts:66-106`（loadAppUI/loadUIScript/createContainer/appUILayers）
- `AppHost` 持有 `UIManager` 实例并委托；对外 API 不变（`host.loadAppUI()` 仍可调）

---

### Phase 1：资源引用系统（P0，1.5 周）

**1.1 扩展 role 语义 + 编辑器分派**
- `SchemaRegistry.ts`：`role` 注释补 `mesh|texture|shader|buffer`（类型仍 `string`，避免破坏现有 color/extra/viewport）
- `EditorPanel.ts:178 renderField`：在 `fd.type` 分派前先查 `fd.role`：
  - `role==='mesh'` → `makeSelect(rm.getMeshNames(), val, onChange)` + 拖放区
  - `role==='texture'` → 拖放区（显示当前 handle 对应名）
  - `role==='color'` → `makeColorField`（新增 `dom.ts`，`<input type=color>` 返回 `[r,g,b,a]`）
  - 其余 role 走原 type 分派
- `dom.ts` 新增 `makeColorField`、`makeAssetRef`（下拉 + drop 区复合控件）

**1.2 Mesh 句柄化**
- `ResourceManager.ts`：新增 `getMeshHandle(name): number`（复用 handle 表或新建 `meshHandleList`，与 `textureHandle`(L745) 对称）
- 现有 `MeshComponent.mesh` 仍存字符串名（不破坏数据）；`getMeshHandle` 供 Preview/拖拽用

**1.3 PreviewManager**
- 新建 `src/core/render/PreviewManager.ts`（或 `src/ui/PreviewManager.ts`，按是否需 GPU 设备定）
- 策略：
  - **Mesh**：离屏 128×128 RenderPass，固定相机 + 纯色光照，`copyTextureToBuffer` → `ImageBitmap`，LRU 缓存
  - **Texture**：源是图片→`<img>`；GPUTexture→`copyExternalImageSubResourceToTexture` 到 canvas
  - **Shader**：取 `PipelineLoader.getShaderKeySource(ref)` 前 10 行文本
  - **Pipeline**：复用现有 `AssetViewPanel` 的配置标签预览
- 接口：`getPreview(kind, key): Promise<{ url?: string; text?: string }>`

**1.4 AssetViewPanel 升级**
- `AssetViewPanel.vue`：增加视图模式切换（文件夹视图 / 图标视图 / 当前列表视图）
- 文件夹视图：按 URL 路径树形组织（`common/meshes/`、`apps/<app>/textures/`），逻辑分组非真实 FS
- 图标视图：卡片网格，`PreviewManager.getPreview` 填充缩略图
- 替换 `previewInfo` 的 `"Preview not yet implemented"`(L111) 为 `PreviewManager` 调用

**1.5 拖拽协议**
- **源**（AssetViewPanel）：`draggable="true"`，`@dragstart` 设 MIME：
  - `application/shaderlab-mesh` = mesh 名
  - `application/shaderlab-texture` = texture handle（`rm.textureHandle(name)`）
  - `application/shaderlab-shader` = shader ref
- **目标**（EditorPanel 资源字段）：`ondragover`/`ondrop` 读 MIME → `SetFieldCommand`
  - texture 字段写 handle(u32)；mesh 字段写名(string)；进 undo 栈
- 非拖拽场景保留手动输入能力

---

### Phase 2：持久化与文件创建（P0，1.5 周）

**2.1 ProjectFS 抽象层**
- 新建 `src/host/ProjectFS.ts`：
  ```ts
  interface ProjectFS {
      readFile(path: string): Promise<string>;
      writeFile(path: string, content: string): Promise<void>;
      readdir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
      exists(path: string): Promise<boolean>;
  }
  ```
- 三后端：
  - `FileSystemAccessFS`（`window.showDirectoryPicker`，MVP 首选，无后端）
  - `DevServerFS`（Vite 自定义 API 路由 `/__fs__`，dev 服务器可写真实文件）
  - `IndexedDBFS`（纯浏览器持久化，降级方案）
- `AppHost` 持有 `projectFS`，按环境选择后端

**2.2 Save 按钮接入**
- `ScriptEditorPanel.vue:91 onSave`：dispatch reload 命令后，追加 `projectFS.writeFile(ref.path, code)`
- `WgslEditorPanel.vue:29 onSave`：接口守卫通过后，`projectFS.writeFile(shaderKey, code)`
- `EditorPanel.saveJSON`：改为 `projectFS.writeFile('scene.json', ...)`（保留下载降级）
- 命令标记 `isDirty`，toolbar 显示"未保存"指示

**2.3 模板引擎**
- 新建 `public/common/templates/`：
  - `system.js`、`render.js`、`shader.wgsl` 标准样板（用 PLAN2 的 boilerplate）
- 编辑器"New"按钮（ScriptEditorPanel/WgslEditorPanel 顶部）→ 弹窗选模板 + 输入名 → 生成文本

**2.4 新建文件注册引用**
- 新建 System Script → 追加到 `systems.json`（经 `MutateRenderGraphCommand` 或新 `MutateSystemsCommand`）
- 新建 Render Script → 追加到 `render.json` 的 `renderScripts`（`MutateRenderGraphCommand`）
- 新建 WGSL → 在管线 `pipeline.json` 引用（提示用户手动接，或扩展命令）
- 写盘 + 立即加载到内存 + 打开编辑器

**2.5 场景写回**
- `EditorPanel.saveJSON` 增加分支：已挂载 ProjectFS 时写回 `<app>/scene.json` 而非下载

---

### Phase 3：节点编辑器补全（P1，1 周）—— 按真实现状收窄

> **起点**：已有 `addNode`/`removeNode`/inspector/`commitParams`→`MutateShaderGraphCommand`。只补以下缺口。

**3.1 画连线（@connect）**
- `PipelineNodeEditor.vue` `<VueFlow>` 增加 `@connect="onConnect"`
- `onConnect({ source, sourceHandle, target, targetHandle })`：构造 `ShaderGraphEdge`（id=`e${Date.now()}`）→ `applyGraph(g => g.edges.push(edge))` → `MutateShaderGraphCommand`
- 连线进入 undo 栈，与现有 commitParams 同机制

**3.2 拖动节点持久位置（@nodes-change）**
- `ShaderGraphNode` schema 增加可选 `position?: { x: number; y: number }`（`shaderGraph.ts` 接口）
- `graphAdapter.shaderGraphToFlow`：若 node 有 position 则用之，否则走现有自动布局
- `PipelineNodeEditor.vue` 增加 `@nodes-change="onNodesChange"`，过滤 `type==='position'` 的 change → 写回 `flowNode.data.node.position` → 显式 Save 按钮时 `commitParams`（不实时发命令，防抖）

**3.3 Palette（替代 prompt）**
- 左侧工具栏列出 5 种节点模板（data/shader/if/foreach/loop），拖拽到画布生成节点
- 替换现有 `addNode` 的 `window.prompt`（`PipelineNodeEditor.vue:101`）

**3.4 连线约束**
- `onConnect` 内调 `isValidConnection(conn)`：
  - data.out → shader.in:N only
  - 控制节点 body/next 按类型约束
  - 禁止跨控制流边
- 非法则阻断并提示

**3.5（可选）混合视图**
- 简单数据绑定场景用配置表格（shader + binding 列表），复杂控制流切节点图
- 节点图聚焦 If/ForEach/Loop 嵌套与多阶段数据流

---

### Phase 4：打磨（P2，0.5 周）

**4.1 面板错误边界**
- `EditorUILayer.mountVuePanels` 已有 try/catch（L292）；为原生 `EditorPanel`/`PipelinePanel` 的 render 包错误捕获，防单面板崩溃拖垮整体

**4.2 ShaderGraphExecutor 求值缓存**
- `shaderGraph.ts:run`(L241)：增加帧级 `fieldCache: Map<string, unknown>`，`evalSource` 求值 `Component.field` 时先查缓存
- 同帧多节点读同字段复用（现有 `compiledSrc` 只缓存编译闭包，未缓存求值结果）

**4.3 暗色主题切换**
- CSS 变量已支持（`AssetViewPanel` 用 `--asset-col1` 等），toolbar 加切换按钮，写 localStorage

**4.4 快捷键统一**
- Ctrl+S 保存（ScriptEditor/WgslEditor 已有，扩展到场景）、Delete 删节点、Ctrl+Z/Y 覆盖节点图

---

## 四、验收标准

- [ ] EditorPanel 资源字段（mesh/texture）显示下拉 + 拖放区，拖拽 AssetView 资源项实时更新且可撤销
- [ ] AssetViewPanel 三视图模式（列表/文件夹/图标），Mesh/Texture/Shader 显示预览缩略图
- [ ] 脚本/Shader 编辑器 Ctrl+S 写回磁盘，刷新页面内容仍在
- [ ] "New"按钮生成带模板文件，并自动列入 systems.json/render.json
- [ ] 节点编辑器可画连线（@connect）、拖动节点位置持久、Palette 拖拽建节点，均可撤销
- [ ] 连线约束生效，非法连线被阻断
- [ ] EditorUILayer 拆为 Layout + Orchestrator，AppHost 的 loadAppUI 迁至 UIManager
- [ ] ShaderGraphExecutor 同字段同帧只求值一次

---

## 五、风险与应对

| 风险 | 应对 |
|------|------|
| File System Access API 在非安全上下文/非 Chromium 不可用 | 三后端降级链：FileSystemAccess → DevServerFS(dev) → IndexedDBFS；保留"导出/导入"手动兜底 |
| Mesh 离屏预览的 GPU 资源泄漏 | PreviewManager LRU + 卸载 app 时 destroy 离屏 target/管线 |
| ShaderGraphNode 加 position 破坏现有 graph JSON 兼容 | position 设可选字段，旧数据缺省时走自动布局 |
| @nodes-change 实时发命令卡顿 | 不实时发；拖动只更新本地 flow 状态，显式 Save 按钮一次性 commitParams |
| role 扩展误伤现有 renderer 对 color/extra/viewport 的依赖 | role 类型保持 `string` 不收紧；编辑器分派用 `if(role==='mesh')` 前置，未命中走原 type 分派 |

---

## 六、时间估算（已按真实现状校正）

| 阶段 | 内容 | 估算 |
|------|------|------|
| Phase 0 | EditorUILayer 拆分 + UIManager 抽取 | 0.5 周 |
| Phase 1 | role 扩展 + PreviewManager + AssetView 升级 + 拖拽协议 + Mesh 句柄 | 1.5 周 |
| Phase 2 | ProjectFS 三后端 + Save 接入 + 模板引擎 + 新建注册 | 1.5 周 |
| Phase 3 | 节点图 @connect + @nodes-change + Palette + 约束（**起点已半成交付**） | 1.0 周 |
| Phase 4 | 错误边界 + 求值缓存 + 主题 + 快捷键 | 0.5 周 |
| **合计** | | **5.0 周** |

> Phase 1 与 Phase 3 互不依赖，可并行。Phase 2 依赖 ProjectFS，与 1/3 也可并行。

---

## 七、关键代码坐标（实施定位）

| 主题 | 文件:行 |
|------|---------|
| 三层宿主 | `src/host/AppHost.ts:9` / `src/main.ts:27` |
| 命令分发 | `AppHost.ts:57` / `EditorUILayer.ts:417` |
| EditorPanel 反射渲染（改 role 分派） | `src/editor/EditorPanel.ts:178` |
| role 字段 | `src/core/ecs/SchemaRegistry.ts:7,220` |
| role 实际值（color/extra/viewport） | `public/plugins/core/components.json:36,41,48,59` |
| dom 工厂（新增 makeColorField/makeAssetRef） | `src/editor/dom.ts:1,8,34` |
| ResourceManager（加 getMeshHandle） | `src/core/render/ResourceManager.ts:154,156,745` |
| AssetViewPanel（升级视图+预览+拖拽源） | `src/ui/vue/panels/AssetViewPanel.vue:13,94,111` |
| 脚本面板（Save 接 ProjectFS） | `src/ui/vue/panels/ScriptEditorPanel.vue:91` |
| Shader 面板（Save 接 ProjectFS） | `src/ui/vue/panels/WgslEditorPanel.vue:29` |
| 节点编辑器（补 @connect/@nodes-change/Palette） | `src/ui/vue/panels/PipelineNodeEditor.vue:101,141,182,226` |
| graphAdapter（读 node.position） | `src/ui/vue/nodeGraph/graphAdapter.ts:51,64,75` |
| ShaderGraph 节点接口（加 position） | `src/core/render/shaderGraph.ts:32-98` |
| ShaderGraphExecutor.run（加帧级缓存） | `src/core/render/shaderGraph.ts:122,230,241` |
| EditorUILayer（拆分） | `src/ui/layers/EditorUILayer.ts` |
| AppHost.loadAppUI（迁出） | `src/host/AppHost.ts:66-106` |
| 命令清单 | `src/editor/commands/*.ts` |
