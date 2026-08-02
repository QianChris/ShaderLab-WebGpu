# 架构重构执行计划（最终修正版）：Engine Core ↔ AppHost ↔ UI Layers

**目标**：将引擎核心与编辑器 UI 彻底解耦，引入 AppHost 作为统一宿主。编辑器交互逻辑（拾取/选中）作为编辑器专属模块，运行时入口完全不包含任何编辑器代码。本次重构仅夯实架构地基，不涉及脚本编辑器、节点编辑器等复杂工具。

**执行原则**：
- 严格遵循单向依赖：`UI Layer → AppHost → Engine Core`
- 命令走 `host.dispatch()` 同步通道，事件走 `host.eventBus.emit()` 广播通道
- UI 层允许只读导入 Core 单例，禁止直接执行写入操作

---

## 一、架构铁律（“宪法”）

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

## 二、重构后目录结构

```
src/
├── core/                          # Engine Core（移除所有 UI 依赖）
│   ├── ecs/
│   ├── render/
│   ├── events/
│   ├── math/
│   ├── plugins/
│   ├── tools/                     # 模块级工具注册表（供 Core 和插件使用）
│   │   └── ToolRegistry.ts        # registerToolType / TOOL_REGISTRY（无 DOM 依赖）
│   └── Engine.ts                  # 移除 toolSystem，增加只读 accessors
│
├── host/                          # 统一宿主层
│   └── AppHost.ts
│
├── ui/                            # UI 层（平级、可插拔）
│   ├── UILayer.ts
│   └── layers/
│       └── EditorUILayer.ts       # 整合编辑器面板、命令总线、输入管理器
│
├── editor/                        # 编辑器核心逻辑（非 UI，但非 Core）
│   ├── EditorCommandBus.ts        # 原 EditorHost 重命名
│   ├── EditorPanel.ts             # 场景/属性面板（修改依赖方向）
│   ├── PipelinePanel.ts           # 管线面板（修改依赖方向）
│   ├── input/
│   │   ├── EditorInputManager.ts  # 封装 ToolSystem 生命周期
│   │   ├── ToolSystem.ts          # 原 src/tools/ToolSystem.ts 移入
│   │   └── SceneTool.ts           # 原 src/tools/SceneTool.ts 移入
│   └── commands/
│       ├── Command.ts
│       ├── SceneCommands.ts
│       └── RenderGraphCommands.ts
│
├── main.ts                        # 编辑器入口
├── player.ts                      # 运行时入口
└── types/
```

---

## 三、执行任务清单（分 7 个 Phase）

### Phase 0：环境准备（10 分钟）

1. 安装 Vue 3（为后续新 UI 组件做准备，本次不迁移现有面板）：
   ```bash
   npm install vue@next @vitejs/plugin-vue
   ```

2. 修改 `vite.config.ts`，注册 Vue 插件并配置**多入口打包**：
   ```typescript
   import { defineConfig } from 'vite';
   import vue from '@vitejs/plugin-vue';

   export default defineConfig({
     plugins: [vue()],
     build: {
       rollupOptions: {
         input: {
           main: 'index.html',
           player: 'player.html',
         },
       },
     },
   });
   ```

3. 新建 `player.html`（复制 `index.html`，将 `<script type="module" src="/src/main.ts"></script>` 改为 `/src/player.ts`）。

4. 在项目根目录创建 `docs/ARCHITECTURE.md`，将上述“架构铁律”完整粘贴进去。

---

### Phase 1：Engine Core 清理 + AppHost 创建（30 分钟）

#### 1.1 Engine.ts 清理

- **删除**以下代码：
  - `import { ToolSystem, registerToolType, unregisterToolType } from './tools/ToolSystem'`
  - `toolSystem!: ToolSystem` 属性
  - 构造函数中的 `this.toolSystem = new ToolSystem(...)`
  - `loadAppInner` 中的 tools 加载逻辑（`if (manifest.tools) { ... }`）
  - `unloadCurrentApp` 中的 `this.toolSystem.dispose()`

