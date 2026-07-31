# Review 合理性分析与解决计划

> 基于 Review.md 与代码仓现状（src/ + public/plugins/）的逐条核对结果。
> 每条标注：✅ 合理 / ⚠️ 部分合理 / ❌ 不合理或过时，并给出落地方案。
>
> **状态：全部 10 批次已完成（10 个 git commits），四件套验证通过。**

---

## 一、总体评价

Review.md 的架构理解基本准确，定位的问题方向（热路径分配、字符串解析、God Class、回滚缺失）多数真实存在。但有两类偏差：
1. **过时信息**：P3.5 称"physics/animation 未见实现"——实际上 `public/plugins/physics/PhysicsSystem.ts` 与 `public/plugins/sprite/SpriteSystem.ts`（animation 系统）已存在，`common/systems.json` 也已列入。
2. **夸大表述**：P0.7 的"view 伪泄漏"、P1.11 的"`as unknown as` 泛滥"（全 src/ 仅 7 处，且多在非热路径）、P1.13 的 CSP 风险与"可拷贝分发"设计目标冲突。

下方按优先级列出**合理且值得落地**的问题与方案，不合理项给出原因后跳过。

---

## 二、P0 关键缺陷（合理，立即/近期执行）

### P0-A. 预编译 `resolveValue`（对应 Review §1）✅

**现状核实**：`src/render/valueResolver.ts:65` `resolveValue` 每帧对每个实体×每个 bind group×每个 write 都做 `indexOf(':')`/`split(',')`/`schemaRegistry.get()`。`PipelineDriver.buildEntries`（`PipelineDriver.ts:219`）在热循环里逐次调用。真实瓶颈。

**方案**：
1. 在 `PipelineDriver` 构造期（`RenderGraph.compile` 已有 driver 创建点，`RenderGraph.ts:247`）对 `decl.bindGroups[*].uniform.writes[*].value` 预编译为 `ValueResolver` 闭包：
   - `const:` → 直接返回常量数组。
   - `builtin.*`/`transform.*`/`tag.*` → 直接查 `atomNamespaces` 取闭包（已是闭包，免去字符串 split）。
   - `Comp.field` → 构造时一次性 `schemaRegistry.get(head)` 拿到 component 引用，运行时只调 `scene.getField`。
   - `pack:` → 编译为 `ValueResolver[]` 数组，运行时拼接。
   - `script:` → 编译为查表闭包。
2. 新增 `CompiledValue = (ctx: ValueContext) => number | number[]` 类型，`PipelineDriver` 持有 `compiledWrites: CompiledValue[][]`（按 bg → write 索引）。
3. `buildEntries` 运行时只执行闭包，不再触碰原始字符串。
4. `resolveHandle`/`resolveString` 同理预编译（mesh name、texture handle）。

**影响文件**：`valueResolver.ts`（新增 `compileValue`）、`PipelineDriver.ts`（构造期编译 + 运行期执行）、`RenderGraph.ts`（driver 构造传编译结果）。

---

### P0-B. math.ts out-parameter API（对应 Review §2）✅

**现状核实**：`src/math.ts` 全部矩阵函数 `new Float32Array(16)`。`buildCameraMatrices`（`math.ts:7`）链式 5 次分配；`transform.model` resolver（`valueResolver.ts:43`）`Array.from(ctx.model())` 每实体每帧分配。真实 GC 压力。

**方案**：
1. 为 `mat4Mul`/`mat4Inverse`/`mat4FromTRS`/`mat4Perspective`/`mat4LookAt`/`normalMatrix` 增加 `out: Float32Array` 参数版本（保留无 out 版本作便捷包装，内部调 out 版本）。
2. 在 `Scene` 上维护帧级 scratch 矩阵池（`scratchModel`/`scratchVp`/`scratchView`/`scratchProj`），`getModelMatrix(eid, out)` 写入 out 而非 new。
3. `getActiveCameras`（`Scene.ts:153`）改用预分配的 `CameraView` 对象池（数组复用，避免每帧 push 新对象 + 5×Float32Array）。
4. `valueResolver.ts` 的 `transform.model`/`transform.normalMatrix` atom 改为写入 `ctx` 提供的 out 缓冲，返回引用而非 `Array.from`。

