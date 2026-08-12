# PLAN.md — ComputeGraph v2：管线脚本编排器

> **版本**：v2.0（替代 v7.0 的"独立 compute 执行引擎"定位）
> **核心使命**：**让 TA 用可视化连线，编排已有的 hook/pipeline 调用顺序，生成可热重载的 RenderScript**
> **设计哲学**：节点图是 source of truth，JS 脚本是产物 · 单向编译 · 受限 DSL · 零新执行机制


## 〇、定位修订（vs v1/v7）

### 0.1 改变的是什么

v7 计划试图新建一套独立的 compute 执行引擎（`GpuTaskExecutor` + LRU + Ring Buffer + archetypeVersion + SoA 零拷贝），但经审计发现：

1. **`Engine.dispatchCompute` 已存在**（`Engine.ts:589-621`）：批量录入帧级 compute pass，`flushCompute()` 统一提交，渲染器开头调用保证同帧可见。新建执行器=重复造轮子。
2. **`RenderScriptLoader` 已是 app 级逃生舱**（`RenderScriptLoader.ts`）：fetch → Blob → dynamic import → hook 注册，HMR 现成（`?t=` cache-bust + 跳 Map 缓存）。
3. **"SoA 零拷贝"是虚假承诺**：bitecs 的 SoA 在 CPU 侧 Float32Array，无 GPU Buffer 直接映射，每帧仍需 `device.queue.writeBuffer` 上传。
4. **`shaderGraph.ts` 已删**：v1 实现的 per-entity dispatch 模型与批次 compute pass 机制冲突，每个 shader 节点开独立 compute pass 性能差，已随 demo10 一并清理。

### 0.2 v2 的定位

**ComputeGraph 是 RenderScript 的可视化 authoring 工具**。它不是新的执行引擎，而是"hook 调用顺序 + 参数绑定"的可视化 source，产物落到现有 RenderScriptLoader 链上。

```
节点图（JSON）  ──编译──▶  common/scripts/render/<name>.js  ──RenderScriptLoader──▶  hook 注册  ──JSON 引用──▶  执行
     ▲                          ▲
     │ 手编 JS 不回写图            │ 产物挂到 render.json 的 script: 引用
     └── 图是唯一 source ──────────┘
```

### 0.3 核心承诺（修订后的用户价值）

| 用户诉求 | v2 提供的开箱即用 |
| :--- | :--- |
| 我要可视化编排粒子发射/积分/绘制 | 拖 `call_hook` 节点引用已注册 hook，连线决定调用顺序，**保存即生成 JS 并热重载**。 |
| 我要切换管线分支（如开/关调试绘制） | `if` 节点帧级求值，被跳过的分支不产生 hook 调用。 |
| 我要参数化 hook（如 emit rate） | `param` 节点引用 UBO 字段或字面量，编译为 JS 调用参数。 |
| 我要快速迭代 | 改节点图保存即 HMR（复用 `RenderScriptLoader.load` 的 `?t=` cache-bust）；改 JS 也可手编但**图标记 stale**。 |
| 我要在 player.html 跑 | 产物是普通 RenderScript，player 完整支持（无编辑器，但执行链完整）。 |

**承诺不再包含**：
- ❌ "零 CPU 拷贝" —— hook 内部自行经 `BufferRegistry` 上下传，节点图不感知。
- ❌ "10 万实体单次批次调度" —— 批次逻辑在 hook 内部，节点图只编排调用顺序。
- ❌ "SoA Buffer 视图" —— `component`/`foreach`/`system_buffer`/`ubo` 节点全部删除。
- ❌ "BindGroup LRU 缓存" —— 复用现有 `PipelineDriver` 的缓存，无新增。


## 一、设计哲学与红线

### 1.1 定位
**ComputeGraph 是 RenderScript 的可视化编排器，不是 compute 执行引擎。**

### 1.2 绝对红线（架构护栏）

