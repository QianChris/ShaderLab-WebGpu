# PLAN.md — Demo6 3DGS 自行车物理化改造

> 版本: 1.0
> 目标: 将 demo6 的 Gaussian Splatting 自行车从纯视觉展示改为物理驱动的可交互场景
> 约束: **引擎零改动** | **不修改现有插件公共 API** | **保持原高斯渲染效果不变**

---

## 背景

demo6 目前用 3DGS PLY 渲染一辆自行车，但场景是静态的 —— 相机可以绕转，物体不会动。

改造目标：
1. 从 PLY 的 splat 中心点云提取几何信息，生成凸包碰撞体
2. 自行车成为一个 dynamic 刚体，会受重力、可以被球砸
3. 高斯 splat 跟随物理驱动的 Transform 移动，视觉上自行车"活"了
4. 加入地面、鼠标点击射球交互（类似 demo2）

---

## 执行原则

1. **先读后写**: 每个任务开始前，先读取所有输入文件
2. **最小变更**: 每个任务修改 2-5 个文件
3. **引擎零改动**: 所有能力通过插件提供，`src/` 一行不改
4. **验证驱动**: 每个任务必须可编译、可通过 `npm run check:plugins`
5. **阶段隔离**: 任务按依赖顺序执行，不可跳跃

---

## 阶段 1: 基础设施（P0）

**目标**: 扩展 physics 插件支持 convexHull 形状，暴露 splat 点云数据。

**完成标准**:
- [ ] PhysicsSystem 支持 `convexHull` 和 `compound` 两种新碰撞形状
- [ ] ColliderComponent schema 的 `shape` options 包含 `convexHull` 和 `compound`
- [ ] GaussianSplatManager 暴露 `getCenters(): Float32Array | null`

---

### Task 1.1: PhysicsSystem 增加 convexHull / compound 形状支持

**优先级**: P0
**目标**: 让 PhysicsSystem 能构建 Rapier convex hull 和 compound 碰撞体。

**输入文件**:
- `public/plugins/physics/PhysicsSystem.ts` — COLLIDER_BUILDERS、buildColliderDesc、signature
- `public/plugins/core/components.json` — ColliderComponent schema

**输出文件**:
- `public/plugins/physics/PhysicsSystem.ts` — 新增 convexHull/compound builder
- `public/plugins/core/components.json` — shape options 扩展

**详细步骤**:

1. **扩展 ColliderComponent schema**（`components.json`）:
   ```json
   "shape": {
     "type": "string", "default": "cuboid",
     "options": ["cuboid", "ball", "capsule", "convexHull", "compound"]
   }
   ```
   新增两个字段存放凸包/复合碰撞体的顶点数据：
   ```json
   "convexVerts": { "type": "vec3a", "default": [] },
   "compoundShapes": { "type": "string", "default": "" }
   ```

2. **扩展 COLLIDER_BUILDERS**（`PhysicsSystem.ts`）:
   ```typescript
   convexHull: (R, _he, _radius, _halfHeight, verts?: Float32Array) => {
       if (!verts || verts.length < 12) throw new Error('convexHull requires ≥4 points');
       return R.ColliderDesc.convexHull(verts);
   },
   compound: (R, _he, _radius, _halfHeight, _verts, children?: RapierNS.ColliderDesc[]) => {
       if (!children || children.length === 0) throw new Error('compound requires children');
       return R.ColliderDesc.compound(children);
   },
   ```
   修改 `ColliderBuilder` 签名加两个可选参数。

3. **程序化 API**（供 splat-physics 插件调用）:
   在 PhysicsSystem 上暴露一个公开方法，让 splat-physics 可以直接用程序化顶点创建碰撞体，而不走 ColliderComponent / scene.json 路径：
   ```typescript
   /** Build a compound collider desc from an array of vertex groups (one convex hull each). */
   buildConvexCompound(vertexGroups: Float32Array[]): RapierNS.ColliderDesc | null;
   ```

