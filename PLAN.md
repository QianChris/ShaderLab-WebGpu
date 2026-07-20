# PLAN.md — ShaderLab-WebGPU 引擎本体整改规划

> 版本: 1.1  
> 目标: 消除特权代码，实现彻底插件化，加固资源生命周期  
> 约束: **不修改 Editor** | **保持所有现有 demo 可运行** | **零破坏重构**  
> 参考真相源: **AGENTS.md**（已取代原 ARCHITECTURE.md，为代码现状最权威描述）。本规划已按 AGENTS.md 校准：删除已完成/已解决/基于过时前提的 Task，并标注与架构原则冲突的 Task。

---

## 执行原则（给 AI 的元指令）

1. **先读后写**: 每个任务开始前，先读取所有输入文件，理解当前实现后再生成修改方案。
2. **最小变更**: 每个任务修改的文件数控制在 3-7 个以内。如果超出，拆分为子任务。
3. **向后兼容**: 所有接口变更必须保留旧路径（deprecated alias 或兼容层），直到下一阶段明确移除。
4. **验收驱动**: 每个任务必须有可自动验证的验收标准。无法自动验证的，必须提供手动验证步骤。
5. **阶段隔离**: 同一阶段内的任务可以并行执行（无文件冲突时）。跨阶段任务必须按顺序执行。
6. **回滚就绪**: 每个任务完成后，git commit 一次，commit message 前缀为 `[PLAN]`。
7. **以代码为准**: 本规划的输入/输出文件清单若与代码现状不符，以代码为准并就地更新本规划，而非按过时清单执行。

---

## 阶段 1: 插件化清零（P0）

**目标**: 消除所有绕过 PluginManager 的能力注入方式。所有可复用能力必须通过插件通道进入引擎。

**完成标准**: 
- [ ] 全局搜索 `orbit.js` / `OrbitCameraController`，除 `public/plugins/orbit/` 外零命中
- [ ] 所有可复用渲染组件（SpriteSheet/SpriteAnimation）迁移至独立插件
- [ ] 所有 demo 的 `components.json` 仅含业务级局部组件

---

### Task 1.1: 统一 Orbit 机制 —— 删除 5 个 orbit.js 副本

**优先级**: P0  
**目标**: 将分散在 5 个 demo 中的 orbit camera 脚本统一收敛到 `orbit` 插件，消除复制粘贴。

**输入文件**:
- `public/plugins/orbit/index.ts` — OrbitComponent 定义
- `public/plugins/orbit/OrbitSystem.ts` — OrbitSystem 实现
- `public/apps/demo3_shadow/scripts/orbit.js`
- `public/apps/demo5_deferred/scripts/orbit.js`
- `public/apps/demo6_3dgsViewer/scripts/orbit.js`
- `public/apps/demo7_multiView/scripts/orbitLeft.js`
- `public/apps/demo7_multiView/scripts/orbitRight.js`
- `public/apps/demo3_shadow/scene.json`
- `public/apps/demo5_deferred/scene.json`
- `public/apps/demo6_3dgsViewer/scene.json`
- `public/apps/demo7_multiView/scene.json`

**输出文件**:
- `public/plugins/orbit/index.ts` — 扩展 OrbitComponent schema
- `public/apps/demo{3,5,6,7}/scene.json` — 替换 ScriptComponent 为 OrbitComponent
- `public/apps/demo{3,5,6,7}/scripts/orbit*.js` — **删除**

**依赖**: 无

**详细步骤**:

1. **差异分析**: 读取 5 个 orbit.js 文件，提取所有硬编码常量（radius, speed, sensitivity, damping, minDistance, maxDistance, target offset 等），建立对照表。

2. **扩展 Schema**: `public/plugins/orbit/index.ts` 当前 `OrbitComponent` 已有 `radius`/`speed`/`spin` 三个 `f32` 字段（实测）。需扩展为以下完整字段，所有从 orbit.js 提取的常量都要有对应字段；类型用 `f32`（非 `float`）、`vec3`、`bool`，遵循插件声明约定（`components` 字段，非 `static schema`，参考 core/components.json）：
   ```typescript
   components = [
     {
       name: 'OrbitComponent',
       fields: {
         // 已有（不要重复声明，扩展即可）:
         radius: { type: 'f32', default: 2.5 },
         speed:  { type: 'f32', default: 0.8 },
         spin:   { type: 'f32', default: 1.5 },
         // 需新增（从 5 个 orbit.js 副本提取的常量）:
         sensitivity: { type: 'f32', default: 1.0 },
         damping:     { type: 'f32', default: 0.9 },
         minDistance: { type: 'f32', default: 0.1 },
         maxDistance: { type: 'f32', default: 100.0 },
         target:      { type: 'vec3', default: [0, 0, 0] },
         autoRotate:  { type: 'bool', default: 0 },   // bool 默认值用 0/1（见 demo4 components.json 约定）
       },
     },
   ];
   ```
   如果 `OrbitSystem.ts` 目前未读取这些新字段，同步修改使其从 Component 读取配置而非硬编码。

