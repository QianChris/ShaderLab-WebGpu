# PLAN.md — ShaderLab-WebGPU 引擎本体整改规划

> 版本: 1.0  
> 目标: 消除特权代码，实现彻底插件化，加固资源生命周期，显式化 System 调度  
> 约束: **不修改 Editor** | **保持所有现有 demo 可运行** | **零破坏重构**

---

## 执行原则（给 AI 的元指令）

1. **先读后写**: 每个任务开始前，先读取所有输入文件，理解当前实现后再生成修改方案。
2. **最小变更**: 每个任务修改的文件数控制在 3-7 个以内。如果超出，拆分为子任务。
3. **向后兼容**: 所有接口变更必须保留旧路径（deprecated alias 或兼容层），直到下一阶段明确移除。
4. **验收驱动**: 每个任务必须有可自动验证的验收标准。无法自动验证的，必须提供手动验证步骤。
5. **阶段隔离**: 同一阶段内的任务可以并行执行（无文件冲突时）。跨阶段任务必须按顺序执行。
6. **回滚就绪**: 每个任务完成后，git commit 一次，commit message 前缀为 `[PLAN]`。

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

2. **扩展 Schema**: 在 `public/plugins/orbit/index.ts` 中扩展 `OrbitComponent` 的 schema，确保所有从 orbit.js 提取的常量都有对应字段：
   ```typescript
   static schema = {
     radius:      { type: 'float', default: 5.0 },
     speed:       { type: 'float', default: 1.0 },
     spin:        { type: 'float', default: 0.0 },
     sensitivity: { type: 'float', default: 1.0 },
     damping:     { type: 'float', default: 0.9 },
     minDistance: { type: 'float', default: 0.1 },
     maxDistance: { type: 'float', default: 100.0 },
     target:      { type: 'vec3',  default: [0, 0, 0] },
     autoRotate:  { type: 'bool',  default: false },
   }
   ```
   如果 OrbitSystem 目前未读取这些字段，同步修改 `OrbitSystem.ts` 使其从 Component 读取配置而非硬编码。

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

### Task 1.2: Sprite 能力插件化

**优先级**: P0  
**目标**: 将 `SpriteSheetComponent` 和 `SpriteAnimationComponent` 从 app 级 components.json 迁移至独立 `sprite` 插件。

**输入文件**:
- `public/apps/demo2/components.json`
- `public/apps/demo4_spriteSheet/components.json`
- `public/apps/demo4_spriteSheet/pipelines/` — Sprites 管线
- `public/apps/demo4_spriteSheet/shaders/` — Sprites shader
- `public/apps/demo2/app.json`
- `public/apps/demo4_spriteSheet/app.json`

**输出文件**:
- `public/plugins/sprite/index.ts` — 新建，定义 SpriteSheetComponent + SpriteAnimationComponent
- `public/plugins/sprite/SpriteSystem.ts` — 新建，处理动画更新（如当前由 AnimationSystem 兼管，则拆分）
- `public/plugins/sprite/pipelines/SpritesPipeline.json` — 从 demo4 迁移
- `public/plugins/sprite/shaders/Sprites.wgsl` — 从 demo4 迁移
- `public/apps/demo2/components.json` — 删除 SpriteSheet/SpriteAnimation 声明
- `public/apps/demo4_spriteSheet/components.json` — 删除 SpriteSheet/SpriteAnimation 声明
- `public/apps/demo2/app.json` — 添加 `"sprite"` 到 plugins
- `public/apps/demo4_spriteSheet/app.json` — 添加 `"sprite"` 到 plugins

**依赖**: 无

**详细步骤**:

1. **新建插件目录**: `public/plugins/sprite/`

2. **组件定义**: 在 `public/plugins/sprite/index.ts` 中定义：
   ```typescript
   export class SpriteSheetComponent extends Component {
     static schema = {
       texture: { type: 'texture', default: null },
       rows: { type: 'int', default: 1 },
       cols: { type: 'int', default: 1 },
       totalFrames: { type: 'int', default: 1 },
     }
   }
   export class SpriteAnimationComponent extends Component {
     static schema = {
       currentFrame: { type: 'int', default: 0 },
       frameRate: { type: 'float', default: 10 },
       playing: { type: 'bool', default: true },
       loop: { type: 'bool', default: true },
     }
   }
   ```