4. **signature() 更新**: 确保 `convexVerts` 字段参与签名计算以保证变更检测。

**验收标准**:
- [ ] `grep "convexHull\|compound" public/plugins/physics/PhysicsSystem.ts` 有新 builder 实现
- [ ] `npm run check:plugins` 通过
- [ ] 语法上 ColliderComponent 可以声明 `"shape": "convexHull"` 而不报错

---

### Task 1.2: GaussianSplatManager 暴露点云数据

**优先级**: P0
**目标**: 让 splat-physics 插件能通过 `splats` attachment 读取 splat 中心坐标。

**输入文件**:
- `public/plugins/splat/GaussianSplatManager.ts` — cpuCenters 为 private 字段

**输出文件**:
- `public/plugins/splat/GaussianSplatManager.ts` — 新增 public getter

**详细步骤**:

1. 在 `GaussianSplatManager` 类中添加公开方法：
   ```typescript
   /** Expose splat center positions for external consumers (e.g. collision generation). */
   getCenters(): Float32Array | null {
       return this.cpuCenters;
   }
   ```

2. 无需其他改动。`cpuCenters` 在 `load()` 中被赋值，`dispose()` 中被置 null，生命周期正确。

**验收标准**:
- [ ] `splat-physics` 插件中 `ctx.getAttachment('splats')` 拿到对象后可以调用 `.getCenters()`
- [ ] 在 splat 加载前调用返回 null（不崩溃）
- [ ] `npm run check:plugins` 通过

---

## 阶段 2: splat-physics 插件（P0）

**目标**: 新建独立插件，实现 splat 点云 → 凸包碰撞体的完整管线。

**完成标准**:
- [ ] `public/plugins/splat-physics/` 目录存在，含 index.ts + SplatCollider.ts
- [ ] 插件依赖 `splat` + `physics`，在 demo6 中声明加载
- [ ] 自行车加载后自动生成 ~30-50 个 convex hull 组成的 compound 碰撞体
- [ ] 碰撞体随 GsEntity 的 Transform 正确放置

---

### Task 2.1: 实现 SplatCollider 核心算法

**优先级**: P0
**目标**: 体素聚类 + 凸包生成 + compound 组装。

**输入文件**:
- `public/plugins/physics/PhysicsSystem.ts` — buildConvexCompound API（来自 Task 1.1）
- `public/plugins/splat/GaussianSplatManager.ts` — getCenters()（来自 Task 1.2）

**输出文件**:
- `public/plugins/splat-physics/SplatCollider.ts` — **新建**

**详细步骤**:

1. **降采样**（stride=200，~5M → ~25K）:
   ```typescript
   function downsample(centers: Float32Array, stride: number): Float32Array {
       const n = Math.ceil(centers.length / (4 * stride));
       const out = new Float32Array(n * 3);
       for (let i = 0, j = 0; i < centers.length; i += stride * 4, j += 3) {
           out[j] = centers[i];
           out[j + 1] = centers[i + 1];
           out[j + 2] = centers[i + 2];
       }
       return out;
   }
   ```

2. **体素聚类**（gridRes=5 → 最多 125 个格）:
   ```typescript
   function voxelCluster(points: Float32Array, gridRes: number): Float32Array[] {
       // 1. 计算 AABB
       // 2. 分配点到 grid[ix + iy*res + iz*res*res]
       // 3. 合并点数 < 4 的格到最近的非空格
       // 4. 返回每个格的顶点数组
   }
   ```

3. **凸包生成**:
   ```typescript
   function buildHulls(RAPIER, clusters: Float32Array[], maxHulls: number): RapierNS.ColliderDesc[] {
       const hulls: RapierNS.ColliderDesc[] = [];
       for (const cluster of clusters) {
           if (cluster.length < 12) continue; // 少于4个点无法构成凸包
           hulls.push(RAPIER.ColliderDesc.convexHull(cluster));
       }
       // 按体积排序，保留最大的 maxHulls 个
       // 合并最小的 hulls（可选）
       return hulls.slice(0, maxHulls);
   }
   ```

