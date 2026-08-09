# PLAN.md — ShaderGraph 重构（终版工程蓝图）

> **版本**：v6.0（终版）
> **状态**：已冻结，可进入实施
> **核心理念**：实体级 GPU Compute 可视化编排 · 纯数据流 · 主机侧静态分支

---

## 〇、MVP 范围声明（本次迭代限定）

以下内容 **必须实现**，缺一不可，列入 Phase 0–3：

- 完整数据模型（L3 Schema + Validator）
- DFS 递归执行器（`logic` 强制 1:1，禁止扇入）
- Pipeline / BindGroup 缓存（LRU）
- `component.value` → SoA StorageBuffer 环形缓冲上传
- `foreach` 实体上下文快照 + Archetype 版本缓存
- `virtual://` 资产路径解析
- Store + Command 分离的编辑器基础架构

以下内容 **明确延后至 Phase 5+**，本次不开发：

| 延后项 | 理由 |
|--------|------|
| `buffer_copy` / `buffer_clear` 节点 | 本质是硬编码操作，应放在 System 层而非图内 |
| Worker 异步类型检查 | 图规模通常 < 50 节点，同步校验 < 2ms，无性能瓶颈 |
| 节点断点 / 单步调试 | 依赖 RenderDoc 或 `console.log` 即可满足 TA 需求 |
| 子图 Standalone 模式 | `instance` 仅支持 Inline（宏展开），独立调度后续再议 |
| `logic` 扇入（Fan-in）OR/AND 语义 | 统一禁止，防止死锁，用户需显式重组图 |
| Indirect Dispatch | 数据模型预留字段，执行器暂不实现 |

---

## 一、设计哲学

### 1.1 定位

ShaderGraph 是 **附着于实体的 GPU Compute 数据流编排器**。

- **输入**：场景中满足 `ComponentList` 的一组实体。
- **执行**：在 GPU 上批量完成计算，CPU 仅负责发令与参数准备。
- **输出**：修改 GPU Buffer（组件 SoA 或中间 Buffer），供后续渲染或下一帧读取。

### 1.2 核心红线（绝对不做）

| 禁止事项 | 正确归属 |
|----------|----------|
| **CPU 游戏逻辑**（AI、事件、网络） | `game.js` / TS System |
| **渲染管线编排**（阴影、后处理） | `RenderGraph` + `render.json` |
| **系统级全局模拟**（PBD 约束投影、流体压力、N-Body） | `PbdManager.ts` 等 TS 插件硬编码 |
| **跨实体全局规约**（Sum、Max） | 独立 Compute Pass，不归图模型 |
| **Per-entity 动态分支** | 在 WGSL Shader 内部用 `if (id < count)` 处理 |

### 1.3 与现有系统的关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        应用层 (App/Game)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  JS Script   │  │ RenderGraph  │  │   ShaderGraph        │  │
│  │  (CPU 逻辑)   │  │ (渲染管线)   │  │  (GPU Compute 编排)   │  │
│  │              │  │              │  │                      │  │
│  │ • AI 状态机  │  │ • 阴影 Pass │  │ • 粒子属性更新       │  │
│  │ • 事件响应   │  │ • GBuffer   │  │ • 软体蒙皮           │  │
│  │ • 网络同步   │  │ • 光照计算  │  │ • 植被风场动画       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│         ▲                  ▲                     ▲             │
│         └──────────────────┴─────────────────────┘             │
│                          ECS Scene                            │
│                (Component SoA / Entity Query)                  │
└─────────────────────────────────────────────────────────────────┘
```

ShaderGraph 与 JS Script **仅通过 ECS 组件和 System Buffer 通信**，不直接调用彼此。

---

## 二、三层架构（简化版）

考虑到 MVP 裁剪，我们将 L1（调度器）简化为 **递归 DFS**，取消复杂的就绪队列。

```
┌─────────────────────────────────────────────────────────────┐
│ L3: 数据层（ShaderGraph Schema）                            │
│     纯 JSON 描述：节点、端口、连线、roots                     │
│     零执行逻辑，可序列化/反序列化                            │
└─────────────────────────────────────────────────────────────┘
                              │ 编译 + 验证
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ L2: 执行层（GpuTaskExecutor）                               │
│     递归 DFS 遍历逻辑链                                      │
│     装配 BindGroup、管理 Buffer 生命周期、提交 Compute Pass │
└─────────────────────────────────────────────────────────────┘
                              │ 提交
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ L1: 调度层（递归 DFS）                                      │
│     无状态机，无就绪队列                                    │
│     执行顺序由逻辑连线静态决定                              │
└─────────────────────────────────────────────────────────────┘
```

**执行入口**：
```ts
function executeGraph(roots: NodeId[]) {
  for (const root of roots) {
    executeNode(root);
  }
}