3. **修改 Scene JSON**: 对每个受影响的 demo，找到其 `MainCamera` entity：
   - 删除 `ScriptComponent`（或其中引用 orbit.js 的部分）
   - 添加 `OrbitComponent`，字段值填入主 orbit.js 中提取的常量
   - demo7 有两个相机（LeftCamera/RightCamera），分别配置不同的 OrbitComponent 参数

4. **声明插件依赖**: 确保 demo3/5/6/7 的 `app.json` 中 `plugins` 数组包含 `"orbit"`。如果 orbit 已作为引擎级插件（在 `engine-config.json` 中），则无需修改。

5. **清理**: 删除 5 个 orbit.js 文件。

**验收标准**:
- [ ] `grep -r "orbit.js" public/apps/` 零命中（排除 plugins/orbit 目录）
- [ ] `grep -r "OrbitCameraController" public/apps/` 零命中
- [ ] demo3/5/6/7 在浏览器中加载后，相机轨道行为与整改前一致（视角、速度、阻尼）
- [ ] demo7 双视口各自独立响应 orbit 控制

**风险与回滚**:
- 风险: OrbitSystem 可能目前依赖某些全局状态或特定初始化顺序，与脚本版行为不一致。
- 回滚: 从 git history 恢复 orbit.js 文件，恢复 scene.json 的 ScriptComponent。

---

### Task 1.2: Sprite 能力从 core 剥离为独立 `sprite` 插件

**优先级**: P0  
**目标**: 消除 core 插件对 app 级声明组件的隐式依赖。当前 core 的 `AnimationSystem`、`SpritePipeline.json`、`systemDefs` 全部引用 `SpriteSheetComponent`/`SpriteAnimationComponent`，但这两个组件的 schema 声明只在 `demo4_spriteSheet/components.json`。任何不带 demo4 组件清单的 app 加载 core，都会让 AnimationSystem 查询不存在的 schema —— 这是跨层耦合 bug，不是"待优化"。

**输入文件**:
- `public/plugins/core/index.ts` — systemDefs 第 28 行声明 animation 系统期望 `['SpriteSheetComponent', 'SpriteAnimationComponent']`
- `public/plugins/core/AnimationSystem.ts` — 整文件读写这两个组件（line 65-152）
- `public/plugins/core/components.json` — 不含这两个组件声明（确认）
- `public/plugins/core/pipelines/SpritePipeline.json` — query 引用这两个组件
- `public/plugins/core/shaders/Sprite.wgsl`
- `public/apps/demo4_spriteSheet/components.json` — 当前唯一声明点
- `public/apps/demo4_spriteSheet/app.json`
- `public/apps/demo4_spriteSheet/scene.json`

**输出文件**:
- `public/plugins/sprite/index.ts` — 新建。声明 `SpriteSheetComponent` + `SpriteAnimationComponent`（从 demo4 components.json 迁移），注册 SpriteSystem（从 core AnimationSystem 迁移），声明 `pipelines('sprite:SpritePipeline')` + `shaders` + `systemDefs`
- `public/plugins/sprite/pipelines/SpritePipeline.json` — 从 core 迁移
- `public/plugins/sprite/shaders/Sprite.wgsl` — 从 core 迁移
- `public/plugins/core/AnimationSystem.ts` — **删除**
- `public/plugins/core/pipelines/SpritePipeline.json` — **删除**
- `public/plugins/core/shaders/Sprite.wgsl` — **删除**
- `public/plugins/core/index.ts` — 从 systemDefs 移除 `animation` 条目；从 setup 移除 AnimationSystem 实例化；移除 `SpritePipeline` 引用（如有）
- `public/plugins/core/components.json` — 无需改（本就不含 SpriteSheet）
- `public/apps/demo4_spriteSheet/components.json` — **删除**（组件声明移入 sprite 插件）
- `public/apps/demo4_spriteSheet/app.json` — 添加 `"sprite"` 到 plugins