3. **系统实现**: 如果 `AnimationSystem`（core 插件）目前负责 Sprite 动画，则在 `SpriteSystem.ts` 中接管：
   - 查询所有带 `SpriteAnimationComponent` 的 entity
   - 根据 `dt` 和 `frameRate` 更新 `currentFrame`
   - 如果动画结束且 `loop=false`，设置 `playing=false`

4. **资源迁移**: 将 demo4 的 Sprites 管线 JSON 和 WGSL shader 复制到 `public/plugins/sprite/pipelines/` 和 `shaders/`，并修改内部路径引用为 `<sprite>:pipelines/...` 和 `<sprite>:shaders/...`。

5. **修改 App 配置**: 
   - 从 demo2 和 demo4 的 `components.json` 中移除 SpriteSheetComponent 和 SpriteAnimationComponent 的声明。
   - 在 `app.json` 的 `plugins` 数组中添加 `"sprite"`。

6. **修改 Scene**: 如果 demo2/demo4 的 `scene.json` 中 entity 引用了这些组件，确保组件名不变（因为插件注册后 schemaRegistry 会全局注册组件名）。

**验收标准**:
- [ ] `grep -r "SpriteSheetComponent" public/apps/` 定义位置不在任何 `components.json` 中（应在 plugins/sprite/）
- [ ] demo2 和 demo4 在浏览器中加载后，Sprite 动画行为与整改前一致
- [ ] demo4 的精灵图正确显示并播放动画

**风险与回滚**:
- 风险: Sprite 管线可能依赖 demo4 特有的 render target 配置或 blending 状态。
- 回滚: 恢复 components.json 中的声明，恢复 app.json 的 plugins 列表。

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
- [ ] PipelineLoader 缓存支持多 app 隔离

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

### Task 2.3: PipelineLoader 缓存命名空间隔离

**优先级**: P1  
**目标**: 防止不同 app/插件的同名管线/着色器互相覆盖。

**输入文件**:
- `src/render/PipelineLoader.ts` — 静态缓存实现

**输出文件**:
- `src/render/PipelineLoader.ts` — 增加 owner 前缀隔离

**依赖**: 无

**详细步骤**:

1. **读取缓存实现**: 确认 `virtualConfigs`、`virtualShaders`、`configs`、`shaderModules` 等 static Map/Record 的 key 结构。

2. **修改缓存 key**: 所有缓存读写点增加 `owner` 前缀：
   ```typescript
   // 之前
   static virtualConfigs: Map<string, any> = new Map();

   // 之后
   static virtualConfigs: Map<string, any> = new Map();

   static getVirtualConfig(ref: string, owner: string): any {
     const key = `${owner}::${ref}`;
     return this.virtualConfigs.get(key);
   }

   static setVirtualConfig(ref: string, owner: string, config: any) {
     const key = `${owner}::${ref}`;
     this.virtualConfigs.set(key, config);
   }
   ```
   对 `virtualShaders`、`configs`、`computeMeta`、`pipelineSlots`、`shaderModules` 执行同样改造。

3. **修改调用点**: 在 `PipelineLoader.loadVirtualConfig` / `loadVirtualShader` / `loadConfig` 等入口中，确保 `owner` 参数被正确传递。`owner` 格式为 `app:<appId>` 或 `plugin:<pluginId>`。
   - 检查 `PluginManager` 在加载插件时如何调用 PipelineLoader，确保 pluginId 传入。
   - 检查 `Engine.loadApp` 在加载 app 级管线时如何调用，确保 appId 传入。

4. **清理接口适配**: `removeVirtualsByPrefix(prefix)` 目前按前缀清理。修改为按 owner 精确清理：
   ```typescript
   static removeVirtualsByOwner(owner: string) {
     const prefix = `${owner}::`;
     [this.virtualConfigs, this.virtualShaders].forEach(map => {
       for (const key of map.keys()) {
         if (key.startsWith(prefix)) map.delete(key);
       }
     });
   }
   ```

5. **向后兼容**: 如果某些调用点暂时无法传入 owner，使用默认 owner `"global"`。

**验收标准**:
- [ ] 创建两个测试 app，各自声明同名但 WGSL 内容不同的管线 `TestPipeline`，同时加载时两者使用各自的 shader，不互相覆盖
- [ ] 所有现有 demo 加载后渲染结果无回归

**风险与回滚**:
- 风险: 调用点分散，可能遗漏某些缓存读写路径。
- 回滚: 恢复原始 key 逻辑，保留 owner 参数但不使用。

---

## 阶段 3: System 调度显式化（P2）

**目标**: 从"全局硬编码 JSON 顺序"进化为"声明式 Phase + Priority"。

