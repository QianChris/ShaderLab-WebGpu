# ShaderLab 引擎改进计划 (Plan.md)

> 综合代码评审与架构路线图，涵盖性能、架构、可维护性与长期演进方向。  
> 版本：v2（合并评审意见与路线图）

---

## 一、总体评价

ShaderLab 是一个**设计意图清晰、架构现代**的 WebGPU 数据驱动渲染引擎。它采用 ECS + 插件化 + 声明式渲染管线的组合，在概念层面已具备生产级引擎的骨架。

### 优势

| 维度 | 说明 |
|------|------|
| **架构分层** | `api.ts` 收敛插件可见表面；ECS、渲染、插件系统职责分离清晰。 |
| **数据驱动** | 渲染管线、组件定义、系统定义、Uniform 布局全部外置为 JSON，新增材质通常无需改 TS。 |
| **生命周期管理** | Engine → App → Plugin 三级加载/卸载链条，配合 `owner` 标签资源追踪，避免泄漏。 |
| **多视图与阴影** | 支持 `multiView` 分屏渲染；阴影系统区分 directional（2d-array）与 point light（cube-face 映射）。 |
| **插件系统完整** | 依赖解析、TS 运行时转译、import 重写、完整的生命周期钩子。 |

### 当前健康度评分（5 分制）

| 维度 | 得分 | 关键瓶颈 |
|------|------|----------|
| 架构质量 | 3.8/5 | `ResourceManager` / `Engine` God Class |
| 运行性能 | 2.8/5 | 热路径分配、字符串解析、Command Buffer 碎片化 |
| 工程效率 | 3.5/5 | 数据驱动降低迭代成本，但调试工具与 HMR 不足 |
| 生态可持续 | 3.2/5 | API 标注 UNSTABLE，插件状态隔离待加强 |

---

## 二、关键缺陷修复（P0：立即修改）

### 1. 热路径字符串解析：`resolveValue` 未预编译

**问题位置**：`render/valueResolver.ts` → `PipelineDriver.bindGroups`  
**影响**：对每个实体、每个 bind group、每帧都调用 `resolveValue`，内部执行 `indexOf(':')`、`split(',')`、`schemaRegistry.get()` 等字符串/Map 操作。CPU 开销随实体数线性放大。

**推荐措施**：
- **预编译值解析器**：在 `PipelineDriver` 初始化（`compile()` 阶段）将 `bindGroups` 中的 `value` 字符串解析为 `ValueResolver[]` 闭包数组。
- 运行时直接执行闭包，不再触碰字符串。例如 `"transform.model"` 预编译为 `(ctx) => Array.from(ctx.model())`。

---

### 2. 数学函数疯狂分配 `Float32Array`

**问题位置**：`math.ts`（`mat4Mul`、`mat4Inverse`、`mat4FromTRS` 等）  
**影响**：每帧数百次 `new Float32Array(16)`，引发 GC 压力与帧率抖动。

**推荐措施**：
- **引入 out-parameter API**：`mat4Mul(a, b, out)`，`mat4Inverse(m, out)`。
- 引擎内部维护一个 `Float32Array` 池（或栈分配），在 `FrameContext` 中提供 `scratchMatrix` 等临时缓冲区。
- 长期：评估引入 `gl-matrix` 或自研 SIMD 友好型矩阵库。

---

### 3. `dispatchCompute` 每次调用都独立 submit

**问题位置**：`Engine.ts:dispatchCompute`  
**影响**：Script system 每帧调用多次（如粒子 emit + simulate）时，产生大量小 command buffer，严重损害 GPU 并行效率与 CPU 开销。

```ts
// 当前：每次调用新建 Encoder + Submit
const encoder = this.device.createCommandEncoder();
// ... 记录 ...
this.device.queue.submit([encoder.finish()]);
```

**推荐措施**：
- **批量提交**：`FrameContext` 提供 `beginComputePass()` / `endComputePass()` 接口，或维护一个 `ComputeCommandBuffer` 缓存数组。
- Script system 将 dispatch 指令缓存到数组中，在 frame 末尾统一编码并一次 `submit`。
- 保留单 dispatch escape hatch 作为降级路径。

---

### 4. `FrameContext` 每帧新建大对象