**依赖**: 无

**详细步骤**:

1. **新建插件目录**: `public/plugins/sprite/`，含 `tsconfig.json`（参考 `public/plugins/tsconfig.json` 的 `@shaderlab/api` paths 映射）

2. **组件声明**: 在 `public/plugins/sprite/index.ts` 的 `components` 字段声明（TS 字面量或 init() fetch 共置 JSON，参考 core 的 12 JSON 模式）：
   ```typescript
   components = [
     { name: 'SpriteSheetComponent', fields: {
         sheet:     { type: 'string', default: '' },
         texHandle: { type: 'u32', default: 0 },
         columns:   { type: 'u32', default: 8 },
         rows:      { type: 'u32', default: 9 } } },
     { name: 'SpriteAnimationComponent', fields: {
         animation: { type: 'u32', default: 0 },
         row:       { type: 'u32', default: 0 },
         frame:     { type: 'u32', default: 0 },
         elapsed:   { type: 'f32', default: 0.0 },
         playing:   { type: 'bool', default: 1 },
         direction: { type: 'i32', default: 1 } } },
   ];
   ```
   字段类型以 `demo4_spriteSheet/components.json` 现状为准（不要沿用本规划 v1.0 里的 `texture`/`frameRate` 旧 schema，那不匹配代码）。

3. **系统迁移**: 把 `core/AnimationSystem.ts` 整文件移到 `sprite/SpriteSystem.ts`，类名可保留 `AnimationSystem` 或改为 `SpriteSystem`。逻辑不变（读写 schemaRegistry + scene field）。注意相对导入带 `.ts` 扩展名（插件约定，见 AGENTS.md）。

4. **管线/着色器迁移**: 把 `core/pipelines/SpritePipeline.json` 移到 `sprite/pipelines/SpritePipeline.json`，`core/shaders/Sprite.wgsl` 移到 `sprite/shaders/Sprite.wgsl`。pipeline JSON 内部如有 shader 相对路径，相对新位置解析。

5. **systemDefs 声明**: 在 sprite 插件 `index.ts` 声明：
   ```typescript
   systemDefs = [
     { name: 'animation', source: 'plugin:sprite', components: ['SpriteSheetComponent','SpriteAnimationComponent'],
       ubos: [], buffers: [], needs: [] },
   ];
   ```
   系统名仍是 `'animation'`（systems.json 顺序不变，demo 不需改 systems.json）。

6. **core 清理**: 从 `core/index.ts` 的 `systemDefs` 删除 `animation` 条目；`setup()` 中删除 `this.animation = new AnimationSystem()` 及相关行；删除 `import { AnimationSystem }`。删除 `core/AnimationSystem.ts`、`core/pipelines/SpritePipeline.json`、`core/shaders/Sprite.wgsl`。

7. **app 配置**: `demo4_spriteSheet/app.json` 的 `plugins` 数组添加 `"sprite"`。删除 `demo4_spriteSheet/components.json`（声明已移入插件）。`scene.json` 中组件实例数据不变（schema 名未变）。

8. **回归检查**: 确认其他 demo（demo1/3/5/6/7/8）的 render.json 不引用 `core:SpritePipeline`（应为 demo4 专属）。若有引用需改引为 `sprite:SpritePipeline`。

**验收标准**:
- [ ] `grep -r "SpriteSheetComponent" public/plugins/core/` 零命中（core 不再持有 sprite 任何痕迹）
- [ ] `grep -r "AnimationSystem" public/plugins/core/` 零命中
- [ ] `public/apps/demo4_spriteSheet/components.json` 不存在或为空
- [ ] demo4_spriteSheet 浏览器加载后精灵动画行为与整改前一致
- [ ] demo1/3/5/6/7/8 加载后渲染无回归（它们本就不用 sprite，core 卸掉 sprite 后应无副作用——此条同时验证 core 不再隐式依赖 sprite 组件）
- [ ] `npm run check:plugins` 通过

**风险与回滚**:
- 风险: Sprite 管线可能依赖 demo4 特有的 render target 或 blending 配置。需检查 `SpritePipeline.json` 是否引用 app 级声明的 target/sampler。
- 风险: 若有其他 demo 的 render.json 误引 `core:SpritePipeline`，迁移后会断链。第 8 步已覆盖检查。
- 回滚: 恢复 core 下三个文件 + systemDefs 条目 + setup 实例化；恢复 demo4 components.json 与 app.json。