| 禁止事项 | 原因/替代方案 |
| :--- | :--- |
| **新建 compute 执行机制** | 复用 `Engine.dispatchCompute` + `pendingComputePass`。节点图只生成 JS，不调度 GPU。 |
| **节点图直接绑定 GPU Buffer** | Buffer 生命周期在 hook 内部，节点图不感知 SoA/BindGroup。若需 buffer 操作，写 hook。 |
| **`if` 条件引用 per-entity 组件** | `if` 是帧级静态分支。per-entity 分支请在 hook 内部（WGSL `if (id < count)`）处理。 |
| **`loop` 迭代引用 per-entity 组件** | `loop` 主机侧展开 ≤64，参数仅限常量/UBO。大循环放 WGSL `for`。 |
| **`logic` 端口扇入（多入一出）** | 执行顺序歧义。需汇聚在 JS 内部做或显式 `merge` 节点（未来）。 |
| **裸环（非 `loop` 回边）** | 静态环导致 DFS 死循环，验证器用 Kahn 算法拦截。 |
| **手编 JS 反向解析回图** | JS 是命令式任意代码，AST↔图的反向解析无解。手编后图标记 stale。 |
| **节点图引用具体插件类型** | `call_hook` 用 `script:foo.bar` 字符串引用，引擎零插件知识。 |

### 1.3 与现有系统的边界

| 系统 | 职责 | 与 ComputeGraph 交互 |
| :--- | :--- | :--- |
| **RenderScriptLoader** | fetch → Blob → import → hook 注册 | **承载 ComputeGraph 的产物**。生成的 JS 经此加载，HMR 自动复用。 |
| **Engine.dispatchCompute** | 批量 compute pass 提交 | hook 内部调用，节点图不直接接触。 |
| **PipelineDriver** | 声明式 draw + BindGroup 缓存 | hook 内部消费，节点图不感知。 |
| **valueResolver** | 字符串 DSL → 编译闭包 | `param` 节点复用此机制，不重写。 |
| **game.js** | AI/事件/网络/状态机 | 通过 ECS 组件与 hook 通信（写组件 → 下一帧 hook 读到新值） |


## 二、三层架构

```
┌───────────────────────────────────────────────────────────────┐
│ L3: 数据层（ComputeGraph Schema）                            │
│     • 纯 JSON：节点、端口、连线、roots                        │
│     • 零执行逻辑，100% 可序列化                               │
└───────────────────────────────────────────────────────────────┘
                               │
                               ▼（编译 + 验证）
┌───────────────────────────────────────────────────────────────┐
│ L2: 编译层（GraphCompiler）                                  │
│     • DFS 拓扑排序                                            │
│     • 节点 → JS 语句翻译                                      │
│     • 产物：common/scripts/render/<name>.js                   │
│     • 增量编译（按 graph 内容 hash 缓存）                     │
└───────────────────────────────────────────────────────────────┘
                               │
                               ▼（保存触发）
┌───────────────────────────────────────────────────────────────┐
│ L1: 执行层（复用现有 RenderScriptLoader）                    │
│     • load(file) → Blob import → hook 注册                   │
│     • HMR：dev 下 ?t= cache-bust + 跳 Map 缓存               │
│     • JSON 用 script:foo.bar 引用                             │
└───────────────────────────────────────────────────────────────┘
```

**核心编译入口（伪代码）**：
```ts
function compileGraph(graph: ComputeGraph): string {
    const order = topoSort(graph.roots, graph.edges);  // Kahn 算法
    const body = order.map(node => emitStatement(node, graph)).join('\n');
    return wrapInModule(graph.name, body);  // 生成完整 JS 文件文本
}

function emitStatement(node: Node, graph: ComputeGraph): string {
    switch (node.type) {
        case 'call_hook': return emitCallHook(node);
        case 'if':        return emitIf(node, graph);
        case 'loop':      return emitLoop(node, graph);
        case 'entry':     return '';  // entry/exit 是结构节点，不产语句
        case 'exit':      return 'return;';
    }
}
```


