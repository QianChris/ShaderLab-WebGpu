# GPU PBD 软体仿真 — 算法文档

## 1. 概述

Position-Based Dynamics (PBD) 是一种基于位置的物理仿真方法。与传统基于力的方法不同，PBD 直接在位置空间求解约束，避免了力/加速度积分带来的数值不稳定。

本 demo 在 WebGPU compute shader 上实现了 PBD 软体仿真：一个 5×5×5 粒子网格组成的立方体从空中自由落体，撞到地板 (y=0) 后弹跳数次。

### 核心循环（每帧）

```
1. Predict  — v += g·dt;  p_pred = p + v·dt          (1 个 compute pass)
2. Solve    — 投影距离约束 × solverIterations 轮      (每轮 8 个 color pass)
3. Integrate — v = (p_pred - p) / dt · damping;  p = p_pred  (1 个 compute pass)
```

## 2. 文件结构

```
public/plugins/pbd/
  index.ts                          插件入口：声明组件/布局/hook，注册 PbdManager attachment
  PbdManager.ts                     GPU 资源管理：buffer 创建、约束染色、simulate/draw 驱动
  hooks/pbd.ts                      3 个 render hook：simulate(Compute) / draw(Geometry) / floor(Geometry)
  components.json                   PbdSoftBodyComponent schema
  uniform-layouts.json              pbdParams UBO 布局 (32 bytes)
  bind-layouts.json                 pbdPredict / pbdSolve / pbdIntegrate / pbdDraw
  pipelines/
    PbdPredictPipeline.json         compute: predict.wgsl
    PbdSolvePipeline.json           compute: solve.wgsl
    PbdIntegratePipeline.json       compute: integrate.wgsl
    PbdDrawPipeline.json            render: 表面网格 + compute.script + aux 预加载
    PbdFloorPipeline.json           render: 地板棋盘格
  shaders/
    PbdPredict.wgsl                 Step 1
    PbdSolve.wgsl                   Step 2
    PbdIntegrate.wgsl               Step 3
    PbdDraw.wgsl                    表面网格渲染
    PbdFloor.wgsl                    地板渲染

public/apps/demo9_softBody/
  app.json                          plugins: ["pbd", "orbit"]
  scene.json                        MainCamera / Environment / SunLight / SoftBody / ResetController
  render.json                       Opaque: [Floor, SoftBody]
  scripts/reset.js                  R 键 = PBD 重置, Shift+R = 全量重载
```

## 3. GPU Buffer 布局

每个 soft body entity 对应一组 buffer，在 `PbdManager.ensure()` 中首次访问时创建。

### 3.1 粒子数据 (vec4f × particleCount)

| Buffer       | .xyz        | .w         | Usage                                    |
|--------------|-------------|------------|------------------------------------------|
| `positions`  | 当前位置    | invMass    | STORAGE \| VERTEX \| COPY_DST            |
| `predicted`  | 预测位置    | invMass    | STORAGE \| COPY_DST                     |
| `velocities` | 速度        | pinned标志 | STORAGE \| COPY_DST                      |

- `invMass = particleCount / totalMass`（默认 125 / 1.0 = 125.0）
- `pinned` = `v.w > 0.5` 时粒子冻结（本 demo 未使用 pinning）
- 所有粒子 buffer 用 `mappedAtCreation: true` 初始化，避免 `queue.writeBuffer` 与 compute encoder 的竞态

### 3.2 约束数据 (vec4f × (1 + count)，共 8 个 buffer)

每个颜色（color 0..7）一个 buffer：

```
constraints[0]     = vec4(count_as_u32, 0, 0, 0)     ← 首元素 .x = 该色约束数
constraints[1..N]  = vec4(a_as_u32, b_as_u32, rest_f32, compliance_f32)
```