**问题位置**：`Engine.ts:frame()`  
**影响**：每帧 `new` 一个包含 15+ 属性的对象，虽然 `attachments` 是引用，但对象本身是新的。

**推荐措施**：
- **对象池化**：在 Engine 上维护一个 `currentFrameContext` 对象，每帧只更新可变字段（`time`、`dt`、`aspect` 等）。
- 或使用 `Object.assign(frameCtx, { time, dt, ... })` 复用同一实例。

---

### 5. 多视图渲染频繁 Submit（性能瓶颈）

**问题位置**：`render/RenderGraph.ts:executeMultiView`  
**影响**：每个 Camera 创建一个独立 `CommandEncoder` 并单独 `queue.submit()`。4 个分屏视图 = 一帧 4 次 submit，破坏 GPU batching，CPU-GPU 同步间隙过大。

**推荐措施**：
- **短期**：将多个摄像机的渲染指令合并到**同一个** `CommandEncoder` 中，利用 `writeBuffer` 在 Pass 间更新 UBO，或使用动态绑定索引。最后统一 `submit`。
- **长期（审慎）**：当场景规模达到万级实体时，评估 **Indirect Draw / Multi-Draw-Indirect** 实现 GPU 驱动的多视图渲染。注意：WebGPU MDI 支持仍在推进中，短期内优先保证单 Encoder 合并。

---

### 6. 句柄表无限增长（内存泄漏风险）

**问题位置**：`render/ResourceManager.ts` 中的 `bufferList` 和 `textureList`  
**影响**：仅追加（`push`），即使 `exitApp` 销毁了底层资源，数组长度也不会收缩。长时间运行后句柄索引可能溢出或导致内存膨胀。

**推荐措施**：
- 实现 **空闲句柄池（Free List）**。销毁资源时将句柄回收入栈，分配时优先复用空闲索引，保证数组大小与实际存活资源数量成正比。
- 同步清理 `textureViewCache` 中对应句柄的 view 条目（见第 7 条）。

---

### 7. `ResourceManager` God Class 与 view 伪泄漏

**问题位置**：`render/ResourceManager.ts`（近 600 行，管理 10 种 GPU 资源）  
**影响**：
1. 职责过重，`exitApp` 清理逻辑冗长，容易遗漏。
2. `WeakMap<GPUTexture, GPUTextureView>` 缓存：Texture 被 `destroy()` 后，WeakMap 不会自动清理直到 GC 回收，而 texture 对象又被 `textureList` 持有，形成**伪泄漏**。
3. Shadow 纹理重建时，`textureViewCache` 中可能残留旧 texture 的 view 对象。

**推荐措施**：
- **拆分 ResourceManager** 为独立模块：
  - `MeshManager`（`meshData` + `meshGpu`）
  - `TextureManager`（`textures` + `fallback` + `upload` + `view cache` + **句柄 Free List**）
  - `BufferManager`（`uniform` + `storage`，可与 `BufferRegistry` 合并）
  - `RenderTargetManager`（`colorTargets` + `depthTargets` + `shadow maps`）
  - `BindGroupLayoutManager`（`bindLayouts` + `samplers`）
- **显式 view 缓存**：改用 `Map<string, GPUTextureView>`，在 `texture.destroy()` 时**同步**删除对应 view，不依赖 GC。
- Shadow 纹理重建时，统一走 `TextureManager.invalidate(name)` 接口。

---

## 三、近期优化（P1：1-4 周内完成）

### 8. Engine 类过于臃肿（上帝类反模式）

**问题位置**：`Engine.ts`  
**影响**：同时管理初始化、App 加载/卸载、插件广播、系统断言、渲染图编译、GLTF 加载等，单元测试困难，代码耦合紧密。

**推荐措施**：
- 拆分为多个专职类：
  - **`AppLifecycleManager`**：负责 Manifest 解析、App 切换、作用域管理。
  - **`ResourceScopeManager`**：封装 `enterApp` / `exitApp` 及资源清理。
  - **`EngineFacade`**：仅暴露 `init`、`startLoop`、`loadApp` 等高层接口给 `main.ts`。
- `Engine` 本身保留为协调者（Facade），但将具体逻辑下放到子系统。

---

### 9. 插件加载失败时的部分回滚缺失