**影响文件**：`math.ts`、`Scene.ts`、`valueResolver.ts`、`Engine.ts`（FrameContext 可选附加 scratch 字段）。

---

### P0-C. 批量 `dispatchCompute`（对应 Review §3）✅

**现状核实**：`Engine.ts:654` `dispatchCompute` 每次新建 encoder + submit。代码注释已自认"not optimal"。粒子/脚本系统每帧多次调用 = 多次 submit。

**方案**：
1. 在 `FrameContext` 增加 `beginComputePass()` / `endComputePass()` 或 `dispatchCompute` 改为延迟模式：每帧第一次 dispatch 时创建一个 `pendingComputeEncoder`，记录所有 dispatch；帧末尾（所有 system update 后、renderGraph execute 前）统一 `submit`。
2. 具体实现：`Engine.frame`（`Engine.ts:606`）在 system 循环前创建 `let computeEncoder: GPUCommandEncoder | null = null`；`dispatchCompute` 改为 `if (!computeEncoder) computeEncoder = device.createCommandEncoder()`，然后 `beginComputePass` 记录；system 循环结束后 `if (computeEncoder) submit`。
3. 保留即时 submit 作为降级（`dispatchComputeImmediate`），供 render hook 内部需要同步结果时用。

**影响文件**：`Engine.ts`（frame + dispatchCompute）、`ecs/SystemRegistry.ts`（FrameContext 类型）。

---

### P0-D. FrameContext 池化（对应 Review §4）✅

**现状核实**：`Engine.ts:619` 每帧 `const ctx: FrameContext = { ... }` 含 14 字段 + 4 个箭头闭包（`getSystem`/`getBuffer`/`writeBuffer`/`dispatchCompute`）。

**方案**（与 P0-C 合并实现）：
1. 在 `Engine` 上维护 `private frameCtx: FrameContext` 单例，构造时一次性创建（闭包绑定 `this`，无需每帧重建）。
2. `frame()` 只更新可变字段：`time`/`dt`/`aspect`/`cw`/`ch`。
3. 闭包字段（`getSystem` 等）绑定到 `this`，无需每帧重赋。

**影响文件**：`Engine.ts`。

---

### P0-E. 多视图单 Encoder 提交（对应 Review §5）✅

**现状核实**：`RenderGraph.ts:493` `executeMultiView` 每个 camera 创建独立 encoder 并 `submit`（line 499）。注释（line 333-336）解释原因是"共享 camera UBO 无法在单 command buffer 的 pass 间安全重写"。

**方案**（短期，不改 UBO 模型）：
1. 将 stage 2 改为单 encoder：`const enc = device.createCommandEncoder()`，所有 camera 的 pass 录入同一 encoder，末尾一次 `submit`。
2. camera UBO 重写用 `encoder.copyBufferToBuffer` 或 `writeBuffer`（`queue.writeBuffer` 在 submit 前生效，但同一 command buffer 内多 pass 间 UBO 更新需用 encoder 级 copy 或 dynamic offset）。
   - 最稳妥：camera UBO 改为 per-camera offset（一个大 buffer，每个 camera 偏移），pass 用 `dynamicOffsets` 绑定，避免写后写冒险。
3. 若 dynamic offset 改造成本高，先做"单 encoder 多 submit"中间态：同一 encoder 录入所有 pass，但每 camera 后 `submit([enc.finish()])` 仍多次——这不能减少 submit。因此优先做 dynamic offset 方案。

**影响文件**：`RenderGraph.ts`（executeMultiView + writeCameraUBO）、`ResourceManager.ts`（camera UBO 改 dynamic）、`UniformLayout.ts`（dynamic offset 支持）。

---

### P0-F. 句柄表 Free List（对应 Review §6）✅

**现状核实**：`ResourceManager.ts:316` `registerBuffer` 只 push；`exitApp` 把 `textureList[handle] = null`（line 201）但不回收索引。`bufferList` 同样无回收。长时间切换 app 后数组只增不减。

**方案**：
1. 增加 `private bufferFreeList: number[] = []` 和 `textureFreeList: number[] = []`。
2. `registerBuffer`/`registerTextureHandle`：free list 非空时 `pop` 复用索引并赋值，否则 push。
3. `exitApp` 销毁资源时把句柄推入对应 free list（而非仅置 null）。
4. `getBuffer`/`getTextureByHandle` 对 free list 回收的索引返回 `undefined`（已置 null 即可）。

