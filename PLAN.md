# EditorHost 开发计划

> **目标**：在不拆分引擎核心、不引入复杂 MVVM 的前提下，为编辑器建立统一的**修改入口层**和**撤销管理层**，解决当前 EditorPanel / PipelinePanel 直接耦合 Engine、Undo 逻辑分散、Play/Edit 模式缺失的问题。
> 
> **范围**：Phase 1（最小可行方案），预计新增/修改约 5 个文件，工作量 1-2 小时。

---

## 1. 现状问题

从 `engine.md` 代码分析，当前编辑器存在以下结构性问题：

### 1.1 直接耦合 Engine
- `EditorPanel` 和 `PipelinePanel` 均直接持有 `engine!: Engine` 引用
- 所有场景修改直接调用 `engine.scene.setField()` / `engine.scene.createEntity()` / `engine.scene.removeEntity()`
- Pipeline 修改直接调用 `engine.renderGraph.fromData()` / `rebuildPipeline()`
- `main.ts` 中 `editor.onAppSwitch = switchToApp` 是 Panel → Engine 的直接回调

### 1.2 Undo 逻辑分散且不完整
- `PipelinePanel` 独立维护 `history: string[]` / `future: string[]`，只覆盖渲染图修改
- `EditorPanel` 的场景编辑（Entity 增删改、字段修改）**完全没有 Undo**
- 两个 Panel 的 Undo 栈互不连通：用户先改场景再改管线，`Ctrl+Z` 只能撤销当前聚焦 Panel 的操作

### 1.3 缺少 Play/Edit 模式隔离
- 引擎没有 `play` / `edit` / `pause` 概念
- 若未来脚本系统每帧生成 Entity，EditorPanel 的 100ms 轮询会与运行时修改产生竞态
- 没有机制阻止 Play 模式下通过 Inspector 误删被脚本引用的 Entity

### 1.4 状态同步粗糙
- `EditorPanel` 用 `setInterval(() => {...}, 100)` 轮询 `entityKeyMap.size` 判断是否重建列表
- 无响应式机制，Inspector 字段值不会自动跟随脚本修改刷新

---

## 2. 架构设计（Phase 1：最小可行方案）

Phase 1 只引入两层：**EditorHost**（修改入口 + 模式控制）和 **Command**（Undo 原子操作）。不引入 ViewModel、不改动 Engine 内部结构、不替换 DOM 操作。

```
┌─────────────────────────────────────────────┐
│  View Layer (EditorPanel / PipelinePanel)   │
│  • 保留现有 DOM 操作                         │
│  • 不再直接持有 Engine                       │
│  • 所有修改通过 host.xxx()                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│           EditorHost（新增）                 │
│  • 统一修改入口：setField / createEntity     │
│  • 模式控制：edit / play / pause              │
│  • 全局 Undo/Redo 栈                         │
│  • 委托给 Engine 执行实际修改                 │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│              Engine（不变）                  │
│  • scene / renderGraph / loadApp 等          │
│  • 对 EditorHost 无感知                      │
└─────────────────────────────────────────────┘
```

### 设计原则
1. **Engine 零侵入**：不修改 Engine 类内部逻辑，只调整 `main.ts` 的初始化顺序
2. **Panel 渐进迁移**：先迁移写操作（改字段、增删 Entity、改管线），读操作（`getField`、`getAllEntities`）暂时保留直接访问或逐步迁移
3. **Undo 统一**：所有修改操作进入同一个栈，跨 Panel 可连续撤销
4. **Play 保护**：Play 模式下拒绝写操作，返回 `false` 并 warn

---

## 3. 接口规范

### 3.1 Command 接口

新建文件：`src/editor/commands/Command.ts`

```ts
export interface Command {
  readonly type: string;
  readonly description: string;
  execute(ctx: CommandContext): boolean;
  undo(ctx: CommandContext): boolean;
}

export interface CommandContext {
  engine: Engine;
}
```

### 3.2 具体 Command 实现

新建文件：`src/editor/commands/SceneCommands.ts`

