# ShaderLab-WebGPU 架构（Architecture）

> 本文档是引擎/宿主/UI 三层的"架构宪法"。任何改动若违反下列铁律，视为架构回退。

## 一、架构铁律（"宪法"）

### 1. 依赖方向（单向向下）

```
UI Layer → AppHost → Engine Core
```

- `src/ui/` 可 import `src/host/` 和 `src/core/` 的**只读内容**
- `src/host/` 可 import `src/core/`
- `src/core/` **禁止** import 任何 `src/host/` 或 `src/ui/`

### 2. 只读导入白名单

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

### 3. 双通道通信

| 通道 | API | 语义 | 返回值 | Undo |
|------|-----|------|--------|------|
| **命令通道** | `host.dispatch(new Command())` | 请求变更 | `boolean` | ✅ 入栈 |
| **事件通道** | `host.eventBus.emit('evt', payload)` | 广播通知 | `void` | ❌ 不入栈 |

**核心原则**：状态变更走 `dispatch`，状态变更的结果通知走 `eventBus.emit`。

### 4. 双入口隔离

| 入口 | 编辑器 UI | 编辑器输入 | Undo/Redo | App UI |
|------|-----------|------------|-----------|--------|
| `main.ts`（编辑器） | ✅ 加载 | ✅ 加载 | ✅ 可用 | ✅ 加载 |
| `player.ts`（运行时） | ❌ 不加载 | ❌ 不加载 | ❌ 不存在 | ✅ 加载 |

---

## 二、目录结构

```
src/
├── core/                          # Engine Core（对 UI/Host 零依赖）
│   ├── ecs/
│   ├── render/
│   ├── events/
│   ├── math.ts
│   ├── plugins/
│   ├── tools/
│   │   └── ToolRegistry.ts        # registerToolType / TOOL_REGISTRY（无 DOM 依赖）
│   ├── gltf/
│   ├── PluginHost.ts
│   └── Engine.ts
│
├── host/                          # 统一宿主层
│   └── AppHost.ts
│
├── ui/                            # UI 层（平级、可插拔）
│   ├── UILayer.ts
│   └── layers/
│       └── EditorUILayer.ts
│
├── editor/                        # 编辑器核心逻辑（非 UI，但非 Core）
│   ├── EditorCommandBus.ts
│   ├── EditorPanel.ts
│   ├── PipelinePanel.ts
│   ├── dom.ts
│   ├── input/
│   │   ├── EditorInputManager.ts
│   │   ├── ToolSystem.ts
│   │   └── SceneTool.ts
│   └── commands/
│       ├── Command.ts
│       ├── SceneCommands.ts
│       └── RenderGraphCommands.ts
│
├── api.ts                         # @shaderlab/api 唯一公开面（只读契约）
├── main.ts                        # 编辑器入口
├── player.ts                      # 运行时入口
└── types/
```

## 三、关键约定

- **命令通道**：`host.dispatch(cmd)` 返回 `boolean`，成功即入 Undo 栈；编辑器模式下由
  `EditorCommandBus` 执行（`edit` 模式外阻断），player 模式下直接执行（不入栈）。
- **事件通道**：`host.eventBus.emit(type, payload)` 广播，无返回值；用于状态变更后的
  通知（如 `editor:changed`）与工具拾取结果（如 `pick`）。
- **工具注册**：`ToolRegistry`（core）只保留模块级 `registerToolType` / `unregisterToolType`
  与 `TOOL_REGISTRY`，与 `ToolSystem` 类解耦 —— player 模式下插件照常注册工具类型，但无
  编辑器输入管理器去装载/附加它们。
- **api.ts 是契约**：给插件加能力 = 在 api 加导出（宁窄勿宽）；严禁 api 导入
  `public/plugins` 下任何东西。
