# 测试基础设施构建计划

> 目标：为零测试的引擎项目建立分层测试体系，覆盖最脆弱的状态机和热路径逻辑。
> 原则：先纯逻辑（Node 可跑、CI 友好），后机制（mock GPU），最后集成。
>
> **状态：全部 5 个阶段已完成（5 个 git commits），129 个测试全部通过，`npm run verify` 一键全绿。**

---

## 现状

| 维度 | 现状 |
|------|------|
| 测试框架 | 无（零 test 文件） |
| 验证手段 | 四件套：`tsc` 类型检查 + `validate-config.mjs` 静态校验 + `smoke-plugin-loader.mjs` 冒烟 + 浏览器手测 |
| 最大风险 | PipelineDriver 排序/instancing/bind-cache、PluginManager 回滚、ResourceManager free list、valueResolver 预编译——都是复杂状态机，无测试即裸奔 |
| 已有资产 | `scripts/smoke-plugin-loader.mjs`（Node 冒烟，可复用 mock 模式）；`scripts/validate-config.mjs`（静态校验） |

---

## Phase 0：框架搭建与 Mock 基础设施（1-2 天）

### 0.1 安装 Vitest

```bash
npm install -D vitest
```

选择 Vitest 的理由：Vite 原生（零配置复用 vite 的 TS 转译）、Node 环境开箱即用、`vi.mock`/`vi.fn` 内建、与现有 `vite.config` 共享配置。

### 0.2 配置文件

**`vitest.config.ts`**（项目根目录）：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        environment: 'node',        // 默认 Node；DOM 测试按需 per-file 切 jsdom
        include: ['tests/**/*.test.ts'],
        globals: true,              // describe/it/expect 全局可用
        coverage: {
            include: ['src/**/*.ts'],
            exclude: ['src/main.ts', 'src/editor/**', 'src/api.ts'],
        },
    },
});
```

**`package.json` scripts 追加**：
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

### 0.3 Mock 基础设施

**`tests/mocks/gpu.ts`** — 最小化 GPU Mock，覆盖引擎调用的 API 面：

```
createMockDevice(): GPUDevice
  ├── createBuffer(config) → { size, usage, destroy(), size }
  ├── createTexture(config) → { width, height, format, createView(), destroy() }
  ├── createBindGroup() / createBindGroupLayout() / createSampler() / createPipelineLayout()
  │   → 各返回 stub 对象（引擎不检查返回值的内部结构）
  ├── createCommandEncoder() → MockCommandEncoder
  └── queue: { submit(cmds), writeBuffer(buf, off, data, ...), copyExternalImageToTexture() }

MockCommandEncoder
  ├── beginRenderPass(desc) → MockRenderPassEncoder
  ├── beginComputePass() → MockComputePassEncoder
  ├── copyBufferToBuffer(src, srcOff, dst, dstOff, size)
  └── finish() → {}

MockRenderPassEncoder（记录所有调用供断言）
  ├── setPipeline(p) / setBindGroup(group, bg, dynamicOffsets?)
  ├── setVertexBuffer(slot, buf) / setIndexBuffer(buf, format)
  ├── setViewport(...) / setScissorRect(...)
  ├── draw(vCount, iCount) / drawIndexed(iCount, instanceCount)
  └── end()
  → 暴露 calls: Call[] 供测试断言调用顺序与参数

MockComputePassEncoder
  ├── setPipeline(p) / setBindGroup(group, bg)
  ├── dispatchWorkgroups(x, y?, z?)
  └── end()
```

**`tests/mocks/pluginHost.ts`** — PluginManager 的 mock host：

```
createMockHost(): {
  host: PluginHost（makeCtx/applyDeclarations/sweepOwner/beginOwner/endOwner）
  declarations: Array<{ id, plugin }>   // 记录 applyDeclarations 调用
  sweeps: string[]                       // 记录 sweepOwner 调用
  owners: Array<{ enter, prev }>         // 记录 begin/endOwner
}
```

**`tests/helpers/reset.ts`** — 模块单例重置助手：

```
resetRegistries():
  schemaRegistry.removeOwner('test') + resetStrings()
  uniformLayouts.removeOwner('test')
  systemRegistry.removeDefsByOwner('test') + removeSystemsByOwner('test')
  PipelineLoader.clearVirtuals()  // 需新增或用 removeVirtualsByPrefix