- **新增**以下公共只读属性（供 UI 层只读访问）：
  ```typescript
  export class Engine {
    // ... 现有属性

    get schemaRegistry() { return schemaRegistry; }
    get systemRegistry() { return systemRegistry; }
    get uniformLayouts() { return uniformLayouts; }
    get resourceManager() { return resourceManager; }
    get canvas() { return this._canvas; }  // 将 private canvas 改为 _canvas，暴露 getter

    /** 供外部计算宽高比（原为 private） */
    aspect(): number {
      return this._canvas.width / Math.max(1, this._canvas.height);
    }
  }
  ```

- **修正** `makePluginContext` 中的 `registerToolType`：
  ```typescript
  // 改为从 core/tools/ToolRegistry 导入，确保 player.ts 下也存在
  import { registerToolType } from '../tools/ToolRegistry';
  
  registerToolType: (name, factory) => {
    registerToolType(name, factory);
    ledger.tools.push(name);
  },
  ```

#### 1.2 提取 ToolRegistry

- 新建 `src/core/tools/ToolRegistry.ts`：
  ```typescript
  import type { ToolFactory } from '../../editor/input/SceneTool'; // 类型仅编译期

  export const TOOL_REGISTRY: Record<string, ToolFactory> = {};

  export function registerToolType(type: string, factory: ToolFactory): void {
    if (TOOL_REGISTRY[type]) throw new Error(`Tool type '${type}' already registered`);
    TOOL_REGISTRY[type] = factory;
  }

  export function unregisterToolType(type: string): void {
    delete TOOL_REGISTRY[type];
  }
  ```

- 修改原 `src/tools/ToolSystem.ts`（后续将移入 `src/editor/input/`）：
  - 移除模块级的 `TOOL_REGISTRY`、`registerToolType`、`unregisterToolType`
  - 改为 `import { TOOL_REGISTRY, registerToolType } from '../../core/tools/ToolRegistry'`

#### 1.3 创建 AppHost

- 新建 `src/host/AppHost.ts`：
  ```typescript
  import { Engine } from '../core/Engine';
  import { EventBus } from '../core/events/EventBus';
  import type { Command, CommandContext } from '../editor/commands/Command';
  import type { UILayer } from '../ui/UILayer';

  export class AppHost {
    public engine: Engine;
    public eventBus: EventBus;
    private uiLayers: UILayer[] = [];
    private uiContainer: HTMLElement;
    private editorLayer?: { dispatch(cmd: Command): boolean };

    constructor(canvas: HTMLCanvasElement, uiContainer: HTMLElement) {
      this.engine = new Engine(canvas);
      this.eventBus = this.engine.eventBus;
      this.uiContainer = uiContainer;
    }

    async init() { await this.engine.init(); }
    async loadApp(name: string) { await this.engine.loadApp(name); }
    startLoop() { this.engine.startLoop(); }
    resize() { this.engine.resize(); }
    get engineConfig() { return this.engine.engineConfig; }

    // 只读代理
    get scene() { return this.engine.scene; }
    get renderGraph() { return this.engine.renderGraph; }

    mountLayer(layer: UILayer) {
      layer.mount(this.uiContainer, this);
      this.uiLayers.push(layer);
      if (layer.id === 'editor') {
        this.editorLayer = layer as unknown as { dispatch(cmd: Command): boolean };
      }
    }

    unmountAll() {
      for (const layer of this.uiLayers) layer.unmount();
      this.uiLayers = [];
      this.editorLayer = undefined;
    }

    dispatch(cmd: Command): boolean {
      if (this.editorLayer) {
        return this.editorLayer.dispatch(cmd);
      }
      // 运行时无编辑器：直接执行，不入栈
      const ctx: CommandContext = { engine: this.engine };
      return cmd.execute(ctx);
    }

    async loadAppUI(appBase: string) { /* Phase 5 实现 */ }
  }
  ```

