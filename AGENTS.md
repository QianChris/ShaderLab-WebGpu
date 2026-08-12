# AGENTS.md — ShaderLab-WebGPU

## 项目目标

**插件驱动的图形引擎**。引擎（src/）只提供**机制**（ECS 存储、渲染图执行器、GPU 资源管理、插件装载器、注册表）；一切**能力**（系统、组件 Schema、管线、着色器、相位、工具、渲染 hook）来自 `public/plugins/<id>/` 下的**运行时装载插件**；一切**组合**（选插件、排系统顺序、摆场景、挂管线）是 `public/apps/<name>/` 与 `public/common/` 下的纯 JSON。

三条硬规则：
1. **引擎不依赖任何插件**：src/ 对 public/plugins/ 零 import、零类型引用。引擎→插件调用只经虚接口（`System`/`PhaseBehavior`/hook/`ToolFactory`/`MeshGenerator`/`AtomResolver`/`IRenderer`/生命周期）+ 注册表分发；插件→引擎只 import `@shaderlab/api` 一个面（运行时被重写到 dev `/src/api.ts` / prod `/assets/engine-api.js`）。
2. **所有插件平等**：无 `builtin:` 特权。core（五个基线系统）与用户插件走同一条装载链。
3. **fail-loud**：缺文件、重名声明、未注册的 system/behavior/hook/组件一律 throw，不静默回退。

## 构建 / 运行 / 校验

| 命令 | 用途 |
| --- | --- |
| `npm run dev` / `run.bat` | Vite 开发服务器 |
| `npm run build` | `tsc`（src/ 类型检查）+ `vite build`（产出 main + 固定名 `assets/engine-api.js`） |
| `npm run check:plugins` | `tsc -p public/plugins`（插件 TS 类型检查，经 `@shaderlab/api`→src 源码映射） |
| `npm test` | `vitest run`（纯逻辑 + 机制 + 集成测试） |
| `npm run verify` | 一键全量：`build` + `check:plugins` + `test` + `validate` + `smoke` |
| `node scripts/validate-config.mjs` | 静态校验组合层（场景组件、管线引用、hook 可达、插件存在等） |
| `node scripts/smoke-plugin-loader.mjs` | Node 冒烟：对真实插件跑 转译→import 重写→装载→实例化 全链 |

**改完任何代码后至少跑 build + check:plugins + test + validate + smoke 五件套（= `npm run verify`）。** 无 Linter/格式化工具/浏览器测试自动化。

## 目录结构