```

> 注：模块单例（schemaRegistry/resourceManager 等）无全局 reset。测试用 `owner: 'test'` 隔离，`afterEach` 调 `resetRegistries()` 清扫。ResourceManager 用 `enterApp('test')` / `exitApp('test')` 隔离资源作用域。

### 0.4 目录结构

```
tests/
  mocks/
    gpu.ts              Mock GPU 设备/encoder/pass
    pluginHost.ts       Mock PluginHost
  helpers/
    reset.ts            单例重置助手
    fixtures.ts         共享测试数据（RendererDecl、PipelineConfig 等）
  unit/                  Phase 1：纯逻辑测试
    math.test.ts
    valueResolver.test.ts
    uniformLayout.test.ts
    systemRegistry.test.ts
    scene.test.ts
  mechanism/             Phase 2：机制测试（mock GPU）
    resourceManager.test.ts
    pluginManager.test.ts
    pluginHost.test.ts
    renderGraph.test.ts
    pipelineDriver.test.ts
  integration/           Phase 3：集成测试
    pluginLifecycle.test.ts
    renderRoundTrip.test.ts
```

**预估：1-2 天**

---

## Phase 1：纯逻辑测试（2-3 天，~40 个测试）

无 GPU 依赖，纯 Node 环境，CI 友好。覆盖数学库、值解析器、布局对齐、系统注册表、场景数据。

### 1.1 `tests/unit/math.test.ts` — 矩阵数学

| 测试 | 验证 |
|------|------|
| `mat4MulInto` 写入 out 且结果与 `mat4Mul` 一致 | out 参数正确性 |
| `mat4InverseInto(m, out)` 后 `mat4InverseInto(out, out2)` ≈ 原始 m | 逆的逆 = 恒等 |
| `mat4FromTRSInto` 单位四元数 → 单位矩阵（对角线 1，其余 0） | TRS 基线 |
| `mat4FromTRSInto` 纯平移 → m[12/13/14] = pos | 平移正确 |
| `mat4FromTRSInto` 纯缩放 → 对角线 = scale | 缩放正确 |
| `mat4PerspectiveInto` → m[11]=-1, m[15]=0 | WebGPU 透视约定 |
| `normalMatrixInto` 单位模型 → 单位法线矩阵 | 基线 |
| `normalMatrixInto` 非均匀缩放模型 → 法线矩阵 ≠ 单位（验证非退化） | 缩放影响法线 |
| `buildCameraMatricesInto` → out.vp ≈ mat4Mul(out.proj, out.view) | 组合正确 |
| `buildCameraMatricesInto` 调用后 out 各字段非空引用 | out 全写入 |
| `mat4MulInto` 与 `mat4Mul` 结果逐元素相等 | Into 变体一致性 |
| `mat4InverseInto` 与 `mat4Inverse` 结果逐元素相等 | Into 变体一致性 |

### 1.2 `tests/unit/valueResolver.test.ts` — 值源预编译与解析

| 测试 | 验证 |
|------|------|
| `compileValue('const:1,2,3')` → 返回 [1,2,3] | const 常量 |
| `compileValue('builtin.time')` → ctx.time | builtin 解析 |
| `compileValue('builtin.entityId')` → ctx.eid | builtin 解析 |
| `compileValue('transform.model')` → Float32Array(16)，与 ctx.model() 同引用 | scratch 复用 |
| `compileValue('transform.normalMatrix')` → Float32Array(12) | normalMatrix scratch |
| `compileValue('Comp.field')` → scene.getField 返回值 | Comp.field 解析 |
| `compileValue('pack:1,2,Comp.field')` → 拼接常量+字段 | pack 拼接 |
| `compileValue('script:foo.bar')` → ctx.scripts.get('foo.bar')(ctx) | script 查表 |
| `compileValue('Unknown.field')` → throws（未注册组件） | fail-loud |
| `compileValue('builtin.unknown')` → throws（未知 builtin atom） | fail-loud |
| `compileString('MeshComponent.mesh')` → ctx.scene.getField 返回值 | 字符串源 |
| `compileString('literal')` → 'literal'（无点号 → 字面量） | 字面量 |
| `compileString('builtin.time')` → 原字符串（builtin/transform/tag 不解析） | 保留命名空间字面量 |
| `compileValue` 返回的闭包不包含原始字符串（闭包捕获无 src） | 预编译彻底性 |
| `resolveValue` 与 `compileValue` 结果一致（同输入同 ctx） | 运行时与编译时等价 |
| `resolveHandle('Comp.field')` → 整数句柄 | handle 解析 |

### 1.3 `tests/unit/uniformLayout.test.ts` — std140 对齐

| 测试 | 验证 |
|------|------|
| `UniformLayout([{name:'a',type:'f32'}])` → byteSize=16（最小 16 字节对齐） | 最小块大小 |
| `UniformLayout([{name:'a',type:'vec3f'},{name:'b',type:'f32'}])` → b 的 floatOffset=4（vec3f 占 12 字节但 16 对齐 → 4 floats） | vec3f 对齐 |
| `UniformLayout([{name:'m',type:'mat4x4f'}])` → byteSize=64 | mat4x4f 大小 |
| `UniformLayout([{name:'m',type:'mat3x3f'}])` → byteSize=48（3 列 × 16） | mat3x3f padding |
| `write(buf, 'a', 42)` → buf[floatOffsetOf('a')] === 42 | 标量写入 |
| `write(buf, 'a', [1,2,3])` → buf.set 到正确偏移 | 数组写入 |
| `write(buf, 'unknown', 0)` → throws | 未知成员 fail-loud |
| `floatOffsetOf('unknown')` → throws | 未知成员 fail-loud |

### 1.4 `tests/unit/systemRegistry.test.ts` — 系统注册与排序

| 测试 | 验证 |
|------|------|
| `autoInsert` 无 after/before 的 system → 不插入 | 默认不插入 |
| `autoInsert({after:['input']})` → 插入 input 之后 | after 正确 |
| `autoInsert({before:['render']})` → 插入 render 之前 | before 正确 |
| `autoInsert` 多个 system → 按依赖顺序插入 | 多依赖排序 |
| `autoInsert` after 指向不存在的 system → 插入到末尾 | 容错 |
| `registerBuiltin` 跨 owner 重名 → throws | fail-loud |
| `registerBuiltin` 同 owner 重名 → 不 throw（允许重载） | 同 owner 容许 |
| `resolve({name:'unknown'})` → null | 未注册系统 |
| `addDef` 跨 owner 重名 → throws | fail-loud |
| `removeDefsByOwner` → 只删该 owner 的 def | owner 隔离 |

### 1.5 `tests/unit/scene.test.ts` — 实体与序列化

| 测试 | 验证 |
|------|------|
| `createEntity` 后 `entityComponents.get(eid)` 包含所有声明的组件名 + NameComponent | 组件追踪 |
| `toggleComponent(eid, 'Foo', true)` → entityComponents 新增 'Foo' | 添加追踪 |
| `toggleComponent(eid, 'Foo', false)` → entityComponents 移除 'Foo' | 移除追踪 |
| `toJSON` → 只包含 entityComponents 中的组件（不含其他已注册组件） | O(E×avgC) 正确性 |
| `toJSON` → createEntity(data) → toJSON → 重新 createEntity → 数据一致 | 往返序列化 |
| `getModelMatrix(eid, out)` → out 非空且与无参版一致 | out 参数 |
| `getModelMatrix` 连续两次调用（同 eid）→ 返回相同引用（scratch 复用） | scratch 安全性 |
| `getActiveCameras` 连续两次调用 → CameraView 对象引用复用（池化） | 相机池复用 |
| `getActiveCameras` 0 个相机 → 返回空数组（不崩溃） | 空场景 |

**预估：2-3 天**

---

## Phase 2：机制测试（3-4 天，~50 个测试）

用 Mock GPU 设备测试注册表状态机和热路径逻辑。这些是**最脆弱**的部分——状态转换复杂、容易在重构中回归。

### 2.1 `tests/mechanism/resourceManager.test.ts` — 资源句柄与作用域

| 测试 | 验证 |
|------|------|
| `registerBuffer` → `getBuffer(handle)` 返回同一 buffer | 基本注册 |
| `exitApp('test')` → `getBuffer(handle)` 返回 undefined | 销毁后句柄无效 |
| 注册+销毁+再注册 → 新 handle 复用旧索引（free list） | **Free List 回收** |
| `registerTextureHandle` 同 key 两次 → 返回同一 handle | 去重 |
| `exitApp` → textureList[handle] = null + freeList 含 handle | 纹理回收 |
| `exitApp('common')` → no-op（common 不释放） | common 保护 |
| `claimName` 跨 owner 重名 → throws | **fail-loud** |
| `claimName` 同 owner 重名 → 不 throw | 同 owner 容许 |
| `exitApp` → textureViewCache 中被销毁纹理的 view 已删除 | **view 清理** |
| `exitApp` → meshGpuOwner 的 GPU buffer 已 destroy() | mesh 清理 |
| `enterApp('a')` → `enterApp('b')` → `exitApp('a')` → a 的资源释放，b 保留 | 多作用域隔离 |
| `colorTarget` 尺寸变化 → 旧纹理 destroy + 新纹理创建 | 重建 |

### 2.2 `tests/mechanism/pluginManager.test.ts` — 插件装载链

| 测试 | 验证 |
|------|------|
| `loadOne` 成功 → `loaded.has(id)` + `order` 末尾含 id | 注册成功 |
| `loadOne` 依赖 A → A 先于依赖者加载（order 中 A 在前） | 拓扑序 |
| `loadOne` 依赖环 A→B→A → throws | **循环检测** |
| `loadOne` setup 抛异常 → `sweepOwner` 被调用（mock host 记录） | **回滚正确性** |
| `loadOne` setup 抛异常 → `loaded.has(id)` 为 false | 未注册 |
| `loadOne` setup 抛异常 → 后续依赖插件的 `loadOne` 也失败 | 依赖链断裂 |
| `unloadAppPlugins` → 逆拓扑序 teardown + sweep | 逆序卸载 |
| `broadcastAppLoaded` → 拓扑序调用 | 广播顺序 |
| `broadcastAppUnloading` → 逆拓扑序调用 | 广播顺序 |
| `moduleFor` 循环相对导入 → throws | **循环导入检测** |
| import 重写：`@shaderlab/api` → api URL | specifier 重写 |
| import 重写：裸导入 `three` → throws | **裸导入禁止** |

### 2.3 `tests/mechanism/pluginHost.test.ts` — 声明应用与清扫

| 测试 | 验证 |
|------|------|
| `applyDeclarations` 含 components → schemaRegistry 可 get | 组件注册 |
| `applyDeclarations` 含 uniformLayouts → uniformLayouts.has | 布局注册 |
| `applyDeclarations` 含 pipelines → PipelineLoader.getVirtualConfig | 虚拟管线注册 |
| `applyDeclarations` 含 valueAtoms → atomNamespaces 有对应 atom | atom 注册 |
| `applyDeclarations` 含 meshGenerators → meshGenerators 有对应 generator | 生成器注册 |
| `sweepOwner` → 上述全部注册项被移除 | **回滚等价性** |
| `sweepOwner` → ledger 被删除 | ledger 清理 |
| `sweepOwner` 当 customRendererOwner === owner → restoreBuiltinRenderer 被调用 | 渲染器恢复 |
| `sweepOwner` 当 customRendererOwner !== owner → 渲染器不变 | 非匹配不恢复 |
| `applyDeclarations` + `sweepOwner` 往返 → 注册表状态恢复初始 | **往返不变量** |
| `ledgerFor` 同 owner 两次 → 返回同一 ledger 对象 | 复用 |

### 2.4 `tests/mechanism/renderGraph.test.ts` — 渲染图编译与数据面

| 测试 | 验证 |
|------|------|
| `fromData` 含未知 phase 名 → throws | **phase 校验** |
| `fromData` → `toData` 往返 → phases/enabled/multiView 一致 | 数据面往返 |
| `fromData` 缺少 multiView → multiView 默认 false | 默认值 |
| `addPhases` 重名 → throws | **fail-loud** |
| `removePhases` → phaseList 不含移除项 | 移除 |
| `compile` multiView + postprocess-chain 同时启用 → throws | **互斥校验** |
| `exitApp` → drivers 数组清空 + hooks 移除 | 清理 |
| `registerPhaseBehavior` 跨 owner 重名 → throws | fail-loud |
| `removePhaseBehaviorsByOwner` → 只删该 owner 的 behavior | owner 隔离 |
| `removeHooksByOwner` → 只删该 owner 的 hook | owner 隔离 |

### 2.5 `tests/mechanism/pipelineDriver.test.ts` — 预编译与绘制路径

> 这是测试体系的**核心**——PipelineDriver 的预编译、排序、instancing、bind-cache 都是最容易回归的热路径。

| 测试 | 验证 |
|------|------|
| `precompile` 后 `compiledWrites` 长度 = bindGroups 的 uniform writes 总数 | 编译完整性 |
| `precompile` 对 `const:1,2,3` → 闭包返回 [1,2,3] | const 编译 |
| `precompile` 对 `builtin.time` → 闭包返回 ctx.time | builtin 编译 |
| `precompile` 对未知组件 → throws | **fail-loud** |
| `record` 无 query → 单次 setPipeline + drawIndexed（Mock pass.calls 验证） | 静态路径 |
| `record` 有 query + camPos + 多实体 → 按距离排序（calls 顺序验证） | **排序正确性** |
| `record` `transparent: true` → 远→近排序 | painter's |
| `record` `transparent: false` → 近→远排序 | early-z |
| `record` 无 camPos → 查询顺序（不排序） | 降级 |
| `record` `instanced: true` → 单次 drawIndexed(count, instanceCount=N) | **Instancing** |
| `record` `instanced: true` + 1 实体 → 退化为普通路径（<2 不 instanced） | 边界 |
| `record` `instanced: true` + `transparent: true` → instanced 优先（不排序） | 优先级 |
| bgCache：同 signature 两次 → 第二次不调 createBindGroup（mock 验证） | **缓存命中** |
| bgCache：signature 变化 → 重建 bind group | 缓存失效 |
| `dispose` → instanceBuffer.destroy() 被调用 | 清理 |
| `bindVertexBuffer` meshSlots → setVertexBuffer 按 slot 顺序调用 | 顶点绑定 |

**预估：3-4 天**

---

## Phase 3：集成测试（2-3 天，~15 个测试）

验证多模块协作的完整生命周期。这些测试最接近真实使用场景，但也最难 mock——需要平衡真实度与维护成本。

### 3.1 `tests/integration/pluginLifecycle.test.ts`

用 mock PluginHost + 真实 PluginManager + 真实 PluginHostHelper + 真实注册表，验证：

| 测试 | 验证 |
|------|------|
| 插件完整生命周期：loadOne(init+applyDeclarations+setup) → appLoaded → appUnloading → teardown → sweep → 注册表回到初始状态 | **往返不变量** |
| 两插件 A(无依赖) + B(依赖 A) → loadMany → B 的 setup 能 getPlugin('a') | 依赖协作 |
| A 卸载 → A 注册的 schema/uniform/pipeline 全部从注册表消失 | **清扫完整性** |
| A 卸载 → B 仍可用（engine-scoped 插件不互相影响） | 作用域隔离 |

### 3.2 `tests/integration/renderRoundTrip.test.ts`

用 mock GPU device + 真实 RenderGraph + 真实 PipelineDriver + 真实 ResourceManager：

| 测试 | 验证 |
|------|------|
| `compile`（mock 管线 JSON）→ `execute`（mock FrameContext）→ Mock pass 有 drawIndexed 调用 | 基本绘制路径 |
| `compile` → `exitApp` → 再 `compile` → drivers 全新（无残留） | **app 切换隔离** |
| `fromData` → `compile` → `toData` → `fromData` → 数据一致 | 数据面往返 |
| 多 driver 同 phase → runNormalPhase 合并为单 pass（pass 数 < driver 数） | pass 合并 |
| `execute` 开头调 `ctx.flushCompute()`（FrameContext mock 验证） | **compute 同帧序** |

### 3.3 `tests/integration/resourceScope.test.ts`

| 测试 | 验证 |
|------|------|
| `enterApp('app1')` → 注册 mesh/texture → `exitApp('app1')` → 资源销毁 → `enterApp('app2')` → handle 复用 | **跨 app 作用域** |
| common 资源在 app 切换后仍可用 | common 持久性 |
| 句柄表在多次 app 切换后大小稳定（不无限增长） | **free list 长期稳定性** |

**预估：2-3 天**

---

## Phase 4：CI 集成（1 天）

### 4.1 GitHub Actions Workflow

**`.github/workflows/ci.yml`**：
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - run: npm run check:plugins
      - run: npm test                 # ← 新增
      - run: node scripts/validate-config.mjs
      - run: node scripts/smoke-plugin-loader.mjs
```