- `a`, `b` = 粒子索引，以 **u32 原始位** 存储，shader 用 `bitcast<u32>()` 读取
- `rest` = 静止长度（= cellSize = 0.4）
- `compliance` = 柔度（0 = 完全刚性，越大越软）
- 同一 ArrayBuffer 上挂 `Uint32Array` + `Float32Array` 视图分别写 u32/f32

### 3.3 表面索引 (u32 × surfaceVertexCount)

```
surfaceIndices[vi] = 粒子索引
```

- 6 面 × (gridN-1)² 四边形 × 2 三角形 × 3 顶点
- gridN=5 时 = 6 × 16 × 6 = 576 个顶点
- 渲染时无 vertex buffer，vertex shader 直接用 `vertex_index` 查此 buffer

### 3.4 UBO: pbdParams (32 bytes, std140)

| 偏移 | 字段                | 类型 | 说明                        |
|------|---------------------|------|-----------------------------|
| 0    | dt                  | f32  | 帧时间步长（已钳制到 1/30） |
| 4    | time                | f32  | 累计时间                    |
| 8    | gravityY            | f32  | Y 方向重力加速度            |
| 12   | damping             | f32  | 每帧速度衰减系数            |
| 16   | solverIterations    | u32  | 求解器迭代轮数              |
| 20   | particleCount       | u32  | 粒子总数                    |
| 24   | restitution        | f32  | 地板弹性系数                |
| 28   | _pad0               | f32  | 对齐填充                    |

UBO 在 `ensure()` 中用 `mappedAtCreation` 初始化为正确默认值，每帧由 `writeUbo()` 通过 `queue.writeBuffer` 更新 dt/time。

## 4. Bind Group 布局

### pbdPredict (group 0)
| binding | 类型               | 资源         |
|---------|--------------------|--------------|
| 0       | storage (rw)       | positions    |
| 1       | storage (rw)       | predicted    |
| 2       | storage (rw)       | velocities   |
| 3       | uniform            | pbdParams    |

### pbdSolve (group 0)
| binding | 类型               | 资源                 |
|---------|--------------------|----------------------|
| 0       | storage (rw)       | predicted            |
| 1       | read-only-storage  | constraints[color]   |
| 2       | uniform            | pbdParams            |

### pbdIntegrate (group 0)
| binding | 类型               | 资源         |
|---------|--------------------|--------------|
| 0       | storage (rw)       | positions    |
| 1       | storage (rw)       | predicted    |
| 2       | storage (rw)       | velocities   |
| 3       | uniform            | pbdParams    |

### pbdDraw (group 1, group 0 = frame)
| binding | 类型               | 资源           |
|---------|--------------------|----------------|
| 0       | read-only-storage  | positions      |
| 1       | read-only-storage  | surfaceIndices |

## 5. 算法详解

### 5.1 Step 1 — Predict (`PbdPredict.wgsl`)

**输入**: positions[i], velocities[i], params(dt, gravityY, particleCount)
**输出**: predicted[i]

```wgsl
accel = (0, gravityY, 0)
newVel = v.xyz + accel * dt          // 半隐式 Euler
newPos = p.xyz + newVel * dt
predicted[i] = vec4f(newPos, p.w)    // 保留 invMass
```

- pinned 粒子 (v.w > 0.5): `predicted[i] = p`（不移动）
- predict 不做地板碰撞（由 solve 负责）
- dispatch: `ceil(particleCount / 64)` 个 workgroup

### 5.2 Step 2 — Solve (`PbdSolve.wgsl`)

**输入**: predicted[a/b], constraints[i], params(compliance)
**输出**: predicted[a/b]（就地修改）

#### 距离约束投影公式

对约束 (a, b)，静止长度 L：

```
delta = pb - pa
dist  = |delta|
diff  = (dist - L) / dist            // 归一化位移偏差
stiffness = 1 - clamp(compliance, 0, 0.95)
correction = delta * 0.5 * diff * stiffness

pa.xyz -= correction * (wa / (wa + wb))
pb.xyz += correction * (wb / (wa + wb))
```

