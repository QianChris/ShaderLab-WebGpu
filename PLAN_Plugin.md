# PLAN_Plugin.md — 插件化整改（v4：内置 Renderer + 虚接口反转）

## 设计公理（用户裁定）

1. **插件易用性 > 纯数据驱动纯度**。简单场景纯 JSON 组合已有插件；复杂场景用户写 TS 插件（schema + 行为）。
2. **System.update 用 TS 写**；所有插件平等，无 `builtin:` 特权注册。
3. **插件住 `public/plugins/<id>/`**：引擎 dist 固定不动，拷目录即扩展，不重新构建引擎。
4. **Renderer 留在引擎内部**：它是"GPU 侧的执行器机制"（与 Scene/bitecs 同级），执行插件的声明，自身不含内容。整机替换通过 `IRenderer` 缝预留。
5. **引擎不依赖任何插件**：src/ 对 public/plugins/ 零 import、零类型引用。引擎→插件的一切调用都经**引擎定义的虚接口**分发（依赖反转）；插件→引擎只经 `@shaderlab/api` 一个面。

## 一、依赖方向与虚接口清单（本次整改的核心契约）

```
┌──────────── Engine (src/, 固定 dist) ────────────┐
│ 宿主: Engine / PluginManager / main / editor      │
│ 机制: Scene / SchemaRegistry / SystemRegistry     │
│       RenderGraph执行器 / PipelineDriver          │
│       PipelineLoader / ResourceManager            │
│       UniformLayout / vertexSlots / valueResolver │
│       BufferRegistry / EventBus / ToolSystem / math│
│ 契约: ↓ 下表全部 interface，引擎只调接口          │
└───────────────┬───────────────────────────────────┘
        @shaderlab/api（唯一公开面，插件唯一 import）
┌───────────────┴───────────────────────────────────┐
│ public/plugins/*：core / physics / particles /    │
│ splat / pbr / postprocess / sprite / 用户插件…    │
└───────────────┬───────────────────────────────────┘
      组合层（纯 JSON）: engine-config / app.json /
      systems.json(顺序) / scene.json / render.json
```

引擎调用插件的**全部**途径（虚接口 + 注册表，引擎不知道实现是谁）：

| 接口 | 引擎调用点 | 插件注册方式 |
| --- | --- | --- |
| `PluginBehavior`（init/setup/appLoaded/appUnloading/teardown） | PluginManager 生命周期广播 | export default class |
| `System`（update(FrameContext)） | Engine.frame() 按 systems.json 顺序分发 | ctx.registerSystem(name, impl) |
| `PhaseBehavior`（run(phase, drivers, facade)） | RenderGraph 按 phase.behavior 名查表执行 | ctx.registerPhaseBehavior(name, impl) |
| `GeometryHook` / `ComputeHook` / `ValueHook` | PipelineDriver / valueResolver 按名查表 | ctx.registerRenderHook / 声明字段 renderHooks |
| `MeshGenerator` | 网格目录构建按名查表 | ctx.registerMeshGenerator / 声明字段 |
| `ToolFactory → SceneTool` | ToolSystem 按 tools.json type 查表 | ctx.registerToolType / 声明字段 |
| `AtomResolver` | valueResolver 命名空间查表 | ctx.registerValueAtoms / 声明字段 |
| `IRenderer`（compile/execute/exitApp/数据面） | Engine 持 `renderer: IRenderer`（默认=内置 RenderGraph） | ctx.replaceRenderer(impl)（预留缝，默认不用） |
| attachments（`Record<string, unknown>`） | 引擎**不调用**，仅在 FrameContext/hook ctx 里透传 | ctx.registerAttachment(name, obj) |

**去类型化配套**（当前代码里引擎↔具体系统的类型耦合必须拆掉，否则"引擎不依赖插件"不成立）：

- `FrameContext` 删除 `physics/camera/light/animation/input/script/splats` 硬类型字段 → 换 `getSystem<T>(name)` + `attachments`。SystemRegistry.ts 不再 import 任何具体 System 类型。
- `GeometryHookContext`/`ComputeHookContext` 同理：`physics/particles/splats` 字段 → `attachments`。
- `RenderGraph.lightSystem/physics/splats/particles` 具名字段删除：shadow 走 `PhaseBehavior`（见下节），其余走 attachments。
- 跨插件协作（如 splat 读 camera 的 view 矩阵、pick 用 physics 射线）一律 `ctx.getSystem('camera')`——契约是**名字 + d.ts 类型声明**，运行时 fail-loud。

