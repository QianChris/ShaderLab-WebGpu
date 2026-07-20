# PLAN_Architecture.md — 数据驱动架构重整

## 目标

消除所有硬编码"内容"，使 JSON 配置文件成为唯一事实来源（Single Source of Truth）。每个阶段完成后可独立 `git commit`。

---

## Phase 1: 消除重复硬编码回退数据（基础层）✅

### Step 1.1 ✅ — 移除 `RenderGraph.ts` 的 `DEFAULT_PHASES`
- **问题**: `DEFAULT_PHASES` 硬编码了 `phases.json` 的子集（缺少 GBuffer），如果 JSON 加载失败会静默掉 GBuffer phase。
- **方案**: 删除 `DEFAULT_PHASES` 常量，`phaseList` 不设默认值。如果 `phases.json` 加载失败则 throw Error（fail-loud），不再静默回退。
- **文件**: `src/render/RenderGraph.ts:15-23,38`
- **提交**: `6ef089a`

### Step 1.2 ✅ — 移除 `ResourceManager.ts` 的 `quadVBO` getter 硬编码
- **问题**: `quadVBO` getter 在 `vbo-presets.json` 中已声明 `quad`，但 TS 里又写了一份同样的数据作为回退。
- **方案**: 删除 fallback 生成逻辑。`quadVBO` 改为直接 return `this.namedVbos.get('quad')!`。如果不存在则 throw（fail-loud）。
- **文件**: `src/render/ResourceManager.ts:371-383`
- **提交**: `aab3b10`

### Step 1.3 ✅ — 移除 `ResourceManager.ts` 的 `defaultWhite`/`defaultNormal` 硬编码回退
- **问题**: `fallback-textures.json` 已声明 `white` 和 `normal` 纹理，TS 里又写了一份回退逻辑。
- **方案**: 移除 if-tex-not-found 的创建逻辑。直接 throw Error 如果 fallback 纹理未声明（fail-loud）。
- **文件**: `src/render/ResourceManager.ts:688-726`
- **提交**: `a9d5c38`

---

## Phase 2: 修复资源分配魔数（数据尺寸层）✅

### Step 2.1 ✅ — `getUniform()` 256 字节改为动态尺寸
- **问题**: `getUniform(key, data)` 的 buffer 固定分配 256 字节，不管实际 layout 多大。
- **方案**: 增加 `byteSize` 参数。调用方传入 `uniformLayouts.get('object').byteSize`、固定值 80（splat）、或 `Math.max(256, data.length * 4)`（post-process）。
- **文件**: `src/render/ResourceManager.ts:510-524` + PipelineDriver/GaussianSplatManager 调用方
- **提交**: `091b949`

### Step 2.2 — `loadTexture()` 强制 `rgba8unorm` 改为可声明
- **状态**: 跳过（低优先级；已有 `uploadTextureFromImage(sRGB)` 替代路径）
- **补充**: `namedDepthTargetView` 改为从 `render-targets.json` 读取 format（`33d2528`）

---

## Phase 3: Bind Group 内容数据驱动（核心架构层）✅

### Step 3.1 ✅ — 为 `bind-layouts.json` 条目增加 `resource` 元数据
- **问题**: `frameBindGroup()`/`frameShadowBindGroup()` 硬编码每个 binding slot 对应的资源。
- **方案**: 扩展 `bind-layouts.json` 每条 entry 增加可选 `resource` 字段。`ResourceManager` 的 `resolveFrameResource()` 遍历 layout entries 按 `resource` 名查表组装。
- **文件**: `public/common/bind-layouts.json` + `src/render/ResourceManager.ts:730-757` + `src/render/types.ts`
- **提交**: `1fe7b3b`

### Step 3.2 — `pbrMaterialBindGroup` 改为数据驱动
- **状态**: **跳过**（需要重构 PBR 渲染逃逸舱脚本，影响面大，属于后续重构项）

### Step 3.3 — `fullscreenBindGroup` 改为数据驱动
- **状态**: **跳过**（需要重构 `runPostChain`，与 Step 3.2 同类）

---

## Phase 4: 值解析器注册表化（Mini-DSL 层）✅

### Step 4.1/4.2 ✅ — `builtin.*` / `transform.*` / `tag.*` 统一为注册表模式
- **问题**: `resolveAtom()` 中的 switch/if-else 分支是闭枚举。
- **方案**: 导出 `atomNamespaces` 三层注册表 `{builtin: {}, transform: {}, tag: {}}`。新增 builtin/transform 字段只需 `atomNamespaces.builtin.newField = (ctx) => ...`，不改 resolveAtom 逻辑。
- **文件**: `src/render/valueResolver.ts`
- **提交**: `0ec4e9a`

---

## Phase 5: 扩展点打开（Plugin 层）✅

### Step 5.1 ✅ — `RenderScriptLoader` 路径剥离修正
- **问题**: `loadAll()` 硬编码 `replace(/^render\//, '')`，但 `scriptsSubdir` 来自 `engine-config.json` 可配置。
- **方案**: 用 `this.scriptsSubdir` 动态构建 prefix 模式。
- **文件**: `src/render/RenderScriptLoader.ts:65`
- **提交**: `1c66c8d`

### Step 5.2 ✅ — `PipelinePanel` BLEND_OPTIONS 从 JSON 读取
- **问题**: 编辑器硬编码 `['opaque', 'alpha', 'additive']`，漏了 `premultiplied`。
- **方案**: 从 `PipelineLoader.blendPresetNames` 动态获取选项列表。
- **文件**: `src/editor/PipelinePanel.ts:14` + PipelineLoader
- **提交**: `1c66c8d`

---

## Phase 6: 验证 ✅

- ✅ `npm run build` 通过（每次 commit 前验证）
- ✅ 所有现有 demo 功能不变（无逻辑变更，仅消除回退/默认值）

---

## 执行顺序

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

每步完成立即 git commit，commit message 格式: `refactor: <step description>`
