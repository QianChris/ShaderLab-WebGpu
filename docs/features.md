# 引擎能力总览（Features）

本目录文档不重复 [AGENTS.md](../AGENTS.md) 的目录速查，而是从**能力视角**回答："引擎能做什么？各插件提供什么？哪个 demo 演示了什么？"

## 一、机制层（src/）提供什么

引擎 `src/` 不含任何具体渲染/物理/玩法知识，只提供**机制**：

| 机制 | 位置 | 能力 |
|------|------|------|
| ECS | `core/ecs/` | bitecs SoA 存储 + `SchemaRegistry`（owner 化组件 schema）+ `Scene`（createEntity/getField/getActiveCameras）+ `SystemRegistry`（owner 化 system def + autoInsert） |
| 渲染图 | `core/render/RenderGraph.ts` | 相位调度执行器（`PhaseBehavior` 策略 + perCamera 分发）+ 管线/driver/hook 注册表 + multiView + compute stage |
| 声明式 draw | `core/render/PipelineDriver.ts` | `RendererDecl` 数据驱动：query 过滤实体、bindGroup 写入、几何 step、排序（透明远→近/不透明近→远）、GPU Instancing |
| 管线编译 | `core/render/PipelineLoader.ts` | 渲染/计算管线编译 + 虚拟路径（`<plugin>:...`）+ 着色器相对解析 + 热重载 |
| GPU 资源 | `core/render/ResourceManager.ts` + `GpuResourceRegistry.ts` | buffer/texture/sampler/bindLayout/renderTarget/pipelineLayout + owner 作用域 + 句柄 free list + 插件共享资源组 + frame/shadow bind group 装配 |
| Uniform 布局 | `core/render/UniformLayout.ts` | std140 打包 + 按成员名写入（`byteSize`/`get`） |
| Buffer 分配 | `core/render/BufferRegistry.ts` | 按 systems.json 清单分配 UBO/storage，common/app scope |
| 值解析器 | `core/render/valueResolver.ts` | mini-DSL（`Comp.field`/`pack:`/`builtin.*`/`transform.*`/`tag.*`/`script:`）+ 预编译闭包 |
| 顶点槽 | `core/render/vertexSlots.ts` | SoA 属性槽注册 + `SLOT_ORDER` 驱动 mesh handle 解析 |
| 相位行为 | `core/render/phaseBehaviors.ts` | 默认三行为：`normal`/`shadow-clear`/`postprocess-chain` |
| 渲染脚本 | `core/render/RenderScriptLoader.ts` | app 级 `.js` 逃生舱（hook 文件装载，dev 热重载） |
| 插件装载 | `core/plugins/PluginManager.ts` | fetch → sucrase 剥类型 → es-module-lexer 重写 import → Blob import → 拓扑装载 → 回滚 |
| 插件宿主 | `core/PluginHost.ts` | 声明应用 + owner 清扫 + render-hook + mesh-catalog（Engine 委托） |
| 工具机制 | `core/tools/ToolRegistry.ts` | `registerToolType`/`TOOL_REGISTRY`（无 DOM 依赖，player 也注册但不装载） |
| 事件 | `core/events/EventBus.ts` | 类型化广播 |
| glTF | `core/gltf/GltfLoader.ts` | 按 `gltf-mapping.json` 映射组件 + 纹理句柄解析 |
| 数学库 | `core/math.ts` | 纯函数 vec3/vec4/mat4 + `*Into` out-param 变体（避免分配） |
| 宿主桥 | `host/AppHost.ts` | dispatch（下行）/ eventBus（上行）+ 编辑器层拦截（edit 门控 + undo） |
| 项目 FS | `host/ProjectFS.ts` | FileSystemAccess/DevServer/IndexedDB/Null 四种后端按环境切换 |
| App UI | `host/UIManager.ts` | app.json `ui` → Blob import `mount(container,host)` |
| 编辑器 | `editor/` | 原生 DOM 面板 + 命令系统 + 输入/工具 + 虚拟滚动 + undo/redo |