## 二、内置 Renderer 定位与数据流

一帧渲染的翻译链（全部由声明驱动，机制零内容）：

```
Component(SoA 字段)
  → PipelineDriver 按 renderer 声明块求值（value mini-DSL / hooks）
  → UBO/SSBO 写入（UniformLayout 布局）+ bind group 组装
  → RenderGraph 按 phases(插件声明) 分组开 pass → draw → GPU
```

- **core 插件的 `render` system 是薄翻译入口**：一行 `ctx.renderer.execute(frameCtx)`；顺序权在 systems.json。
- **PhaseBehavior 注册表**（Phase A 新增）：消灭 RenderGraph 里最后的内容残留——`'shadow-clear'`/`'postprocess-chain'` 闭枚举 if 分支改为按名查 `PhaseBehavior` 表。引擎内置 `normal`（按 target 合并开 pass）为默认；shadow 链、后处理链改写成同接口实现，**先由引擎自己经同一注册 API 注册**（吃自己狗粮），Phase C 随 light/postprocess 插件迁出源码。`PhaseRunFacade` 提供机制门面：encoder、openPass(colors,depth,clear,viewport)、recordDrivers、target 视图查询、frame 信息——facade 是 api 的一部分，接口要窄。
- **`IRenderer` 缝**：`{ compile, execute, exitApp, toData, fromData }`。默认实现 = 内置 RenderGraph；编辑器 PipelinePanel 依赖此数据面而非具体类。整机替换（路径追踪、纯 2D）= 一个实现该接口的插件，当前不为其付 API 成本。
- 多视口、pass 合并、bind group 缓存、资源 owner 清扫等保持引擎机制。引擎按名引用 `'camera'` 等布局属**数据契约**（core 插件声明提供，缺失 fail-loud），不构成代码依赖。

## 三、装载链（同 v3，不变）

```
PluginManager.load(id):
  fetch /plugins/<id>/index.ts → sucrase 剥类型(懒加载 chunk；.js 跳过)
  → es-module-lexer 重写 import：相对路径→递归 Blob 化(多文件)；'@shaderlab/api'→API 模块 URL
    (dev: /src/api.ts 由 Vite 即时转译；prod: /assets/engine-api.js 固定名 entry，Rollup 共享 chunk 保单例)
  → Blob import → 读 meta.dependencies → 递归 → 拓扑序: 注入声明 → setup(ctx)
unload(id): 无 active app + 无依赖者 → teardown → 注册表按 owner 清扫
```

类型保障：引擎构建产出 `plugin-api.d.ts`；`public/plugins/tsconfig.json` 映射 `@shaderlab/api`；`npm run check:plugins`（tsc --noEmit）进提交流程。运行时零类型检查，配置错误由 fail-loud 兜底。插件 TS 限"可剥离语法"。

## 四、基类与 Context（定稿）

```ts
export abstract class EnginePlugin {
    abstract readonly meta: { id: string; dependencies?: string[] };
    /* 声明字段（全可选；TS 字面量或 init 里 fetch 共置 JSON 填充） */
    components?; uniformLayouts?; bindLayouts?; vertexSlots?; vertexInputs?;
    samplers?; blendPresets?; fallbackTextures?; vboPresets?; meshes?;
    renderTargets?; phases?; systemDefs?;
    pipelines?: Record<string, PipelineConfig | ComputePipelineConfig>;  // "<id>:Name" 虚拟路径
    shaders?: Record<string, string>;
    renderHooks?; meshGenerators?; toolTypes?; valueAtoms?;
    /* 生命周期 */
    init?(ctx); setup?(ctx); appLoaded?(ctx, appBase); appUnloading?(ctx); teardown?(ctx);
}

export interface PluginContext {
    device; scene; eventBus; engineConfig; baseUrl;      // 机制使用面
    renderer: IRenderer;                                  // 默认内置 RenderGraph
    registerSystem(name, sys: System): void;              // ↓ 全部带 owner 记账
    registerPhaseBehavior(name, b: PhaseBehavior): void;
    registerRenderHook(name, fn): void;
    registerAttachment(name, obj: unknown): void;
    registerMeshGenerator(name, fn): void;
    registerToolType(name, f: ToolFactory): void;
    registerValueAtoms(ns, atoms): void;
    replaceRenderer(r: IRenderer): void;                  // 预留缝
    getSystem<T = System>(name): T | null;
    getPlugin<T extends EnginePlugin>(id): T | null;
}
```

