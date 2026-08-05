# ShaderLab-WebGPU 架构（Architecture）

> 本文档是引擎/宿主/UI 三层的"架构宪法"。任何改动若违反下列铁律，视为架构回退。
> 配套参考文档：[features.md](./features.md) · [app-development.md](./app-development.md) · [plugin-development.md](./plugin-development.md) · [json-schemas.md](./json-schemas.md) · [code-conventions.md](./code-conventions.md)

---

## 一、插件驱动架构（顶层宪法）

引擎是**插件驱动的图形引擎**。`src/` 只提供**机制**（ECS 存储、渲染图执行器、GPU 资源管理、插件装载器、注册表）；一切**能力**（系统、组件 Schema、管线、着色器、相位、工具、渲染 hook）来自 `public/plugins/<id>/` 下的**运行时装载插件**；一切**组合**（选插件、排系统顺序、摆场景、挂管线）是 `public/apps/<name>/` 与 `public/common/` 下的纯 JSON。

### 三条硬规则

1. **引擎不依赖任何插件**：`src/` 对 `public/plugins/` 零 import、零类型引用。引擎→插件调用只经虚接口（`System`/`PhaseBehavior`/hook/`ToolFactory`/`MeshGenerator`/`AtomResolver`/`IRenderer`/生命周期）+ 注册表分发；插件→引擎只 `import '@shaderlab/api'` 一个面（运行时被重写到 dev `/src/api.ts` / prod `/assets/engine-api.js`）。
2. **所有插件平等**：无 `builtin:` 特权。`core`（五个基线系统）与用户插件走同一条装载链。
3. **fail-loud**：缺文件、重名声明、未注册的 system/behavior/hook/组件一律 throw，不静默回退。

### 三层组合模型

| 层 | 位置 | 内容 | 改动成本 |
|----|------|------|----------|
| **机制层** | `src/` | Engine Core（ECS/RenderGraph/ResourceManager/PluginManager/注册表）+ Host + UI | 引擎重构，需 `npm run verify` |
| **能力层** | `public/plugins/<id>/` | TS 插件（系统/组件/管线/着色器/hook/工具） | 写新目录，引擎零改动 |
| **组合层** | `public/apps/<name>/` + `public/common/` | 纯 JSON（选插件、排系统、摆场景、挂管线） | 改 JSON，无需重构 |

---

## 二、依赖方向（单向向下）

```
UI Layer → AppHost → Engine Core
```

- `src/ui/` 可 import `src/host/` 和 `src/core/` 的**只读内容**
- `src/host/` 可 import `src/core/`
- `src/core/` **禁止** import 任何 `src/host/` 或 `src/ui/`

### 只读导入白名单

UI 层可直接导入以下单例进行**只读查询**：

| 单例 | 允许的操作 |
|------|-----------|
| `schemaRegistry` | `getDef()`, `get()`, `mandatory.has()`, `isRenderTag()` |
| `systemRegistry` | `resolve()`（只读查询） |
| `uniformLayouts` | `get()`, `has()`, `byteSize` |
| `Scene` | 所有 getter（`getField`, `hasComponent`, `getActiveCameras` 等） |
| `RenderGraph` | `getPhaseNames()`, `toData()`, `getComputePipeline()`（只读） |
| `PipelineLoader` | `getConfig()`, `blendPresetNames`（只读） |

**禁止**：UI 层直接调用 `register*`, `load*`, `setField`, `createEntity`, `fromData`, `writeBuffer` 等写入方法。

---

## 三、双通道通信

| 通道 | API | 语义 | 返回值 | Undo |
|------|-----|------|--------|------|
| **命令通道** | `host.dispatch(new Command())` | 请求变更 | `boolean` | ✅ 入栈 |
| **事件通道** | `host.eventBus.emit('evt', payload)` | 广播通知 | `void` | ❌ 不入栈 |

**核心原则**：状态变更走 `dispatch`，状态变更的结果通知走 `eventBus.emit`。

- 编辑器模式：`dispatch` 由 `EditorCommandBus` 执行（`edit` 模式外阻断 + undo/redo）；player 模式：直送 engine（不入栈）。
- 事件用于状态变更后的通知（如 `editor:changed`）与工具拾取结果（如 `pick`）。

---

## 四、双入口隔离

| 入口 | 编辑器 UI | 编辑器输入 | Undo/Redo | App UI |
|------|-----------|------------|-----------|--------|
| `main.ts`（编辑器） | ✅ 加载 | ✅ 加载 | ✅ 可用 | ✅ 加载 |
| `player.ts`（运行时） | ❌ 不加载 | ❌ 不加载 | ❌ 不存在 | ✅ 加载 |

player 不栈化命令、不装载工具/undo——同一份 Engine Core 跑两种角色。