**完成标准**:
- [ ] demo6/8 不再需要覆盖整个 `systems.json` 来插入自定义 System
- [ ] 新插件可以通过声明 phase 自动插入正确位置

---

### Task 3.1: 引入 SystemPhase + Priority 机制

**优先级**: P2  
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

### Task 3.2: RenderGraph Phase Behavior 插件注册

**优先级**: P2  
**目标**: 让插件可以注册自定义 Render Phase Behavior，解耦 Deferred 等复杂管线的硬编码。

**输入文件**:
- `src/render/RenderGraph.ts` — Phase 调度实现
- `src/render/types.ts` — PhaseBehavior 接口
- `public/apps/demo5_deferred/render.json` — Deferred 的 tight coupling 示例

**输出文件**:
- `src/render/RenderGraph.ts` — 支持动态注册 PhaseBehavior
- `src/render/types.ts` — 扩展 IRenderer 或 PluginContext 接口
- `public/apps/demo5_deferred/render.json` — 简化，利用新 behavior

**依赖**: Task 3.1

**详细步骤**:

1. **读取当前 PhaseBehavior 实现**: 理解 `normal`、`shadow-clear`、`postprocess-chain` 三个默认 behavior 的实现方式。

2. **扩展注册接口**: 在 `PluginContext` 中增加：
   ```typescript
   registerPhaseBehavior(name: string, behavior: PhaseBehavior): void;
   ```
   在 `RenderGraph` 中维护 `Map<string, PhaseBehavior>`。

3. **Deferred Phase Behavior 插件化**:
   - 新建或修改一个插件（如 `deferred` 插件，或放在 core 中但按需注册），提供 `gbuffer` behavior：
     ```typescript
     const gbufferBehavior: PhaseBehavior = {
       perCamera: true,
       run: (ctx) => {
         // 1. 执行所有 target="gbufferA/B/C/D" 的 pass
         // 2. 执行 DeferredLight pass（读取 GBuffer）
       }
     };
     ```
   - demo5 的 `render.json` 中，将 GBuffer → DeferredLight 的 tight coupling 改为引用 `"behavior": "gbuffer"`。

4. **简化 render.json**: demo5 的 render.json 应该不再需要手动排列 GBuffer 和 DeferredLight 的 pass 顺序，而是由 behavior 内部处理依赖。

**验收标准**:
- [ ] demo5 的 deferred 渲染结果与整改前一致
- [ ] `render.json` 中 GBuffer 和 DeferredLight 的 pass 顺序不再硬编码（或至少不依赖 app 级配置）
- [ ] 新增一个自定义 behavior 插件，能在不修改 RenderGraph 核心代码的情况下注册并执行

**风险与回滚**:
- 风险: PhaseBehavior 的抽象可能过度设计，Deferred 的 tight coupling 可能难以完全解耦而不损失性能。
- 回滚: 恢复硬编码的 render.json 配置。

---

## 阶段 4: 组合冲突自动化（P3）

**目标**: 为将来"多 demo 合并运行"扫清配置层面的障碍。

**完成标准**:
- [ ] 两个 scene.json 可以加载到同一 Scene 而不发生 entity key 冲突
- [ ] PhysicsWorld 多控制器冲突可被检测或自动合并

---

### Task 4.1: Entity Key 命名空间/前缀支持

**优先级**: P3  
**目标**: 消除 Scene 中 entity key 的唯一性冲突。

**输入文件**:
- `src/ecs/Scene.ts` — createEntity / getEntity 实现

**输出文件**:
- `src/ecs/Scene.ts` — 增加 key prefix / namespace 支持

**依赖**: 无

**详细步骤**:

1. **读取当前实现**: 确认 `Scene.createEntity(key, components)` 和 `Scene.getEntity(key)` 的实现。

2. **增加 Prefix 支持**:
   ```typescript
   class Scene {
     private keyPrefix: string = '';

     setKeyPrefix(prefix: string) {
       this.keyPrefix = prefix;
     }

     createEntity(key: string, components: Record<string, any>): number {
       const namespacedKey = this.keyPrefix ? `${this.keyPrefix}/${key}` : key;
       // 使用 namespacedKey 作为唯一标识
       // ...
     }

     getEntity(key: string): number | undefined {
       const namespacedKey = this.keyPrefix ? `${this.keyPrefix}/${key}` : key;
       return this.entityMap.get(namespacedKey);
     }

     // 兼容：也支持直接查询短名（如果全局唯一）
     getEntityByShortName(key: string): number | undefined {
       return this.entityMap.get(key);
     }
   }
   ```