#### 1.4 创建 UILayer 接口

- 新建 `src/ui/UILayer.ts`：
  ```typescript
  import type { AppHost } from '../host/AppHost';

  export interface UILayer {
    id: string;
    mount(container: HTMLElement, host: AppHost): void | Promise<void>;
    unmount(): void;
  }
  ```

---

### Phase 2：迁移 ToolSystem 为编辑器内置模块（40 分钟）

#### 2.1 移动文件

- 将 `src/tools/` 下所有文件移动到 `src/editor/input/`
- 更新这些文件内部的 import 路径（如 `../ecs/Scene` → `../../core/ecs/Scene`）

#### 2.2 新建 EditorInputManager

- 新建 `src/editor/input/EditorInputManager.ts`：
  ```typescript
  import { ToolSystem } from './ToolSystem';
  import type { Scene } from '../../core/ecs/Scene';
  import type { EventBus } from '../../core/events/EventBus';

  export class EditorInputManager {
    private toolSystem: ToolSystem;

    constructor(
      scene: Scene,
      eventBus: EventBus,
      getSystem: <T>(name: string) => T | null,
      getAspect: () => number,
    ) {
      this.toolSystem = new ToolSystem(scene, eventBus, getSystem, getAspect);
    }

    /** 加载当前 App 的 tools.json */
    async loadTools(appBase: string, toolsPath: string): Promise<void> {
      this.toolSystem.setBase(appBase);
      await this.toolSystem.loadFromFile(`${appBase}/${toolsPath}`);
    }

    dispose(): void {
      this.toolSystem.dispose();
    }
  }
  ```

**注意**：`ToolSystem` 本身没有 `attach(canvas)` / `detach()` 方法，它通过 `load()` 在内部管理 `SceneTool.attach/detach`。`EditorInputManager` 封装的是 `loadTools` 和 `dispose`，不要调用不存在的 `attach/detach`。

---

### Phase 3：重构编辑器 UI 层（EditorUILayer）（70 分钟）

#### 3.1 重命名 EditorHost → EditorCommandBus

- 移动 `src/editor/EditorHost.ts` → `src/editor/EditorCommandBus.ts`
- 类名改为 `EditorCommandBus`
- 保留所有原有逻辑（`dispatch`, `undo`, `redo`, `play`, `pause`, `stop`, `setField`, `createEntity`, `removeEntity`, `mutateRenderGraph`）
- 保持 `Command` 相关实现完全不变

#### 3.2 修改 EditorPanel 和 PipelinePanel

- **移除**对 Core 单例的**写入**依赖，保留**只读** import：
  - 保留 `import { schemaRegistry } from '../ecs/SchemaRegistry'`（只读查询）
  - 保留 `import { PipelineLoader } from '../render/PipelineLoader'`（只读查询）
  - 移除任何直接调用 `scene.setField`、`renderGraph.fromData` 的代码，改为通过 `commandBus.dispatch()` 执行

- **修改构造函数/attach 签名**：
  - 原 `EditorPanel` 接收 `container: HTMLElement`，内部通过固定 ID 查找子元素
  - 改为接收 `host: AppHost` 或 `commandBus: EditorCommandBus`，不再直接操作 Engine

#### 3.3 新建 EditorUILayer