```ts
// SetFieldCommand
export class SetFieldCommand implements Command {
  readonly type = 'setField';
  private oldValue: unknown;
  constructor(
    private entityKey: string,
    private compName: string,
    private field: string,
    private newValue: unknown,
  ) {}
  execute(ctx: CommandContext): boolean {
    const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
    if (eid == null) return false;
    this.oldValue = ctx.engine.scene.getField(eid, this.compName, this.field);
    ctx.engine.scene.setField(eid, this.compName, this.field, this.newValue);
    return true;
  }
  undo(ctx: CommandContext): boolean {
    const eid = ctx.engine.scene.entityKeyMap.get(this.entityKey);
    if (eid == null) return false;
    ctx.engine.scene.setField(eid, this.compName, this.field, this.oldValue);
    return true;
  }
}

// CreateEntityCommand
export class CreateEntityCommand implements Command {
  readonly type = 'createEntity';
  private createdKey: string;
  constructor(
    private key: string,
    private data: Record<string, Record<string, unknown>>,
  ) { this.createdKey = key; }
  execute(ctx: CommandContext): boolean {
    ctx.engine.scene.createEntity(this.createdKey, this.data);
    return true;
  }
  undo(ctx: CommandContext): boolean {
    ctx.engine.scene.removeEntity(this.createdKey);
    return true;
  }
}

// RemoveEntityCommand
export class RemoveEntityCommand implements Command {
  readonly type = 'removeEntity';
  private backupData: Record<string, Record<string, unknown>> | null = null;
  constructor(private key: string) {}
  execute(ctx: CommandContext): boolean {
    const eid = ctx.engine.scene.entityKeyMap.get(this.key);
    if (eid == null) return false;
    // 备份完整 Entity 数据用于恢复
    this.backupData = this.serializeEntity(ctx, eid);
    ctx.engine.scene.removeEntity(this.key);
    return true;
  }
  undo(ctx: CommandContext): boolean {
    if (!this.backupData) return false;
    ctx.engine.scene.createEntity(this.key, this.backupData);
    return true;
  }
  private serializeEntity(ctx: CommandContext, eid: number): Record<string, Record<string, unknown>> {
    // 从 engine.scene 读取该 entity 的所有 component 数据
    // 参考 engine.scene.toJSON() 的单 entity 逻辑
  }
}
```

新建文件：`src/editor/commands/RenderGraphCommands.ts`

```ts
// MutateRenderGraphCommand
export class MutateRenderGraphCommand implements Command {
  readonly type = 'mutateRenderGraph';
  private prevData: string;
  constructor(private nextData: object) {}
  execute(ctx: CommandContext): boolean {
    this.prevData = JSON.stringify(ctx.engine.renderGraph.toData());
    ctx.engine.renderGraph.fromData(this.nextData as import('../render/types').RenderGraphData);
    return true;
  }
  undo(ctx: CommandContext): boolean {
    ctx.engine.renderGraph.fromData(JSON.parse(this.prevData));
    return true;
  }
}
```

### 3.3 EditorHost 类

新建文件：`src/editor/EditorHost.ts`

```ts
export type EditMode = 'edit' | 'play' | 'pause';

export class EditorHost {
  private mode: EditMode = 'edit';
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory = 50;
  private editSnapshot: object | null = null;

  constructor(private engine: Engine) {}

  get editMode() { return this.mode; }

  // ── 模式控制 ──
  play(): void {
    if (this.mode === 'play') return;
    this.editSnapshot = { scene: this.engine.exportScene(), renderGraph: this.engine.exportRenderGraph() };
    this.mode = 'play';
    this.engine.eventBus.emit('editor:play');
  }
  pause(): void {
    if (this.mode !== 'play') return;
    this.mode = 'pause';
    this.engine.eventBus.emit('editor:pause');
  }
  stop(): void {
    if (this.mode === 'edit') return;
    this.mode = 'edit';
    if (this.editSnapshot) {
      // 恢复场景数据（可选：是否恢复 renderGraph 取决于需求）
      const s = this.editSnapshot as any;
      this.engine.loadSceneData(s.scene.entities as import('../ecs/Scene').SceneData);
      this.engine.renderGraph.fromData(s.renderGraph as import('../render/types').RenderGraphData);
    }
    this.engine.eventBus.emit('editor:stop');
  }

  // ── 统一修改入口 ──
  dispatch(cmd: Command): boolean {
    if (this.mode !== 'edit') {
      console.warn(`[EditorHost] Blocked ${cmd.type} while in ${this.mode} mode`);
      return false;
    }
    const ctx: CommandContext = { engine: this.engine };
    if (!cmd.execute(ctx)) return false;

    // 合并连续同类型命令（如连续拖拽）
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && last.type === cmd.type && (last as any).canMerge?.(cmd)) {
      this.undoStack[this.undoStack.length - 1] = (last as any).merge(cmd);
    } else {
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    }
    this.redoStack = [];
    this.engine.eventBus.emit('editor:changed', { source: cmd.type });
    return true;
  }

  undo(): void {
    if (this.undoStack.length === 0) return;
    const cmd = this.undoStack.pop()!;
    cmd.undo({ engine: this.engine });
    this.redoStack.push(cmd);
    this.engine.eventBus.emit('editor:changed', { source: 'undo' });
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    const cmd = this.redoStack.pop()!;
    cmd.execute({ engine: this.engine });
    this.undoStack.push(cmd);
    this.engine.eventBus.emit('editor:changed', { source: 'redo' });
  }

  // ── 便捷方法（Panel 可直接调用） ──
  setField(entityKey: string, comp: string, field: string, value: unknown): boolean {
    return this.dispatch(new SetFieldCommand(entityKey, comp, field, value));
  }
  createEntity(key: string, data: Record<string, Record<string, unknown>>): boolean {
    return this.dispatch(new CreateEntityCommand(key, data));
  }
  removeEntity(key: string): boolean {
    return this.dispatch(new RemoveEntityCommand(key));
  }
  mutateRenderGraph(data: object): boolean {
    return this.dispatch(new MutateRenderGraphCommand(data));
  }

  // ── 读代理（可选，逐步迁移） ──
  get scene() { return this.engine.scene; }
  get renderGraph() { return this.engine.renderGraph; }
}
```