---

### Task 1.3: GameStateComponent 降级为局部组件

**优先级**: P0  
**目标**: 明确 `GameStateComponent` 是 demo2 的私有业务逻辑，不插件化，但需确保其不污染全局组件注册。

**输入文件**:
- `public/apps/demo2/components.json`
- `public/apps/demo2/scene.json`
- `public/apps/demo2/scripts/game.js`

**输出文件**:
- `public/apps/demo2/components.json` — 保留 GameStateComponent，但添加注释标记
- `public/apps/demo2/scripts/game.js` — 可选：将状态管理移入脚本本地状态

**依赖**: 无

**详细步骤**:

1. **保留局部声明**: `GameStateComponent` 保留在 demo2 的 `components.json` 中。这是正确的——它是业务级组件。

2. **添加显式标记**: 在 `components.json` 顶部添加注释（或 metadata）：
   ```json
   {
     "_comment": "LOCAL COMPONENTS: 以下组件仅本 demo 使用，不具备复用性",
     "components": [
       { "name": "GameStateComponent", ... }
     ]
   }
   ```

3. **可选优化**: 如果 `game.js` 中大量读写 `GameStateComponent`，考虑将部分状态（如 `ballSpeed`, `ballRadius`）改为 ScriptComponent 的局部变量，减少 ECS 查询开销。但**不做强制要求**。

**验收标准**:
- [ ] demo2 正常运行，游戏逻辑（球生成、碰撞火花）无回归
- [ ] `GameStateComponent` 不出现在任何插件目录中

**风险与回滚**:
- 风险: 无。此任务主要是文档和标记工作。

---

## 阶段 2: 资源生命周期加固（P1）

**目标**: 消除单例隐患和实例限制，让引擎经得起快速切换 demo 的压力测试。

**完成标准**:
- [ ] 连续切换 8 个 demo 各 10 轮（共 80 次）不崩溃、不泄漏
- [ ] GaussianSplatManager 支持多实例

---

### Task 2.1: GaussianSplatManager 多实例支持

**优先级**: P1  
**目标**: 移除 "单 GsComponent 限制"，支持同一 Scene 中多个 3DGS 实体。

**输入文件**:
- `public/plugins/splat/index.ts` — GsComponent 定义
- `public/plugins/splat/GaussianSplatManager.ts` — 当前单实例实现
- `public/plugins/splat/GaussianSplatSystem.ts` — 如存在
- `public/apps/demo6_3dgsViewer/scene.json`

**输出文件**:
- `public/plugins/splat/GaussianSplatManager.ts` — 重构为多实例
- `public/plugins/splat/index.ts` — 如有需要，调整组件声明

**依赖**: 无

**详细步骤**:

1. **读取当前实现**: 理解 GaussianSplatManager 如何存储 splat 数据（是否只有一个 `this.splat` 字段？）。

2. **重构核心数据结构**: 将单实例字段改为 Map：
   ```typescript
   class GaussianSplatManager {
     private splatData: Map<number, GaussianSplatRenderData> = new Map();
     private sortPipeline: GPUComputePipeline; // 全局共享排序管线

     onComponentAdded(entity: number, comp: GsComponent) {
       const data = this.createRenderData(comp);
       this.splatData.set(entity, data);
     }

     onComponentRemoved(entity: number) {
       const data = this.splatData.get(entity);
       if (data) {
         this.releaseRenderData(data);
         this.splatData.delete(entity);
       }
     }

     update(ctx: FrameContext) {
       // 收集所有可见的 splat
       const visibleSplats: GaussianSplatRenderData[] = [];
       for (const [entity, data] of this.splatData) {
         if (this.isVisible(entity, ctx.camera)) {
           visibleSplats.push(data);
         }
       }

       // 如果需要全局排序（3DGS 性能关键），合并所有可见 splat 的索引到一个大 buffer
       if (visibleSplats.length > 0) {
         this.sortAndRender(visibleSplats, ctx);
       }
     }
   }
   ```

3. **生命周期绑定**: 确保 `GaussianSplatSystem`（或对应 System）在 `update` 中调用 Manager，并在 entity 被删除时触发 `onComponentRemoved`。
   - 如果当前通过 `scene.onEntityRemoved` 事件无法可靠通知，考虑在 System 的 `update` 中做差分检测（对比上一帧和当前帧的 GsComponent 集合）。