- 新建 `src/ui/layers/EditorUILayer.ts`：
  ```typescript
  import type { AppHost } from '../../host/AppHost';
  import type { UILayer } from '../UILayer';
  import type { Command } from '../../editor/commands/Command';
  import { EditorCommandBus } from '../../editor/EditorCommandBus';
  import { EditorInputManager } from '../../editor/input/EditorInputManager';
  import { EditorPanel } from '../../editor/EditorPanel';
  import { PipelinePanel } from '../../editor/PipelinePanel';

  export class EditorUILayer implements UILayer {
    id = 'editor';
    private commandBus?: EditorCommandBus;
    private inputManager?: EditorInputManager;
    private panels: { editor?: EditorPanel; pipeline?: PipelinePanel } = {};

    async mount(container: HTMLElement, host: AppHost) {
      // ── 1. 构建编辑器 DOM 结构 ──
      // 原 main.ts 中的 tab 结构移入此处
      container.innerHTML = `
        <div class="editor-head">
          <span class="ed-title">Scene Editor</span>
          <div class="editor-btn-row">
            <button class="editor-btn" id="btn-save">Save JSON</button>
            <button class="editor-btn" id="btn-load">Load JSON</button>
          </div>
        </div>
        <div class="tab-bar">
          <button class="tab-btn active" data-tab="scene">Scene</button>
          <button class="tab-btn" data-tab="pipeline">Pipeline</button>
        </div>
        <div id="tab-scene" style="display:flex"></div>
        <div id="tab-pipeline" style="display:none"></div>
      `;

      const sceneContainer = container.querySelector('#tab-scene') as HTMLElement;
      const pipelineContainer = container.querySelector('#tab-pipeline') as HTMLElement;

      // ── 2. 初始化命令总线 ──
      this.commandBus = new EditorCommandBus(host.engine);

      // ── 3. 初始化输入管理器（拾取/工具）──
      this.inputManager = new EditorInputManager(
        host.engine.scene,
        host.eventBus,
        (name) => host.engine.systemRegistry.resolve({ name }),
        () => host.engine.aspect(),
      );

      // 加载当前 App 的 tools.json（关键：补全原 Engine 中的加载逻辑）
      const appName = host.engine.currentApp;
      if (appName) {
        const base = `${host.engineConfig.appsRoot}/${appName}`;
        try {
          const manifestResp = await fetch(`${base}/app.json`);
          if (manifestResp.ok) {
            const manifest = await manifestResp.json();
            if (manifest.tools) {
              await this.inputManager.loadTools(base, manifest.tools);
            }
          }
        } catch (e) {
          console.warn('[EditorUILayer] failed to load tools:', e);
        }
      }

      // ── 4. 初始化面板 ──
      const editorPanel = new EditorPanel(sceneContainer);
      const pipelinePanel = new PipelinePanel(pipelineContainer);

      editorPanel.attach(this.commandBus);
      pipelinePanel.attach(this.commandBus);
      editorPanel.render();
      pipelinePanel.render();

      // 绑定 tab 切换
      const buttons = container.querySelectorAll<HTMLButtonElement>('.tab-btn');
      buttons.forEach(btn => {
        btn.onclick = () => {
          const tab = btn.dataset.tab;
          buttons.forEach(b => b.classList.toggle('active', b === btn));
          sceneContainer.style.display = tab === 'scene' ? 'flex' : 'none';
          pipelineContainer.style.display = tab === 'pipeline' ? 'flex' : 'none';
        };
      });

      // 绑定 app 切换回调（原 main.ts 中的 switchToApp）
      editorPanel.onAppSwitch = async (name: string) => {
        await host.loadApp(name);
        editorPanel.render();
        pipelinePanel.render();
      };

      this.panels = { editor: editorPanel, pipeline: pipelinePanel };

      // 监听引擎事件刷新面板
      host.eventBus.on('editor:changed', () => {
        editorPanel.render();
        pipelinePanel.render();
      });
    }

    unmount() {
      this.inputManager?.dispose();
      this.commandBus = undefined;
      this.panels = {};
    }

    dispatch(cmd: Command): boolean {
      return this.commandBus?.dispatch(cmd) ?? false;
    }
  }
  ```

**关键修正**：
- `EditorUILayer` 负责构建原 `index.html` 中的 tab DOM 结构
- `EditorPanel` 和 `PipelinePanel` 分别挂载到 `#tab-scene` 和 `#tab-pipeline` 子容器
- 在 `mount()` 中**补全** `tools.json` 的加载（原由 Engine 执行）
- `onAppSwitch` 逻辑从 `main.ts` 移入 `EditorUILayer`