---

## 五、目录结构

```
src/                          分层：host(宿主桥) → core(引擎机制) → ui/editor(界面)
  main.ts                     编辑器入口：AppHost + EditorUILayer（无 rAF——AppHost.startLoop）
  player.ts                   运行时入口（player.html）：AppHost only，无编辑器/工具/undo
  api.ts                      @shaderlab/api 唯一公开面（基类+类型+机制单例+math+RAPIER/bitecs 再导出）
  core/                       引擎机制（对插件/UI 零知识）
    Engine.ts                 宿主：GPU 初始化、engine-config、插件装卸、app 装卸、
                              帧循环（时间 + FrameContext 组装 + systems.json 顺序分发）、
                              attachments 表、插件 ctx/声明注入/owner 清扫、loadGltf
    PluginHost.ts             插件声明应用/owner 清扫/render-hook/mesh-catalog（Engine 委托）
    math.ts                   纯函数 vec3/vec4/mat4 + *Into out-param 变体
    plugins/  Plugin.ts（EnginePlugin 基类 + PluginContext + 声明字段类型）
              PluginManager.ts（装载链：fetch → sucrase 剥类型 → es-module-lexer 重写 import
              （相对→Blob 递归；@shaderlab/api→api URL；裸导入 throw）→
              Blob import → meta.dependencies 拓扑 → init/applyDecls/setup；
              卸载：teardown → 各注册表按 owner 'plugin:<id>' 清扫）
    ecs/      Scene(bitecs 封装) / SchemaRegistry / SystemRegistry（皆 owner 化）
    render/   RenderGraph(相位调度执行器) / PipelineDriver(声明式 draw) /
              PipelineLoader(管线编译，含 '<plugin>:' 虚拟/文件源) /
              ResourceManager(GPU 资源+owner) / UniformLayout(std140) /
              vertexSlots / valueResolver(mini-DSL) / phaseBehaviors(默认三行为) /
              BufferRegistry / shaderGraph(节点式着色器图注册表) / RenderScriptLoader(app 级逃生舱)
    tools/    ToolRegistry(机制)
    events/   EventBus + eventTypes
    gltf/     GltfLoader + GltfTypes
  host/                       宿主桥层：UI Layer → AppHost → Engine Core（AppHost 是唯一桥）
    AppHost.ts                 拥有 Engine + UI 层；dispatch(command) 下行 / eventBus 上行
    ProjectFS.ts               项目文件系统抽象（FileSystemAccessFS/DevServerFS/IndexedDBFS/NullFS）
    UIManager.ts               app 自定义 UI 脚本装载（app.json ui → Blob import mount(container,host)）
  ui/                          界面层（唯一放 UI 代码处；经 host.dispatch 写，eventBus 读）
    UILayer.ts                 接口：mount(container,host)/unmount
    layers/  EditorUILayer(组合根，仅 main.ts 装) / EditorLayout(纯 DOM 框架) / EditorOrchestrator(行为)
    vue/     Vue 面板 + composables + nodeGraph(节点图)
  editor/                      原生面板 + 命令系统（被 ui/layers 消费，非自挂载）
    EditorPanel.ts / PipelinePanel.ts(undo/redo + 虚拟滚动) / EditorCommandBus.ts / dom.ts(ce 工厂)
    input/   EditorInputManager / ToolSystem / SceneTool
    commands/ Command(基类) + Scene/RenderGraph/Shader/Script/ShaderGraph Commands
  types/                       bitecs-legacy.d.ts

public/plugins/<id>/          插件（运行时装载 TS/JS，可拷贝分发，改动无需重构引擎）
  index.ts                    default export class extends EnginePlugin；meta.id=目录名
  core/    基线五系统 + 12 个声明 JSON + 11 条管线 + WGSL + params hook
  physics/ particles/ splat/ sprite/ orbit/ pbd/  能力插件

public/common/                组合层残留：engine-config.json / systems.json / gltf-mapping.json / textures/
public/apps/<name>/           app：app.json + scene.json + render.json + 可选 tools/systems/components/ui-config/graph.json
```

详见 [features.md](./features.md) 各插件/app 清单。

---

## 六、引擎机制概览（改代码前须知）

下列机制是引擎层的"齿轮"。机制级改动必须动 `src/`，且不得引入任何内容/插件知识。

### 帧循环（Engine.frame）
计时 → 组装 `FrameContext`（scene/time/dt/尺寸/device/eventBus/**attachments**/**getSystem**/getBuffer/writeBuffer/dispatchCompute，**无任何具体系统类型**）→ 按 `systems.json` 顺序 `systemRegistry.resolve(name).update(ctx)` → rAF。`appLoading` 期间跳帧。