3. **Engine 集成**: 在 `Engine.loadApp(appId)` 中，加载 scene 前调用 `scene.setKeyPrefix(appId)`。
   - 注意：这会影响现有 demo 中脚本通过 key 查找 entity 的逻辑（如 `scene.getEntity('SunLight')`）。
   - 如果脚本中使用了硬编码 key，需要修改为支持前缀查找，或在 `setKeyPrefix` 时同时注册无前缀别名（双重注册）。

4. **双重注册策略（推荐）**: 
   - `createEntity` 时，同时注册 `appId/key` 和 `key`（如果 `key` 尚未被占用）。
   - `getEntity('SunLight')` 先尝试查找 `SunLight`，如果找不到且当前有 prefix，再查找 `appId/SunLight`。
   - 这样单个 app 运行时不破坏现有行为，合并运行时才启用命名空间隔离。

**验收标准**:
- [ ] 单个 demo 运行时，`scene.getEntity('MainCamera')` 仍然正常工作（向后兼容）
- [ ] 两个 demo 合并加载时（通过某种测试方式），同名 entity（如两个 `SunLight`）共存且不覆盖
- [ ] `scene.toJSON()` 序列化时保留命名空间信息（或能正确还原）

**风险与回滚**:
- 风险: 脚本系统中大量硬编码 entity key，双重注册可能引入歧义。
- 回滚: 移除 prefix 逻辑，恢复纯 key 模式。

---

### Task 4.2: PhysicsWorld 冲突检测与合并策略

**优先级**: P3  
**目标**: 明确同一 Scene 中多个 PhysicsControllerComponent 的处理方式。

**输入文件**:
- `public/plugins/physics/PhysicsSystem.ts` — PhysicsWorld 初始化逻辑
- `public/apps/demo1/scene.json` — PhysicsControllerComponent 配置
- `public/apps/demo2/scene.json` — PhysicsControllerComponent 配置

**输出文件**:
- `public/plugins/physics/PhysicsSystem.ts` — 增加冲突检测/合并逻辑

**依赖**: 无

**详细步骤**:

1. **读取当前实现**: 确认 PhysicsSystem 如何处理 `PhysicsControllerComponent`。是否一个 World 只能有一个 Controller？

2. **选择策略**（根据当前实现选择其一）：

   **策略 A: 自动合并**（如果参数可合并）：
   ```typescript
   // PhysicsSystem 初始化时
   const controllers = scene.query(PhysicsControllerComponent);
   if (controllers.length > 1) {
     const mergedConfig = mergePhysicsConfigs(controllers.map(c => c.config));
     this.world = createWorld(mergedConfig);
   }
   ```

   **策略 B: 严格检测 + 清晰报错**（如果只能有一个）：
   ```typescript
   const controllers = scene.query(PhysicsControllerComponent);
   if (controllers.length > 1) {
     throw new Error(
       `[PhysicsSystem] Multiple PhysicsControllerComponent detected in scene. ` +
       `Only one is allowed per Scene. Found on entities: ${controllers.map(e => e.key).join(', ')}. ` +
       `Suggestion: Merge physics config into a single entity, or use separate Scene instances.`
     );
   }
   ```

3. **推荐策略 B**: 因为 PhysicsWorld 的全局参数（gravity、ground plane）通常只能有一份，自动合并可能产生不可预期的物理行为。严格报错更利于早期发现问题。

4. **文档化**: 在 `ARCHITECTURE.md` 或插件 README 中明确说明："一个 Scene 只能有一个 PhysicsControllerComponent"。

**验收标准**:
- [ ] 加载包含两个 PhysicsControllerComponent 的 scene 时，`loadApp` 阶段抛出清晰错误（而非静默异常）
- [ ] 所有现有 demo（只有一个 Controller）正常运行
- [ ] 错误消息包含 entity key 和修复建议

**风险与回滚**:
- 风险: 某些 demo 可能无意中包含多个 Controller（如 glTF 导入时自动添加）。
- 回滚: 移除检测逻辑，恢复静默覆盖行为。

---

## 附录 A: 术语表

| 术语 | 含义 |
|------|------|
| `app.json` | App 级配置：声明插件、系统顺序、场景、渲染图 |
| `scene.json` | 场景实体配置：entity key + component 数据 |
| `render.json` | 渲染图配置：phases、passes、render targets |
| `systems.json` | System 执行顺序表（将被 Phase 机制取代） |
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