---

### Phase 4：创建双入口（main.ts / player.ts）（20 分钟）

#### 4.1 重构 main.ts（编辑器入口）

```typescript
import { AppHost } from './host/AppHost';
import { EditorUILayer } from './ui/layers/EditorUILayer';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const uiContainer = document.getElementById('ui-container')!;

async function main() {
  if (!navigator.gpu) {
    document.getElementById('error')!.textContent = 'WebGPU is not supported.';
    return;
  }

  try {
    const host = new AppHost(canvas, uiContainer);
    await host.init();

    const appName = new URLSearchParams(location.search).get('app') ?? host.engineConfig.defaultApp;
    await host.loadApp(appName);

    // 挂载编辑器层（含命令总线、输入管理器、面板）
    host.mountLayer(new EditorUILayer());

    // 加载 App 自定义 UI
    await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

    window.addEventListener('resize', () => host.resize());
    host.startLoop();

    (window as any).host = host;
    console.log('[ShaderLab] editor mode initialized');
  } catch (err) {
    console.error(err);
    document.getElementById('error')!.textContent = `Error: ${err}`;
  }
}

main();
```

#### 4.2 新建 player.ts（运行时入口）

```typescript
import { AppHost } from './host/AppHost';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const uiContainer = document.getElementById('ui-container')!;

async function main() {
  if (!navigator.gpu) {
    document.getElementById('error')!.textContent = 'WebGPU is not supported.';
    return;
  }

  try {
    const host = new AppHost(canvas, uiContainer);
    await host.init();

    const appName = new URLSearchParams(location.search).get('app') ?? host.engineConfig.defaultApp;
    await host.loadApp(appName);

    // ❌ 不挂载 EditorUILayer
    // ❌ 不加载 EditorInputManager

    // ✅ 仅加载 App 自定义 UI
    await host.loadAppUI(`${host.engineConfig.appsRoot}/${appName}`);

    window.addEventListener('resize', () => host.resize());
    host.startLoop();

    (window as any).host = host;
    console.log('[ShaderLab] player mode initialized');
  } catch (err) {
    console.error(err);
    document.getElementById('error')!.textContent = `Error: ${err}`;
  }
}

main();
```

---

### Phase 5：实现 App 自定义 UI 数据驱动加载（30 分钟）

在 `AppHost` 中实现：

```typescript
private appUILayers: Array<{ id: string; unmount: () => void }> = [];

async loadAppUI(appBase: string) {
  // 清理旧的 App UI
  for (const layer of this.appUILayers) layer.unmount();
  this.appUILayers = [];

  const manifestResp = await fetch(`${appBase}/app.json`);
  if (!manifestResp.ok) return;
  const manifest = await manifestResp.json();
  if (!manifest.ui) return;

  const configs = await fetch(`${appBase}/${manifest.ui}`).then(r => r.json());
  for (const cfg of configs) {
    const container = document.querySelector(cfg.container) ?? this.createContainer(cfg.id);
    const mod = await this.loadUIScript(`${appBase}/${cfg.source}`);
    const unmount = mod.mount(container, this);
    this.appUILayers.push({ id: cfg.id, unmount });
  }
}

private createContainer(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = `ui-${id}`;
  this.uiContainer.appendChild(el);
  return el;
}

private async loadUIScript(url: string): Promise<{ mount: Function; unmount?: Function }> {
  const resp = await fetch(`${url}?t=${Date.now()}`);
  if (!resp.ok) throw new Error(`UI script not found: ${url}`);
  const src = await resp.text();
  const blob = new Blob([src], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ blobUrl);
    return mod.default ?? mod;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
```

在 `apps/demo1/app.json` 中添加：
```json
{
  "name": "demo1",
  "ui": "ui-config.json"
}
```

创建 `apps/demo1/ui-config.json`：
```json
[
  {
    "id": "demo-hud",
    "source": "ui/demoHUD.js",
    "container": "#hud-container"
  }
]
```