---

## 4. 实施步骤

### Step 1：创建 Command 基础设施（新增 3 个文件）

1. `src/editor/commands/Command.ts` — 定义 `Command` / `CommandContext` 接口
2. `src/editor/commands/SceneCommands.ts` — `SetFieldCommand`、`CreateEntityCommand`、`RemoveEntityCommand`
3. `src/editor/commands/RenderGraphCommands.ts` — `MutateRenderGraphCommand`

**注意**：`RemoveEntityCommand` 的 `serializeEntity` 需要读取 entity 的所有 component 数据。参考 `Engine.ts` 中 `exportScene()` 和 `Scene.ts` 中 `toJSON()` 的逻辑，但只序列化单个 entity。

### Step 2：创建 EditorHost（新增 1 个文件）

4. `src/editor/EditorHost.ts` — 实现 `EditorHost` 类

### Step 3：迁移 EditorPanel（修改 1 个文件）

5. `src/editor/EditorPanel.ts`：
   - 将 `private engine!: Engine` 改为 `private host!: EditorHost`
   - `attach(engine)` 改为 `attach(host: EditorHost)`
   - 所有 `this.engine.scene.setField(...)` 改为 `this.host.setField(...)`
   - 所有 `this.engine.scene.createEntity(...)` 改为 `this.host.createEntity(...)`
   - 所有 `this.engine.scene.removeEntity(...)` 改为 `this.host.removeEntity(...)`
   - `saveJSON()` 中 `this.engine.exportScene()` 改为 `this.host.scene.toJSON()`（或保留 `this.host.engine.exportScene()`）
   - `loadJSON()` 中 `this.engine.loadSceneData(...)` 和 `this.engine.loadApp(...)` 暂时保留直接访问（App 切换不属于 Editor 细粒度 Undo 范围）
   - 删除 `syncTimer` 中的 `entityKeyMap.size` 轮询重建逻辑，改为监听 `editor:changed` 事件：
     ```ts
     attach(host: EditorHost): void {
       this.host = host;
       this.host.engine.eventBus.on('editor:changed', () => {
         const count = this.host.scene.entityKeyMap.size;
         if (count !== this.lastEntityCount) {
           this.lastEntityCount = count;
           this.render();
           return;
         }
         for (const sync of this.syncers) sync();
       });
     }
     ```

### Step 4：迁移 PipelinePanel（修改 1 个文件）