**问题位置**：`plugins/PluginManager.ts:loadOne`  
**影响**：若 `instance.setup` 抛出异常，已通过 `applyDeclarations` 注册的内容不会被回滚，且 `loaded` 状态被标记为成功，导致依赖插件读取到半初始化状态。

**推荐措施**：
- 采用 **两阶段加载**：
  1. **Phase 1**：应用所有声明（`applyDeclarations`），记录注册项到临时 ledger。
  2. **Phase 2**：调用 `setup`。若失败，立即执行 `sweepOwner` 完全回滚 Phase 1 的副作用，并向上抛出致命错误，阻止依赖插件加载。

---

### 10. 渲染排序与批处理缺失（Draw Call 爆炸）

**问题位置**：`PipelineDriver` 仅按 ECS 查询顺序遍历实体  
**影响**：没有针对透明物体的深度排序，也无相同材质的自动 Instancing。高颗粒场景（>1k 物体）会导致 Draw Call 飙升。

**推荐措施**：
- 在 `RenderGraph.compile` 或 `execute` 阶段，根据 `sortKey`（材质 Hash → 距离）构建**排序队列**。
- 实现 **GPU Instancing**：复用同一 `GPURenderPipeline`，仅通过 `object` bind group 更新每个实例的 model 矩阵，大幅减少 Draw Call。
- 透明物体单独队列，按相机距离从远到近排序（ painter's algorithm ）。

---

### 11. 类型安全与错误处理

**问题位置**：`Engine.ts`、`RenderGraph.ts`、`GltfLoader.ts`  
**影响**：
1. 大量非空断言 `!`（`this.device!: GPUDevice`）掩盖初始化顺序错误。
2. `as unknown as` 泛滥，破坏 TypeScript 保护。

**推荐措施**：
- 将 `device` / `context` 改为可选类型，访问前做运行时检查：
  ```ts
  get device(): GPUDevice {
    if (!this._device) throw new Error('Engine not initialized');
    return this._device;
  }
  ```
- 对 JSON 配置引入 `zod` 或 `valibot` 做 schema 校验，在加载阶段 fail loud。
- 对 dynamic import 结果使用类型守卫，替代 `as unknown as`。

---

### 12. ECS `toJSON` 遍历所有组件类型

**问题位置**：`ecs/Scene.ts:toJSON`  
**影响**：导出场景时，对每个实体遍历**所有已注册组件**（O(E × C)）。组件类型多（50+）时呈 O(n²)。

**推荐措施**：
- 在 `createEntity` 时记录该实体实际拥有的组件列表（`entityComponents: Map<eid, string[]>`）。
- `toJSON` 只遍历该实体的组件，降至 O(E × 平均组件数)。

---

### 13. 插件生产构建与 CSP 安全

**问题位置**：`plugins/PluginManager.ts`  
**影响**：
1. 生产环境使用 Sucrase 转译 TS，加载延迟高。
2. Blob URL + dynamic import 存在泄漏风险与 CSP 安全隐患。

**推荐措施**：
- **构建时编译**：插件在构建阶段（Rollup/Vite）预编译为 ESM JS，生产环境直接加载 `.js`。
- **保留 Blob 机制仅用于 dev**：通过 `import.meta.env.DEV` 分支，生产环境直接 `import()` 真实 URL。
- **Subresource Integrity**：生产环境加载插件时校验 hash。

---

## 四、中期改进（P2：1-3 个月内完成）

### 14. 全局状态 `atomNamespaces` 的跨插件污染

**问题位置**：`render/valueResolver.ts`  
**影响**：模块级全局对象，插件 A 注册 `ns.foo`，插件 B 直接使用但未声明依赖，卸载 A 后 B 会运行时崩溃。

**推荐措施**：
- 将 `atomNamespaces` 移入 `PluginContext`，限定为**插件私有命名空间**。
- 跨插件共享的 Atom 必须通过 `getPlugin` 显式获取，禁止全局状态暴露。
- 或引入命名空间引用计数：插件卸载时仅删除其私有的 atom，若其他插件引用了同一 atom，延迟到最后一个引用者卸载时再清理。

---

### 15. 开发环境下渲染脚本缓存导致 HMR 失效

**问题位置**：`render/RenderScriptLoader.ts`  
**影响**：`loaded` Map 缓存了旧脚本，修改文件后必须刷新页面才能生效。