4. **资源释放**: 每个 `GaussianSplatRenderData` 必须持有自己的 GPU Buffer/Texture 引用。在 `releaseRenderData` 中调用 `resourceManager.release(...)`。

5. **测试数据**: 修改 demo6 的 `scene.json`，复制一份 `GsEntity`（重命名为 `GsEntity2`），加载不同的 PLY 文件（或同一文件），验证两者都能渲染。

**验收标准**:
- [ ] demo6 的 scene.json 中包含两个 `GsEntity`（不同 key），浏览器中两者均正确渲染
- [ ] Console 无 "multiple GsComponent, using last" 类警告
- [ ] 删除其中一个 GsEntity 后，另一个仍然正常渲染，GPU 资源无泄漏

**风险与回滚**:
- 风险: 3DGS 的全局排序是性能核心。多实例合并排序可能引入复杂度或性能回归。
- 回滚: 恢复单实例实现，保留多实例分支在 git 中。

---

### Task 2.2: App 切换压力测试脚本

**优先级**: P1  
**目标**: 验证 15 个模块级单例在快速切换下的清理可靠性。

**输入文件**:
- `src/Engine.ts` — loadApp / unloadCurrentApp 实现
- `src/render/ResourceManager.ts` — exitApp 实现
- `src/render/BufferRegistry.ts` — exitApp 实现

**输出文件**:
- `tests/stress-app-switch.ts` — 压力测试脚本

**依赖**: 无

**详细步骤**:

1. **编写测试脚本**: 在 `tests/stress-app-switch.ts`（或浏览器可执行的 JS）中：
   ```typescript
   export async function runStressTest(engine: Engine) {
     const demos = ['demo1', 'demo2', 'demo3_shadow', 'demo4_spriteSheet', 
                    'demo5_deferred', 'demo6_3dgsViewer', 'demo7_multiView', 'demo8_customSystem'];
     const results = { passes: 0, fails: 0, leaks: [] as string[] };

     for (let round = 0; round < 10; round++) {
       for (const demo of demos) {
         try {
           await engine.loadApp(demo);
           await new Promise(r => requestAnimationFrame(r)); // 至少跑一帧

           // 检查点：资源泄漏
           const preUnload = engine.getResourceStats?.(); // 如果 ResourceManager 有统计接口

           await engine.unloadCurrentApp();

           const postUnload = engine.getResourceStats?.();
           if (preUnload && postUnload && postUnload.textureCount > 0) {
             results.leaks.push(`${demo} round ${round}: ${postUnload.textureCount} textures remaining`);
           }

           results.passes++;
         } catch (e) {
           results.fails++;
           console.error(`Failed at ${demo} round ${round}:`, e);
         }
       }
     }

     return results;
   }
   ```

2. **暴露统计接口（如需）**: 如果 `ResourceManager` 没有 `getStats()` 方法，临时添加一个（标记为 `@internal`）：
   ```typescript
   getStats() {
     return {
       meshCount: this.meshes.size,
       textureCount: this.textures.size,
       targetCount: this.targets.size,
       bufferCount: this.buffers.size,
     }
   }
   ```

3. **手动验证步骤**: 
   - 打开 Chrome DevTools Performance 面板
   - 运行压力测试
   - 观察 GPU Memory 曲线：应呈现阶梯式上升后平台化，而非持续线性上升
   - 检查 Console 是否有 `Device Lost`、`Buffer destroyed but still in use` 等错误

**验收标准**:
- [ ] 80 次切换中失败次数为 0
- [ ] GPU Memory 曲线在初始 5-10 轮后进入平台期（允许 common 级资源常驻）
- [ ] Console 无红色错误

**风险与回滚**:
- 风险: 压力测试可能暴露深层时序 bug（如异步 texture 上传与 unload 竞态）。
- 回滚: 删除测试脚本，移除临时统计接口。

---

### Task 2.3: ~~PipelineLoader 缓存命名空间隔离~~（已解决，保留为记录）

**状态**: 已解决，无需执行。