6. `src/editor/PipelinePanel.ts`：
   - 将 `private engine!: Engine` 改为 `private host!: EditorHost`
   - `attach(engine)` 改为 `attach(host: EditorHost)`
   - 替换原有的 `history/future` 私有栈，改用 `EditorHost` 的 `undoStack`：
     - `snapshot()` 改为 `this.host.mutateRenderGraph(this.host.renderGraph.toData())`
     - `undo()` 改为 `this.host.undo()`
     - `redo()` 改为 `this.host.redo()`
   - 注意：`snapshot` 是每次参数修改前调用，而 `MutateRenderGraphCommand` 需要捕获修改后的完整数据。因此 `snapshot()` 方法应改为：
     ```ts
     private snapshot(): void {
       // 记录当前状态，供下一次 mutation 的 undo 使用
       this.pendingSnapshot = JSON.stringify(this.host.renderGraph.toData());
     }
     // 在参数 onChange 中：
     // 1. 用 pendingSnapshot 创建 Command（undo 目标）
     // 2. 应用修改
     // 3. 用新数据创建 Command 并 dispatch
     ```
     更简单的方式：在 `onChange` 回调中直接构造 `MutateRenderGraphCommand`：
     ```ts
     onChange: () => {
       const next = this.host.renderGraph.toData();
       this.host.mutateRenderGraph(next);
     }
     ```
     但这里有个问题：`MutateRenderGraphCommand` 的构造函数接收的是**修改后的数据**，execute 时直接 `fromData(next)`，undo 时恢复 `prevData`。所以 `snapshot()` 不需要了——每次用户触发修改时，直接 `host.mutateRenderGraph(engine.renderGraph.toData())` 是不对的，因为此时数据已经被改了。

     **正确做法**：保留 `snapshot()` 但改为记录 `prevData`，然后在修改后 dispatch：
     ```ts
     private beforeMutation(): string {
       return JSON.stringify(this.host.renderGraph.toData());
     }
     // 在 onChange 中：
     const prev = this.beforeMutation();
     config.primitive.topology = v as GPUPrimitiveTopology;
     this.host.dispatch(new MutateRenderGraphCommand(this.host.renderGraph.toData(), prev));
     ```
     因此 `MutateRenderGraphCommand` 需要支持传入 `prevData`：
     ```ts
     constructor(private nextData: object, prevData?: string) {
       this.prevData = prevData ?? JSON.stringify(nextData); // 如果未传入，则 next === prev（无变化）
     }
     ```
     或者保持简单：在 `PipelinePanel` 中仍然自己维护 `history/future`，但把 `history` 的 push/pop 委托给 `EditorHost` 的 `dispatch`。Phase 1 允许 PipelinePanel 保留自己的 snapshot 逻辑，只是将 `engine` 引用改为 `host.engine`。

### Step 5：修改 main.ts（修改 1 个文件）

7. `src/main.ts`：
   - 导入 `EditorHost`
   - 在 `engine.init()` 之后创建 `const host = new EditorHost(engine);`
   - `editor.attach(engine)` 改为 `editor.attach(host)`
   - `pipelinePanel.attach(engine)` 改为 `pipelinePanel.attach(host)`
   - `editor.onAppSwitch = switchToApp` 保留（App 切换是 Host 级别操作，未来可移入 Host，Phase 1 不动）

### Step 6：Engine 帧循环添加模式感知（可选，修改 1 个文件）

8. `src/Engine.ts`：
   - 在 `Engine` 类中添加 `editorHost?: EditorHost`（可选引用）
   - 在 `frame()` 方法中，Play 模式下可以跳过 `script` / `physics` 系统（如果 Editor 要求）：
     ```ts
     // 在 Engine.frame 中：
     const skipSystems = this.editorHost?.editMode === 'edit' 
       ? new Set(['script', 'physics']) 
       : new Set();
     for (const sys of this.activeSystems) {
       if (skipSystems.has(sys.name)) continue;
       // ...
     }
     ```
     这一步是可选的，Phase 1 可以只做 Host 的 Play/Stop 状态切换，不修改 Engine 帧逻辑。

---

## 5. 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 新增 | `src/editor/commands/Command.ts` | 接口定义 |
| 新增 | `src/editor/commands/SceneCommands.ts` | 场景相关 Command |
| 新增 | `src/editor/commands/RenderGraphCommands.ts` | 渲染图相关 Command |
| 新增 | `src/editor/EditorHost.ts` | 核心类 |
| 修改 | `src/editor/EditorPanel.ts` | 迁移写操作到 Host |
| 修改 | `src/editor/PipelinePanel.ts` | 迁移 engine 引用到 host |
| 修改 | `src/main.ts` | 初始化 Host 并注入 Panel |
| 可选修改 | `src/Engine.ts` | 添加 `editorHost` 引用和帧循环模式感知 |

---