- `wa`, `wb` = 粒子逆质量 (predicted.w)
- `wsum < 1e-6` 时跳过（两端都无限重）
- **0.5 因子** = PBD 松弛参数，每轮只修正 50% 误差，8 轮后收敛到 ~99.6%
- 等质量时每粒子实际移动 = `0.25 * diff * delta`（25% 误差修正/轮）

#### 地板碰撞

```
if (pa.y < 0) pa.y = 0    // 硬夹紧到 y >= 0
if (pb.y < 0) pb.y = 0
```

在约束投影后立即执行，确保粒子不会穿透地板。

#### 边染色（Edge Coloring）—— 并行安全

**问题**: 多个约束共享同一粒子时，并行写入 `predicted[a]` 会产生竞态。

**方案**: CPU 上贪心 8-色染色，保证同一颜色内没有任何两个约束共享粒子。

```
for each constraint (a, b):
    用过的颜色 = adjColor[a] ∪ adjColor[b]
    chosen = 第一个不在用过的颜色集合中的颜色 (0..7)
    adjColor[a].add(chosen)
    adjColor[b].add(chosen)
```

- 3D 网格结构约束最大度 = 6（内部粒子 ±X ±Y ±Z），8 色足够
- 每色独立 compute pass（pass 间有 GPU 屏障），保证顺序
- `solverIterations` 轮 × 8 色 = 最多 64 个 solve pass/帧

#### 约束 buffer 读取

```wgsl
count = bitcast<u32>(constraints[0].x)    // 首元素 = 该色约束数
c = constraints[1 + i]                      // 第 i 条约束
a = bitcast<u32>(c.x)                       // 粒子索引 A
b = bitcast<u32>(c.y)                       // 粒子索引 B
rest = c.z                                  // 静止长度
compliance = c.w                            // 柔度
```

- 索引以 u32 原始位存储，`bitcast<u32>()` 读取（不走 f32 截断）
- count=0 的颜色跳过 dispatch

### 5.3 Step 3 — Integrate (`PbdIntegrate.wgsl`)

**输入**: positions[i], predicted[i], velocities[i], params(dt, damping, restitution)
**输出**: positions[i], velocities[i]

```wgsl
newVel = (predicted.xyz - positions.xyz) / dt    // 从位置差反推速度

// 地板反射：粒子在地板上且有显著下落速度
if (pred.y < 0.001 && newVel.y < -0.3):
    newVel.y = -newVel.y * restitution             // Y 方向反射
    newVel.x *= 0.8                                 // 摩擦
    newVel.z *= 0.8

newVel *= damping                                   // 全局阻尼
positions[i] = predicted[i]                          // 更新位置
velocities[i] = vec4f(newVel, v.w)                   // 更新速度（保留 pinned 标志）
```

- `v.w > 0.5` (pinned): `positions[i] = predicted[i]`（位置更新但速度不变）
- 地板反射阈值 `-0.3 m/s` 防止静止微抖产生无限小弹
- damping = 0.995 → 每帧速度衰减 0.5% → 60fps 下每秒衰减 ~26%

### 5.4 渲染 — PbdDraw.wgsl

**无 vertex buffer**。vertex shader 用 `@builtin(vertex_index)` 查 `surfaceIndices`：

```wgsl
tri = vi / 3                         // 三角形索引
local = vi % 3                       // 三角形内顶点 (0/1/2)
ia = surfaceIndices[tri*3 + 0]       // 三个粒子的索引
ib = surfaceIndices[tri*3 + 1]
ic = surfaceIndices[tri*3 + 2]
pa = positions[ia].xyz               // 变形后的世界坐标
pb = positions[ib].xyz
pc = positions[ic].xyz
n = normalize(cross(pb - pa, pc - pa))  // 平面法线
```