**推荐措施**：
- 开发模式下，不持久缓存 `loaded`（或利用 `import.meta.hot` 监听变更，清除对应 `blobUrl`）。
- 生产环境再启用强缓存策略。
- 在 `loadAll` 中加入 `?t=${Date.now()}` 的 cache-bust 已存在，但 `loaded` Map 的 key 未包含 timestamp，导致 fetch 了新内容却返回旧缓存。

---

### 16. 编辑器与工具链

#### 16.1 EditorPanel DOM 操作瓶颈
**问题**：实体列表全量重建 DOM，数量大时卡顿。  
**措施**：实体列表引入虚拟滚动（virtual scroll）；字段更新保持现有 `syncers` 增量机制。

#### 16.2 PipelinePanel 缺少 Undo/Redo
**问题**：直接修改配置对象，无历史状态管理。  
**措施**：引入不可变配置快照（`immer` 或手动深拷贝），维护 `historyStack` / `futureStack`。

---

### 17. 资产引用计数与生命周期

**问题**：当前 `loadTexture`、`loadGltf` 为即时加载，一个 texture 被多个 mesh 使用时，没有引用计数，释放时机不可控。

**推荐措施**：
- 建立 `AssetManager`，统一处理引用计数、生命周期、缓存策略。
- 支持资产 Bundle（`.slab` 格式），将 glTF、纹理、JSON 打包为二进制 blob，减少 fetch 次数。

---

## 五、长期演进方向（P3：3 个月以上）

### 1. 渲染架构：向 FrameGraph 演进

当前 `RenderGraph` 是 "Phase + Pipeline 列表"，缺少**帧资源依赖分析**与**自动屏障/同步**。

**演进目标**：
- 声明每个 pass 的 read/write 资源（texture / buffer）。
- 自动推导 render pass 合并、image layout 转换、内存别名（memory aliasing）。
- 显著降低 Deferred + SSAO + Bloom 等多 pass 场景的带宽与内存占用。

---

### 2. Shader 系统：引入组合与热重载

**演进目标**：
- **Shader Permutation**：PBR variant（`USE_NORMAL_MAP`、`USE_ALPHA_TEST`）当前需复制整份 JSON。应支持 `defines` / `keywords` 系统，由 `PipelineLoader` 自动编译 variant。
- **Hot Reload**：监听 shader 文件变化，只重新编译受影响的 pipeline，不重建整个 render graph。
- 长期：评估 WebGPU Shader Graph（节点化材质编辑器）。

---

### 3. 异步资产流（Streaming）

**问题**：当前 `loadApp` 为全量加载（`await` 所有资源），用户需等待所有纹理、网格下载完毕才能看到画面。

**演进目标**：
- 先显示默认颜色/占位网格，优先加载相机视锥内的资产，后台流式加载剩余资源。
- 对大体积 buffer 数据（PLY 点云、骨骼动画）使用 `OffscreenCanvas` / Worker 后台异步上传。

---

### 4. GPU 驱动的剔除（GPU-Driven Culling）

**问题**：当前 `PipelineDriver` 的 `query` 基于 CPU 遍历 ECS 实体，当场景实体数达到数十万时 CPU 将成为瓶颈。

**演进目标**：
- 将剔除逻辑迁移至 Compute Shader，利用 Indirect Draw 参数回传，实现 **完全 GPU 驱动的绘制**。
- **审慎建议**：在场景未达到 10k+ 实体前，CPU 遍历 + frustum culling 的成本远低于维护 compute pass 的复杂度。建议设置**实体数阈值**（如 >5000）再触发该优化。

---

### 5. 物理与动画集成

- `systemOrder` 中已有 `physics` 和 `animation`，但代码库中未见具体实现。
- Rapier3D 已通过 `api.ts` 导出，建议实现 `PhysicsSystem` 和 `AnimationSystem` 作为官方插件。
- 动画系统需考虑骨骼动画 GPU 计算路径（compute shader skinning）。

---

### 6. 调试与剖析（Profiling）

**演进目标**：
- GPU timer query：在 `PipelinePanel` 显示每个 phase 的 GPU 耗时。
- 渲染统计面板：draw call 数、tri 数、texture bind 次数、uniform buffer 上传带宽。
- 内存分析：GPU 显存占用（texture、buffer、target）实时图表。

---

## 六、实施路线图