创建 `apps/demo1/ui/demoHUD.js`：
```javascript
export function mount(container, host) {
  const btn = document.createElement('button');
  btn.textContent = 'Click Me';
  btn.onclick = () => {
    host.eventBus.emit('toast:show', 'Hello from App UI!');
  };
  container.appendChild(btn);
  return () => { btn.remove(); };
}
```

---

### Phase 6：清理遗留文件与验证（20 分钟）

1. **删除以下旧文件**（内容已迁移）：
   - `src/editor/EditorHost.ts`（已重命名为 EditorCommandBus）
   - `src/tools/`（已移动到 `src/editor/input/`）

2. **验证编译**：
   ```bash
   npx tsc --noEmit
   ```
   确保无 import 路径错误。

3. **验证构建**：
   ```bash
   npm run build
   ```
   确保 `dist/` 下同时存在 `index.html` 和 `player.html` 的入口。

---

## 四、验收检查清单

### 1. 编辑器模式（`npm run dev` → 访问 `index.html`）

- [ ] 场景树显示所有实体，点击实体高亮
- [ ] 属性面板修改字段，3D 场景实时更新
- [ ] 管线面板修改拓扑/混合模式，渲染效果变化
- [ ] 点击 3D 视口内的模型，场景树自动高亮（验证 `EditorInputManager` + `tools.json` 加载）
- [ ] `Ctrl+Z` / `Ctrl+Y` 撤销/重做正常工作
- [ ] 切换 App（如 `?app=demo2`）后编辑器面板正确刷新

### 2. 运行时模式（`npm run dev` → 访问 `player.html`）

- [ ] 页面仅显示 3D 画布和 App UI（无场景树/管线面板）
- [ ] 点击 3D 视口无拾取反应（无 `editor:select` 事件）
- [ ] 控制台无报错
- [ ] 插件系统正常加载（验证 `registerToolType` 在 player 模式下不崩溃）

### 3. App 自定义 UI

- [ ] `apps/demo1/ui/demoHUD.js` 成功加载，按钮显示
- [ ] 点击按钮，`toast:show` 事件被触发

### 4. 架构规则验证

- [ ] `src/core/` 下无任何文件 import `src/host/` 或 `src/ui/`
- [ ] `src/ui/` 下无文件直接调用 `scene.setField`（必须通过 `host.dispatch`）

---

## 五、回滚策略

如果上述验收项任意 **2 项失败**：

1. 立即停止修改，不要强行修复
2. 执行 `git reset --hard HEAD` 回退到重构前的 commit
3. 记录失败的验收项及错误日志，分析根因后重新执行

---

## 六、风险与注意事项

| 风险 | 缓解措施 |
|------|---------|
| `ToolSystem` 迁移后事件绑定失效 | `EditorInputManager` 封装的是 `loadTools` 和 `dispose`，不虚构 `attach/detach` API |
| `player.ts` 下插件调用 `registerToolType` 崩溃 | 将模块级 `TOOL_REGISTRY` 保留在 `src/core/tools/ToolRegistry.ts`，与 `ToolSystem` 类解耦 |
| `EditorPanel` / `PipelinePanel` 找不到挂载点 | `EditorUILayer.mount()` 负责构建 tab DOM 结构，面板挂载到子容器 |
| `tools.json` 加载时机丢失 | `EditorUILayer.mount()` 中主动 fetch `app.json` 并加载 `tools.json` |
| Vite 不打包 `player.html` | Phase 0 中已在 `vite.config.ts` 配置 `rollupOptions.input` |
| Vue 引入导致构建问题 | 本次仅安装插件，不迁移现有面板，不影响现有构建 |

---

**预估总时间**：约 3.5 小时（含验收）。

**执行开始**：从 Phase 0 依次向下执行，每个 Phase 完成后执行一次 `git commit -m "phase N: ..."`，方便回滚。