**核查结论**: `src/render/PipelineLoader.ts` 已具备 owner 隔离：
- `virtualConfigs` / `virtualShaders`（line 60-62）以 `'<plugin>:<name>'` 为 key，天然按插件命名空间隔离，不同插件同名管线不会碰撞
- `vertexInputOwners`（line 54）/ `blendPresetOwners`（line 63）已有 owner map + 跨 owner throw（与 AGENTS.md "跨 owner 重名 throw" 一致）
- `configs` / `shaderModules` / `computeMeta` / `pipelineSlots` 是 GPU 编译产物缓存，按 URL/key 索引，跨 app 同 key 同内容复用是有意为之（AGENTS.md 明示）
- 原设想的"两个 app 同名但 WGSL 不同的管线互相覆盖"场景在当前"app 级管线走文件 URL、virtual 走 `<plugin>:` 前缀"设计下不会发生

如未来出现真实碰撞 case，再单开 Task，不要按过时假设预防式改造。

---

## 阶段 3: System 调度显式化（P2）— ⚠️ 需架构决策

**目标**: ~~从"全局硬编码 JSON 顺序"进化为"声明式 Phase + Priority"。~~

> **⚠️ 此阶段与架构核心原则冲突，需先做架构决策，不可当"零破坏重构"执行。**
>
> AGENTS.md 三处明示："**顺序权永远在 systems.json，插件只提供实现**"。这是刻意设计选择：让组合层（JSON）而非插件决定帧顺序，原因正是本阶段风险栏自己列出的"某些 System 有隐式前后依赖（如 light 必须在 camera 之后），仅靠 phase 不够精细"。
>
> Task 3.1 试图改为"插件声明 phase 自动排序，systems.json 降级为白名单" —— 这是**架构方向性反转**，不是 P2 级加固。
>
> **决策门**：在启动本阶段前，必须先回答："是否放弃 systems.json 持有顺序权？"
> - 是 → 本阶段升格为架构 RFC，单独评审，不能藏在 P2 里偷渡
> - 否 → 整个阶段 3 砍掉（Task 3.2 已完成，Task 3.1 不做）

**完成标准**（仅当决策门通过时适用）:
- [ ] demo6/8 不再需要覆盖整个 `systems.json` 来插入自定义 System
- [ ] 新插件可以通过声明 phase 自动插入正确位置

---

### Task 3.1: 引入 SystemPhase + Priority 机制

**优先级**: P2（** gated by 决策门，未通过前不得启动 **）  
**目标**: 让 System 注册时声明执行阶段，SystemRegistry 支持自动排序。

**输入文件**:
- `src/ecs/SystemRegistry.ts` — System 注册和调度核心
- `src/ecs/SystemRegistry.ts` — FrameContext 定义（如在同文件）
- `src/plugins/Plugin.ts` — PluginContext 接口
- `public/common/systems.json` — 默认系统顺序
- `public/apps/demo6_3dgsViewer/systems.json` — override 示例
- `public/apps/demo8_customSystem/systems.json` — override 示例

**输出文件**:
- `src/ecs/SystemRegistry.ts` — 增加 phase/priority 支持
- `src/plugins/Plugin.ts` — 扩展 PluginContext.registerSystem 签名
- `src/render/types.ts` — 如需要，扩展相关接口
- `public/common/systems.json` — 增加 `"sortMode": "manual"` 标记（向后兼容）

**依赖**: 阶段 1 完成（确保所有 System 都通过插件注册，无脚本直接 `new System`）

**详细步骤**:

1. **定义 Phase 枚举**: 在 `src/ecs/SystemRegistry.ts`（或新建 `src/ecs/SystemPhase.ts`）中：
   ```typescript
   export enum SystemPhase {
     Input = 100,
     Script = 200,
     Physics = 300,
     Animation = 400,
     PreRender = 500,
     Render = 600,
     PostRender = 700,
   }
   ```

2. **扩展 System 注册接口**:
   ```typescript
   export interface SystemDef {
     name: string;
     phase: SystemPhase;
     priority: number; // 同 phase 内排序，升序
     factory: (ctx: PluginContext) => System;
   }

   // PluginContext 扩展
   registerSystem(
     name: string, 
     factory: (ctx: PluginContext) => System, 
     options?: { phase?: SystemPhase; priority?: number; }
   ): void;
   ```

3. **修改 SystemRegistry**:
   - 内部存储从 `Map<string, System>` 改为 `Map<string, { system: System; phase: SystemPhase; priority: number }>`
   - 增加 `sortSystems()` 方法：
     ```typescript
     private sortSystems(): void {
       this.sortedSystems = Array.from(this.systems.values())
         .sort((a, b) => {
           if (a.phase !== b.phase) return a.phase - b.phase;
           return a.priority - b.priority;
         })
         .map(entry => entry.system);
     }
     ```
   - `update(ctx)` 改为遍历 `this.sortedSystems`

