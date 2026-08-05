# 插件开发指南（Agent 友好）

本指南面向写**能力层**的 Agent/开发者：用 TS 写一个 `public/plugins/<id>/` 目录，引擎零改动即可加新能力。组合层（选插件/摆场景）见 [app-development.md](./app-development.md)。

> 字段级 schema 全在 [json-schemas.md](./json-schemas.md)。WGSL/脚本规范见 [code-conventions.md](./code-conventions.md)。

## 一、插件是什么

一个插件 = `public/plugins/<id>/` 目录，`index.ts` default-export 一个继承 `EnginePlugin` 的类。`meta.id` **必须等于目录名**（fail-loud 校验）。运行时由 `PluginManager` 装载：fetch → sucrase 剥类型 → es-module-lexer 重写 import → Blob import → 拓扑装载（先 `meta.dependencies`）→ 生命周期。

```
public/plugins/myfx/
├── index.ts                # 必需：default export class extends EnginePlugin
├── MySystem.ts             # 可选：相对导入（必须带 .ts 扩展名）
├── MyManager.ts
├── hooks/
│   └── myfx.ts             # 可选：render hook 实现
├── components.json         # 可选：共置声明 JSON（init() fetch）
├── uniform-layouts.json
├── bind-layouts.json
├── pipelines/
│   └── MyPipe.json         # 可选：共置管线 JSON
├── shaders/
│   └── MyShader.wgsl       # 可选：共置 WGSL
└── tsconfig.json           # （根级）paths 映射 @shaderlab/api → ../../src/api.ts
```

**作用域：**
- **引擎级常驻**：写进 `public/common/engine-config.json` `plugins` 数组，会话启动时装载，整个会话存活（core/physics/particles/sprite）。
- **app 级**：写进 `public/apps/<name>/app.json` `plugins` 数组，切 app 时逆拓扑卸载（splat/orbit/pbd/splat-physics）。

## 二、EnginePlugin 基类（src/core/plugins/Plugin.ts:101）

```ts
export abstract class EnginePlugin {
    abstract readonly meta: PluginMeta;   // { id: string; dependencies?: string[] }

    // ── 声明字段（全可选；TS 字面量或 init() 从 JSON 填充）──
    components?: ComponentDef[];
    uniformLayouts?: UniformLayoutDecls;
    bindLayouts?: BindLayoutDecls;
    vertexSlots?: VertexSlotDecls;
    vertexInputs?: VertexInputDecls;
    samplers?: SamplerDecls;
    blendPresets?: Record<string, GPUBlendState>;
    fallbackTextures?: FallbackTextureDecls;
    vboPresets?: VboPresetDecls;
    meshes?: MeshCatalogEntry[];
    renderTargets?: RenderTargetDecls;
    phases?: PhaseDecl[];
    systemDefs?: SystemDef[];                                  // 系统元数据
    pipelines?: Record<string, PipelineConfig | ComputePipelineConfig>;  // 虚拟 '<id>:<name>'
    shaders?: Record<string, string>;                         // 虚拟 '<id>:<relpath>'
    renderHooks?: Record<string, GeometryHook | ComputeHook | ValueHook>;
    meshGenerators?: Record<string, MeshGenerator>;
    toolTypes?: Record<string, ToolFactory>;
    valueAtoms?: Record<string, Record<string, AtomResolver>>;

    // ── 生命周期（全可选）──
    init?(ctx: PluginContext): void | Promise<void>;          // 声明应用前：fetch/fill decls
    setup?(ctx: PluginContext): void | Promise<void>;         // 声明已应用、依赖就绪：注册 system
    appLoaded?(ctx: PluginContext, appBase: string): void | Promise<void>;
    appUnloading?(ctx: PluginContext): void;
    teardown?(ctx: PluginContext): void;                      // 插件卸载；注册表按 owner 自动清扫
}
```