## 五、组合层（不变）

engine-config.json `plugins:[...]`（引擎级常驻）；app.json `plugins:[...]`（app 级，切 app 逆拓扑卸载）；systems.json 仍是执行顺序唯一权威（def.source 字段废弃）；render.json 可引用 `"<plugin>:<Pipeline>"`。

## 六、改动清单

### Phase A — 装载链 + api + 接口反转基建（demo 原样可跑）

| 项 | 内容 | 规模 |
| --- | --- | --- |
| 依赖 | sucrase + es-module-lexer（懒加载） | — |
| `src/plugins/PluginManager.ts` | 装载链/拓扑/生命周期/owner 清扫 | ~300 |
| `src/api.ts` + vite 配置 | 公开面 + 独立 entry 固定名 + d.ts 产出 + check:plugins | ~150 |
| **接口反转** | FrameContext/hook ctx 去具体类型（getSystem+attachments）；RenderGraph 删 lightSystem/physics/splats 字段；`PhaseBehavior` 注册表（shadow/post 链改实现、引擎自注册）；`IRenderer` 接口 + Engine.renderer 持有 | ~+300/-120 |
| 注册表 owner 化 | Schema/UniformLayout/vertexSlots/PipelineLoader(虚拟管线源)/ResourceManager(exitOwner)/RenderGraph(addPhases/hooks)/SystemRegistry/Primitives/ToolSystem/valueResolver | ~+420 |
| `Engine.ts` | init 装引擎级插件（common 暂以合成清单走老路径）；loadApp 装 app 级 + 广播；loading 跳帧 | ±100 |
| 端到端样例 | demo8 orbit 改写为 `public/plugins/orbit/`（多文件 + d.ts 补全 + 卸载往返冒烟） | 样例 |

### Phase B — 非核心能力迁出（Engine 特判清零）

particles / splat / physics 三目录平移到 `public/plugins/`（import 改 api）；SplatLoader 随 splat 走；Engine 删 gaussianSplat 特判与无条件 RAPIER.init（RAPIER 经 api 再导出）；RenderGraph 删 `new ParticleManager()`；PickTool 迁为 physics 插件 toolType；demo6 app.json 声明 `plugins:["splat"]`。

### Phase C — 核心系统迁 core 插件 + common 退役

input/script/camera/light/animation/render(薄包装) 六系统迁 `public/plugins/core/`；shadow/postprocess 的 PhaseBehavior 实现源码随属主插件迁出；api 使用面在此被倒逼补齐并冻结；common/*.json 声明拆给各属插件（TS 字面量或共置 JSON，作者自选）；`common/` 只剩组合层文件；AGENTS.md/ARCHITECTURE.md 重写。

### Phase D — 后续

插件热重载；check:plugins 进 CI；编辑器插件面板（依赖图/归属）；npm 依赖开放（import map）；IRenderer 替换示范插件；gltf 加载器插件化候选。

## 七、风险与对策

| 风险 | 对策 |
| --- | --- |
| api/虚接口一旦发布即契约 | Phase A~C 标注 unstable，Phase C 末冻结 + d.ts 版本化 |
| PhaseRunFacade 设计过宽 → 变相暴露 ResourceManager 内脏 | 从 shadow/post 两个真实实现反推最小面；宁窄勿宽，缺了再加 |
| FrameContext 去类型化让插件间协作失去编译期检查 | d.ts 里发布各官方插件的 System 类型，getSystem<T> 显式 cast + 运行时 fail-loud |
| Blob 相对导入无 base URL | 装载器递归重写（es-module-lexer）；Phase A 首个冒烟项 |
| 卸载悬挂引用 | 不变：卸载插件前必须 unloadCurrentApp；依赖者在载 → throw |
| 运行时无类型检查 | 编辑器 + check:plugins + fail-loud 三层兜底 |

## 八、验证

- Phase A：`npm run build` + orbit 插件全链冒烟（装载/多文件/补全/卸载往返/PhaseBehavior 自注册后 8 demo 渲染不变）
- 每 Phase：8 demo 手测 + 切 app 往返资源回收；validate 脚本扩展（插件 id/依赖闭包/声明重名/虚拟管线可达/接口注册完整性）