4. **体积估算**（用于排序）:
   对于 convex hull desc，用 AABB 体积近似排序；Rapier 的 ColliderDesc 在创建前没有体积 API，所以用聚类点的 AABB。

5. **导出主函数**:
   ```typescript
   export function generateSplatCollider(
       RAPIER: typeof import('@dimforge/rapier3d-compat'),
       centers: Float32Array,
       options?: { stride?: number; gridRes?: number; maxHulls?: number }
   ): { colliderDesc: RapierNS.ColliderDesc; hullCount: number };
   ```

**验收标准**:
- [ ] `generateSplatCollider` 对有效输入返回 non-null 的 compound ColliderDesc
- [ ] hullCount 在 10-50 范围内（对于自行车 PLY）
- [ ] 算法在 JS 主线程执行时间 < 5 秒（对于 25K 点、125 格）
- [ ] `npm run check:plugins` 通过

---

### Task 2.2: 实现 splat-physics 插件入口

**优先级**: P0
**目标**: 在 appLoaded 时机读取 splat 数据、生成碰撞体、创建物理体并绑定 GsEntity。

**输入文件**:
- `public/plugins/splat-physics/SplatCollider.ts` — 来自 Task 2.1
- `public/plugins/physics/PhysicsSystem.ts` — buildConvexCompound API
- `public/plugins/splat/GaussianSplatManager.ts` — getCenters()

**输出文件**:
- `public/plugins/splat-physics/index.ts` — **新建**
- `public/plugins/splat-physics/tsconfig.json` — **新建**

**详细步骤**:

1. **插件声明**:
   ```typescript
   export default class SplatPhysicsPlugin extends EnginePlugin {
       readonly meta = { id: 'splat-physics', dependencies: ['splat', 'physics'] };
       
       components = [];      // 不声明新组件
       systemDefs = [];      // 不注册新系统
       renderHooks = {};     // 不注册渲染 hook
   }
   ```

2. **appLoaded 生命周期**:
   ```typescript
   async appLoaded(ctx: PluginContext, appBase: string): Promise<void> {
       // 1. 从 attachments 获取 splat 管理器
       const splatMgr = ctx.getAttachment('splats');
       const centers = splatMgr?.getCenters();
       if (!centers) return;
       
       // 2. 从 attachments 获取物理系统
       const physics = ctx.getAttachment('physics');
       if (!physics) throw new Error('splat-physics requires physics plugin');
       
       // 3. 找到 GsComponent 所在的 entity
       let gsEid: number | null = null;
       for (const [, eid] of ctx.scene.entityKeyMap) {
           if (ctx.scene.hasComponent(eid, 'GsComponent')) { gsEid = eid; break; }
       }
       if (gsEid === null) return;
       
       // 4. 生成 compound convex hull 碰撞体
       const { colliderDesc } = generateSplatCollider(RAPIER, centers);
       
       // 5. 创建 dynamic 刚体 + 挂载 compound 碰撞体
       const pos = ctx.scene.getField(gsEid, 'Transform', 'position') as number[];
       const rot = ctx.scene.getField(gsEid, 'Transform', 'rotation') as number[];
       const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
           .setTranslation(pos[0], pos[1], pos[2])
           .setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] })
           .setLinearDamping(0.1)
           .setAngularDamping(0.1)
           .setCcdEnabled(true);
       
       // 6. 通过 PhysicsSystem 的内部 world 创建（需要暴露 API）
       //    或者: 直接在 GsEntity 上添加 ColliderComponent + RigidBodyComponent，
       //    让 PhysicsSystem.reconcile 自动创建。
       
       // 推荐方案: 在 GsEntity 上添加 RigidBodyComponent（dynamic），
       // 然后通过 PhysicsSystem.buildConvexCompound() 直接操作 Rapier world
   }
   ```

