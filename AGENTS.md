# AGENTS.md — ShaderLab-WebGPU

## 项目目标

**插件驱动的图形引擎**。引擎（src/）只提供**机制**（ECS 存储、渲染图执行器、GPU 资源管理、插件装载器、注册表）；一切**能力**（系统、组件 Schema、管线、着色器、相位、工具、渲染 hook）来自 `public/plugins/<id>/` 下的**运行时装载插件**；一切**组合**（选插件、排系统顺序、摆场景、挂管线）是 `public/apps/<name>/` 与 `public/common/` 下的纯 JSON。

三条硬规则：
1. **引擎不依赖任何插件**：src/ 对 public/plugins/ 零 import、零类型引用。引擎→插件调用只经虚接口（`System`/`PhaseBehavior`/hook/`ToolFactory`/`MeshGenerator`/`AtomResolver`/`IRenderer`/生命周期）+ 注册表分发；插件→引擎只 import `@shaderlab/api` 一个面（运行时被重写到 dev `/src/api.ts` / prod `/assets/engine-api.js`）。
2. **所有插件平等**：无 `builtin:` 特权。core（六个基线系统）与用户插件走同一条装载链。
3. **fail-loud**：缺文件、重名声明、未注册的 system/behavior/hook/组件一律 throw，不静默回退。

## 构建 / 运行 / 校验

| 命令 | 用途 |
| --- | --- |
| `npm run dev` / `run.bat` | Vite 开发服务器 |
| `npm run build` | `tsc`（src/ 类型检查）+ `vite build`（产出 main + 固定名 `assets/engine-api.js`） |
| `npm run check:plugins` | `tsc -p public/plugins`（插件 TS 类型检查，经 `@shaderlab/api`→src 源码映射） |
| `node scripts/validate-config.mjs` | 静态校验组合层（场景组件、管线引用、hook 可达、插件存在等） |
| `node scripts/smoke-plugin-loader.mjs` | Node 冒烟：对真实插件跑 转译→import 重写→装载→实例化 全链 |

**改完任何代码后至少跑 build + check:plugins + validate + smoke 四件套。** 无 Linter/格式化工具/浏览器测试自动化。

## 目录结构

```
src/                          引擎 = 宿主 + 机制（对插件零知识）
  main.ts                     入口：Engine + 两个编辑器面板 + rAF
  Engine.ts                   宿主：GPU 初始化、engine-config、插件装卸编排、app 装卸、
                              帧循环（时间 + FrameContext 组装 + systems.json 顺序分发）、
                              attachments 表、插件 ctx/声明注入/owner 清扫、loadGltf
  api.ts                      @shaderlab/api 唯一公开面（基类+类型+机制单例+math+RAPIER/bitecs 再导出）
  plugins/
    Plugin.ts                 EnginePlugin 基类 + PluginContext + 声明字段类型
    PluginManager.ts          装载链：fetch → sucrase 剥类型 → es-module-lexer 重写 import
                              （相对→Blob 递归；@shaderlab/api→api URL；裸导入 throw）→
                              Blob import → meta.dependencies 拓扑 → init/applyDecls/setup；
                              卸载：teardown → 各注册表按 owner 'plugin:<id>' 清扫
  ecs/                        Scene(bitecs 封装) / SchemaRegistry / SystemRegistry / （皆 owner 化）
  render/                     RenderGraph(相位调度执行器) / PipelineDriver(声明式 draw) /
                              PipelineLoader(管线编译，含 '<plugin>:' 虚拟/文件源) /
                              ResourceManager(GPU 资源+owner) / UniformLayout(std140) /
                              vertexSlots / valueResolver(mini-DSL) / phaseBehaviors(默认三行为) /
                              BufferRegistry / RenderScriptLoader(app 级逃生舱，官方 hook 已插件化)
  tools/ ToolSystem(机制) + SceneTool 类型      events/ EventBus + EVENT_TYPES
  gltf/ GltfLoader            editor/ 面板（读注册表，纯 DOM）

public/plugins/<id>/          插件（运行时装载 TS/JS，可拷贝分发，改动无需重构引擎）
  index.ts                    default export class extends EnginePlugin；meta.id=目录名
  tsconfig.json               (根目录级) paths 映射 @shaderlab/api → ../../src/api.ts
  core/                       基线：input/script/camera/light/animation/render(薄包装) 六系统 +
                              12 个声明 JSON(components/uniform-layouts/bind-layouts/vertex-slots/
                              vertex-inputs/samplers/blend/fallback/vbo/meshes/render-targets/phases，
                              init() fetch 共置文件) + 12 条管线 + WGSL + params hook
  physics/                    Rapier：PhysicsSystem + PickTool('pick' 工具) + debug 管线/hook；
                              RAPIER.init() 在 setup（不载即不付 WASM 成本）
  particles/                  ParticleManager('particles' attachment) + 3 管线 + hooks
  splat/                      3DGS：GaussianSplatManager + SplatLoader + GsComponent +
                              gaussianSplat 系统 + splat.draw hook（app 级，demo6 声明）
  orbit/                      示例：自定义组件 + OrbitSystem（demo8 声明）

public/common/                组合层残留：engine-config.json（含 pluginsRoot + plugins 引擎级清单）、
                              systems.json（默认帧顺序，bare name 数组）、gltf-mapping.json、textures/
public/apps/<name>/           app：app.json（plugins/components/scene/render/systems/tools/gltf）、
                              scene.json、render.json（管线清单，'<plugin>:pipelines/X.json' 引用）、
                              systems.json（顺序覆盖）、tools.json、scripts/、私有 pipelines/shaders
```