## 二、引擎级常驻插件（engine-config.json `plugins`）

这四个插件在会话启动时装载，整个会话存活：

| 插件 | 系统 | 关键声明 | 作用 |
|------|------|----------|------|
| **core** | `input`/`script`/`camera`/`light`/`render` | 12 个声明 JSON（components/uniform-layouts/bind-layouts/vertex-slots/vertex-inputs/samplers/blend-presets/fallback-textures/vbo-presets/meshes/render-targets/phases）+ 11 条管线 + WGSL | 基线：时间输入、脚本系统、相机矩阵、光照 UBO、PBR/TestMesh/Grid/Skybox/Shadow 管线、9 个相位 |
| **physics** | `physics` | Rapier 物理 + `pick` 工具 + debug 管线 | Rapier 刚体/碰撞器、射线拾取、物理调试可视化；`RAPIER.init()` 在 setup（不载即不付 WASM 成本） |
| **particles** | （无 system，由 hook 驱动） | 3 管线（Emit/Sim/Draw）+ `particles.simulate`/`particles.draw` hook + `'particles'` attachment | GPU 粒子（emit/simulate/draw 全在 compute+geometry hook） |
| **sprite** | `animation` | SpriteSheet/Animation 组件 + SpritePipeline + WGSL | 精灵图集动画（从 core 迁出的独立插件） |

## 三、App 级可选插件

app.json `plugins` 声明，切 app 时逆拓扑卸载：

| 插件 | 系统/Attachment | 关键能力 |
|------|-----------------|----------|
| **splat** | `gaussianSplat` 系统（`before: ['camera']` 自动插入，用上一帧 camera 排序）+ `'splats'` attachment | 3D 高斯泼溅（多实例 `Map<eid,SplatInstance>` + SplatLoader + GsComponent） |
| **splat-physics** | （splat 与 physics 桥接） | 3DGS 与物理协作（demo6 用） |
| **orbit** | `orbit` 系统（`after: ['animation']`）+ `orbitCamera` 系统（`after: ['input']`） | 自动轨道（OrbitComponent）+ 鼠标驱动相机（OrbitCameraComponent，demo3/5/6/7/8/9 用） |
| **pbd** | `pbd.simulate`/`pbd.draw` hook + `'pbd'` attachment + 7 条 compute 管线 | PBD 软体（predict/solve/apply/integrate/floor/draw/debugLines 全 GPU compute） |
| **environment-lighting** | `environmentLighting` 系统 + 原子 GPU 资源组 | 静态 2:1 环境图加载、SH9 漫反射、GGX specular cubemap、DFG LUT 与可见天空 |

> **新插件写法**：见 [plugin-development.md](./plugin-development.md)。

## 四、Demo Apps（public/apps/）

11 个示例 app，按引入的概念复杂度排列：

| App | 用到的 app 级插件 | 演示要点 |
|-----|------------------|----------|
| **demo1** | — | 基线：PBR（DamagedHelmet glTF）+ TestMesh/TestEdge/TestPoint + Grid + Skybox + Postprocess 链（Tint/Invert/Greyscale）+ Particles + Physics + pick 工具 + 自定义 HUD（ui-config）+ spin.js 脚本 |
| **demo2** | — | 游戏玩法脚本：`game.js` 订阅 `mousedown`/`collision` 事件，动态生成/回收球实体；app 级 `components.json`（GameStateComponent） |
| **demo3_shadow** | orbit | 阴影：定向光 2D 阴影图 + 点光源 6 面立方阴影 + ShadowDebug 管线（可视化阴影贴图） |
| **demo4_spriteSheet** | — | 精灵图集动画：SpriteSheetComponent + SpriteAnimationComponent + director.js 脚本 + sheets/spritesheet.json |
| **demo5_deferred** | orbit | 延迟渲染：GBuffer（4 MRT）+ DeferredLight 全屏光照；app 私有 GBuffer/DeferredLight 管线+着色器 |
| **demo6_3dgsViewer** | splat, orbit, splat-physics | 3DGS 查看器：高斯泼溅 + 自有 systems.json 顺序 + GaussianSplat 管线 + game.js |
| **demo7_multiView** | orbit | 分屏：`render.json` `multiView: true`，每相机独立视口渲染 |
| **demo8_customSystem** | orbit | 自定义系统范例：app 级 system 注册（见 app scene/render） |
| **demo9_softBody** | pbd, orbit | PBD 软体：softbody_asset.json + reset.js 重置脚本 |
| **demo11_environmentLighting** | environment-lighting, orbit | IBL 诊断场景：高分辨率天空、不同金属度/粗糙度材质球、全局环境光强度与旋转 |
| **demo_paint** | — | TextureEdit compute 绘制与编辑器交互 |