| 阶段 | 任务 | 预估工作量 | 预期收益 |
|------|------|-----------|----------|
| **P0** | 预编译 `resolveValue` | 2-3 天 | 消除每帧字符串解析，CPU 开销降低 30-50% |
| **P0** | math.ts out-parameter 改造 | 2-3 天 | 消除 GC 压力，帧率稳定性提升 |
| **P0** | 批量 `dispatchCompute` | 1-2 天 | 减少 command buffer 碎片化 |
| **P0** | 多视图单 Encoder 提交 | 2-3 天 | 减少 submit 次数，提升 GPU 利用率 |
| **P0** | 句柄表 Free List + ResourceManager 拆分 | 3-5 天 | 消除 God Class，修复内存泄漏 |
| **P1** | 拆分 Engine 上帝类 | 2-3 天 | 提升代码可维护性与单元测试覆盖率 |
| **P1** | 插件加载两阶段回滚 | 1-2 天 | 提升健壮性，防止半初始化状态 |
| **P1** | 渲染排序 + GPU Instancing | 3-5 天 | 支撑 1k+ 实体场景 |
| **P1** | 类型安全加固（zod + 守卫） | 2-3 天 | 减少运行时 `undefined` 错误 |
| **P1** | ECS `toJSON` 优化 | 1 天 | 场景导出性能提升 |
| **P1** | 插件生产构建（移除 Sucrase） | 3-5 天 | 消除运行时转译开销，提升安全性 |
| **P2** | `atomNamespaces` 插件隔离 | 2-3 天 | 消除跨插件状态污染 |
| **P2** | RenderScript HMR 修复 | 1 天 | 开发体验提升 |
| **P2** | 编辑器虚拟滚动 + Undo | 2-3 天 | 支撑大规模实体编辑 |
| **P2** | 资产引用计数 | 3-5 天 | 支撑大规模项目资产管控 |
| **P3** | FrameGraph 架构 | 2-4 周 | 支撑复杂多 pass 管线 |
| **P3** | GPU-Driven Culling | 2-3 周 | 解放 CPU，支撑 10万+ 实体 |
| **P3** | 异步资产流 | 2-3 周 | 提升加载体验 |
| **P3** | Shader 热重载 + Permutation | 1-2 周 | 提升开发迭代速度 |

---

## 七、评价体系建议（如何持续衡量引擎健康度）

### 量化评分卡（每季度评审）

| 维度 | 指标 | 权重 | 评价方法 |
|------|------|------|----------|
| **架构** | 职责分离度 | 15% | 检查核心类是否违反 SRP；绘制模块依赖图 |
| | 数据驱动覆盖率 | 15% | 新增材质/后处理需改 TS 代码的比例 |
| | 插件隔离性 | 10% | 插件崩溃是否拖垮主引擎；有无命名空间隔离 |
| **性能** | 帧预算占用 | 10% | Chrome DevTools Performance Panel，每帧 < 8ms |
| | 每帧分配量 | 10% | Memory Timeline 观察 Float32Array/Object 分配曲线 |
| | GPU 利用率 | 5% | `chrome://gpu` 或 WebGPU Inspector |
| **工程** | 功能迭代成本 | 10% | 新增 PBR variant 所需文件数 |
| | 错误定位速度 | 5% | 故意制造 5 种常见错误，统计定位时间 |
| | 热重载支持 | 5% | shader/JSON 修改后生效时间 |
| **生态** | API 稳定性 | 5% | 季度内 `api.ts` breaking change 次数 |
| | 依赖健康度 | 5% | 核心依赖（bitecs、Rapier）的维护活跃度 |

### 自动化监控

- **CI 中加入**：类型检查、单元测试、Bundle 体积监控、循环依赖检测（`madge`）。
- **引擎中加入**：可选的 `StatsSystem`（每帧自动上报 FPS / GPU / 内存）。
- **性能回归测试**：固定场景（1000 个 cube）的帧率不能低于基线。

### 核心准则

> **"在不动用 TypeScript 编译器的情况下，一个插件开发者能在 30 分钟内新增一种自定义材质，并且性能不会比手写管线差 20% 以上。"**

如果这句话成立，引擎的架构就是成功的；如果不成立，评价体系会精确指出是卡在架构、性能、文档还是工具链上。

---

*本文档为活文档，应根据每季度评审结果持续更新。*