**影响文件**：`ResourceManager.ts`。

---

## 三、P1 近期优化（合理，1-4 周内）

### P1-A. 插件加载两阶段回滚（对应 Review §9）✅

**现状核实**：`PluginManager.ts:134-143` `loadOne`：try 块内 `init` → `applyDeclarations` → `setup`。若 `setup` 抛异常，`finally` 只 `endOwner`，`applyDeclarations` 注册的 schema/uniform/pipeline 等未回滚，且异常向上传播使依赖插件读到半初始化状态。

**方案**：
1. `loadOne` 的 try 块改为：先 `applyDeclarations`（记录 owner = `plugin:<id>`），再 `setup`。
2. 若 `setup` 抛异常，catch 中调 `this.host.sweepOwner(pluginOwner(id))` 回滚所有声明注册项，然后 re-throw。
3. 确保 `loaded.set` 只在 `setup` 成功后执行（现状已如此），且回滚后不残留 ledger（`sweepPluginOwner` 已删 ledger）。

**影响文件**：`PluginManager.ts`（loadOne）。

---

### P1-B. 渲染排序与 Instancing（对应 Review §10）✅

**现状核实**：`PipelineDriver.record`（`PipelineDriver.ts:161`）按 `query(world)` 顺序遍历，无材质排序、无透明排序、无 instancing。高实体数场景 draw call 线性增长。

**方案**（分层，先排序后 instancing）：
1. **Phase 1 - 排序队列**：在 `PipelineDriver`（或 `RenderGraph.compile`）预编译每个 driver 的 sortKey 提取器（material hash + 距离）。`record` 时先收集 `{eid, sortKey}`，排序后遍历。透明物体（decl 标记 `transparent: true`）单独队列，按相机距离远→近。
2. **Phase 2 - GPU Instancing**：相同 pipeline + 相同 material bind group 的连续实体，合并为单次 `drawIndexed(count, instanceCount)`，object UBO 改为 array（`array<mat4x4f>`），每实例写入偏移。
3. 透明物体不参与 instancing（排序敏感）。

**影响文件**：`PipelineDriver.ts`（排序 + instancing 逻辑）、`rendererDecl.ts`（新增 `transparent`/`sort` 字段）、`ResourceManager.ts`（object UBO array 化）。

---

### P1-C. ECS `toJSON` 优化（对应 Review §12）✅

**现状核实**：`Scene.ts:203` `toJSON` 对每个实体遍历 `schemaRegistry.comps.keys()`（全部已注册组件），O(E×C)。仅在导出时调用，非热路径，但组件多时导出卡顿。

**方案**：
1. `Scene` 增加 `private entityComponents = new Map<number, string[]>`，`createEntity` 时记录实际 addComponent 的组件名列表。
2. `toggleComponent`/`removeEntity` 同步维护该表。
3. `toJSON` 改为遍历 `entityComponents.get(eid)`，O(E×平均组件数)。

**影响文件**：`Scene.ts`。

---

### P1-D. Engine 职责拆分（对应 Review §8）⚠️→✅（合理但需谨慎）

**现状核实**：`Engine.ts` 736 行，承载 init + app 加载/卸载 + 插件编排 + 帧循环 + glTF + system 断言。职责确实偏多，单元测试困难。

**方案**（渐进，不一步到位）：
1. 先抽 `AppLifecycleManager`：把 `loadApp`/`loadAppInner`/`unloadCurrentApp`/`resolveAsset`/`isJson` 迁出，Engine 持有其引用。
2. 再抽 `PluginHostImpl`：把 `makePluginContext`/`applyPluginDeclarations`/`sweepPluginOwner`/`ledgerFor` 迁出（当前散在 Engine 里）。
3. `Engine` 保留 `init`/`startLoop`/`frame`/`loadGltf` 作为 Facade。
4. 每抽一步跑 build + check:plugins + validate + smoke 四件套验证。

**影响文件**：新建 `src/AppLifecycle.ts`、`src/PluginHost.ts`，瘦身 `Engine.ts`。

---

## 四、P1/P2 部分合理项（方案弱化或暂缓）

### P1-E. 类型安全（对应 Review §11）⚠️