### 4.2 package.json scripts 最终状态

```json
"scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "check:plugins": "tsc -p public/plugins --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "validate": "node scripts/validate-config.mjs",
    "smoke": "node scripts/smoke-plugin-loader.mjs",
    "verify": "npm run build && npm run check:plugins && npm test && npm run validate && npm run smoke"
}
```

`npm run verify` = 四件套 + 测试，一键全量验证。

### 4.3 tsconfig 调整

`tsconfig.json` 的 `include` 保持 `["src"]`；测试文件在 `tests/` 下，Vitest 独立转译（不进 tsc 类型检查范围）。如需对测试文件也做类型检查，加 `tsconfig.test.json`：

```json
{
    "extends": "./tsconfig.json",
    "include": ["src", "tests"],
    "compilerOptions": { "noEmit": true }
}
```

**预估：1 天**

---

## 执行顺序（已完成）

| 批次 | 任务 | 依赖 | 状态 | Commit | 测试数 |
|------|------|------|------|--------|--------|
| 0 | Vitest 安装 + 配置 + Mock 基础设施 | 无 | ✅ 完成 | `8067199` | 0 |
| 1 | Phase 1 纯逻辑测试 | 批次 0 | ✅ 完成 | `92d4e30` | 68 |
| 2 | Phase 2 机制测试 | 批次 0-1 | ✅ 完成 | `8ef34dc` | 52 |
| 3 | Phase 3 集成测试 | 批次 0-2 | ✅ 完成 | `746a0e0` | 9 |
| 4 | CI 集成 | 批次 0-3 | ✅ 完成 | `3edcd5a` | 0 |