## 三、数据模型（L3 — 核心定义）

### 3.1 图级结构
```ts
interface ComputeGraph {
    version: 2;
    name: string;            // 也是产物文件名 <name>.js
    roots: NodeId[];         // 有序执行入口
    nodes: Node[];
    edges: Edge[];
    description?: string;
}
```

**多根执行语义**：
- 按 `roots` 数组顺序逐个编译为 JS 语句。
- 所有节点产出的语句按拓扑序拼接为 `main(ctx)` 函数体。
- 无 "全局 vs foreach" 的二元区分（v7 的 foreach 已删）。

### 3.2 节点类型全集

#### A. 入口/出口节点：`entry` / `exit`
**语义**：标记图的逻辑起点和终点。
- **端口**：`entry` 1 个 `logic` 出口；`exit` 1 个 `logic` 入口。
- **编译**：不产语句，仅作拓扑根/叶。`exit` 产出 `return;`。
- **约束**：每图恰好 1 个 `entry`，至多 1 个 `exit`。

#### B. 核心节点：`call_hook`
**语义**：调用一个已注册 hook（`script:foo.bar` 或经 `attachments` 暴露的方法）。

| 属性 | 说明 |
| :--- | :--- |
| **配置** | `hook: string`（如 `script:particles.emit`）<br>`params: Record<string, ValueSource>`（命名参数，复用 valueResolver DSL） |
| **端口** | 1 个 `logic` 入口，1 个 `logic` 出口，N 个 `param` 入口（与 `params` keys 对应）。 |
| **编译产物** | `particlesEmit(ctx, { rate: 100, lifetime: 3.0 });`（hook 名转 camelCase，参数对象展开） |
| **运行时** | 由 RenderScriptLoader 注册的 hook 函数被调用，传入 `RenderScriptContext`。 |

**hook 解析规则**：
- `script:foo.bar` → 调用 `common/scripts/render/foo.js` 导出的 `bar` 函数。
- `attachment:physics.step` → 调用 `attachments.physics.step(...)` 方法（未来扩展，Phase 5+）。

#### C. 控制流节点（主机侧静态）

**`if`（帧级分支）**
- **配置**：`op: '>' | '<' | '>=' | '<=' | '==' | '!='`
- **端口**：2 个 `value` 入口（A, B）+ 1 个 `logic` 入口 + `true`/`false` 两个 `logic` 出口。
- **编译**：`if (A op B) { <true 分支语句> } else { <false 分支语句> }`
- **红线**：**A/B 禁止连接 per-entity 组件字段**（Validator 报错）。仅限 `literal`/`param`(引用 UBO)。

**`loop`**
- **端口**：`iterations`（`value` 入口），`loop_in`（`logic` 入口），`cycle_end`（`logic` 回边），`cycle_start`/`loop_out`（`logic` 出口）。
- **编译**：`for (let i = 0; i < N; i++) { <body 语句> }`
- **约束**：`iterations` 仅限常量/UBO 字段，上限 64，超限截断 + 报错。

#### D. 参数节点：`param`
**语义**：字面量或字段引用，作为 `call_hook` 的参数源。

| 属性 | 说明 |
| :--- | :--- |
| **配置** | `source: string`（valueResolver DSL：`42` / `[1,0,0]` / `frame.dt` / `builtin.time`） |
| **端口** | 1 个 `value` 出口。 |
| **编译** | 字面量直接内联；字段引用编译为 `ctx.frame.dt` / `ctx.time` 等窄门面读取。 |

**复用 valueResolver**：`param.source` 走 `valueResolver.compileValue`，不重写 DSL。

### 3.3 端口与连线

| 端口类型 | 传递内容 | 连接规则 |
| :--- | :--- | :--- |
| `logic` | 执行依赖 | **强制 1:1**（Validator 拦截多入），允许扇出（1→N） |
| `value` | CPU 可求值标量/向量 | 严格类型匹配，允许 `f32` → `vecN` 隐式广播 |