function executeNode(node: Node) {
  if (node.executedThisFrame) return; // 防重入
  node.executedThisFrame = true;

  // 1. 执行当前节点（Dispatch / 求值 / 控制流展开）
  doCompute(node);

  // 2. 递归所有逻辑后继（扇出支持）
  for (const next of getLogicSuccessors(node)) {
    executeNode(next);
  }
}
```

---

## 三、数据模型（L3）

### 3.1 图级结构

```ts
interface ShaderGraph {
  version: 6;
  roots: NodeId[];           // 有序。先全局节点，后 foreach
  nodes: Node[];
  edges: Edge[];
  interface?: GraphInterface; // 子图对外暴露的端口（子图必填）
}
```

**多根执行语义**：
1. 按 `roots` 数组顺序执行。
2. 非 `foreach` 根节点：执行一次，与实体数量无关。
3. `foreach` 根节点：筛选实体集合，下游 shader 单次批量 dispatch。

### 3.2 节点类型全集

#### A. 入口节点：`foreach`
- **配置**：`components: string[]`（ComponentList，实体必须同时拥有全部列出的组件）。
- **端口**：1 个 `logic` 出口。
- **运行时**：
  1. ECS Query 得到 `entityIds[]` 与 `count`。
  2. 结果作为 **帧级静态快照** 缓存（见 §4.1）。
  3. 计算 `dispatchWorkgroupsX = ceil(count / workgroupSize)`，传递给下游 `shader` 节点。
- **约束**：一张图至少有一个 `foreach`。

#### B. Shader 节点：`shader`
- **配置**：
  - `pipeline: string`（引用 `pipelines/*.json`）
  - `entryPoint: string`
  - `bindLayout: string`（引用 `bind-layouts.json`）
  - `dispatch: { mode: 'direct'; shape: [number, number, number] }`
- **端口**：1 个 `logic` 入口，1 个 `logic` 出口。多个 `buffer` 入口由 `bindLayout` 反射生成。
- **dispatch shape 推导**：若 shape 为 `"$foreach.count"`，自动替换为上游 `foreach` 的实体数量 / workgroupSize。

#### C. 资源节点

**`component`**
- **配置**：`component: string`。
- **端口生成**：
  - 数值/向量字段（`f32`/`i32`/`u32`/`vec2/3/4`）→ **`value` 出口**（运行时自动收集为 SoA StorageBuffer）。
  - Buffer 字段（`role: 'buffer'`）→ **`buffer` 出口**（直接传递 GPU Handle）。
- **运行时行为**：`value` 出口在帧开始时收集所有实体的该字段值，上传为只读 StorageBuffer，按 `(componentName, fieldName, archetypeVersion)` 缓存。

**`ubo`**
- **配置**：`layout: string`（如 `frame`/`object`）。
- **端口**：1 个 `buffer` 出口（引擎分配/查询 uniform buffer）。

**`system_buffer`**
- **配置**：`system: string`，`buffer: string`。
- **端口**：1 个 `buffer` 出口。
- **生命周期**：由对应 System（如 `PbdManager.ts`）创建/销毁，ShaderGraph 只读其 handle。

#### D. 控制流节点

**`if`（帧级静态分支）**
- **配置**：`op: '>' | '<' | '>=' | '<=' | '==' | '!='`
- **端口**：2 个 `value` 入口（A, B），1 个 `logic` 入口，`true`/`false` 两个 `logic` 出口。
- **执行**：帧开始时求值 A、B（仅限 `literal`/`ubo`/`math`），按结果选择分支。
- **红线**：**严禁** A/B 入口连接 `component` 的 `value` 端口（Validator 报错）。

**`loop`**
- **配置**：无额外配置。
- **端口**：`iterations`（`value` 入口），`loop_in`（`logic` 入口），`cycle_end`（`logic` 回边入口），`cycle_start`（`logic` 出口），`loop_out`（`logic` 出口）。
- **执行**：
  1. 求值 `iterations` 得 N（仅限常量/ubo）。
  2. N = 0 → 走 `loop_out`。
  3. N > 64 → 截断为 64 + `console.error`。
  4. 主机侧展开 N 次，每次从 `cycle_start` 派发，`cycle_end` 回到 loop 节点内部计数。
- **性能上限**：`MAX_HOST_LOOP = 64`。

#### E. 数学节点（CPU 侧求值）
- **类型**：`add`、`sub`、`mul`、`div`、`neg`、`abs`、`min`、`max`、`splat`（标量→向量广播）、`extract`（向量取分量）。
- **端口**：`value` 入口 → `value` 出口。
- **执行**：纯 CPU 求值，不产生 GPU 命令。

#### F. 子图节点：`instance`（Phase 4 实现）
- **配置**：`graphPath: string`（`virtual://assets/graphs/xxx`），`portMapping: Record<string, PinRef>`。
- **执行**：Inline（宏展开），子图平铺到父图中，**继承父 `foreach` 的实体上下文**。
- **限制**：最大嵌套深度 = 8。子图若有自己的 `foreach`，验证器报错。

### 3.3 端口与连线规则

| 端口类型 | 传递内容 | 连接规则 |
|----------|----------|----------|
| `logic` | 执行依赖 | **1:1 强制**（禁止扇入），允许扇出（1→N）。Validator 拦截多入。 |
| `value` | CPU 可求值数据（标量/向量） | 严格类型匹配，允许 `f32` → `vecN` 隐式广播。 |
| `buffer` | GPU BufferHandle + 访问权限 | 需匹配 `bind-layout` 的 storage class。 |

**连线格式**：
```ts
interface Edge {
  from: NodeId;
  to: NodeId;
  type: 'logic' | 'value' | 'buffer';
  fromPin?: string;  // logic 可省略
  toPin: string;
}
```

### 3.4 值引用的两种写法

```json
// 字面量
{ "literal": 42 }
{ "literal": [1.0, 0.0, 0.0] }

// 上游引用
{ "pin": "getParams:exposure" }
```

---

## 四、运行时执行引擎（Runtime Caching）

### 4.1 Entity Context 快照
- `foreach` 节点在帧开始时执行 ECS Query，结果为 **静态快照**（`entityIds[]` + `count` + SoA 指针）。
- **缓存策略**：记录当前 ECS 的 `archetypeVersion`。若下一帧版本号不变，直接复用上一帧的快照（跳过 Query）。
- **生命周期**：快照仅在当前帧有效，帧结束释放引用。

### 4.2 `component.value` → SoA StorageBuffer 上传
- 对于被引用的 `component.value` 端口，执行器在帧开始时：
  1. 根据快照的 `entityIds[]`，收集所有实体的该字段值到 `Float32Array`。
  2. 从 **Ring Buffer（3 帧）** 中分配一个 StorageBuffer 并上传。
  3. 缓存 key = `(componentName, fieldName, archetypeVersion)`，若版本未变，复用上一帧的 BufferHandle。
- **Shader 侧**：WGSL 中用 `array<field_type>` 声明，以 `global_invocation_id.x` 索引。

### 4.3 Pipeline / BindGroup 缓存
- **Pipeline**：以 `(pipelineName, entryPoint, bindLayout)` 为 key，全局单例懒加载。
- **BindGroup**：以 `(layoutHash, [bufferHandles...])` 为 key，帧级 LRU 缓存。若 BufferHandle 未变，直接复用。

---

## 五、UI 与资产架构

### 5.1 UI 架构（Store + Command）

采用极简三层，避免过度设计：

1. **Store（`graphStore.ts`）**：
   - 用 `reactive({ nodes: [], edges: [], roots: [] })` 存储纯 JSON。
   - 提供 `updateGraph(mutator)` 函数，内部使用 `immer` 产生新状态。

2. **Command（复用 `EditorCommandBus`）**：
   - `AddNodeCommand`、`ConnectEdgeCommand`、`RemoveNodeCommand`、`SetPropertyCommand`。
   - 每次 `updateGraph` 前将旧 JSON 推入历史栈（最多 30 步）。

3. **View（Vue 组件）**：
   - 只负责渲染和派发事件。
   - 用 `watch(store.graph, debounce(validate, 300))` 触发异步校验（主线程同步执行，不另开 Worker）。

### 5.2 资产路径协议（`virtual://`）

- **主图**：`public/apps/<appName>/graph.json`
- **子图**：`public/assets/graphs/<subgraphName>.graph.json`
- **引用格式**：`instance` 节点存 `"graphPath": "virtual://assets/graphs/pbd_solver"`
- **解析器（AssetResolver）**：
  - 开发环境映射到 `public/assets/graphs/`
  - 打包后映射到 `dist/assets/graphs/`
- **热重载**：`ProjectFS.watch` 监听 `.graph.json` 变更，重新加载该图及其父图。

---

## 六、验证器（Validator）与拓扑约束

### 6.1 硬规则

| # | 规则 | 报错信息 |
|---|------|----------|
| 1 | `logic` 端口禁止扇入（1:1） | `"Logic fan-in detected at node ${id}"` |
| 2 | 无裸环（除 `loop` 回边） | `"Cyclic dependency detected"`（Kahn 算法） |
| 3 | 至少一个 `foreach` | `"Graph must have at least one foreach node"` |
| 4 | 全局节点（`system_buffer`）若在 `foreach` 下游 | `"Global node cannot be placed after foreach"` |
| 5 | `if` 的 `value` 入口禁止连接 `component` | `"If condition cannot reference per-entity component field"` |
| 6 | `loop.iterations` 禁止连接 `component` | `"Loop iterations must be compile-time constant or ubo"` |
| 7 | `instance` 嵌套深度 > 8 | `"Subgraph nesting depth exceeds 8"` |
| 8 | 子图 `instance` 中含 `foreach` | `"Subgraph cannot contain its own foreach root"` |

### 6.2 类型检查（`value` 端口）

```ts
function isTypeCompatible(src: DataType, dst: DataType): boolean {
  if (src.base !== dst.base) return false;
  if (src.shape === dst.shape) return true;
  if (src.shape === 'scalar' && dst.shape.startsWith('vec')) return true; // 广播
  return false;
}
```

---

## 七、实施路线图（分阶段）

### Phase 0 — 数据模型 + 验证器（2 周）
- [ ] 完整定义 `shaderGraph.ts`（v6 Schema）。
- [ ] 实现 `GraphValidator`（环检测、扇入拦截、红线检查）。
- [ ] 实现 `AssetResolver`（`virtual://` 协议）。
- [ ] 手写 demo10 `graph.json`（覆盖 `foreach` + `component` + `shader` + `ubo`）。

### Phase 1 — 执行器 + 缓存（2 周）
- [ ] 实现 DFS 递归执行器（`executeNode`）。
- [ ] 实现 Entity Context 快照 + Archetype 版本缓存。
- [ ] 实现 `component.value` → Ring Buffer 上传。
- [ ] 实现 Pipeline / BindGroup LRU 缓存。
- [ ] 端到端跑通线性 compute 链。

### Phase 2 — 控制流（2 周）
- [ ] 实现 `if` 帧级静态分支（短路 + 递归）。
- [ ] 实现 `loop` 主机侧展开（上限 64）。
- [ ] 编辑器适配：控制流节点可视化。

### Phase 3 — 编辑器 + 数学节点（1 周）
- [ ] Store + Command 基础架构（Undo/Redo）。
- [ ] 动态端口生成（`component` 反射，`shader` bindLayout 反射）。
- [ ] 实时类型检查 + 错误高亮。
- [ ] 数学节点调色板（CPU 求值）。

### Phase 4 — 子图（1 周）
- [ ] `instance` 节点：Inline 加载 + 端口映射。
- [ ] 子图下钻编辑（面包屑导航）。
- [ ] 文档重写（`code-conventions.md`、`json-schemas.md`、`subgraph-guide.md`）。

### Phase 5+ — 未来扩展（不排期）
- [ ] `buffer_copy` / `buffer_clear` 节点（如确有必要）。
- [ ] 独立子图模式（Standalone）。
- [ ] Indirect Dispatch。
- [ ] StorageTexture 支持。

---

## 八、验证标准（Definition of Done）

| 阶段 | 冻结标准 |
|------|----------|
| Phase 0 | Schema 定稿，demo10 通过 `GraphValidator` 全部检查。 |
| Phase 1 | 线性 compute 链（`foreach` + `component` + `shader` + `ubo`）在真实 WebGPU 环境端到端跑通，输出正确。 |
| Phase 2 | `if`/`loop` 控制流在 demo10 中手工搭建并输出正确结果。 |
| Phase 3 | 编辑器实时类型检查、动态端口生成、错误高亮全部可用，Undo/Redo 工作。 |
| Phase 4 | `instance` 嵌套加载成功，文档完整。 |
| 交付 | `npm run verify`（build + check:plugins + test + validate + smoke）全部通过。 |
