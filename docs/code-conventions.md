# 非 JSON 代码规范（Code Conventions）

本文档锚定引擎中**所有非 JSON 代码声明**的规范：WGSL 着色器、游戏脚本、渲染脚本、着色器图节点 WGSL、插件 TS 模块、值原子、相位行为。JSON schema 见 [json-schemas.md](./json-schemas.md)。

> 标注约定：**必填** / 可选 / 默认 `X` / 锚点 `src/...:行号`。

---

## 总览：有什么是 JSON 定义不了的？

**7 类非 JSON 代码声明**（函数/源码，无法用 JSON 描述）：

| # | 类型 | 文件 | 引用方式 | 引擎注入 vs 用户写 |
|---|------|------|----------|---------------------|
| 1 | **WGSL 着色器** | `.wgsl` | 管线 JSON `vertex/fragment/compute.shader` | 引擎注入 **buffer 内容**（UBO/std140 写入、绑定）；**不注入代码**——用户写整个 `.wgsl` |
| 2 | **游戏脚本** | `.js`（**不是 .ts**） | scene.json `ScriptComponent.script` | 引擎注入 `ScriptContext`；用户写 `export function init/update` |
| 3 | **渲染脚本** | `.js` | render.json `renderScripts` + 管线 JSON `script:<base>.<fn>` | 引擎注入 hook 注册表 + `GeometryHookContext`/`ComputeHookContext`/`ValueContext`；用户写 hook 函数 |
| 4 | **插件 TS 模块** | `index.ts` + 相对 `.ts` | engine-config/app.json `plugins` | 引擎注入 `PluginContext` + owner-tracked 注册表 + 生命周期；用户写 EnginePlugin 子类 |
| 5 | **值原子 resolver** | 插件 TS 内 | 值源 `<ns>.<atom>` | 引擎注入 `ValueContext` + 开放 `atomNamespaces`；用户写闭包（仓库内无插件自定义，仅引擎内置） |
| 6 | **相位行为** | 插件 TS 内 | phases.json `behavior` | 引擎注入 `PhaseBehaviorContext` + `runDefault()`；用户写 `PhaseBehavior` impl（仓库内无插件自定义，仅引擎默认三行为） |

**关键原则**：引擎对 WGSL **不注入任何代码、不跑预处理器、无 `#include`/`#define` 注入**。shader/引擎契约纯靠**结构**——shader 声明的 `struct`/`var` 形状必须匹配引擎侧 `uniform-layouts.json` + `bind-layouts.json`；引擎按 std140 写 buffer 内容，shader 自取。

---

## 一、WGSL 着色器

### 1.1 文件位置约定
- **插件着色器**：`public/plugins/<id>/shaders/<Name>.wgsl`（如 `core/shaders/PbrShader.wgsl`）
- **App 私有着色器**：`public/apps/<name>/shaders/<Name>.wgsl`（如 `demo5_deferred/shaders/GBuffer.wgsl`）
- **模板**：`public/common/templates/shader.wgsl`（20 行起步模板）
- **虚拟（内存）着色器**：插件 `shaders` 字段（`PluginHost.ts:95-99` 调 `PipelineLoader.registerVirtualShader`）——**机制全 wired 但仓库内无插件用**，全用文件约定

### 1.2 引用方式
从管线 JSON 引用：
```jsonc
"vertex":   { "shader": "../shaders/PbrShader.wgsl", "entryPoint": "vs", "input": "pbr_static" },
"fragment": { "shader": "../shaders/PbrShader.wgsl", "entryPoint": "fs" }
// 计算：
"compute":  { "shader": "../shaders/ParticleSim.wgsl", "entryPoint": "main" }
```

**解析规则**（`PipelineLoader.shaderSource`）：
- `shader` 串相对**管线 JSON 文件所在目录**解析（`PipelineLoader.shaderBaseFor` 算 `ShaderBase`：`{kind:'url', dir}` 或 `{kind:'virtual', plugin, dir}`）
- 相对 ref 用 `../shaders/X.wgsl` 风格（`joinRel` 支持 `..`/`.`）
- **虚拟 ref** `<plugin>:<rest>`（如 `core:shaders/PbrShader.wgsl`）：正则 `^([A-Za-z0-9_-]+):(?!\/)(.+)$` 识别；虚拟管线→查 `virtualShaders`，未中→fetch `/plugins/<plugin>/<rest>`；文件管线→fetch `/plugins/<plugin>/<dir>/<shaderRef>`
- 绝对 URL（`/` 开头）或 `http(s)://` 原样保留
- 缓存 key = `virtual:<plugin>:<rel>` 或解析后绝对 URL；一个 `GPUShaderModule` per cache key，跨管线共享

### 1.3 Entry point 约定
- `@vertex fn <name>(...)` —— 渲染管线必需（管线 JSON `vertex.entryPoint`）
- `@fragment fn <name>(...)` —— 可选（有 `fragment` 块则必需，名匹配 `fragment.entryPoint`）
- `@compute @workgroup_size(N) fn <name>(...)` —— 计算管线必需