```
src/                          分层：host(宿主桥) → core(引擎机制) → ui/editor(界面)
  main.ts                     编辑器入口：AppHost + EditorUILayer（无 rAF——AppHost.startLoop）
  player.ts                   运行时入口（player.html）：AppHost only，无编辑器/工具/undo
  api.ts                      @shaderlab/api 唯一公开面（基类+类型+机制单例+math+RAPIER/bitecs 再导出）
  core/                       引擎机制（对插件零知识；原 src/ 根的引擎层全迁此）
    Engine.ts                 宿主：GPU 初始化、engine-config、插件装卸编排、app 装卸、
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
              BufferRegistry / RenderScriptLoader(app 级逃生舱)
    tools/    ToolRegistry(机制)
    events/   EventBus + eventTypes
    gltf/     GltfLoader + GltfTypes
  host/                       宿主桥层：UI Layer → AppHost → Engine Core（AppHost 是唯一桥）
    AppHost.ts                 拥有 Engine + UI 层；dispatch(command) 下行 / eventBus 上行；
                               编辑器层拦截 dispatch 走 command bus（edit-mode 门控 + undo/redo），
                               无编辑器层（player）则直送 engine（不栈化）
    ProjectFS.ts               项目文件系统抽象：FileSystemAccessFS / DevServerFS / IndexedDBFS / NullFS
                               （按环境/权限切换；IndexedDBFS 为默认 refresh-safe 回退）
    UIManager.ts               app 自定义 UI 脚本装载（app.json `ui` → Blob import mount(container,host)）
  ui/                          界面层（唯一放 UI 代码处；经 host.dispatch 写，eventBus 读）
    UILayer.ts                 接口：mount(container,host)/unmount
    layers/  EditorUILayer(组合根，仅 main.ts 装) / EditorLayout(纯 DOM 框架) / EditorOrchestrator(行为)
    vue/     Vue 面板 + composables
  editor/                      原生面板 + 命令系统（被 ui/layers 消费，非自挂载）
    EditorPanel.ts / PipelinePanel.ts(undo/redo + 虚拟滚动) / EditorCommandBus.ts / dom.ts(ce 工厂)
    input/   EditorInputManager / ToolSystem / SceneTool
    commands/ Command(基类) + Scene/RenderGraph/Shader/Script Commands
  types/                       bitecs-legacy.d.ts

public/plugins/<id>/          插件（运行时装载 TS/JS，可拷贝分发，改动无需重构引擎）
  index.ts                    default export class extends EnginePlugin；meta.id=目录名
  tsconfig.json               (根目录级) paths 映射 @shaderlab/api → ../../src/api.ts
  core/                       基线：input/script/camera/light/render(薄包装) 五系统 +
                              12 个声明 JSON(components/uniform-layouts/bind-layouts/vertex-slots/
                              vertex-inputs/samplers/blend/fallback/vbo/meshes/render-targets/phases，
                              init() fetch 共置文件) + 11 条管线 + WGSL + params hook
                              （animation 系统已迁至 sprite 插件）
  physics/                    Rapier：PhysicsSystem + PickTool('pick' 工具) + debug 管线/hook；
                              RAPIER.init() 在 setup（不载即不付 WASM 成本）
  particles/                  ParticleManager('particles' attachment) + 3 管线 + hooks
  splat/                      3DGS：GaussianSplatManager(多实例 Map<eid,SplatInstance>) + SplatLoader +
                              GsComponent + gaussianSplat 系统(before:camera,用上一帧 camera 排序) +
                              splat.draw hook（app 级，demo6 声明）
  sprite/                     SpriteSheetComponent + SpriteAnimationComponent + SpriteSystem('animation'
                              系统，从 core 迁出) + SpritePipeline + WGSL；引擎级常驻
  orbit/                      示例：OrbitComponent + OrbitSystem(自动轨道,demo8) +
                              OrbitCameraComponent + OrbitCameraSystem(鼠标驱动相机,demo3/5/6/7)
  environment-lighting/       环境光照：静态图像源 + SH9 + GGX specular cubemap +
                              DFG LUT + 可见天空（demo11）

public/common/                组合层残留：engine-config.json（含 pluginsRoot + plugins 引擎级清单
                              [core,physics,particles,sprite] + systemOrder 旧式 bare-name 兜底）、
                              systems.json（默认帧顺序，`[{ "name": "..." }]` 对象数组，主用）、
                              gltf-mapping.json、textures/
public/apps/<name>/           app：app.json（plugins/components/scene/render/tools/gltf）、
                              scene.json、render.json（管线清单，'<plugin>:pipelines/X.json' 引用）、
                              tools.json、scripts/、私有 pipelines/shaders
                              （app 可选自带 systems.json 覆写默认顺序；未提供时走 common + 自动插入）
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

- 组合：engine-config.json `plugins`（引擎级常驻）或 app.json `plugins`（app 级，切 app 逆拓扑卸载）；systems.json 里列 `{ "name": "myfx" }` 决定帧顺序（**顺序权永远在 systems.json，插件只提供实现**）。app 未提供自有 systems.json 时，引擎自动把声明了 `after`/`before` 的未列出 system 插入默认顺序（见下文"自动插入"）。
- 跨插件协作：`ctx.getSystem<T>(name)` / `ctx.getPlugin(id)` / attachments —— **结构类型契约**（本地声明 interface），运行时 fail-loud。
- 插件 TS 限"可剥离语法"；运行时只剥类型不检查——类型错误靠编辑器 + `check:plugins` 抓。
- 相对导入支持多文件（Blob 递归重写）；**相对导入必须带 `.ts` 扩展名**（如 `from './Foo.ts'`，运行时 Blob fetch 需要完整路径，插件 tsconfig 用 `allowImportingTsExtensions` 放行）；禁止裸导入（除 `@shaderlab/api`）；循环相对导入 throw。
- 插件内 fetch 资产用 `ctx.baseUrl`；管线/着色器可为文件（`'<id>:pipelines/X.json'` → `/plugins/<id>/...`，shader 相对管线文件解析）或内存声明（`pipelines`/`shaders` 字段，同名 key）。

## 引擎侧关键机制（改代码前须知）

- **帧循环**（Engine.frame）：计时 → 组装 `FrameContext`（scene/time/dt/尺寸/device/eventBus/**attachments**/**getSystem**/getBuffer/writeBuffer/dispatchCompute，**无任何具体系统类型**）→ 按 systems.json 顺序 `systemRegistry.resolve(name).update(ctx)` → rAF。`appLoading` 期间跳帧。
- **PhaseBehavior**：phases.json 每相位 `behavior` 名 → RenderGraph 注册表查表执行。引擎默认 `normal`（按 target 合并 pass）/`shadow-clear`/`postprocess-chain` 三个实现（src/core/render/phaseBehaviors.ts），经与插件相同的 `registerPhaseBehavior` 注册。行为拿到窄门面 `PhaseBehaviorContext`（encoder/drivers/frame/pipelineFor/runDefault/getSystem/transientTargets…）。`perCamera:false` 的行为在 multiView 走每帧一次的 stage1。
- **attachments**：插件 `ctx.registerAttachment(name, obj)` 发布不透明 CPU 对象（'particles'/'physics'/'splats'）；FrameContext 与 hook ctx 透传，引擎不调用。
- **共享 GPU 资源**：插件用 `registerGpuResourceSet(setName, resources)` / `replaceGpuResourceSet(setName, resources)` / `unregisterGpuResourceSet(setName)` 发布必须同步切换的 buffer/sampler/texture。组名在 owner 内局部唯一；替换必须保持成员名集合不变。管线以 `renderer.bindGroups[].resources` + `resource:<name>` 声明式消费；资源名用 lowercase ASCII，`.` 分命名空间、`-` 分词。
- **owner 清扫**：一切注册（schema/uniform/slots/inputs/blends/bindLayouts/samplers/vbo/fallback/targets/phases/hooks/systems/defs/虚拟管线/attachments/GPU resources/tools/generators/atoms）带 owner 标签（'engine' | 'app:<id>' | 'plugin:<id>'）；跨 owner 重名 throw；插件卸载=按 owner sweep；**卸载插件前必须已无 active app**（app 级插件由 unloadCurrentApp 自动逆序卸载）。
- **IRenderer 缝**：Engine.renderer 默认= RenderGraph；插件可 `ctx.replaceRenderer(r)`（重注册 'render' 分派目标）。编辑器 PipelinePanel 依赖 to/fromData 数据面。
- **buffers**：system 元数据（`ubos`/`buffers`/`needs`/`after`/`before`）由插件 `systemDefs` 声明（SystemRegistry.injectedDefs），BufferRegistry 按 systems.json 清单分配（common/app scope）。
- **自动插入**：app 未提供自有 systems.json 时，`SystemRegistry.autoInsert(commonSystems)` 把声明了 `after`/`before` 但不在默认列表中的 system 自动插入。`after: ['input']` = 插到 input 之后；`before: ['render']` = 插到 render 之前。app 提供了自有 systems.json → 显式覆写优先，不自动插入。`needs` 不驱动自动插入（仅做顺序验证）。
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
4. **改系统顺序**：改 common/systems.json 或 app systems.json（纯 JSON）。新 system 声明 `after`/`before` 可自动插入默认顺序（无需 app 自带 systems.json）。
5. **给插件开新引擎能力**：api.ts 加导出（这是契约变更，慎重+文档）。
6. **机制级改动**（RenderGraph/ResourceManager/PluginManager…）：动 src/，勿引入内容/插件知识。
7. 收尾必跑五件套（见上）。

## 插件命名

1. 插件 ID 使用 ASCII lowercase kebab-case，目录名与 `meta.id` 必须一致。
2. 使用能力或领域名，不使用实现类名，不添加 `-plugin` 后缀。
3. 广泛认可的技术缩写可以使用，例如 `pbd`。
4. 集成插件使用 `<domain>-<extension>`，例如 `splat-physics`。
5. 不用 `builtin`、`internal`、`core` 等名称为新插件制造等级。
6. 插件自有 GPU 资源使用 `<id-or-domain>.<resource-name>` 命名空间。

## 渲染插件贡献协议（Agent 必读）

详细流程见 `docs/plugin-development.md` 的“渲染插件贡献检查表”。新增渲染能力时还必须遵守：

1. **默认只改插件与 demo**：先用现有 `@shaderlab/api`、声明注册表和 RenderGraph 完成闭环；若确实受机制阻塞，记录缺口和被拒绝的 workaround，经维护者确认后再做最小机制改动。
2. **真实渲染优先**：优先贡献有明确物理/成像依据的能力（材质 BRDF、阴影、GI/IBL、后处理、体积、抗锯齿、LOD/可见性等）。提交前说明模型、近似、单位、色彩空间和限制。
3. **一个 PR 一个能力**：插件自有 Schema、layout、pipeline、shader、hook；demo 只负责组合。不要把插件专属声明塞进 core/common，也不要夹带无关重构。
4. **依赖可追踪**：管线引用使用 `<plugin>:`；组件名暂以 `Component` 结尾；跨插件能力必须写入 `meta.dependencies`。
5. **demo 必须可判读**：同一画面给出基线和参数变体，固定可复现的相机、灯光、几何；不能靠说明文字替代画面。
6. **渲染正确性检查**：至少检查有限值、归一化、参数边界、能量、多光源、阴影、深度/剔除，以及切换 app 后的资源清理。性能敏感路径避免逐帧创建 GPU 对象和无界 shader 循环。
7. **验证与证据**：五件套全部通过后，用 `player.html?app=<demo>` 实测，检查控制台、画布和构图；PR 描述写清模型、视觉对照、验证命令和限制。

## 已知残留 / 陷阱

- `common/textures` 是共享资产池（`asset:` 按 dataRoot 解析）；`PRESET_MESHES` 仍在 Primitives.ts；`RenderScriptLoader` app 级逃生舱保留但 common/scripts 已空。
- ScriptComponent 游戏脚本（scene 挂 .js，Blob import）与 SystemRegistry 的 `source:"scripts/*.js"` 无构建系统仍可用，属内容层逃生舱，非推荐主路径。
- `spriteEntity` uniform layout 仍在 core/uniform-layouts.json（sprite 插件的 SpritePipeline 引用它）；理论上应随 sprite 迁出，但 sprite 依赖 core 所以跨层引用可用。
- gaussianSplat 用 `before: ['camera']` 自动插入，sort 使用上一帧 camera 数据（一帧延迟，对排序可接受）。
- PhysicsWorld 多控制器冲突检测未实现（P3 暂缓）；当前多 `PhysicsControllerComponent` 会静默用最后一个。

## 测试体系

### 分层结构

| 层级 | 目录 | 说明 |
|------|------|------|
| **纯逻辑** | `tests/unit/` | 无 GPU 依赖，Node 直跑，覆盖 math/valueResolver/uniformLayout/systemRegistry/scene |
| **机制** | `tests/mechanism/` | Mock GPU 设备，覆盖 resourceManager/pluginManager/pluginHost/renderGraph/pipelineDriver/GPU resource registry |
| **集成** | `tests/integration/` | 多模块协作，覆盖插件完整生命周期/渲染数据面往返/跨 app 资源作用域 |

### Mock 基础设施

- `tests/mocks/gpu.ts`：MockGPUDevice（createBuffer/Texture/BindGroup, createCommandEncoder）、MockRenderPassEncoder（记录所有 setPipeline/setBindGroup/draw/drawIndexed 调用供断言）、MockComputePassEncoder。
- `tests/mocks/pluginHost.ts`：MockPluginHost 记录 applyDeclarations/sweepOwner/beginOwner/endOwner 调用。
- `tests/helpers/reset.ts`：`resetRegistries()` 清扫模块单例（schemaRegistry/uniformLayouts/systemRegistry/resourceManager/GpuResourceRegistry/PipelineLoader/atomNamespaces），测试间隔离。
- `tests/helpers/fixtures.ts`：共享测试数据（RendererDecl 变体、RenderGraphData、组件定义）。
- `tests/setup.ts`：WebGPU 全局常量 polyfill（GPUBufferUsage/GPUTextureUsage/GPUShaderStage），Node 环境无 WebGPU API。

### 运行

- `npm test`：全量运行。
- `npm run test:watch`：watch 模式。
- `npm run verify`：一键全量验证（build + check:plugins + test + validate + smoke）。
- CI（`.github/workflows/ci.yml`）在 push/PR 时自动运行 verify 套件。

### 测试约定

- 模块单例（schemaRegistry/resourceManager 等）无全局 reset；测试用 `owner: 'test'` 隔离，`afterEach` 调 `resetRegistries()`。
- ResourceManager 用 `enterApp('test')` / `exitApp('test')` 隔离资源作用域。
- `vi.spyOn(pm, 'importPluginModule')` mock 插件模块加载（按 baseUrl 返回不同插件类）。
- PipelineDriver 测试用 `defineQuery` from bitecs 构建真实 query，MockRenderPassEncoder 记录绘制调用。

## 性能优化（已落地）

### 热路径

- **FrameContext 池化**：`Engine.frameCtx` 在 `init()` 一次性创建（闭包绑定 `this` + 模块单例），每帧只更新 `time`/`dt`/`aspect`/`cw`/`ch`。不再每帧 `new` 14 字段对象 + 4 闭包。
- **dispatchCompute 批量**：`FrameContext.dispatchCompute` 将 dispatch 录入帧级 compute pass（`pendingComputeEncoder`/`pendingComputePass`），由 `flushCompute()` 统一提交。渲染器在 `execute()` 开头调 `ctx.flushCompute()` 保证 compute 结果同帧可见。
- **resolveValue 预编译**：`valueResolver.compileValue(src)` 在 `PipelineDriver` 构造期将值源字符串编译为 `CompiledValue` 闭包。运行时每实体每帧只执行闭包——无 `indexOf`/`split`/`schemaRegistry.get` 字符串解析。纹理句柄、mesh 名、draw count 同样预编译。
- **math out-param**：`mat4MulInto`/`mat4InverseInto`/`mat4FromTRSInto`/`mat4PerspectiveInto`/`normalMatrixInto`/`buildCameraMatricesInto` 写入调用方提供的 `out: Float32Array`，避免 `new Float32Array(16)`。`Scene.getModelMatrix(eid, out?)` 默认用 scratch；`getActiveCameras` 用预分配 `CameraView` 池（Float32Array 字段复用）。所有 `*Into` 变体经 `api.ts` 导出。
- **多视图单 Encoder**：`executeMultiView` 将 compute + per-frame + per-camera 全部录入一个 `GPUCommandEncoder`，末尾一次 `submit`（原 1+N 次）。相机 UBO 更新用 `copyBufferToBuffer` 从 staging buffer 在 encoder 内按相机顺序复制（解决 write-after-write 冒险）。

### 资源管理

- **句柄 Free List**：`ResourceManager.bufferFreeList`/`textureFreeList` 回收销毁资源的句柄索引，分配时优先复用。句柄表大小与存活资源数成正比，不再只增不减。
- **插件加载回滚**：`PluginManager.loadOne` 在 `init`/`applyDeclarations`/`setup` 失败时调 `sweepOwner` 完全回滚已注册声明（schema/uniform/pipeline/hook/tool/atom/attachment），防止半初始化状态泄漏给依赖插件。

### 渲染排序与 Instancing

- **渲染排序（Phase 1）**：`PipelineDriver.record` 在有相机位置 + >1 实体时按距离排序。`RendererDecl.transparent: true` → 远→近（painter's）；默认（opaque）→ 近→远（early-z）。排序缓冲对象复用，不每帧分配。多视图时每相机用各自 `cameraPos`。
- **GPU Instancing（Phase 2）**：`RendererDecl.instanced: true` → `PipelineDriver.recordInstanced` 将所有匹配实体的 model 矩阵写入 storage buffer（`array<mat4x4f>`），一次 `drawIndexed(count, instanceCount)` 绘制全部实例。**着色器契约**：顶点着色器必须用 `@builtin(instance_index)` 索引 storage buffer；object bind layout 必须声明 storage buffer（非 uniform）。与 `transparent` 不兼容（instancing 忽略逐实例排序）。

### 编辑器

- **虚拟滚动**：`EditorPanel` 实体列表用虚拟滚动——仅渲染可见行 + overscan 缓冲，滚动位置跨重渲染保持。DOM 节点数与可见行数成正比，不随实体数线性增长。
- **Undo/Redo**：`PipelinePanel` 维护 JSON 快照栈（`history`/`future`），每次变更前调 `snapshot()`。`Ctrl+Z` = undo，`Ctrl+Y`/`Ctrl+Shift+Z` = redo。面板 `tabIndex=0` 可聚焦接收键盘事件。
- **RenderScript HMR**：`RenderScriptLoader.load` 在 `import.meta.env.DEV` 跳过 `loaded` Map 缓存，脚本编辑无需刷新页面即可生效。

### 架构

- **PluginHost 提取**：`src/core/PluginHost.ts` 封装插件声明应用（`applyDeclarations`）、owner 清扫（`sweepOwner`）、render-hook 注册、mesh-catalog 构建。Engine 在 `init()` 创建 `PluginHostHelper` 并委托。减少 Engine ~150 行，使插件注册生命周期可独立测试。`Engine.customRenderer`/`customRendererOwner`/`pluginLedgers` 改为 public 供 helper 访问。