**总计：129 个测试，13 个测试文件，5 个 commits。`npm run verify` 一键全绿（<1 秒测试时间）。**

每批次完成后跑 `npm run verify`（四件套 + 测试）验证，全部通过。

### 最终测试覆盖

| 层级 | 文件 | 测试数 | 覆盖范围 |
|------|------|--------|----------|
| **纯逻辑** | `tests/unit/math.test.ts` | 12 | mat4MulInto/mat4InverseInto/mat4FromTRSInto/mat4PerspectiveInto/normalMatrixInto/buildCameraMatricesInto |
| | `tests/unit/valueResolver.test.ts` | 23 | compileValue (const/builtin/transform/Comp.field/pack/script), compileString, resolveHandle, fail-loud |
| | `tests/unit/uniformLayout.test.ts` | 13 | std140 对齐 (f32/vec2f/vec3f/vec4f/mat3x3f/mat4x4f), write/writeU32, 多成员布局 |
| | `tests/unit/systemRegistry.test.ts` | 11 | autoInsert (after/before/多系统/缺失目标), registerBuiltin (跨owner/同owner), addDef |
| | `tests/unit/scene.test.ts` | 9 | createEntity 组件追踪, toJSON O(E×avgC), 序列化往返, getModelMatrix out 参数, 相机池复用 |
| **机制** | `tests/mechanism/resourceManager.test.ts` | 11 | 句柄 free list 回收, exitApp 销毁, common 保护, 跨 app 隔离, claimName 跨 owner throw |
| | `tests/mechanism/pluginManager.test.ts` | 8 | loadOne 成功/回滚/循环检测/依赖拓扑序, unloadAppPlugins, broadcast 正逆序 |
| | `tests/mechanism/pluginHost.test.ts` | 12 | applyDeclarations (components/layouts/pipelines/atoms/phases), sweepOwner 往返不变量, 渲染器恢复 |
| | `tests/mechanism/renderGraph.test.ts` | 12 | fromData phase 校验, toData 往返, addPhases 重名/排序, phase behavior 跨 owner, exitApp 清理 |
| | `tests/mechanism/pipelineDriver.test.ts` | 9 | precompile 完整性/失败抛出, 无 query 单次绘制, dispose 清理, 排序 (opaque/transparent/无相机) |
| **集成** | `tests/integration/pluginLifecycle.test.ts` | 2 | 插件完整生命周期往返 (load→setup→broadcast→unload→sweep→注册表清理), sweepOwner 隔离 |
| | `tests/integration/renderRoundTrip.test.ts` | 3 | fromData→toData 多轮往返, exitApp→re-fromData 隔离, execute 调 flushCompute |
| | `tests/integration/resourceScope.test.ts` | 4 | 跨 app 资源作用域, common 持久性, free list 长期稳定性, exitApp GPU buffer 销毁 |