- `device!: GPUDevice` 非空断言 → ✅ 合理，改为 getter + 运行时 throw（`if (!this._device) throw`）。
- `as unknown as` "泛滥" → ❌ 夸大，全 src/ 仅 7 处且多在非热路径（window typing、gltf 动态 key、render script 跨类型）。可局部清理但非系统性问题。
- 引入 `zod`/`valibot` 做 JSON 校验 → ⚠️ 可选。项目当前零运行时配置校验依赖，且 AGENTS.md 强调 fail-loud（malformed JSON 已通过 `json()` throw）。zod 增益有限，暂缓；若加，仅限 app.json/engine-config.json 入口校验。

**方案**：仅做 device/context getter 化（Engine.ts + ResourceManager.ts），其余暂缓。

---

### P1-F. 插件生产构建（对应 Review §13）⚠️→暂缓

**现状核实**：生产环境 Sucrase 转译 TS 确有延迟。但 AGENTS.md 明确设计目标为"可拷贝分发 TS 插件，改动无需重构引擎"，移除 Sucrase 与此冲突。Review 自身建议的"dev 保留 Blob、prod 直接 import"是合理折中，但需为插件建立独立构建管线，工程量大且改变分发模型。

**方案**：暂缓。记录为未来选项（当插件数量/体积显著增长时再评估 dev/prod 分离构建）。

---

### P0-G. ResourceManager 拆分（对应 Review §7）⚠️

- God Class（1025 行）→ ✅ 合理，但拆分应跟随 P1-D Engine 拆分之后，避免一次性大重构。
- "view 伪泄漏"→ ❌ 不成立。`exitApp`（`ResourceManager.ts:194`）已 `textureViewCache.delete(tex)` 后再 `tex.destroy()`；WeakMap 设计注释（line 75-82）已论证重建 texture = 新对象 = cache miss。不存在"伪泄漏"。
- Shadow 纹理重建残留 → ✅ 合理，`ensureShadowTextures`（line 514）重建时已清 `_shadow2DArrayView = null` 等，但 `_frameBg`/`_frameShadowBg` 的失效依赖手动置 null（已做，line 530/548）。当前实现已处理，Review 的担忧已被代码覆盖。

**方案**：仅保留"拆分 God Class"作为跟随项（与 P1-D 合并），删除"view 伪泄漏"和"shadow 残留"子项（已不存在）。

---

### P2-A. atomNamespaces 插件隔离（对应 Review §14）⚠️

**现状核实**：`valueResolver.ts:25` 模块级全局。`Engine.ts:327` `registerValueAtoms` 合并进全局。卸载时 `sweepPluginOwner`（line 360）按 ledger 删除。跨插件隐式依赖确实未被显式约束。

**方案**：弱化版——不做强制命名空间隔离（插件设计为协作式，强隔离会破坏 `ctx.getPlugin` 跨插件协作模式），改为：
1. `registerValueAtoms` 时记录 owner 标签到 atom 级（`atomOwners: Map<string, Map<string, string>>`）。
2. 卸载插件时若某 atom 被其他插件 ctx 引用过（无法静态检测），至少在文档/AGENTS.md 补充"跨插件引用 atom 必须声明 meta.dependencies"。
3. 不引入引用计数（过度工程）。

---

### P2-B. RenderScriptLoader HMR（对应 Review §15）✅（低成本）

**现状核实**：`RenderScriptLoader.ts:29` `if (cached) return cached`，`?t=` 已加但 key 不含 timestamp，返回旧缓存。

**方案**：dev 模式下 `load` 不查 `loaded` 缓存（或 key 含 `import.meta.hot` 的 timestamp），生产保持缓存。改动 ~10 行。

**影响文件**：`RenderScriptLoader.ts`。

---

### P2-C. 编辑器虚拟滚动 + Undo（对应 Review §16）✅（编辑器为次要）

**方案**：
1. `EditorPanel.ts:62` 实体列表引入简易虚拟滚动（窗口化渲染，仅渲染可见行 + 上下 buffer）。
2. `PipelinePanel.ts` 引入快照栈（手动深拷贝 `entry.params` / `entry.enabled`，Ctrl+Z/Ctrl+Y）。
3. 不引入 immer（项目无该依赖，手写深拷贝即可）。

**影响文件**：`EditorPanel.ts`、`PipelinePanel.ts`。

---

### P2-D. 资产引用计数（对应 Review §17）⚠️→暂缓