> **`@workgroup_size` vs 管线 JSON `workgroupSize`**：GPU 用 shader 的 `@workgroup_size(N)`；JSON 的 `workgroupSize` 存 `ComputeMeta`，供 hook CPU 端算 `dispatchWorkgroups(ceil(count/tgs))`。**二者应一致**（仓库内示例都一致）。JSON 值**不**覆盖 shader 声明——若不一致，GPU 用 shader、CPU 用 JSON → bug。

### 1.4 常用 builtins（标准 WGSL，无引擎注入）
- `@builtin(vertex_index) vi: u32` —— fullscreen triangle / 程序化顶点（Triangle/Tint/Invert/Greyscale/Skybox/Grid/PbdDraw/PbdFloor/PbdDebugLines/ShadowDebug/DeferredLight/GBuffer.vs）
- `@builtin(instance_index) inst: u32` —— instancing（Particle.wgsl/GaussianSplat.wgsl）；引擎级 GPU instancing（`renderer.instanced:true`）shader 须用 `@builtin(instance_index)` 索引 `array<mat4x4f>` storage buffer
- `@builtin(position)` —— 顶点输出
- `@builtin(frag_depth)` —— Grid.wgsl 手动写，做深度正确的网格线
- `@builtin(global_invocation_id) gid: vec3u` —— 每个计算 shader（ParticleEmit/ParticleSim/Pbd*/Counter）

### 1.5 引擎声明的 uniform/bind 结构（shader 须匹配）

shader 须声明匹配的 WGSL `struct` + `@group(N) @binding(M) var<...>`——**无自动 codegen**，契约靠 by-name + by-shape。`core` 插件声明的结构（shader 可用）：

| uniform layout | 成员（WGSL struct 形状） | 绑定于 |
|----------------|--------------------------|--------|
| `camera` | `vp, ivp, pos, view, proj`（mat4x4f×4 + vec4f） | frame @group(0) binding 0；frameShadow @group(0) binding 0 |
| `light` | `ambient, count, light0..15_{posOrDir,color,viewProj,params}` | frame @group(0) binding 1 |
| `timeInput` | `time, dt, frame, _pad, mouse` | frame @group(0) binding 2 |
| `pointShadowFaces` | `face0..95`（96× mat4x4f） | frame @group(0) binding 6 |
| `perEntity` | `model, color, params` | object @group(1) binding 0 |
| `pbrObject` | `model, normalMatrix, entityId` | object @group(1) binding 0 |
| `pbrMaterial` | `baseColor, matParams, emissive` | materialPbr @group(2) binding 0 |
| `spriteEntity` | `model, animParams` | object @group(1) binding 0（注：sprite 依赖 core，跨层引用可用） |
| `shadowPass` | `lightIdx, face` | shadowPass @group(2) binding 0 |
| `particleEmit`/`particleSim` | 见对应 .wgsl | particle 各 @group |