3. **关键设计决策: 物理体如何绑定 GsEntity**

   **方案 A（推荐）**: 在 `appLoaded` 中直接给 GsEntity 添加组件：
   ```typescript
   // 给 GsEntity 挂 dynamic 刚体标记
   ctx.scene.addComponent(gsEid, 'RigidBodyComponent');
   ctx.scene.setField(gsEid, 'RigidBodyComponent', 'bodyType', 'dynamic');
   ctx.scene.setField(gsEid, 'RigidBodyComponent', 'ccd', 1);
   ctx.scene.setField(gsEid, 'RigidBodyComponent', 'linearDamping', 0.05);
   ctx.scene.setField(gsEid, 'RigidBodyComponent', 'angularDamping', 0.1);
   
   // 通过 PhysicsSystem 的公开 API 直接创建 compound 碰撞体
   // （不通过 ColliderComponent，因为顶点数据太大，不适合 JSON）
   physics.createCompoundCollider(gsEid, convexHullDescs);
   ```
   
   **方案 B**: 通过 ColliderComponent 声明 `shape: "compound"`，顶点数据存 attachments。
   
   **选方案 A**，因为：
   - 凸包顶点可能很大（数万个 float），不适合 JSON
   - PhysicsSystem 已有 `createRecord` 内部方法，只需暴露一个程序化入口
   - 复用现有的 reconcile / writeBodiesToTransforms 管道

4. **PhysicsSystem 需要新增的公开 API**:
   ```typescript
   /** Programmatic compound collider creation (for splat-physics etc). */
   createCompoundBody(eid: number, colliders: RapierNS.ColliderDesc[]): void {
       if (!this.world) return;
       // 读取 Transform 创建 body
       // 创建 compound collider
       // 注册到 records
   }
   ```

5. **tsconfig.json**:
   ```json
   {
       "extends": "../../tsconfig.base.json",
       "compilerOptions": { "paths": { "@shaderlab/api": ["../../src/api.ts"] } }
   }
   ```

**验收标准**:
- [ ] demo6 加载后，GsEntity 上自动生成了动态刚体 + compound 碰撞体
- [ ] 自行车受重力影响会落到地面上
- [ ] 可以通过 physics debug 渲染看到凸包线框
- [ ] `npm run check:plugins` 通过对 splat-physics 目录的检查

---

## 阶段 3: Demo6 场景改造（P1）

**目标**: 把 demo6 从静态查看器改为物理沙盒。

**完成标准**:
- [ ] demo6 加载后自行车站在地面上，受重力约束
- [ ] 有地面碰撞体，自行车不会掉落
- [ ] 鼠标左键点击射出球体，可砸倒自行车
- [ ] 碰撞触发火花粒子效果
- [ ] 物理调试线框可选开关

---

### Task 3.1: 修改 demo6 场景与配置

**优先级**: P1
**目标**: 加入地面、物理世界、粒子系统、游戏脚本。

**输入文件**:
- `public/apps/demo6_3dgsViewer/app.json`
- `public/apps/demo6_3dgsViewer/scene.json`
- `public/apps/demo6_3dgsViewer/render.json`
- `public/apps/demo6_3dgsViewer/systems.json`

**输出文件**:
- `public/apps/demo6_3dgsViewer/app.json` — 添加 splat-physics 插件
- `public/apps/demo6_3dgsViewer/scene.json` — 加入 PhysicsWorld/Ground/粒子/GameState
- `public/apps/demo6_3dgsViewer/render.json` — 加入 PhysicsDebug + ParticlePipeline
- `public/apps/demo6_3dgsViewer/systems.json` — 加入 gaussianSplat（如需要）

**详细步骤**:

1. **app.json** 修改:
   ```json
   {
     "name": "demo6_3dgsViewer",
     "plugins": ["splat", "splat-physics"],
     "scene": "scene.json",
     "render": "render.json",
     "systems": "systems.json"
   }
   ```
   `physics` 已在 engine-config.json 中常驻，`particles` 同理。

2. **scene.json** 新增实体:

   - **PhysicsWorld**: PhysicsControllerComponent，gravity [0, -9.81, 0]，groundEnabled=true
   - **Ground**: 可选，用 PhysicsController 的 ground 代替
   - **Sparks**: ParticleSystemComponent（maxParticles 40000, gravity [0, -6, 0]）
   - **SparkEmitter**: sphere emitter, radius 0.15, rate 24000, 默认 disabled
   - **GameState**: GameStateComponent（ballSpeed 18, ballRadius 0.35, spawnHeight 6）
   - **MainCamera ScriptComponent**: 改为引用 `scripts/orbit.js`（保持现有相机控制）

3. **render.json** 新增管线:
   ```json
   {
     "Opaque": [
       { "name": "Grid", "pipeline": "core:pipelines/GridPipeline.json", "enabled": true },
       { "name": "PbrSolid", "pipeline": "core:pipelines/PbrPipeline.json", "enabled": true },
       { "name": "PhysicsDebug", "pipeline": "physics:pipelines/PhysicsDebugPipeline.json", "enabled": false }
     ],
     "Transparent": [
       { "name": "Splat", "pipeline": "pipelines/GaussianSplatPipeline.json", "enabled": true },
       { "name": "Particles", "pipeline": "particles:pipelines/ParticlePipeline.json", "enabled": true }
     ]
   }
   ```

4. **systems.json** 不需要修改 —— `gaussianSplat` 已在清单中，`physics` 在 engine-config.json 默认顺序中。

**验收标准**:
- [ ] `npm run build` 通过
- [ ] `node scripts/validate-config.mjs` 通过
- [ ] 浏览器加载 demo6 不报错

---

### Task 3.2: 编写游戏脚本 scripts/game.js

**优先级**: P1
**目标**: 鼠标点击射球 + 碰撞触发火花。

**输入文件**:
- `public/apps/demo2/scripts/game.js` — 参考实现

**输出文件**:
- `public/apps/demo6_3dgsViewer/scripts/game.js` — **新建**

**详细步骤**:

1. 参考 demo2 的 game.js，功能完全一致：
   - 左键点击：从相机位置向屏幕点击方向射出 dynamic 球体（icosphere）
   - 碰撞监听：球碰到任何物体 → 在碰撞点触发 SparkEmitter 粒子爆发
   - 清理：y < -10 的球体自动删除

2. 关键差异：
   - 球的 target 可以是自行车（GsEntity key），但碰撞系统已经按 layer/mask 过滤
   - GameStateComponent 字段沿用 demo2 的定义

3. 脚本内容结构与 demo2/scripts/game.js 保持一致，使用 EventBus + scene API。

**验收标准**:
- [ ] 点击鼠标后球体从相机位置射出
- [ ] 球碰到自行车触发火花
- [ ] 球掉落出界被清理
- [ ] 浏览器 console 无脚本错误

---

## 阶段 4: 验证与收尾（P2）

**目标**: 完整验证改造结果，确保无回归。

---

### Task 4.1: 端到端验收

**优先级**: P2
**目标**: 跑全量构建 + 校验 + 手动测试。

**步骤**:

```bash
# 1. 构建与类型检查
npm run build
npm run check:plugins

# 2. 配置校验
node scripts/validate-config.mjs

# 3. 插件装载冒烟
node scripts/smoke-plugin-loader.mjs

# 4. 手动浏览器测试
# - 加载 demo6，确认自行车渲染正常
# - 打开 PhysicsDebug，确认凸包线框可见
# - 左键射球，确认自行车被砸动
# - 碰撞时确认火花出现
# - 切换 demo（demo1→demo6→demo2），确认无泄漏/崩溃
```