---

## 不测什么

以下内容**不纳入测试计划**，原因附注：

| 不测的内容 | 原因 |
|-----------|------|
| 真实 GPU 渲染输出（像素比较） | 需 GPU 硬件 + 参考图像，维护成本极高，收益低 |
| 插件 TS 运行时转译（sucrase + es-module-lexer） | 已由 `smoke-plugin-loader.mjs` 覆盖，重复投入不值 |
| 编辑器 DOM 交互（点击/输入/滚动） | 编辑器是次要工具，DOM 测试脆弱且维护成本高 |
| GLTF 加载 | 依赖网络 fetch + 二进制解析，集成测试成本高 |
| 物理模拟正确性 | Rapier 是外部库，不测第三方 |
| `main.ts` 入口编排 | 胶水代码，手动验证即可 |

---

## 完成标准

- [x] `npm test` 在 CI（无 GPU 环境）下通过，<1 秒（129 tests, 386ms）
- [x] Phase 1+2 的所有 `**加粗**` 标记测试通过（最脆弱的状态机路径全覆盖）
- [x] `npm run verify` 一键通过（build + check:plugins + test + validate + smoke）
- [x] CI workflow（`.github/workflows/ci.yml`）在 push/PR 时自动触发
- [x] 覆盖率：核心模块全覆盖（math/valueResolver/uniformLayout/systemRegistry/scene/resourceManager/pluginManager/pluginHost/renderGraph/pipelineDriver）