**连线格式**：
```ts
interface Edge {
    from: NodeId;
    to: NodeId;
    type: 'logic' | 'value';
    fromPin?: string;  // logic 可省略；value 必填（如 'true'/'false'/'out'）
    toPin: string;     // 'in' / 'A' / 'B' / 'rate' / 'iterations' / ...
}
```


## 四、编译器（L2 — GraphCompiler）

### 4.1 拓扑排序
- **Kahn 算法**：按 `logic` 边入度排序，同入度按 `roots` 声明顺序。
- **环检测**：若排序后剩余节点 ≠ 总节点数，报错 `"Cyclic dependency detected."`。
- **结构验证**：`entry` 必为根，`exit` 必为叶。

### 4.2 语句翻译
| 节点 | 翻译为 JS |
| :--- | :--- |
| `entry` | （空，作根） |
| `exit` | `return;` |
| `call_hook` | `<hookFn>(ctx, { <param>: <value>, ... });` |
| `if` | `if (<A> <op> <B>) { <body> } else { <body> }` |
| `loop` | `for (let i=0; i<<N>; i++) { <body> }` |
| `param` | （值内联到消费方） |

### 4.3 产物模板
```js
// AUTO-GENERATED from <name>.graph.json — DO NOT EDIT (edits will be lost on recompile)
// Source: public/apps/<app>/graphs/<name>.graph.json
import { registerHook } from '@shaderlab/api';
import * as particles from './particles.js';
import * as physics from './physics.js';

export function main(ctx) {
    const { scene, eid, device, encoder, time, dt, frame } = ctx;
    particles.emit(ctx, { rate: 100, lifetime: 3.0 });
    physics.step(ctx, { dt, substeps: 2 });
    if (frame.enableRender) {
        particles.draw(ctx);
    }
}
```

**生成规则**：
- 头部 `import` 按图中引用的 `script:foo.bar` 去重生成 `import * as foo from './foo.js'`。
- 函数体按拓扑序拼接每个节点产出的语句。
- `if`/`loop` 的 body 用缩进 + 花括号嵌套。
- 文件头标 `AUTO-GENERATED` + source 路径，提醒勿手编。

### 4.4 增量编译与 HMR
- **内容 hash**：按 `JSON.stringify(graph)` 计算 SHA-256，缓存产物文本。
- **保存触发**：编辑器 `debounce(300ms)` 调 `compileAndWrite(graph)`，hash 变才写盘。
- **HMR**：写盘后 `RenderScriptLoader.load` 在 dev 下 `?t=` cache-bust 自动重新 import（已有机制，无需新增）。


## 五、验证器（Validator）

### 5.1 硬规则拦截

| # | 规则 | 报错信息 |
| :--- | :--- | :--- |
| 1 | `logic` 端口扇入（多入） | `"Logic fan-in detected at node '${id}'. Use 1:1 connections only."` |
| 2 | 裸环（非 `loop` 回边） | `"Cyclic dependency detected (not via loop node)."` |
| 3 | 图中无 `entry` 节点 | `"ComputeGraph must have exactly one entry node."` |
| 4 | `entry` 数量 > 1 | `"ComputeGraph must have exactly one entry node (found ${n})."` |
| 5 | `if` 的 A/B 入口连接了 per-entity 组件 | `"If condition cannot reference per-entity component data (use UBO/frame field only)."` |
| 6 | `loop.iterations` 连接了 per-entity 组件 | `"Loop iterations must be compile-time constant or UBO field."` |
| 7 | `call_hook` 的 `hook` 字段不是 `script:` 前缀 | `"Hook reference must be 'script:<file>.<export>' (got '${ref}')."` |
| 8 | `call_hook` 引用的 hook 未在 RenderScriptLoader 注册 | `"Hook '${ref}' not registered. Check render.json renderScripts includes the file."` |