- `abs(dot(n, LIGHT_DIR))` 双面 Lambert（法线方向不影响着色）
- 重心坐标边缘高亮：`min(bary.xyz)` 接近 0 时画边线
- `cullMode: none` → 双面渲染

### 5.5 地板渲染 — PbdFloor.wgsl

- 6 个硬编码顶点（2 三角形），无 vertex buffer
- 棋盘格 + 网格线 fragment shader
- `depthWriteEnabled: false` → 不写深度，软体始终可见

## 6. 每帧执行流

```
Engine.frame()
  → systems.json 顺序: input → orbitCamera → camera → light → render
  → render system → RenderGraph.execute()
    → 1. Compute hooks (共享 encoder):
         PbdDrawPipeline.compute → pbd.simulate hook
           → PbdManager.simulate(encoder, ...):
               writeUbo (queue.writeBuffer)
               Predict pass (1)
               Solve passes (iterations × colors, 最多 64)
               Integrate pass (1)
    → 2. Phase behaviors (render passes):
         Opaque:
           PbdFloorPipeline → pbd.floor hook → draw(6)
           PbdDrawPipeline → pbd.draw hook → draw(surfaceVertexCount)
    → 3. encoder.finish() → queue.submit()
```

## 7. 调试指南

### 7.1 Console 日志

`PbdManager.ensure()` 在首次创建时打印：
- `gridN`, `particleCount`, `invMass`
- 约束总数和每色分布
- 前 5 条约束
- 前 4 个粒子初始位置
- 染色验证（同色内约束不应共享粒子）

`PbdManager.simulate()` 前 5 帧打印 `dt` 和 `safeDt`。

### 7.2 常见问题排查

| 症状                     | 可能原因                                    | 排查方法                          |
|--------------------------|---------------------------------------------|-----------------------------------|
| 立方体不落下/全零        | UBO 未上传 → particleCount=0 → 全 early-return | 检查 WebGPU validation 错误       |
| 立方体爆炸                | encoder invalid → compute pass 未执行        | 检查 console 中的 WebGPU 错误     |
| 立方体穿地板              | solve 的 floor clamp 未生效                  | 检查 predicted.y 是否 < 0         |
| 立方体不弹                | restitution=0 或地板反射阈值过高             | 调低反射阈值 `-0.3` → `-0.1`      |
| 立方体太软/塌             | solverIterations 太少 或 compliance 太大    | 增加 iterations / 减小 compliance |
| 立方体抖动不停            | damping 太高或 restitution 太大             | 降低 damping / restitution        |
| 染色错误（console 报错）  | 边染色 bug → 并行竞态                       | 检查 `COLORING BUG` 日志          |

### 7.3 GPU Readback（如需验证 GPU 状态）

临时加回 readback 代码时，**必须给 positions buffer 加 `COPY_SRC` usage**：

```ts
const positions = dev.createBuffer({
    size: particleCount * stride,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
         | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // ← 加这个
    mappedAtCreation: true,
});
```

否则 `encoder.copyBufferToBuffer(positions, ...)` 会验证失败，**使整个 encoder invalid**，导致所有 compute pass 被丢弃。

### 7.4 关键时序约束

1. **`mappedAtCreation` 初始化**: 所有 buffer 在 `ensure()` 中用 `mappedAtCreation: true` 创建并写入初始数据。这避免了 `queue.writeBuffer` 与同一帧 compute encoder 的竞态。

2. **`writeUbo` 每帧更新**: UBO 的 dt/time 通过 `queue.writeBuffer` 更新。WebGPU 保证 queue 操作在 `submit()` 前完成，因此 compute pass 能读到最新 UBO。UBO 在创建时也有正确默认值作为后备。

3. **Compute pass 间屏障**: 每个 `beginComputePass()` / `end()` 对是一个同步点。Predict → Solve → Integrate 之间有隐式屏障，保证顺序执行。Solve 的 8 个颜色之间也有屏障，保证边染色的正确性。