4. **兼容 systems.json**:
   - 读取 `systems.json` 时，检查 `"sortMode"` 字段：
     - `"manual"`（默认）: 按 JSON 数组顺序执行，忽略 phase/priority（完全向后兼容）
     - `"auto"`: 按 phase + priority 自动排序
   - 如果 `systems.json` 中显式列出系统名（如 `["input", "script", ...]`），但 `sortMode: "auto"`，则这些名称仅作为"白名单"（只运行列出的系统，但顺序由 phase 决定）。

5. **迁移 demo6/8**:
   - demo6: 删除 `systems.json` override，在 `splat` 插件注册 `gaussianSplat` system 时声明 `phase: SystemPhase.PreRender, priority: 0`
   - demo8: 删除 `systems.json` override，在 `orbit` 插件注册 `orbit` system 时声明 `phase: SystemPhase.Animation, priority: 10`（在 animation 之后）
   - 两个 demo 的 `app.json` 中移除 `systems.json` 引用或标记 `"sortMode": "auto"`

**验收标准**:
- [ ] demo6 不依赖自定义 `systems.json`，`gaussianSplat` system 自动插入到 `animation` 之后、`render` 之前
- [ ] demo8 不依赖自定义 `systems.json`，`orbit` system 自动插入到正确位置
- [ ] `public/common/systems.json` 标记 `"sortMode": "manual"`，所有未迁移 demo 行为不变
- [ ] 新增一个测试插件，注册 `phase: SystemPhase.PreRender` 的 System，在不修改任何 systems.json 的情况下正确执行

**风险与回滚**:
- 风险: 某些 System 可能有隐式的前后依赖（如 `light` 必须在 `camera` 之后），仅靠 phase 不够精细。
- 回滚: 恢复 `systems.json` override，将 sortMode 改回 manual。

---

### Task 3.2: ~~RenderGraph Phase Behavior 插件注册~~（已完成）

**状态**: 已实现，无需执行。

**核查结论**（对照 AGENTS.md 与源码）:
- `src/render/types.ts:237` 已暴露 `registerPhaseBehavior(name, behavior, owner?)` 接口
- `src/render/RenderGraph.ts:69` 已实现，带 `phaseBehaviorOwners` map + `removePhaseBehaviorsByOwner`（line 79-85）
- `src/render/phaseBehaviors.ts` 已有 `normal` / `shadow-clear` / `postprocess-chain` 三默认
- 引擎默认三 behavior 经与插件相同通道注册（`RenderGraph.ts:63-65`），插件可覆盖/补充

**遗留可选优化**（不阻塞，低优先级）: demo5 的 deferred 紧耦合仍写在 `render.json`，未来若要解耦可由 deferred 插件注册 `gbuffer` behavior。但这是组合层重构，非引擎缺口，且 DeferredLight ← GBuffer 的 pass 顺序当前能正常工作，不必预防式动刀。

---

## 阶段 4: 组合冲突自动化（P3）— ⚠️ 暂缓（YAGNI）

**目标**: ~~为将来"多 demo 合并运行"扫清配置层面的障碍。~~

> **⚠️ 本阶段暂缓执行。**
>
> AGENTS.md 明示：合并 demo 的正确姿势是"写一个新的 app.json + scene.json + render.json"，引擎零改动。当前无任何 demo 需要运行时多场景或 entity key 命名空间隔离。本阶段在为**假设的**"多 demo 同 Scene 运行"需求做引擎级改动（`Scene.setKeyPrefix` + 双重注册），属 YAGNI。
>
> **解封条件**: 出现真实的"运行时合并两个 demo 到同一 Scene"产品需求时再启动。在此之前，用 fail-loud throw 覆盖明确的冲突（Task 4.2 简化版），不动 Scene 核心数据结构。

---

### Task 4.1: ~~Entity Key 命名空间/前缀支持~~（暂缓）

**状态**: 暂缓（YAGNI）。解封条件见阶段 4 头部。

**理由**: `Scene.createEntity(key, ...)` 当前用 key 作唯一标识，同 key 后者覆盖前者。这是设计而非 bug —— 单 app 运行时 entity key 自然唯一，合并场景应在新 app.json 里手动去重（AGENTS.md 已示）。引入 `setKeyPrefix` + 双重注册会污染 Scene 核心数据结构，且脚本中大量硬编码 entity key 查找需同步改造，风险/收益不划算。