## 6. 验收标准

完成以下测试即视为 Phase 1 成功：

1. **编译通过**：`tsc --noEmit` 无错误
2. **场景编辑 Undo**：
   - 打开 EditorPanel，选中 Cube，修改 Transform.position.x
   - 按 `Ctrl+Z`，字段值恢复，场景中 Cube 位置恢复
   - 按 `Ctrl+Shift+Z`，Redo 生效
3. **Entity 增删 Undo**：
   - 点击 `+` 创建 Entity，Undo 后 Entity 消失
   - 选中 Entity 点击 `✕` 删除，Undo 后 Entity 恢复且数据完整
4. **跨 Panel Undo**：
   - 修改场景字段 → 切换 PipelinePanel → 修改管线参数 → 连续按 `Ctrl+Z`
   - 期望：先撤销管线修改，再撤销场景修改（统一栈）
5. **Play 模式保护**：
   - 调用 `host.play()` 后，在 EditorPanel 修改字段
   - 期望：控制台出现 warn，字段未被修改，`dispatch` 返回 `false`
6. **PipelinePanel 兼容**：
   - 修改 topology / cullMode / blend 等参数，Undo/Redo 正常工作
   - recompile 触发正常

---

## 7. 风险与回退方案

| 风险 | 缓解措施 |
|------|----------|
| `RemoveEntityCommand` 备份数据不完整 | 参考 `Scene.toJSON()` 的单 entity 逻辑，若组件读取失败则 warn 并跳过 |
| PipelinePanel 的 snapshot 与 Host Undo 冲突 | Phase 1 允许 PipelinePanel 保留自己的 history，但快捷键统一走 `host.undo()`。若冲突，优先保证 PipelinePanel 原有功能 |
| `editor:changed` 事件触发过于频繁 | `SetFieldCommand` 每次都会触发事件。若性能有问题，后续可改为批量触发或节流 |
| Play/Stop 恢复数据时丢失运行时生成的 Entity | 这是预期行为。`editSnapshot` 只保存编辑态，Stop 时恢复。若需保留运行时数据，Phase 2 引入分支快照 |

---

## 8. 后续扩展方向（Phase 2+）

| 阶段 | 内容 | 收益 |
|------|------|------|
| Phase 2 | 引入 `MacroCommand`（批量命令封装） | 支持"组合操作"一键撤销 |
| Phase 2 | `EditorPanel` / `PipelinePanel` 完全移除 `engine` 直接引用 | 所有读操作通过 Host 代理，Engine 可被 Mock 用于测试 |
| Phase 3 | ViewModel 层（`SceneVM`、`RenderGraphVM`） | 替换 100ms 轮询为响应式更新 |
| Phase 3 | Editor 插件化 | 将 Editor 代码移入 `public/plugins/editor/`，通过 `EnginePlugin` 加载 |
| Phase 4 | 多人协作 | Command 序列化后可通过 WebSocket 广播，实现操作同步 |

---

## 9. 关键代码片段参考

### RemoveEntityCommand 的 serializeEntity 实现

```ts
private serializeEntity(ctx: CommandContext, eid: number): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  // 获取该 entity 的所有 component（参考 Scene.entityComponents）
  const comps = ctx.engine.scene['entityComponents'].get(eid) ?? [];
  for (const compName of comps) {
    const comp = schemaRegistry.get(compName);
    if (comp && ctx.engine.scene.hasComponent(eid, compName)) {
      result[compName] = schemaRegistry.readAllFields(compName, comp, eid);
    }
  }
  return result;
}
```

> 注意：`entityComponents` 是 `Scene` 的 private 字段。Phase 1 可以通过 `scene['entityComponents']` 访问，或给 `Scene` 添加 `getEntityComponents(eid): string[]` 公共方法（推荐后者，修改 Scene.ts 添加一个 getter）。

### EditorPanel 的 eventBus 监听替代 setInterval

```ts
attach(host: EditorHost): void {
  this.host = host;
  // 替代原有的 setInterval
  host.engine.eventBus.on('editor:changed', () => {
    const count = host.scene.entityKeyMap.size;
    if (count !== this.lastEntityCount) {
      this.lastEntityCount = count;
      this.render();
      return;
    }
    for (const sync of this.syncers) sync();
  });
}
```

---

*本计划基于 engine.md 的当前代码结构制定，所有文件路径、类名、方法名均与现有代码一致，可直接执行。*