### PhaseBehavior（相位行为）
`phases.json` 每相位 `behavior` 名 → RenderGraph 注册表查表执行。引擎默认三个实现（`normal`/`shadow-clear`/`postprocess-chain`，`src/core/render/phaseBehaviors.ts`），经与插件相同的 `registerPhaseBehavior` 注册。行为拿到窄门面 `PhaseBehaviorContext`（encoder/drivers/frame/pipelineFor/runDefault/getSystem/transientTargets…）。`perCamera:false` 的行为在 multiView 走每帧一次的 stage1。详见 [code-conventions.md §相位行为](./code-conventions.md#相位行为phase-behavior)。

### attachments（跨插件协作对象）
插件 `ctx.registerAttachment(name, obj)` 发布不透明对象（`'particles'`/`'physics'`/`'splats'`/`'pbd'`）；FrameContext 与 hook ctx 透传，引擎不调用。跨插件协作用 `ctx.getSystem<T>(name)` / `ctx.getPlugin(id)` / attachments —— **结构类型契约**（本地声明 interface），运行时 fail-loud。

### owner 清扫（一切注册带标签）
所有注册（schema/uniform/slots/inputs/blends/bindLayouts/samplers/vbo/fallback/targets/phases/hooks/systems/defs/虚拟管线/attachments/tools/generators/atoms）带 owner 标签（`'engine'` | `'app:<id>'` | `'plugin:<id>'`）；跨 owner 重名 throw；插件卸载 = 按 owner sweep；**卸载插件前必须已无 active app**（app 级插件由 `unloadCurrentApp` 自动逆拓扑卸载）。

### IRenderer 缝
`Engine.renderer` 默认 = RenderGraph；插件可 `ctx.replaceRenderer(r)`（重注册 'render' 分派目标）。编辑器 PipelinePanel 依赖 to/fromData 数据面。

### buffers（系统元数据驱动分配）
system 元数据（`ubos`/`buffers`/`needs`/`after`/`before`）由插件 `systemDefs` 声明（SystemRegistry.injectedDefs），BufferRegistry 按 systems.json 清单分配（common/app scope）。

### 自动插入（autoInsert）
app 未提供自有 `systems.json` 时，`SystemRegistry.autoInsert(commonSystems)` 把声明了 `after`/`before` 但不在默认列表中的 system 自动插入。`after: ['input']` = 插到 input 之后；`before: ['render']` = 插到 render 之前。app 提供了自有 systems.json → 显式覆写优先，不自动插入。`needs` 不驱动自动插入（仅做顺序验证）。详见 [app-development.md §系统顺序](./app-development.md#系统顺序systemsjon)。

### api.ts 是契约
给插件加能力 = 在 api 加导出（宁窄勿宽）；**严禁 api 导入 `public/plugins` 下任何东西**。dev 下 Blob 模块 import `/src/api.ts` 与主包同 URL 同实例；prod 下 `engine-api.js` 与 main 共享 Rollup chunk。改 vite.config 的 entry 配置前先理解这一点。

---

## 七、关键约定速查

- **工具注册**：`ToolRegistry`（core）只保留模块级 `registerToolType` / `unregisterToolType` 与 `TOOL_REGISTRY`，与 `ToolSystem` 类解耦 —— player 模式下插件照常注册工具类型，但无编辑器输入管理器去装载/附加它们。
- **虚拟路径**：`'<plugin>:<rest>'`（如 `core:pipelines/PbrPipeline.json`）由 `PipelineLoader.pluginRef` 正则 `/^([A-Za-z0-9_-]+):(?!\/)(.+)$/` 解析为 `/plugins/<plugin>/<rest>`。着色器引用相对管线文件目录解析。
- **值源 mini-DSL**：管线 JSON 的 `value`/`source`/`countField` 字符串由 `valueResolver` 预编译为闭包。详见 [code-conventions.md §值原子](./code-conventions.md#值原子value-atom--mini-dsl)。
- **fail-loud 触发点**：缺声明文件、未知组件（scene.json）、未知相位键（render.json）、未知相位 behavior、未解析的 system 名（systems.json）、跨 owner 重名、未知 mesh generator、未知 tool type —— 一律 throw。

## 八、相关文档

- [features.md](./features.md) —— 引擎与各插件/app 的能力清单
- [app-development.md](./app-development.md) —— 组合层开发指南（Agent 友好）
- [plugin-development.md](./plugin-development.md) —— 能力层开发指南（Agent 友好）
- [json-schemas.md](./json-schemas.md) —— 所有 JSON 声明的 schema 锚定
- [code-conventions.md](./code-conventions.md) —— WGSL/脚本/插件 TS 等非 JSON 规范
- 仓库根 [AGENTS.md](../AGENTS.md) —— 构建命令、目录速查、陷阱速查