## 五、能力速查表（"我要做 X，看哪个 demo/插件"）

| 目标 | 参考 |
|------|------|
| 加载 glTF 模型 | demo1/demo3/demo7 的 `app.json` `gltf` + `common/gltf-mapping.json` |
| 写 PBR 物体 | demo1 scene + `core:pipelines/PbrPipeline.json` |
| 自定义材质颜色 | scene.json 的 `TestMeshRender.color`/`PbrMaterial.baseColor` |
| 后处理链 | demo1 render.json Postprocess 相位（input/output ping-pong） |
| 阴影 | demo3 + `core:pipelines/ShadowPipeline.json` + `shadow-clear` 相位行为 |
| 延迟渲染 | demo5 + GBuffer/DeferredLight 管线 + `gbufferA-D` render targets |
| 分屏 multiView | demo7 + Camera.viewport + `render.json` `multiView: true` |
| 粒子 | demo1 Transparent 相位 + `particles:pipelines/*` + ParticleSystemComponent/EmitterComponent |
| 精灵动画 | demo4 + sprite 插件 + sheets/*.json |
| 3D 高斯泼溅 | demo6 + splat 插件 + GsComponent |
| 软体 | demo9 + pbd 插件 + PbdSoftBodyComponent |
| 自定义游戏脚本 | demo1 spin.js / demo2 game.js（ScriptComponent + `export function init/update`） |
| 自定义交互工具 | demo1 tools.json + physics `pick` 工具类型 |
| 自定义 UI HUD | demo1 ui-config.json + `ui/demoHUD.js`（`mount(container,host) => unmount`） |
| GPU compute | particles 的 simulate hook / pbd 的 7 条 compute 管线 |
| 环境光照 / IBL | demo11 + environment-lighting 插件 |
| 跨插件协作 | demo6（splat + splat-physics + orbit）/ attachments + `ctx.getSystem` |
| 自动插入系统顺序 | splat `before: ['camera']` / orbit `after: ['animation']`（app 不带 systems.json 时生效） |
| 显式覆写系统顺序 | demo6 `systems.json`（带自带 systems.json → 不自动插入） |

## 六、已知残留 / 陷阱（能力视角）

- `common/textures` 是共享资产池（`asset:` 按 `dataRoot` 解析）。
- `PRESET_MESHES` 仍在 `src/core/render/Primitives.ts`（引擎内置 mesh generator，未插件化）。
- `spriteEntity` uniform layout 仍在 `core/uniform-layouts.json`（sprite 插件 SpritePipeline 引用；sprite 依赖 core，跨层引用可用）。
- `RenderScriptLoader` app 级逃生舱保留但 `common/scripts` 已空——所有 hook 现由插件 `renderHooks` 字段提供。
- gaussianSplat 用 `before: ['camera']` 自动插入，sort 使用上一帧 camera 数据（一帧延迟，对排序可接受）。
- PhysicsWorld 多控制器冲突检测未实现（P3 暂缓）；多 `PhysicsControllerComponent` 会静默用最后一个。
- 完整陷阱清单见 [AGENTS.md "已知残留/陷阱"](../AGENTS.md)。