4. **Compute → Render 屏障**: compute pass 写入 `positions`，render pass 读取 `positions`。两者在同一 encoder 内，pass 间有屏障，保证渲染读到最新位置。

## 8. 可调参数

在 `scene.json` 的 `PbdSoftBodyComponent` 中调整，或通过编辑器实时修改：

| 参数              | 默认  | 作用                           | 调参建议                        |
|-------------------|-------|--------------------------------|---------------------------------|
| gridN             | 5     | 网格分辨率 (gridN³ 粒子)       | 3=快速预览, 7=高精度(慢)        |
| cellSize          | 0.4   | 粒子间距(=约束静止长度)         | 与 gridN 乘积决定立方体大小     |
| gravity           | -9.81 | Y 方向重力                     | 正值=反重力, 0=无重力测试       |
| damping           | 0.995 | 每帧速度衰减                   | 0.99=更阻尼, 0.999=更有弹性     |
| solverIterations  | 8     | 约束求解轮数                   | 更多=更刚性但更慢, 4=软, 16=硬  |
| compliance        | 0.0   | 柔度 (0=刚性, >0=软)           | 0=完全刚性, 0.3=果冻感          |
| restitution       | 0.35  | 地板弹性                        | 0=不弹, 0.5=中等弹, 0.8=很弹    |
| mass              | 1.0   | 总质量 (分配到所有粒子)         | 仅影响相对 invMass, 同质量无影响 |

### Reset 操作

- **R 键**: 轻量 PBD 重置（`PbdManager.clear()` 销毁 GPU buffer，下一帧 `ensure()` 懒重建）
- **Shift+R**: 全量 app 重载（`switchApp('demo9_softBody')`）
- Console: `switchApp('demo9_softBody')`

## 9. 约束类型说明

当前仅实现 **结构约束**（沿 X/Y/Z 轴的相邻粒子距离约束）。未实现：

- **剪切约束** (Shear): 对角线方向，防止立方体剪切变形
- **弯曲约束** (Bend): 跨 2 格的粒子对，防止过度弯折
- **体积约束** (Volume): 四面体体积保持，防止体积压缩

如需添加，在 `PbdManager.ensure()` 的约束生成循环中加入：

```ts
// 剪切约束 (面对角线, rest = cellSize * sqrt(2))
if (i+1 < gridN && j+1 < gridN) all.push({ a, b: idxAt(i+1, j+1, k), rest: cellSize * 1.4142, comp: compliance });
// 弯曲约束 (跨2格, rest = cellSize * 2)
if (i+2 < gridN) all.push({ a, b: idxAt(i+2, j, k), rest: cellSize * 2, comp: compliance });
```

注意：增加约束会增加边染色所需的颜色数（最大度增加）。8 色可能不够，需要增加到 12 或 16 色。

## 10. 已踩的坑

1. **WGSL swizzle 复合赋值**: `pa.xyz -= correction` 在 naga (WGSL 编译器) 中非法。必须用 `pa = vec4f(pa.xyz - corr, pa.w)` 重建。

2. **`queue.writeBuffer` 竞态**: 在 compute hook 内部调 `queue.writeBuffer` 初始化 buffer，理论上 WebGPU 保证 queue 操作在 `submit` 前完成。但实测某些情况下数据未到达。改用 `mappedAtCreation: true` 彻底解决。

3. **`copyBufferToBuffer` 需 `COPY_SRC`**: debug readback 的 `encoder.copyBufferToBuffer(positions, ...)` 需要 positions buffer 有 `COPY_SRC` usage。没有的话，WebGPU 验证失败会使**整个 encoder invalid**，导致所有 compute pass 被丢弃——表现为立方体"爆炸"（位置永远是初始值）。

4. **dt 钳制**: Engine 的 `dt` 无上限。标签页切换/GC 停顿后首帧 dt 可能是几秒，predict 步大幅过冲导致爆炸。`simulate()` 中钳制到 `min(dt, 1/30)`。