> 完整 uniform/bind-layout 清单见 [json-schemas.md §A3/A4](./json-schemas.md#a3-uniformlayouts--std140-uniform-块布局) 及 `core/uniform-layouts.json` + `core/bind-layouts.json`。

### 1.6 引擎注入 vs 用户写
- **引擎注入**：buffer **内容**（UBO std140 写入——camera/light/timeInput 系统；per-entity `PerEntity`/`pbrObject`/`spriteEntity` 由 PipelineDriver 从值源写；纹/sampler/storage 绑定按 renderer `bindGroups` 块）
- **用户写**：整个 `.wgsl` 文件，含所有 `struct` + `@group/@binding var` 声明。必须与 `uniform-layouts.json` 形状兼容（引擎 std140 打包由那些声明驱动；不匹配 = 数据损坏）

### 1.7 常量约定
- WGSL `const` 声明自由用（如 `const PI`/`const EPSILON`/`const SHADOW_BIAS` in PbrShader）
- **无引擎 `#define` 注入**。`SHADOW_DEBUG` toggle in PbrShader.wgsl 是硬编码源常量，用户直接改源——无 JSON hook
- WGSL 无预处理器；"常量" = `const` 声明

### 1.8 自动绑定规则
`PipelineDriver.bindGroups`：若管线 `bindLayout[0]` 是 `'frame'` 或 `'frameShadow'`，driver 在迭代 renderer `bindGroups` 前**自动** `pass.setBindGroup(0, resourceManager.frameBindGroup() | frameShadowBindGroup())`。其他 `bindLayout[0]` 值若无 renderer `bindGroups` 显式 group 0 条目 → throw。

### 1.9 示例

**最小**（`public/common/templates/shader.wgsl`）：
```wgsl
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vs(@location(0) pos: vec3f) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4f(pos, 1.0);
    out.color = vec4f(1.0, 0.4, 0.3, 1.0);
    return out;
}

@fragment
fn fs(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
```

**带完整 bind 契约**（`core/shaders/TestMesh.wgsl`，26 行，最小但引擎集成）：
```wgsl
struct PerEntity { model: mat4x4f, color: vec4f, params: vec4f };
struct Camera { vp: mat4x4f, ivp: mat4x4f, camPos: vec4f };

@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<uniform> perEntity: PerEntity;

struct VertexOutput { @builtin(position) position: vec4f };

@vertex fn vs(@location(0) pos: vec3f) -> VertexOutput {
    var out: VertexOutput;
    out.position = camera.vp * perEntity.model * vec4f(pos, 1.0);
    return out;
}

@fragment fn fs() -> @location(0) vec4f {
    return perEntity.color;
}
```

### 1.10 执行模型
- **渲染 shader**：app 装载时编译一次（`RenderGraph.compile` → `PipelineLoader.load` → `device.createShaderModule`）；按 URL 缓存。管线对象经 `device.createRenderPipeline` 建一次。每帧 `PipelineDriver.record` 开 pass、设管线 + bind group、发 draw
- **计算 shader**：`PipelineLoader.loadCompute` → `device.createComputePipeline`。每帧 compute hook（如 `pbd.simulate`）在 `beginComputePass` 内 `dispatchWorkgroups(ceil(count/tgs))`
- **热重载**：`PipelineLoader.hotReloadShader(device, shaderKey, newSrc)` 换模块（预编译验证语法）+ 返回依赖管线路径重建。dev 下编辑器 WGSL 面板用
- **寿命**：shader module 会话级缓存（`PipelineLoader.shaderModules`）；app 私有管线切 app 丢（`RenderGraph.exitApp` 丢 driver 但保 module 复用）

---

## 二、游戏脚本（ScriptComponent）

### 2.1 是什么
plain JS（或 TS 剥类型到 JS）模块，default-export 命名函数作生命周期 hook。挂在场景实体上经 `ScriptComponent` schema；运行时由 `core` 插件的 `ScriptSystem` 装载。**玩法脚本逃生舱**——不改插件即可扩展逐帧行为。

### 2.2 文件位置
- `public/apps/<name>/scripts/<name>.js` —— **始终 `.js`，不是 `.ts`**（`ScriptSystem` 不跑 sucrase）
- base dir 每 app 设：`ScriptSystem.setBaseDir(appBase)` 由 `CorePlugin.appLoaded` 调。`"scripts/spin.js"` → `<appBase>/scripts/spin.js`
- 绝对路径（`/` 开头）也接受
- fetch 加 `?t=${Date.now()}` cache-bust

### 2.3 引用方式
scene.json 实体加 `ScriptComponent`：
```json
"SpinningCube": {
  "Transform": { ... },
  "ScriptComponent": { "script": "scripts/spin.js", "enabled": 1 }
}
```
- `script` = 相对 app base 的路径
- `enabled: 1`（或 `0`）门控 `update` 是否跑；`schemaRegistry.getScalar(...'enabled')` 读

### 2.4 模块形状
```ts
interface ScriptModule {
    init?: (ctx: ScriptContext) => void;
    update?: (ctx: ScriptContext) => void;
    [key: string]: unknown;
}
```
- Blob URL import（`new Blob([src], {type:'text/javascript'})` → `import(blobUrl)`）；loader 取 `mod.default ?? mod`，所以 `export function init` 和 default-export 对象 `{ init, update }` 都行。**仓库内一致用命名导出**（`export function init(ctx) {...}`）
- 调的 hook 集由 **engine-config.json `scriptHooks: ["init","update"]` 驱动**（非硬编码）：`ScriptSystem.setHooks(...)`，`update` 迭代 `this.hooks` 调 `mod[hook]`（是函数才调）
  - `init` 特殊：每实体调一次（`initialized` set 按 `${path}#${eid}` 跟踪）。热重载时重跑
  - 其他 hook（`update` 及将来扩展的）每帧（实体 enabled 时）调

### 2.5 ScriptContext（`public/plugins/core/ScriptSystem.ts:4`）
```ts
interface ScriptContext {
    eid: number;            // 脚本挂的实体
    scene: Scene;          // 全 scene API（getField/setField/createEntity/removeEntity/entityKeyMap/...）
    time: number;          // app 启动后秒
    dt: number;            // 帧增量秒
    aspect: number;        // canvas 宽/高
    physics: unknown | null; // 结构契约——cast 到你的 physics interface；physics 插件未载时 null
    getField(compName: string, field: string): unknown;   // 快捷：ctx.scene.getField(eid, ...)
    setField(compName: string, field: string, value: unknown): void;
    on(type: string, handler: (payload: unknown) => void): () => void;  // EventBus 订阅
    emit(type: string, payload?: unknown): void;                       // EventBus 发布
}
```
- `physics` 是 lazy lookup（`() => ctx.getSystem('physics')`）——physics 插件未载则 `null`。脚本用本地结构 interface（`{ castRay(...): ... }`）
- 脚本可经 `ctx.scene`、`ctx.on/emit`、及（如 demo9 reset.js）`window.engine` 全局（编辑器发布）—— `window.engine.attachments.get('pbd').obj`

### 2.6 示例

**最小**（`public/apps/demo1/scripts/spin.js`，26 行）：
```js
let boost = 0, angle = 0, lastTime = 0;
export function init(ctx) {
    ctx.on('mousedown', () => { boost += 6.0; });
}
export function update(ctx) {
    const rot = ctx.getField('Transform', 'rotation');
    if (!rot) return;
    const dt = lastTime === 0 ? 0 : ctx.time - lastTime;
    lastTime = ctx.time;
    const speed = 1.0 + boost;
    boost *= Math.exp(-dt * 2.0);
    angle += speed * dt;
    const half = angle * 0.5;
    ctx.setField('Transform', 'rotation', [0, Math.sin(half), 0, Math.cos(half)]);
}
```

**真实（订阅碰撞事件 + 动态生成实体）** —— `demo2/scripts/game.js`（120 行）：`init` 订阅 `ctx.on('collision', ...)` + `ctx.on('mousedown', e => spawnBall(ctx, e.x, e.y))`；`update` 关 spark 窗口 + 回收球。用 `ctx.scene.createEntity(key, {...})`、`ctx.scene.removeEntity(key)`、`ctx.scene.entityKeyMap.get('SparkEmitter')`、`ctx.scene.getActiveCamera(ctx.aspect)` → `{ ivp }`

### 2.7 执行模型
- **装载**：懒——首帧见 enabled=1 的 ScriptComponent 实体，`ScriptSystem.update` 见 module 未缓存（`this.modules.get(path)` miss）→ `load(path)` fetch → Blob → dynamic import → 存 module。后续帧跑 `init` 一次再 `update` 每帧。错误 catch + log（不 throw——脚本 bug 不杀帧循环）
- **热重载**：`ScriptSystem.reloadScript(path, source)`——丢缓存 module + 从内存文本 re-import；per-entity `init` 懒重跑。编辑器 Scripts tab 用。`reloading` Set 防热重载中 `load()` 重 fetch 旧文件
- **base dir**：启动空；`CorePlugin.appLoaded` 调 `setBaseDir(appBase)`；`appUnloading` 调 `clear()` 抹 module/init 标志
- **寿命**：绑 ScriptSystem 实例（引擎级，会话寿命）；切 app 抹 module。脚本持久状态（如 `let balls = new Set()`）模块作用域——跨帧存活，切 app 丢（下 app 重新 import）
- **scope**：page realm（非沙箱）。脚本可达 `window.engine`/`window.switchApp`（demo9 reset.js 用）——这是逃生舱

### 2.8 陷阱
- **必须 `.js`**——`ScriptSystem` 不跑 sucrase；`.ts` 脚本 Blob import 会因 TS 语法被 JS 解析器拒
- `script` 字段空串 → 跳过（不 throw）
- fetch 失败 → console.error（不 throw），该实体脚本不跑
- `enabled` 用 `0`/`1`，不是 `true`/`false`

---

## 三、渲染脚本（RenderScriptLoader）

### 3.1 是什么
渲染侧的玩法脚本等价物：plain `.js` 模块经 Blob import，导出函数可被管线 JSON 作 `script:<baseName>.<export>` 引用。一个导出可作 value hook（返 number/number[]）、geometry hook（录 draw call）、compute hook（录 compute pass）——**落在哪个注册表由 JSON 引用方决定**（引擎不预分类）。

### 3.2 文件位置
- 约定：`<dataBase>/<renderScriptsSubdir>/<file>.js`，`dataBase` 默认 `/common`，`renderScriptsSubdir` 默认 `scripts`（`engine-config.json`）。app 私有则 `<appBase>/scripts/...`
- 子目录允许——首段命名空间目录**被剥**成 baseName：`render/particles.js` → `particles.simulate`（不是 `render.particles.simulate`）
- **`public/common/scripts/` 仓库内为空**——无 app 声明 `renderScripts`。机制全 wired 但未用；插件 `renderHooks` 字段是内存等价物且**被用**（particles/physics/pbd/splat/core）

### 3.3 引用方式
- **manifest 声明**（render.json，编译时装载文件）：
  ```jsonc
  { "renderScripts": ["render/particles.js", "render/splat.js"] }
  ```
  `Engine.loadApp` 读 `render.json` 的 `renderScripts`（`Engine.ts:343`：`(json as {renderScripts?: string[]}).renderScripts ?? []`）→ `renderGraph.setScriptFiles(files)` → `RenderGraph.compile` 调 `loader.loadAll`
- **消费**（管线 JSON）：
  - geometry hook：`renderer.geometry.hook: "particles.draw"`
  - compute hook：`renderer.compute.script: "particles.simulate"`
  - value hook：`bindGroups[].uniform.writes[].value: "script:foo.bar"`（`compileValue` → `ctx.scripts.get(rest)`）

### 3.4 模块形状
```js
// <dataBase>/scripts/render/particles.js → baseName "particles"
export function simulate(encoder, ctx) { ... }   // → "particles.simulate" 进全 3 hook map
export function draw(pass, ctx) { ... }           // → "particles.draw"
export const someValue = (ctx) => [1,2,3,4];      // → "particles.someValue"
```
- 非函数导出跳过（`if (typeof fn !== 'function') continue`）
- 单个函数注册进**三个** hook 命名空间（value/geometry/compute）——引擎信任 JSON 在正确上下文调它（函数签名决定什么能用）

### 3.5 hook 函数签名（`src/core/render/PipelineDriver.ts`）
```ts
type GeometryHook = (pass: GPURenderPassEncoder, ctx: GeometryHookContext) => void;
type ComputeHook  = (encoder: GPUCommandEncoder, ctx: ComputeHookContext) => void;
type ValueHook     = (ctx: ValueContext) => number | number[];

interface GeometryHookContext {
    scene: Scene; entities: readonly number[]; pipeline: GPURenderPipeline;
    time: number; dt: number; cw: number; ch: number;
    attachments: Record<string, unknown>;
    computePipelines: Map<string, GPUComputePipeline>;
}
interface ComputeHookContext {
    scene: Scene; entities: readonly number[]; time: number; dt: number;
    computePipelines: Map<string, GPUComputePipeline>;
    attachments: Record<string, unknown>;
    aux: Record<string, string | undefined>;          // 自 renderer.aux
    getComputeMeta?: (path: string) => ComputeMeta | undefined;
}
```

### 3.6 示例
**仓库内无文件型示例**（`common/scripts/` 空）。插件提供的 hook（`public/plugins/particles/hooks/particles.ts`）遵循同契约：
```ts
import type { GeometryHookContext, ComputeHookContext } from '@shaderlab/api';
import type { ParticleManager } from '../ParticleManager.ts';

export function simulate(encoder: GPUCommandEncoder, ctx: ComputeHookContext): void {
    const particles = ctx.attachments.particles as ParticleManager | undefined;
    if (!particles) return;
    const emit = ctx.aux.emit ? ctx.computePipelines.get(ctx.aux.emit) : undefined;
    const sim  = ctx.aux.simulate ? ctx.computePipelines.get(ctx.aux.simulate) : undefined;
    if (!emit || !sim) return;
    const emitTgs = ctx.getComputeMeta?.(ctx.aux.emit!)?.workgroupSize ?? 64;
    particles.simulate(encoder, ctx.scene, emit, sim, ctx.entities, ctx.dt, ctx.time, emitTgs, simTgs);
}

export function draw(pass: GPURenderPassEncoder, ctx: GeometryHookContext): void {
    const particles = ctx.attachments.particles as ParticleManager | undefined;
    if (!particles) return;
    pass.setPipeline(ctx.pipeline);
    particles.draw(pass, ctx.scene, ctx.pipeline, ctx.entities);
}
```
由插件 `renderHooks = { 'particles.simulate': simulate, 'particles.draw': draw }` 注册（非文件），但契约相同。

### 3.7 执行模型
- **装载**：app 编译时（`RenderGraph.compile` 行 257-263），若 `scriptFiles.length > 0`，`RenderScriptLoader.loadAll` fetch → Blob → dynamic import。导出分进三 map（value/geometry/compute），合并进 render graph hook 注册表（owner `'app'`）。插件同名 hook 优先（`if (!this.valueScripts.has(k))`）
- **缓存**：prod 按文件路径缓存；**dev 跳缓存**（`import.meta.env.DEV ? undefined : this.loaded.get(file)`）——脚本编辑无需刷新即生效。`?t=${Date.now()}` fetch cache-bust + 每次新 Blob import
- **热重载**：`RenderGraph.reloadRenderScript(file, source)`——`RenderScriptLoader.loadFromText`，re-register 每个导出函数为 `<baseName>.<export>` 进全 3 命名空间（owner `'app'`，覆盖旧）。编辑器 Scripts tab 用
- **执行**：hook 帧内跑。`PipelineDriver.compute` 在任何 render pass 开前跑 compute hook（`RenderGraph` compute stage 调）。`PipelineDriver.record` 在 render pass 内跑 geometry hook（bind group 设后，含自动绑的 frame @group(0)）。Value hook 在 `bindGroups` → `buildEntries` → `uniform.writes` 解析时跑
- **寿命**：app scoped。`RenderGraph.exitApp` 调 `removeHooksByOwner('app')`，切 app 丢所有 render-scripts hook。插件 hook（owner `'plugin:<id>'`）跨 app 存活，插件卸载时扫

---

## 四、着色器图（已移除）

着色器图（`shaderGraph.ts`）已删除：原 per-entity dispatch 模型与引擎批量 compute pass 机制冲突，每个 shader 节点开独立 compute pass 性能差；demo10 是纯计数器无视觉产出。替代方案见 [PLAN.md](../PLAN.md) v2（管线脚本编排器：节点图→RenderScript 单向编译）。

---

## 五、插件 TS 模块约定

完整指南见 [plugin-development.md](./plugin-development.md)。本节锚定关键契约。

### 5.1 EnginePlugin 基类（`src/core/plugins/Plugin.ts:101`）
```ts
abstract class EnginePlugin {
    abstract readonly meta: PluginMeta;   // { id; dependencies? }，id 必须等于目录名

    // 19 声明字段（全可选，见 json-schemas.md §A）
    components?/uniformLayouts?/bindLayouts?/vertexSlots?/vertexInputs?/samplers?/
    blendPresets?/fallbackTextures?/vboPresets?/meshes?/renderTargets?/phases?/
    systemDefs?/pipelines?/shaders?/renderHooks?/meshGenerators?/toolTypes?/valueAtoms?

    // 5 生命周期（全可选）
    init?(ctx): void | Promise<void>;          // 声明应用前
    setup?(ctx): void | Promise<void>;         // 声明应用后，依赖就绪
    appLoaded?(ctx, appBase): void | Promise<void>;
    appUnloading?(ctx): void;
    teardown?(ctx): void;
}
```

### 5.2 PluginContext API（`Plugin.ts:50`）
见 [plugin-development.md §三](./plugin-development.md#三plugincontext-apisrccorepluginsplugints50)。所有 `register*` 带 owner `'plugin:<id>'`；跨插件重名 throw；卸载按 owner 自动扫。

### 5.3 相对导入规则（**易错**）
| import 形式 | 处理 |
|------------|------|
| `@shaderlab/api` | 重写到 api URL（dev `/src/api.ts`，prod `/assets/engine-api.js`） |
| `./x` / `../x` | 递归装载同级文件 → Blob URL。**必须带 `.ts` 扩展名**（`import { Foo } from './Foo.ts'`） |
| `/abs` 或 `http(s)://` | 原样（须 plain JS） |
| 其他裸导入 | **throw**（除 `@shaderlab/api`） |
| 循环相对导入 | **throw**（`inFlight` Set） |

- `@shaderlab/api` 再导出 RAPIER + bitecs 查询 API（`defineQuery`/`hasComponent`/`addComponent`/`removeComponent`/`World`/`EntityId`）——唯一允许的第三方依赖
- TS 仅剥类型（sucrase `transforms:['typescript']`，`disableESTransforms:true`），不下降语法——现代 JS 语法原样跑
- `//# sourceURL=shaderlab-plugin:<url>` 注入便于 stack trace

### 5.4 最小插件
```ts
// public/plugins/myfx/index.ts
import { EnginePlugin, type PluginContext, type FrameContext } from '@shaderlab/api';

class MySystem { update(ctx: FrameContext): void { /* ... */ } }

export default class MyFxPlugin extends EnginePlugin {
    readonly meta = { id: 'myfx', dependencies: ['core'] };
    components = [{ name: 'MyComponent', fields: { speed: { type: 'f32', default: 1 } } }];
    setup(ctx: PluginContext): void { ctx.registerSystem('myfx', new MySystem()); }
}
```

---

## 六、值原子（Value Atom）/ mini-DSL

### 6.1 是什么
字符串 mini-DSL，声明 uniform 值/纹理句柄/mesh 名来自哪。用于管线 JSON 的 `renderer.bindGroups[].uniform.writes[].value`、`textures[].source`、`geometry.steps[].draw.countField`，及着色器图节点 `count`/`condition`/`iterations`/`index`。运行时 per-entity per-frame 从 `ValueContext` 解析。管线构造期预编译为闭包（热路径无字符串解析）。

### 6.2 位置
- `src/core/render/valueResolver.ts`（284 行）——resolver、atom namespace、precompiler
- atom namespace 是开放注册表：`atomNamespaces: Record<string, Record<string, AtomResolver>>`（可变，导出）。插件经 `valueAtoms` 字段或 `ctx.registerValueAtoms` 扩展

### 6.3 引用方式
```jsonc
"bindGroups": [
  { "group": 1, "uniform": { "layoutRef": "pbrObject", "writes": [
    { "member": "model",        "value": "transform.model" },
    { "member": "normalMatrix", "value": "transform.normalMatrix" },
    { "member": "entityId",     "value": "builtin.entityId" } ] } },
  { "group": 2, "uniform": { "layoutRef": "pbrMaterial", "writes": [
    { "member": "matParams", "value": "pack:PbrMaterial.metallic,PbrMaterial.roughness,PbrMaterial.ao,PbrMaterial.shadowReceive" },
    { "member": "emissive",  "value": "pack:PbrMaterial.emissive,0" } ] } }
]
```

### 6.4 语法（`resolveValue` / `compileValue`）

| 值源串 | 解析为 |
|--------|--------|
| `<number>`（如 `0.5`/`42`） | 数字字面量 |
| `const:a,b,c,0` | 数字字面量数组 `[a,b,c,0]` |
| `pack:<atom>,<atom>,...,<num>` | 扁平 `number[]`，拼接各 atom（数字直推；ArrayLike 拷贝） |
| `script:<baseName>.<fn>` | 逃生舱——调注册的 value script（`ctx.scripts.get(rest)`）；未中 throw |
| `builtin.<name>` | 引擎内置（见下） |
| `transform.<name>` | transform 内置（见下） |
| `tag.<name>` | tag 内置：`tag.color`=`scene.getTagColor(eid,tag)`，`tag.extra`=`scene.getTagExtra(eid,tag)`（tag = `renderer.tag` 组件） |
| `<Component>.<field>` | 组件字段经 `scene.getField(eid, comp, field)`；返标量或 `number[]`。**未知组件 = throw**（配置 typo）；实体无该组件 = 解析为 `0`（合法缺失） |

**引擎内置 `atomNamespaces.builtin`：**
- `builtin.entityId` → `ctx.eid`
- `builtin.time` → `ctx.time`
- `builtin.dt` → `ctx.dt`
- `builtin.aspect` → `ctx.aspect`
- `builtin.screenW` → `ctx.screenW`
- `builtin.screenH` → `ctx.screenH`

**Transform 内置 `atomNamespaces.transform`：**
- `transform.model` → `ctx.model()`（16-float `Float32Array` 引用——立即消费，勿保留）
- `transform.normalMatrix` → `normalMatrixInto(ctx.model(), _scratchNormal)`（12-float mat3x3f padded）

**Tag 内置 `atomNamespaces.tag`：**
- `tag.color` → `scene.getTagColor(eid, tag)`
- `tag.extra` → `scene.getTagExtra(eid, tag)`

### 6.5 ValueContext
```ts
interface ValueContext {
    scene: Scene; eid: number; tag: string;
    time: number; dt: number; aspect: number; screenW: number; screenH: number;
    model(): Float32Array;          // 懒算 model 矩阵（scratch——立即消费）
    scripts: Map<string, (ctx: ValueContext) => number[] | number>;
}
```

### 6.6 纹理源 / mesh 名 / 句柄源
- **纹理源**（`textures[].source`）额外前缀：`renderTarget:<name>` / `asset:<path>`（按 `engine-config.dataRoot`）/ `builtin:...`
- **mesh 名**（`vertexBuffers.mesh` / `indexBuffer.mesh`，默认 `MeshComponent.mesh`）：`compileString` 解析——`Comp.field` → `scene.getField` + `String(v ?? '')`；`builtin.*`/`transform.*`/`tag.*` 直通
- **句柄源**（纹理句柄）：`resolveHandle` = `resolveValue` 然后 `typeof v === 'number' ? v : (v[0] ?? 0)`——取数组结果首元素

### 6.7 预编译
`PipelineDriver.precompile` 调 `compileValue(w.value)` per uniform write、`compileValue(t.source)`（包 `resolveHandle`）per 非静态纹理源、`compileValue(step.draw.countField)`/`compileValue(step.draw.instanceCountField)` per draw count、`compileString(meshSrc)` per mesh 名。闭包存 `compiledWrites`/`compiledTextureHandles`/`compiledCounts`/`compiledMeshNames`。每帧热路径 `PipelineDriver.record`/`bindGroups` 调闭包，用 per-frame `ValueContext`（每 `record` 建一次，循环实体时 mutate `eid`）。**无每帧字符串解析。**

---

## 七、相位行为（Phase Behavior）

### 7.1 是什么
pass 执行策略，按名注册，决定一个渲染相位怎么跑（开哪些 pass、清什么 target、怎么合并 driver）。`phases.json` 每相位 `behavior` 名；渲染图 execute 时查注册的 `PhaseBehavior` 调 `run(ctx)`——per 相位 per 相机（或 `perCamera:false` 每帧一次）。

### 7.2 位置
- `src/core/render/phaseBehaviors.ts`（92 行）——三引擎默认行为
- `src/core/render/types.ts`——`PhaseBehavior` + `PhaseBehaviorContext` 接口
- `public/plugins/core/phases.json`——相位声明名行为
- `src/core/render/RenderGraph.ts`——`registerPhaseBehavior`/`removePhaseBehaviorsByOwner` + execute 分发

### 7.3 PhaseBehavior 接口（`types.ts`）
```ts
interface PhaseBehavior {
    /** multiView: per 相机跑一次（true，默认）或每帧一次在 per-camera 阶段前
     *  （false——如阴影图渲染）。 */
    perCamera?: boolean;   // 默认 true
    run(ctx: PhaseBehaviorContext): void;
}
```

### 7.4 PhaseBehaviorContext（窄门面）
```ts
interface PhaseBehaviorContext {
    encoder: GPUCommandEncoder;
    phase: PhaseDecl;                  // 当前相位（name/order/behavior）
    drivers: PipelineDriver[];         // 全 driver（含 disabled——shadow-clear 跑即使管线 off）
    scene: Scene;
    frame: DriverFrame;               // time/dt/cw/ch/attachments/computePipelines/cameraPos
    cw: number; ch: number;
    format: GPUTextureFormat;
    swapView: GPUTextureView;
    viewport: ViewportRect | null;
    cleared: Set<string>;             // 已清 target（共享合并 load/clear op）
    sceneIsScreen: boolean;           // true 当 'scene' target 别名 swapchain
    getSystem<T>(name: string): T | null;
    pipelineFor(d: PipelineDriver): GPURenderPipeline | undefined;
    transientTargets(): string[];     // ping-pong target 名（render-targets.json transient:true）
    runDefault(): void;               // 引擎 normal-phase 路径：按 (color,depth) target 分组 enabled driver，开合并 pass，录每 driver
}
```

### 7.5 引擎默认三行为（`phaseBehaviors.ts`）
1. **`normal`**（`normalBehavior`）：`perCamera: true`。`run = (ctx) => ctx.runDefault()`——委托引擎正常路径
2. **`shadow-clear`**（`shadowClearBehavior`）：`perCamera: false`。查 `ctx.getSystem<ShadowPassProvider>('light')`，迭 `shadowPassList`（每 (light, face) 一项），开深度 pass 每 face，清深度，可选录 shadow driver 带 per-face bind group（`resourceManager.shadowPassBindGroup(i, p.lightIdx, p.face)`）。**即使 shadow 管线 disabled 也清 face**——防陈旧深度泄漏
3. **`postprocess-chain`**（`postProcessChainBehavior`）：`perCamera: false`。首 enabled pass 读 `'scene'`，末写 `'screen'`，中间在两 transient target 间交替。`resourceManager.fullscreenBindGroup(srcView, entry)` 装源纹理 + 参数。`pass.draw(3)`（fullscreen triangle）

### 7.6 插件自定义（机制全 wired，仓库内无插件用）
```ts
// 插件 setup(ctx):
ctx.registerPhaseBehavior('my-volume-strategy', {
    perCamera: true,
    run(ctx) {
        // 开单 pass 进 3D 纹理，录每 enabled driver 带特殊 bind group
        ctx.runDefault();   // 或不——完全自定义
    },
});
// 然后声明相位：
//   phases: [{ name: 'Volumetric', order: 45, behavior: 'my-volume-strategy' }]
```

### 7.7 执行模型
- **注册**：`RenderGraph` 构造器注册三引擎默认（owner `'engine'`）。插件经 `ctx.registerPhaseBehavior` 注册（owner `'plugin:<id>'`）。跨 owner 重名 throw
- **分发**：帧 execute 时 `RenderGraph.execute` 按 `order` 迭相位（`setPhases` 排序）。每相位：查 `phaseBehaviors.get(phase.behavior)`。`perCamera:true` 行为 multiView 下 per 活跃相机跑（或主相机一次）。`perCamera:false` 行为每帧一次在 per-camera 阶段前（stage1）。`PhaseBehaviorContext` per-run 装当前 encoder、相位 driver、frame 信息、target 元数据
- **清扫**：插件卸载时 `removePhaseBehaviorsByOwner('plugin:<id>')`。引擎默认（owner `'engine'`）永不扫

---

## 八、注入对照表（"引擎注入 vs 用户写"）

| 机制 | 引擎注入 | 用户写 |
|------|----------|--------|
| WGSL shader | buffer **内容**（UBO/std140 写入、绑定）；**无代码注入** | 整个 `.wgsl`：struct、`@group/@binding var`、entry point。须与 uniform-layouts/bind-layouts 形状兼容 |
| 游戏脚本 | `ScriptContext`（eid/scene/time/aspect/physics/getField/setField/on/emit） | `.js` 模块，`export function init/update` |
| 渲染脚本 | hook 注册表 + 调用；`GeometryHookContext`/`ComputeHookContext`/`ValueContext` | `.js` 模块导出 hook 函数 |
| 插件 TS | `PluginContext` + owner-tracked 注册表 + 生命周期分发 | `index.ts` 类 extends `EnginePlugin` |
| 值原子 | `ValueContext` + 开放 `atomNamespaces` 注册表 | resolver 闭包（仓库内无插件自定义，仅引擎内置） |
| 相位行为 | `PhaseBehaviorContext` + 分发 + `runDefault()` | `PhaseBehavior` impl（仓库内无插件自定义，仅引擎默认） |

---

## 九、待验证项

- **WGSL `@workgroup_size` vs JSON `workgroupSize` 不一致**：GPU 用 shader 的属性，CPU 用 JSON 值 → 不一致则 dispatch 数算错。约定保持相等（仓库示例都一致）。见 [§1.3](#13-entry-point-约定)
- **插件内存 `shaders`/`pipelines` 字段**：机制全 wired（`PluginHost.applyDeclarations` 行 90-99）但仓库内无插件用。全用文件约定。见 [§1.2](#12-引用方式) / [json-schemas.md §A15-A16](./json-schemas.md#a15-pipelines--虚拟渲染计算管线配置)
- **`renderScripts`（render.json）**：全 wired（`RenderScriptLoader`，`RenderGraph.compile` 行 257-263）但无 app 声明。`common/scripts/` 空。插件 `renderHooks` 是内存等价且被用。`script:<base>.<export>` 命名空间共享，插件优先。见 [§三](#三渲染脚本renderscriptloader)
- **自定义值原子/相位行为/mesh generator**：注册表开放且 API 暴露 `registerValueAtoms`/`registerPhaseBehavior`/`registerMeshGenerator`，但仓库内无插件注册自定义——仅引擎默认在跑。`PRESET_MESHES` 仍在 `src/core/render/Primitives.ts`（AGENTS.md 注）
- **ScriptComponent `.ts` 支持**：`ScriptSystem` **不跑 sucrase**——玩法脚本必须 `.js`。插件 TS 经 sucrase；玩法脚本不。约定严格：所有 6 个玩法脚本是 `.js`
- **`@shaderlab/api` 再导出**：RAPIER + bitecs 查询 API（`defineQuery`/`hasComponent`/`addComponent`/`removeComponent`/`World`/`EntityId`）——插件唯一允许的第三方导入，引擎经 api.ts 控制版本