## 插件写法（用户视角）

```ts
// public/plugins/myfx/index.ts —— 目录名 = meta.id，engine 零改动
import { EnginePlugin, type PluginContext, type FrameContext } from '@shaderlab/api';

class MySystem { update(ctx: FrameContext): void { /* TS，补全+check:plugins */ } }

export default class MyFxPlugin extends EnginePlugin {
    readonly meta = { id: 'myfx', dependencies: ['core'] };
    components = [{ name: 'MyComponent', fields: { speed: { type: 'f32', default: 1 } } }];
    // 可选声明字段：uniformLayouts/bindLayouts/pipelines('myfx:Name')/shaders/phases/
    // renderTargets/samplers/blendPresets/fallbackTextures/vboPresets/meshes/systemDefs/
    // renderHooks('myfx.draw')/meshGenerators/toolTypes/valueAtoms —— TS 字面量或 init() fetch 共置 JSON
    setup(ctx: PluginContext): void { ctx.registerSystem('myfx', new MySystem()); }
    // 生命周期：init(声明注入前) / setup(依赖就绪) / appLoaded(场景就绪,拿 appBase) /
    //          appUnloading / teardown（注册表按 owner 自动清扫）
}
```

- 组合：engine-config.json `plugins`（引擎级常驻）或 app.json `plugins`（app 级，切 app 逆拓扑卸载）；systems.json 里列 `{ "name": "myfx" }` 决定帧顺序（**顺序权永远在 systems.json，插件只提供实现**）。
- 跨插件协作：`ctx.getSystem<T>(name)` / `ctx.getPlugin(id)` / attachments —— **结构类型契约**（本地声明 interface），运行时 fail-loud。
- 插件 TS 限"可剥离语法"；运行时只剥类型不检查——类型错误靠编辑器 + `check:plugins` 抓。
- 相对导入支持多文件（Blob 递归重写）；禁止裸导入（除 `@shaderlab/api`）；循环相对导入 throw。
- 插件内 fetch 资产用 `ctx.baseUrl`；管线/着色器可为文件（`'<id>:pipelines/X.json'` → `/plugins/<id>/...`，shader 相对管线文件解析）或内存声明（`pipelines`/`shaders` 字段，同名 key）。

## 引擎侧关键机制（改代码前须知）