**现状核实**：app 级 ownership 是有意设计（`ResourceManager.exitApp` 按 owner 全量释放）。引用计数会改变生命周期模型，与"app 切换 = 全量释放"的简单性冲突。

**方案**：暂缓。当出现"单 app 内大量资产且需增量释放"的真实场景时再评估 AssetManager。

---

## 五、不采纳项

### ❌ P3.5 物理/动画"未见实现"（对应 Review §5）

**核实**：错误。
- `public/plugins/physics/PhysicsSystem.ts` + `PickTool.ts` + debug 管线/hook 已存在。
- `public/plugins/sprite/SpriteSystem.ts`（animation 系统，从 core 迁出，见 AGENTS.md）已存在。
- `common/systems.json` 已列 `physics`/`animation`。
- Rapier3D 经 `api.ts` 导出，已在 physics 插件 setup 中 `RAPIER.init()`。

Reviewer 未检查 `public/plugins/` 目录。此条不采纳。

---

### ❌ P3 FrameGraph / GPU-Driven Culling / 异步资产流 / Shader Permutation

均为合理长期方向，但属"新能力"而非"缺陷修复"，不在本次解决计划范围内。记录为路线图参考，按需单独立项。

---

## 六、执行顺序（已完成）

| 批次 | 任务 | 依赖 | 状态 | Commit |
|------|------|------|------|--------|
| 1 | P0-D FrameContext 池化 + P0-C dispatchCompute 批量 | 无 | ✅ 完成 | `2a1f105` |
| 2 | P0-F 句柄 Free List | 无 | ✅ 完成 | `103f7c9` |
| 3 | P0-B math.ts out-param + Scene 矩阵池 | 无 | ✅ 完成 | `6c92873` |
| 4 | P0-A resolveValue 预编译 | 依赖 P0-B 的 out buffer | ✅ 完成 | `ac58995` |
| 5 | P0-E 多视图单 Encoder | 依赖 P0-B/D | ✅ 完成 | `30e0471` |
| 6 | P1-A 插件回滚 + P1-C toJSON | 无 | ✅ 完成 | `c215a72` |
| 7 | P1-B 渲染排序（Phase 1） | 可独立 | ✅ 完成 | `c653ef1` |
| 8 | P2-B RenderScript HMR + P2-C 编辑器 | 无 | ✅ 完成 | `b3c6bd0` |
| 9 | P1-D Engine 拆分 + P0-G ResourceManager 拆分 | 依赖 1-5 稳定 | ✅ 完成（PluginHost 提取） | `ca9e38a` |
| 10 | P1-B GPU Instancing（Phase 2） | 依赖批次 7 | ✅ 完成 | `081c140` |

每批次完成后跑 `npm run build` + `npm run check:plugins` + `node scripts/validate-config.mjs` + `node scripts/smoke-plugin-loader.mjs` 四件套，全部通过。

### 备注

- **批次 9（ResourceManager 拆分）**：PluginHost 已从 Engine 提取（`src/PluginHost.ts`），减少 ~150 行。ResourceManager God Class 拆分延后——"view 伪泄漏"被证伪（`exitApp` 已同步 `textureViewCache.delete`），拆分属低优先级架构清理，非缺陷修复。
- **批次 10（GPU Instancing）**：引擎侧基础设施已落地（`RendererDecl.instanced` + `PipelineDriver.recordInstanced`）。使用方需：(1) 在管线 JSON 设 `instanced: true`；(2) 声明含 storage buffer 的 object bind layout；(3) 着色器用 `@builtin(instance_index)` 索引 `array<mat4x4f>`。

---

## 七、Review 评分修正

| 维度 | Review 评分 | 核实后修正 | 说明 |
|------|------------|-----------|------|
| 架构质量 | 3.8/5 | 3.8/5 | 准确。God Class 真实存在。 |
| 运行性能 | 2.8/5 | 3.0/5 | 热路径问题真实，但部分被现有缓存（bgCache/textureViewCache）缓解，2.8 偏低。 |
| 工程效率 | 3.5/5 | 3.5/5 | 准确。 |
| 生态可持续 | 3.2/5 | 3.5/5 | API 标注 UNSTABLE 但插件体系已完整（physics/sprite/splat/particles 均已落地），3.2 偏低。 |