### 5.2 类型检查（`value` 端口）
```ts
function isTypeCompatible(src: DataType, dst: DataType): boolean {
    if (src.base !== dst.base) return false;
    if (src.shape === dst.shape) return true;
    if (src.shape === 'scalar' && dst.shape.startsWith('vec')) return true; // 广播
    return false;
}
```


## 六、UI 与资产架构

### 6.1 UI 三层
1. **Store**（`graphStore.ts`）：`reactive({ nodes, edges, roots })`，用 `immer` 更新。
2. **Command**（复用 `EditorCommandBus`）：`AddNodeCommand`、`ConnectEdgeCommand` 等，历史栈 30 步。
3. **View**（Vue + vue-flow 面板）：仅渲染 + 派发事件。`watch(store.graph, debounce(validate, 300))`。

### 6.2 节点面板（编辑器）
- **左侧调色板**：`entry`/`exit`/`call_hook`/`if`/`loop`/`param`。
- **画布**：vue-flow，节点可拖拽、连线、自动布局。
- **右侧检查器**：选中节点显示配置表单（hook 名、参数、op、iterations 等）。
- **顶部工具栏**：保存（触发编译）、生成预览（显示产物 JS）、切换图（多图）。

### 6.3 动态端口生成
- **`call_hook` 节点**：用户输入 `hook` 字符串后，扫描 `RenderScriptLoader` 已注册的 hook 签名（未来需 hook 元数据声明），自动生成 `param` 入口。**Phase 1 简化**：参数手动添加（命名 + value 源）。
- **`if` 节点**：固定 A/B 入口 + true/false 出口。
- **`loop` 节点**：固定 iterations 入口 + body/out 出口。

### 6.4 资产路径
- **图源**：`public/apps/<appName>/graphs/<name>.graph.json`
- **产物**：`public/common/scripts/render/<name>.js`（统一挂到 common，跨 app 共享）
- **引用**：`render.json` 的 `renderScripts` 数组加 `render/<name>.js`，phase entry 用 `script:<name>.main`
- **HMR**：编辑器保存即写盘 → `RenderScriptLoader.load` 在 dev 下自动 reload

### 6.5 产物预览与 stale 标记
- 编辑器右下角显示产物 JS 预览（只读）。
- 若用户手编了产物 JS（disk mtime > graph mtime），编辑器在工具栏显示 `⚠ JS out of sync with graph` 警示，但**不阻止**手编生效（手编优先直到下次保存图）。


## 七、实施路线图（分阶段）

### Phase 0 — Schema + Validator + AssetResolver（1 周）
- [ ] 定义 `ComputeGraph` v2 Schema（`src/core/graph/schema/`）
- [ ] 实现 `GraphValidator`（环检测 + 8 条硬规则）
- [ ] 手写 demo（粒子管线可视化版）`graph.json`（覆盖 `entry`/`call_hook` ×3/`if`/`param`）
- [ ] Validator 单元测试（`tests/unit/graphValidator.test.ts`）

### Phase 1 — 编译器 + HMR（1.5 周）
- [ ] 实现 `GraphCompiler`（拓扑排序 + 语句翻译 + 产物模板）
- [ ] 实现增量 hash 缓存
- [ ] 接入 `RenderScriptLoader.loadFromText`（编辑器路径）
- [ ] 端到端跑通：图 → 编译 → JS → RenderScriptLoader → hook 注册 → player.html 执行
- [ ] 编译器机制测试（`tests/mechanism/graphCompiler.test.ts`）

### Phase 2 — 编辑器集成（2 周）
- [ ] `graphStore` + Command 基础架构（Undo/Redo 30 步）
- [ ] vue-flow 画布 + 节点调色板 + 检查器面板
- [ ] 实时类型检查 + 错误高亮
- [ ] 产物预览面板
- [ ] 控制流节点可视化（`if` 双分支、`loop` body 框）