- **帧循环**（Engine.frame）：计时 → 组装 `FrameContext`（scene/time/dt/尺寸/device/eventBus/**attachments**/**getSystem**/getBuffer/writeBuffer/dispatchCompute，**无任何具体系统类型**）→ 按 systems.json 顺序 `systemRegistry.resolve(name).update(ctx)` → rAF。`appLoading` 期间跳帧。
- **PhaseBehavior**：phases.json 每相位 `behavior` 名 → RenderGraph 注册表查表执行。引擎默认 `normal`（按 target 合并 pass）/`shadow-clear`/`postprocess-chain` 三个实现（src/render/phaseBehaviors.ts），经与插件相同的 `registerPhaseBehavior` 注册。行为拿到窄门面 `PhaseBehaviorContext`（encoder/drivers/frame/pipelineFor/runDefault/getSystem/transientTargets…）。`perCamera:false` 的行为在 multiView 走每帧一次的 stage1。
- **attachments**：插件 `ctx.registerAttachment(name, obj)` 发布不透明对象（'particles'/'physics'/'splats'）；FrameContext 与 hook ctx 透传，引擎不调用。
- **owner 清扫**：一切注册（schema/uniform/slots/inputs/blends/bindLayouts/samplers/vbo/fallback/targets/phases/hooks/systems/defs/虚拟管线/attachments/tools/generators/atoms）带 owner 标签（'engine' | 'app:<id>' | 'plugin:<id>'）；跨 owner 重名 throw；插件卸载=按 owner sweep；**卸载插件前必须已无 active app**（app 级插件由 unloadCurrentApp 自动逆序卸载）。
- **IRenderer 缝**：Engine.renderer 默认= RenderGraph；插件可 `ctx.replaceRenderer(r)`（重注册 'render' 分派目标）。编辑器 PipelinePanel 依赖 to/fromData 数据面。
- **buffers**：system 元数据（`ubos`/`buffers`/`needs`）由插件 `systemDefs` 声明（SystemRegistry.injectedDefs），BufferRegistry 按 systems.json 清单分配（common/app scope）。
- **api.ts 是契约**：给插件加能力=在 api 加导出（宁窄勿宽）；**严禁 api 导入 public/plugins 下任何东西**。
- **dev/prod 单例**：dev 下 Blob 模块 import `/src/api.ts` 与主包同 URL 同实例；prod 下 `engine-api.js` 与 main 共享 Rollup chunk。改 vite.config 的 entry 配置前先理解这一点。

## TypeScript / 代码风格

- 4 空格缩进、单引号、分号、多行尾逗号；`import type` 分离类型；仅相对导入（src 内）/仅 `@shaderlab/api`+相对（插件内）。
- 类成员序：公有字段→私有字段→构造→公有→私有；两阶段初始化用 `!`；rAF 回调用箭头字段。
- 接口用 `interface`，联合/映射用 `type`；`as` 断言；避免 `any`（用 `unknown`+守卫或结构接口）。
- ECS：bitecs SoA；字符串走字符串表；vec3 展开 `_x/_y/_z`；组件默认值只在 components.json（`schemaRegistry.getFieldDefault` 读，TS 不重复硬编码）；字段 `role` 元数据供 renderer 泛型取用。
- 模块单例：`schemaRegistry`/`resourceManager`/`uniformLayouts`/`systemRegistry`/`bufferRegistry`/`pluginManager` 直接 import 使用。
- 错误处理：不可恢复 `throw new Error`；main.ts 最外层 try/catch 显示错误浮层。
- 编辑器纯原生 DOM（`ce()` 工厂），无框架。

## 添加新功能（速查）

1. **新能力（系统/组件/管线/hook）**：写一个插件目录，app.json 或 engine-config 声明 —— 引擎零改动。
2. **新渲染相位**：插件 `phases` 字段 +（如需新策略）`registerPhaseBehavior`。
3. **新 uniform/bind/slot/target/blend/sampler/fallback/vbo/mesh**：插件对应声明字段（core 的 12 个 JSON 是范例）。
4. **改系统顺序**：改 common/systems.json 或 app systems.json（纯 JSON）。
5. **给插件开新引擎能力**：api.ts 加导出（这是契约变更，慎重+文档）。
6. **机制级改动**（RenderGraph/ResourceManager/PluginManager…）：动 src/，勿引入内容/插件知识。
7. 收尾必跑四件套（见上）。

## 已知残留 / 陷阱

- `common/textures` 是共享资产池（`asset:` 按 dataRoot 解析）；`PRESET_MESHES` 仍在 Primitives.ts；`RenderScriptLoader` app 级逃生舱保留但 common/scripts 已空 —— 见 PLAN_Plugin.md 残留清单。
- ScriptComponent 游戏脚本（scene 挂 .js，Blob import）与 SystemRegistry 的 `source:"scripts/*.js"` 无构建系统仍可用，属内容层逃生舱，非推荐主路径。
- gaussianSplat 单实例限制仍在（多 GsComponent 用最后一个并 warn）。
- 深度设计文档 ARCHITECTURE.md 反映的是插件化以前的旧结构，细节以本文与 PLAN_Plugin.md 为准。