每个声明字段的 schema 见 [json-schemas.md §A](./json-schemas.md#a-插件声明字段)。

## 三、PluginContext API（src/core/plugins/Plugin.ts:50）

```ts
interface PluginContext {
    device: GPUDevice;
    scene: Scene;
    eventBus: EventBus;
    engineConfig: EngineConfig;
    canvas: HTMLCanvasElement;
    baseUrl: string;          // '/plugins/<id>' — fetch 共置资产用
    renderer: IRenderer;      // 默认 RenderGraph，可被 replaceRenderer 替换

    registerSystem(name: string, sys: System): void;
    registerAttachment(name: string, obj: unknown): void;
    registerRenderHook(name: string, fn: GeometryHook | ComputeHook | ValueHook): void;
    registerPhaseBehavior(name: string, behavior: PhaseBehavior): void;
    registerMeshGenerator(name: string, fn: MeshGenerator): void;
    registerToolType(name: string, factory: ToolFactory): void;
    registerValueAtoms(ns: string, atoms: Record<string, AtomResolver>): void;
    replaceRenderer(renderer: IRenderer): void;   // 罕用缝

    getSystem<T = System>(name: string): T | null;          // 结构类型契约——本地声明 interface
    getPlugin<T extends EnginePlugin>(id: string): T | null;
}
```

- 所有 `register*` 调用带 owner 标签 `'plugin:<id>'`；跨插件重名 throw；卸载时按 owner 自动清扫。
- `ctx.registerX` 等价于对应声明字段（`renderHooks`/`meshGenerators`/`toolTypes`/`valueAtoms`）。声明字段是"静态数据"，`ctx.registerX` 是"setup 时动态注册"，效果相同。

## 四、生命周期顺序（PluginManager.loadOne）

1. fetch `index.ts`（或 `index.js`），sucrase 剥类型（`transforms: ['typescript']`, `disableESTransforms: true`，仅剥类型不下降语法），es-module-lexer 重写 import，Blob import。
2. `new mod.default()`；校验 `meta.id === folderName`（fail-loud）。
3. 递归装载 `meta.dependencies`（`stack` 做环检测）。
4. `beginOwner('plugin:<id>')` → GPU 资源 ownership scope。
5. `await instance.init?.(ctx)` —— 插件填充声明字段（典型：`fetch(${ctx.baseUrl}/components.json)` 等）。
6. `host.applyDeclarations(id, instance)` —— 把所有声明字段合并进注册表（components/uniforms/bind-layouts/pipelines/shaders/hooks/...）。
7. `await instance.setup?.(ctx)` —— 实例化 system，`ctx.registerSystem('physics', new PhysicsSystem())` 等。
8. **任意 5–7 步失败 → `sweepOwner('plugin:<id>')` 完全回滚已注册声明 + throw**（防半初始化泄漏给依赖插件）。
9. `endOwner(prevOwner)`。
10. `appLoaded` 在 app 的 scene+render graph 装载完成后**拓扑序**广播给所有插件；`appUnloading` **逆拓扑序**广播在 app 卸载前；`teardown` 仅在插件卸载时调（app 级插件：切 app 时；引擎级：除会话 teardown 外永不卸载）。

## 五、相对导入规则（**关键，易错**）

插件 TS 经 sucrase 剥类型 + es-module-lexer 重写 import 后 Blob import。规则（`PluginManager.moduleFor`）：

| import 形式 | 处理 | 示例 |
|------------|------|------|
| `@shaderlab/api` | 重写到 api 模块 URL（dev `/src/api.ts`，prod `/assets/engine-api.js`） | `import { EnginePlugin } from '@shaderlab/api'` |
| `./x` / `../x` | 递归装载同级文件 → 其 Blob URL。**必须带 `.ts` 扩展名** | `import { Foo } from './Foo.ts'` |
| `/abs` 或 `http(s)://` | 原样保留（必须是 plain JS，不能是 TS） | `import 'https://...'` |
| **其他裸导入** | **throw** | `import _ from 'lodash'` ❌ |
| **循环相对导入** | **throw**（`inFlight` Set 检测） | A↔B 相对循环 ❌ |

**tsconfig 放行 `.ts` 扩展名**：`public/plugins/tsconfig.json` 用 `allowImportingTsExtensions: true`。运行时 Blob fetch 需要完整路径，所以 `.ts` 必须显式写。

- `@shaderlab/api` 再导出 RAPIER + bitecs 查询 API（`defineQuery`/`hasComponent`/`addComponent`/`removeComponent`/`World`/`EntityId`）——这是插件唯一允许的第三方依赖，引擎控制版本。
- TS 是"可剥离语法"——运行时只剥类型不检查；类型错误靠编辑器 + `npm run check:plugins` 抓。

## 六、最小插件示例

```ts
// public/plugins/myfx/index.ts —— 目录名 = meta.id，引擎零改动
import { EnginePlugin, type PluginContext, type FrameContext } from '@shaderlab/api';

class MySystem {
    update(ctx: FrameContext): void {
        // ctx.scene / ctx.time / ctx.dt / ctx.attachments / ctx.getSystem...
    }
}

export default class MyFxPlugin extends EnginePlugin {
    readonly meta = { id: 'myfx', dependencies: ['core'] };

    // 可选声明字段：TS 字面量 或 init() fetch 共置 JSON
    components = [
        { name: 'MyComponent', fields: { speed: { type: 'f32', default: 1 } } },
    ];

    setup(ctx: PluginContext): void {
        ctx.registerSystem('myfx', new MySystem());
    }
}
```

声明为 engine 级（`engine-config.json` `plugins` 加 `'myfx'`）或 app 级（`app.json` `plugins` 加 `'myfx'`）即可。

## 七、真实插件示例

### 7.1 最短真实插件（particles，38 行）
```ts
import { EnginePlugin, type PluginContext } from '@shaderlab/api';
import { ParticleManager } from './ParticleManager.ts';
import * as particleHooks from './hooks/particles.ts';

export default class ParticlesPlugin extends EnginePlugin {
    readonly meta = { id: 'particles' };
    renderHooks = {
        'particles.simulate': particleHooks.simulate,   // ComputeHook
        'particles.draw': particleHooks.draw,           // GeometryHook
    };
    private manager: ParticleManager | null = null;

    setup(ctx: PluginContext): void {
        this.manager = new ParticleManager();
        ctx.registerAttachment('particles', this.manager);
    }
    appUnloading(): void { this.manager?.clear(); }
    teardown(): void { this.manager?.clear(); this.manager = null; }
}
```
要点：`renderHooks` 字段注册两个 hook（管线 JSON 用 `script:particles.simulate` / `geometry.hook: "particles.draw"`）；`setup` 创建 manager 并发布为 `'particles'` attachment（hook ctx 经 `ctx.attachments.particles` 拿到）；**无 system**（粒子模拟完全由 compute hook 驱动，`systemDefs` 不需要）。

### 7.2 全生命周期插件（core，104 行）
- `systemDefs` 字段：5 个系统的元数据（`input`/`script`/`camera`/`light`/`render`，含 `ubos`/`needs`）。
- `renderHooks`：`params.point` + `params.edge`（value hook，给 TestPoint/TestEdge 管线算像素尺寸）。
- `init`：fetch 12 个共置 JSON（components/uniform-layouts/bind-layouts/...）填进声明字段。
- `setup`：实例化 5 个 system，`ctx.registerSystem(name, instance)`。
- `appLoaded`：`script.setBaseDir(appBase)`。
- `appUnloading`：`script.clear()`。

## 八、如何注册各类能力

| 能力 | 声明字段 / ctx API | 被谁引用 |
|------|-------------------|----------|
| **系统** | `systemDefs`（元数据：name/source/components/ubos/buffers/needs/after/before）+ `setup` 里 `ctx.registerSystem(name, instance)` | `systems.json` `name` |
| **组件 schema** | `components` 字段（TS 字面量或 `components.json`） | `scene.json` 组件名 |
| **Uniform 布局** | `uniformLayouts` 字段（或 `.json`） | `bind-layouts.json` `resource` + 管线 `bindGroups.uniform.layoutRef` |
| **Bind layout** | `bindLayouts` 字段（或 `.json`） | 管线 `bindLayout[]` |
| **顶点槽/输入** | `vertexSlots` / `vertexInputs`（或 `.json`） | 管线 `vertex.input` + `MeshComponent` 句柄 |
| **Sampler/Fallback/VBO** | `samplers`/`fallbackTextures`/`vboPresets`（或 `.json`） | bind-layouts `resource: "sampler:..."` + 管线 `textures.fallback` + `vertexBuffers.source: "vbo"` |
| **Mesh catalog** | `meshes`（name+generator+params） | `MeshComponent.mesh` + `gltf-mapping.json` |
| **Render target** | `renderTargets`（或 `.json`） | 管线 `renderer.target.color/depth` + 后处理 `input/output` |
| **相位** | `phases`（name+order+behavior） | `render.json` `phases` 键 |
| **管线（文件）** | `public/plugins/<id>/pipelines/X.json` | `render.json` `pipeline: "<id>:pipelines/X.json"` |
| **管线（内存）** | `pipelines` 字段，key `'<id>:<name>'` | `render.json` `pipeline: "<id>:<name>"` |
| **着色器（文件）** | `public/plugins/<id>/shaders/X.wgsl` | 管线 JSON `vertex.shader: "../shaders/X.wgsl"` |
| **着色器（内存）** | `shaders` 字段，key `'<id>:<relpath>'` | 管线 JSON 虚拟 ref |
| **Render hook** | `renderHooks` 字段 或 `ctx.registerRenderHook` | 管线 `geometry.hook` / `compute.script` / `uniform.writes.value: "script:<name>"` |
| **Mesh generator** | `meshGenerators` 字段 或 `ctx.registerMeshGenerator` | `meshes` catalog `generator` |
| **Tool type** | `toolTypes` 字段 或 `ctx.registerToolType` | `tools.json` `type` |
| **Phase behavior** | `ctx.registerPhaseBehavior`（无字段，setup 里调） | `phases.json` `behavior` |
| **Value atom** | `valueAtoms` 字段 或 `ctx.registerValueAtoms` | 值源 `<ns>.<atom>` |
| **Attachment** | `ctx.registerAttachment`（setup 里调） | hook ctx `ctx.attachments.<name>` |

> **现状提示**：仓库内插件用了 `components/uniformLayouts/bindLayouts/.../systemDefs/renderHooks`（particles/physics/pbd/splat/core 都用）。`pipelines`/`shaders` 内存字段、`meshGenerators`/`toolTypes`/`valueAtoms` 声明字段**机制全 wired 但仓库内无插件用**——文件约定更主流。

## 九、跨插件协作

### 结构类型契约（推荐）
```ts
// 在 myfx 插件里，本地声明需要的 interface（不 import physics 插件）
interface PhysicsLike { castRay(x: number, y: number): RaycastHit | null; }

const physics = ctx.getSystem<PhysicsLike>('physics');
if (physics) { const hit = physics.castRay(x, y); ... }
```
运行时 fail-loud：拿不到 system → `null`（legitimate absence）；拿到但形状不对 → 调用时 throw。**不要 import 其他插件**（违反铁律 1）。

### Attachment
```ts
// physics 插件 setup:
ctx.registerAttachment('physics', physicsSystem);
// myfx 插件 hook:
const physics = ctx.attachments.physics as PhysicsLike | undefined;
```
attachment 是不透明对象，引擎不调用，透传给 FrameContext/hook ctx。

### getPlugin
```ts
const core = ctx.getPlugin<CorePlugin>('core');   // 必须在 meta.dependencies 声明
```
少用——优先结构契约。

## 十、系统元数据（systemDefs）详解

```ts
interface SystemDef {
    name: string;          // system 名（systems.json 引用）
    source: string;        // 插件系统: 'plugin:<id>'；脚本系统: '<path>.js'
    components?: string[]; // 读取的组件
    ubos?: string[];       // UBO 名（必须匹配 uniform-layouts.json）→ BufferRegistry 分配
    buffers?: SystemBufferDecl[];  // storage buffer 显式声明
    needs?: string[];      // 软顺序约束（仅警告，不驱动 autoInsert）
    requires?: string[];   // 特性需求（如 'wasm:rapier'，SystemRegistry 不强制）
    after?: string[];      // autoInsert：插到这些 system 之后（仅 app 无自带 systems.json）
    before?: string[];     // autoInsert：插到这些 system 之前
}
interface SystemBufferDecl {
    name: string;
    layout?: string;       // uniform-layouts 名 → size = layout.byteSize × count
    size?: number;         // 显式字节（× count）。与 layout 互斥
    count?: number;        // 倍数（默认 1）
    scope?: 'app' | 'common';  // 默认 'app'；'common' = 引擎寿命
    usage?: string[];      // GPUBufferUsage 标志名。storage 默认 ['storage','copy_dst']，UBO 默认 ['uniform','copy_dst']
}
```

**autoInsert 规则**：app 未提供自带 `systems.json` 时，`SystemRegistry.autoInsert(commonSystems)` 把声明了 `after`/`before` 但不在默认列表的 system 自动插入。`after: ['input']` = 紧跟 input 之后；`before: ['render']` = 紧贴 render 之前。**app 提供了自带 systems.json → 显式覆写优先，不自动插入**。

实例（orbit/splat）：
```ts
// orbit
systemDefs = [
    { name: 'orbit', source: 'plugin:orbit', components: ['Transform','OrbitComponent'], ubos: [], buffers: [{ name: 'orbitScratch', size: 64, usage: ['storage','copy_dst'] }], needs: [], after: ['animation'] },
    { name: 'orbitCamera', source: 'plugin:orbit', components: ['Transform','OrbitCameraComponent'], ubos: [], buffers: [], needs: [], after: ['input'] },
];
// splat（用上一帧 camera 排序，一帧延迟可接受）
systemDefs = [{ name: 'gaussianSplat', source: 'plugin:splat', components: ['GsComponent','Transform'], ubos: [], buffers: [], needs: [], before: ['camera'] }];
```

## 十一、陷阱与 fail-loud

- **`meta.id` 必须等于目录名**——否则装载 throw。
- **相对导入必须带 `.ts`**——`import { Foo } from './Foo'` 会 Blob fetch 失败。
- **裸导入 throw**——除 `@shaderlab/api` 外禁止；需要的工具库（如 bitecs query API）已从 `@shaderlab/api` 再导出。
- **循环相对导入 throw**——A→B→A 会报错。
- **跨插件重名 throw**——组件/uniform/pipeline/hook 名跨 owner 冲突；用 plugin id 前缀避免。
- **`init` fetch 共置文件 404 throw**——Vite SPA fallback 会返回 index.html，引擎用 `content-type` 检测抓。
- **未注册 system 在 systems.json 里 throw**——`assertSystemsResolve` 在 app 装载时校验。
- **管线引用未知 phase throw**——`render.json` `phases` 键必须存在于 `phases.json`。
- **卸载插件前必须无 active app**——app 级插件由 `unloadCurrentApp` 自动逆拓扑卸载，不要手动 unload。
- **`renderScripts`（render.json）与 `renderHooks`（插件字段）共享 `script:<name>` 命名空间**——插件注册的 hook 优先；文件名首段目录被剥掉（`render/foo.js` → `foo.bar`）。

## 十二、校验命令

- `npm run check:plugins` —— `tsc -p public/plugins`（插件 TS 类型检查，经 `@shaderlab/api`→src 源码映射）
- `node scripts/smoke-plugin-loader.mjs` —— Node 冒烟：对真实插件跑 转译→import 重写→装载→实例化 全链
- `npm run verify` —— 一键全量（build + check:plugins + test + validate + smoke）

## 十三、Agent 操作清单（写新插件时）

1. 建 `public/plugins/<id>/` 目录，`id` = `meta.id`。
2. 写 `index.ts`：`export default class extends EnginePlugin`，`readonly meta = { id: '<id>', dependencies: [...] }`。
3. 决定声明方式：
   - **TS 字面量**（简单/小声明）：直接写字段。
   - **共置 JSON**（复杂/大声明，core 风格）：`init(ctx)` 里 `fetch(${ctx.baseUrl}/X.json)` 填字段。
4. 声明字段：按需写 `components`/`uniformLayouts`/`bindLayouts`/`vertexSlots`/`vertexInputs`/`samplers`/`blendPresets`/`fallbackTextures`/`vboPresets`/`meshes`/`renderTargets`/`phases`/`systemDefs`/`renderHooks`。
5. 写 `setup(ctx)`：实例化 system/manager，`ctx.registerSystem`/`ctx.registerAttachment`。
6. 写管线/着色器：`pipelines/X.json` + `shaders/X.wgsl`（render.json 用 `<id>:pipelines/X.json` 引用）。
7. 如需 hook：`hooks/myfx.ts` 导出函数 → `renderHooks` 字段注册。
8. 相对导入**带 `.ts`**；裸导入只 `@shaderlab/api`。
9. 声明 engine 级（改 `engine-config.json` `plugins`）或 app 级（`app.json` `plugins`）。
10. 跑 `npm run check:plugins` + `node scripts/smoke-plugin-loader.mjs` + 浏览器验证。

**最简参考**：`particles/index.ts`（38 行，hook 驱动）/ `orbit/index.ts`（系统 + autoInsert）/ `core/index.ts`（全生命周期 + 12 JSON）。