### Phase 3 — 真实 demo + 文档（1 周）
- [ ] 把 `public/plugins/particles` 的 emit/integrate/draw pipeline 用节点图重画一遍
- [ ] 验证产物 JS 与手写脚本行为等价（同一画面、同一帧率）
- [ ] `docs/compute-graph.md`（架构与快速上手）
- [ ] `docs/json-schemas.md` 更新（图 schema）
- [ ] demo 完整示例（含 `if`/`loop`）

### Phase 4+ — 未来扩展（不排期）
- [ ] `attachment:foo.bar` 节点（引用插件 attachment 方法）
- [ ] hook 签名元数据（让 `call_hook` 自动生成 param 端口）
- [ ] 子图（`instance` 节点，inline 展开）
- [ ] 多图组合（一个 app 多个 graph）


## 八、验证标准（Definition of Done）

| 阶段 | 冻结标准 |
| :--- | :--- |
| Phase 0 | Schema 定稿，demo graph 通过 Validator 全部检查；`npm run verify` 通过。 |
| Phase 1 | 图→JS→执行链跑通（粒子 emit+draw），产物 JS 与手写脚本在 player.html 画面等价；`npm run verify` 通过。 |
| Phase 2 | 编辑器支持拖拽连线、Undo/Redo、产物预览、实时错误提示。 |
| 交付 | `npm run verify` 全部通过；TA 照着文档 30 分钟内搭出第一个管线图；demo 在 player.html 可判读（与手写脚本基线对比）。 |


## 九、风险与应对

| 风险 | 应对 |
| :--- | :--- |
| **用户手编 JS 后图过时** | 编辑器工具栏显示 stale 警示；保存图时覆盖手编（fail-loud：弹确认对话框）。 |
| **hook 签名不可反射** | Phase 1 简化：`call_hook` 的 param 手动添加（命名 + value 源）。Phase 4+ 引入 hook 元数据声明。 |
| **产物 JS 跨 app 共享冲突** | 产物挂 `common/scripts/render/`，命名 `<appName>_<graphName>.js` 避免冲突；或允许 app 私有 `scripts/render/` 目录。 |
| **`if`/`loop` 编译产物缩进错乱** | 编译器用字符串数组 + 统一缩进策略，不嵌套字符串拼接；机制测试覆盖嵌套场景。 |
| **用户试图在 `if` 里用 per-entity 数据** | Validator 红线 5 拦截 + 文档解释"帧级静态分支"语义。 |
| **loop 展开 64 次产物 JS 过大** | 控制台警告 + 文档建议大循环放 WGSL `for`。 |
| **产物 import 路径在打包后失效** | 产物用相对路径 `./foo.js`，Vite build 时 RenderScript 走 Blob import 不经 Rollup，路径在 fetch 时解析。 |


## 十、与 v7 的差异速查

| 维度 | v7 计划 | v2 |
| :--- | :--- | :--- |
| 定位 | 独立 compute 执行引擎 | RenderScript 可视化编排器 |
| 执行机制 | 新建 GpuTaskExecutor + LRU + Ring Buffer + archetypeVersion | **零新机制**，复用 dispatchCompute + RenderScriptLoader |
| `component` 节点 | SoA 零拷贝（虚假承诺） | **删除**，buffer 在 hook 内部 |
| `foreach` 节点 | 批次调度 | **删除**，批次在 hook 内部 |
| `system_buffer`/`ubo` 节点 | 直接引用 | **删除**，经 hook 间接访问 |
| `if`/`loop` | 主机侧静态 | **保留**，编译为 JS 控制流 |
| `instance` 子图 | inline 展开 | Phase 4+ 扩展 |
| 产物 | 图本身是可执行单元 | **图→JS 单向编译**，JS 是产物 |
| HMR | 假设 ProjectFS.watch（不存在） | **复用 RenderScriptLoader 的 `?t=` cache-bust**（已存在） |
| 工期 | 8 周 | **5-6 周**（少 2 个机制改动） |
| demo | demo10 纯计数器（不可判读） | **粒子管线可视化版**（与手写脚本对比） |