**验收标准**:
- [ ] 四项构建/校验命令全部通过
- [ ] 浏览器中自行车物理行为正确（受重力、可被砸倒、不穿透地面）
- [ ] 高斯 splat 渲染效果与改造前一致
- [ ] 连续切换 demo 5 次无崩溃

---

## 附录 A: 文件变更总览

| 文件 | 动作 | 所属阶段 |
|------|------|----------|
| `public/plugins/core/components.json` | 改 | 1.1 |
| `public/plugins/physics/PhysicsSystem.ts` | 改 | 1.1 |
| `public/plugins/splat/GaussianSplatManager.ts` | 改 | 1.2 |
| `public/plugins/splat-physics/index.ts` | **新建** | 2.2 |
| `public/plugins/splat-physics/SplatCollider.ts` | **新建** | 2.1 |
| `public/plugins/splat-physics/tsconfig.json` | **新建** | 2.2 |
| `public/apps/demo6_3dgsViewer/app.json` | 改 | 3.1 |
| `public/apps/demo6_3dgsViewer/scene.json` | 改 | 3.1 |
| `public/apps/demo6_3dgsViewer/render.json` | 改 | 3.1 |
| `public/apps/demo6_3dgsViewer/scripts/game.js` | **新建** | 3.2 |

总计: **6 新建 + 4 修改 = 10 个文件**，`src/` 零改动。

---

## 附录 B: 架构图

```
┌─────────────────────────────────────────────────────────┐
│  demo6 scene.json                                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ GsEntity │  │ PhysicsWorld │  │ Sparks/Emitter    │  │
│  │ (splat)  │  │ + Ground     │  │ + GameState      │  │
│  └────┬─────┘  └──────────────┘  └──────────────────┘  │
│       │                                                  │
└───────┼──────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│  splat-physics 插件 (appLoaded)       │
│                                       │
│  ① getCenters() ◄── splats attachment │
│  ② voxelCluster() + convexHull()     │
│  ③ createCompoundBody(eid, hulls)    │
│  ④ 写入 RigidBodyComponent           │
│     ┌─────────────────┐              │
│     │  GsEntity        │              │
│     │  Transform ◄─── PhysicsSystem  │
│     │    │                ▲           │
│     │    ▼                │           │
│     │  GaussianSplatMgr  │           │
│     │  (sort + render)   │           │
│     └─────────────────┘              │
└───────────────────────────────────────┘

渲染管线:
  Opaque:  Grid → PbrSolid → [PhysicsDebug]
  Transparent: Splat (splat.draw hook) → Particles
```

---

## 附录 C: 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| convex hull 生成太慢（阻塞主线程 > 5s） | 增大 stride、减小 gridRes | 改回静态展示，用预烘焙碰撞体 |
| 凸包数量太多导致物理性能下降 | 限制 maxHulls=30，合并小 hull | 减少 gridRes |
| compound 碰撞体形状不匹配 splat 视觉 | PhysicsDebug 线框可视化校对 | 调整 gridRes/stride 参数 |
| 多个凸包组合导致自行车"粘"在地上 | 调整 density/friction 参数 | — |
| splat 排序与物理更新时序冲突 | gaussianSplat 在 physics 之后执行（systems.json 已保证） | — |

---

## 附录 D: 后续扩展方向

1. **Web Worker 凸包计算**: 将 `voxelCluster` + `convexHull` 移到 Worker，避免主线程卡顿
2. **预烘焙碰撞体**: 首次生成后将 convexVerts 序列化缓存，下次直接加载
3. **碎块效果**: 自行车被砸后，各凸包分离为独立刚体（碎块飞溅）
4. **多 splat 实体**: 与 Task 2.1（原 PLAN.md）联动，支持多辆自行车同时物理交互