如未来真有需求，再评估"prefix + 双重注册"或"显式 namespace API"哪个更合适。

---

### Task 4.2: PhysicsWorld 多控制器冲突检测（fail-loud throw）

**优先级**: P3（轻量版，可独立于阶段 4 其他项执行）  
**目标**: 同一 Scene 出现多个 `PhysicsControllerComponent` 时立即 throw，而非静默用最后一个导致未定义物理行为。

**输入文件**:
- `public/plugins/physics/PhysicsSystem.ts` — PhysicsWorld 初始化逻辑
- `public/apps/demo1/scene.json` — 单控制器示例
- `public/apps/demo2/scene.json` — 单控制器示例

**输出文件**:
- `public/plugins/physics/PhysicsSystem.ts` — 初始化处加多控制器检测

**依赖**: 无

**详细步骤**:

1. **读取当前实现**: 确认 `PhysicsSystem` 如何发现并消费 `PhysicsControllerComponent`。当前若是"取第一个/最后一个"即静默覆盖，正是要改的点。

2. **严格检测（策略 B，唯一策略）**: 在 PhysicsWorld 初始化前查询所有带 `PhysicsControllerComponent` 的 entity：
   ```typescript
   const controllers = scene.queryByComponent('PhysicsControllerComponent');
   if (controllers.length > 1) {
     throw new Error(
       `[PhysicsSystem] Multiple PhysicsControllerComponent detected in scene. ` +
       `Only one is allowed per Scene. Found on entities: ` +
       `${controllers.map(e => scene.getEntityKey(e)).join(', ')}. ` +
       `Fix: merge physics config into a single entity, or split into separate apps.`
     );
   }
   ```
   不做自动合并（策略 A）—— PhysicsWorld 的全局参数（gravity / ground plane）只能有一份，自动合并会产生不可预期的物理行为，fail-loud 更利于早期发现问题（与 AGENTS.md "fail-loud" 原则一致）。

3. **文档化**: 在 AGENTS.md "已知残留 / 陷阱" 区追加一行："一个 Scene 只能有一个 PhysicsControllerComponent，多控制器在 loadApp 阶段 throw。"

**验收标准**:
- [ ] 加载包含两个 `PhysicsControllerComponent` 的 scene 时，`loadApp` 阶段抛出含 entity key 的清晰错误（而非静默异常或未定义行为）
- [ ] 所有现有 demo（单控制器）正常运行
- [ ] `node scripts/validate-config.mjs` 通过（如该脚本已支持 PhysicsController 计数检查，更好）

**风险与回滚**:
- 风险: 极低。某些 demo 若无意中含多个 Controller（如 glTF 导入副作用），会从"静默坏掉"变成"显式报错"——这恰是 fail-loud 的预期收益。
- 回滚: 移除检测逻辑。

---

## 附录 A: 术语表

| 术语 | 含义 |
|------|------|
| `app.json` | App 级配置：声明插件、系统顺序、场景、渲染图 |
| `scene.json` | 场景实体配置：entity key + component 数据 |
| `render.json` | 渲染图配置：phases、passes、render targets |
| `systems.json` | System 执行顺序表（架构原则：顺序权在此，非插件；见 AGENTS.md） |
| `components.json` | App 级局部组件 Schema 声明 |
| `owner-tag` | ResourceManager / BufferRegistry 的资源归属标记：`app:<id>` / `plugin:<id>` |
| PhaseBehavior | RenderGraph 的相位策略：控制该 phase 下 pass 如何执行 |

## 附录 B: 回滚策略

每个 Task 完成后必须执行：
```bash
git add .
git commit -m "[PLAN] Task X.Y: <描述>"
```

如需回滚：
```bash
git log --oneline | grep "\[PLAN\]"  # 找到对应 commit
git revert <commit-hash>              # 或 git reset --hard <commit-hash>
```

## 附录 C: AI 执行检查清单

在开始每个 Task 前，AI 必须确认：
- [ ] 已读取所有输入文件并理解当前实现
- [ ] 已识别该 Task 与其他 Task 的文件冲突（如有冲突，等待前置 Task 完成）
- [ ] 已设计向后兼容方案（如接口变更）
- [ ] 已准备验收测试步骤

在每个 Task 完成后，AI 必须输出：
- [ ] 修改的文件列表（含路径）
- [ ] 关键代码 diff（如有接口变更）
- [ ] 验收测试结果（通过/失败）
- [ ] 发现的意外问题（如有）
