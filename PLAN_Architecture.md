# PLAN_Architecture.md — 数据驱动架构重整

## 目标

消除所有硬编码"内容"，使 JSON 配置文件成为唯一事实来源（Single Source of Truth）。每个阶段完成后可独立 `git commit`。

---

## Phase 1: 消除重复硬编码回退数据（基础层）

### Step 1.1 — 移除 `RenderGraph.ts` 的 `DEFAULT_PHASES`
- **问题**: `DEFAULT_PHASES` 硬编码了 `phases.json` 的子集（缺少 GBuffer），如果 JSON 加载失败会静默掉 GBuffer phase。
- **方案**: 删除 `DEFAULT_PHASES` 常量，`phaseList` 不设默认值。如果 `phases.json` 加载失败则 throw Error（fail-loud），不再静默回退。
- **文件**: `src/render/RenderGraph.ts:15-23,38`

### Step 1.2 — 移除 `ResourceManager.ts` 的 `quadVBO` getter 硬编码
- **问题**: `quadVBO` getter 在 `vbo-presets.json` 中已声明 `quad`，但 TS 里又写了一份同样的数据作为回退。
- **方案**: 删除 fallback 生成逻辑。`quadVBO` 改为直接 return `this.namedVbos.get('quad')!`。如果不存在则 throw（fail-loud）。
- **文件**: `src/render/ResourceManager.ts:371-383`

### Step 1.3 — 移除 `ResourceManager.ts` 的 `defaultWhite`/`defaultNormal` 硬编码回退
- **问题**: `fallback-textures.json` 已声明 `white` 和 `normal` 纹理，TS 里又写了一份回退逻辑。
- **方案**: 移除 if-tex-not-found 的创建逻辑。直接 throw Error 如果 fallback 纹理未声明（fail-loud）。
- **文件**: `src/render/ResourceManager.ts:688-726`

---

## Phase 2: 修复资源分配魔数（数据尺寸层）

### Step 2.1 — `getUniform()` 256 字节改为 `uniformLayouts.get()` 动态尺寸
- **问题**: `getUniform(key, data)` 的 buffer 固定分配 256 字节，不管实际 layout 多大。
- **方案**: 接收可选 `layoutRef` 参数，或接受 `byteSize` 参数。调用方传入 `uniformLayouts.get('object').byteSize`。
- **文件**: `src/render/ResourceManager.ts:519-532` + 所有调用方

### Step 2.2 — `loadTexture()` 强制 `rgba8unorm` 改为可声明
- **问题**: `loadTexture(url)` 不读取 `render-targets.json` 或任何声明，强制 `rgba8unorm`。
- **方案**: 增加可选 `sRGB` 参数（默认 false），调用方（如动画系统加载 sprite sheet）可传入。
- **文件**: `src/render/ResourceManager.ts:551-575`

---

## Phase 3: Bind Group 内容数据驱动（核心架构层）

### Step 3.1 — 为 `bind-layouts.json` 条目增加 `resource` 元数据
- **问题**: `frameBindGroup()`/`frameShadowBindGroup()` 硬编码每个 binding slot 对应的资源（cameraUBO, lightUBO 等）。
- **方案**: 扩展 `bind-layouts.json` 每条 entry 增加可选 `resource` 字段描述其运行时来源（`"cameraUBO"`, `"lightUBO"`, `"timeInputUBO"`, `"shadowDepth2D"`, `"sampler:shadow"`, `"shadowPoint2D"`, `"pointShadowFaceUBO"`）。`ResourceManager` 的 `frameBindGroup()` 遍历 layout entries 按 `resource` 名查表组装。
- **文件**: `public/common/bind-layouts.json` + `src/render/ResourceManager.ts:730-757`

### Step 3.2 — `pbrMaterialBindGroup` 改为数据驱动
- **问题**: `materialPbr` layout 的 binding 2-6 硬编码了 baseColor/metallicRoughness/occlusion/emissive/normal 纹理顺序。
- **方案**: 在 PipelineDriver 的 `buildEntries()` 已经支持声明式 `bindGroups[].textures[].source`。关键是把 PBR 管线的 `renderer.bindGroups` 改为声明式（当前 PBR 走 `pbrMaterialBindGroup` 闭过程）。`PipelineDriver` 的 per-entity bind group 组装已经通用，只需要 PBR 管线 JSON 里加声明。
- **文件**: public/common/pipelines/PbrPipeline.json + 可能的 PipelineDriver 调整

### Step 3.3 — `fullscreenBindGroup` 改为数据驱动
- **问题**: `fullscreenBindGroup()` 在 `ResourceManager` 中硬编码了两个 layout（fullscreen + fullscreenParam）。
- **方案**: 将其逻辑移到 PipelineDriver 中，通过声明式 `bindGroups` 组装（后处理管线 JSON 已经声明 params，但绑定过程走的是 `ResourceManager.fullscreenBindGroup` 闭过程）。
- **文件**: `src/render/ResourceManager.ts:873-894` + PipelineDriver

---

## Phase 4: 值解析器注册表化（Mini-DSL 层）

### Step 4.1 — `builtin.*` 改为可注册表
- **问题**: `resolveAtom()` 中的 `switch(field)` 是闭枚举。新增 `builtin.frameIndex` 需改 TS。
- **方案**: 导出 `builtinResolvers: Record<string, (ctx) => number>`，预注册已知 builtin。valueResolver 在运行时按名查表。
- **文件**: `src/render/valueResolver.ts:64-74`

### Step 4.2 — `transform.*` / `tag.*` 改为可注册表
- **问题**: `transform.model`/`transform.normalMatrix` 和 `tag.color`/`tag.extra` 是闭分支。
- **方案**: 同样导出可注册的 resolver 表。
- **文件**: `src/render/valueResolver.ts:59-62,75-78`

---

## Phase 5: 扩展点打开（Plugin 层）

### Step 5.1 — `RenderScriptLoader` 路径剥离修正
- **问题**: `loadAll()` 硬编码 `replace(/^render\//, '')`，但 `scriptsSubdir` 来自 `engine-config.json` 可配置。
- **方案**: 用 `this.scriptsSubdir` 动态构建 prefix 模式。
- **文件**: `src/render/RenderScriptLoader.ts:65`

### Step 5.2 — `PipelinePanel` BLEND_OPTIONS 从 JSON 读取
- **问题**: 编辑器硬编码 `['opaque', 'alpha', 'additive']`，漏了 `premultiplied`。
- **方案**: 从 `PipelineLoader.blendPresets` keys 动态获取选项列表。
- **文件**: `src/editor/PipelinePanel.ts:14` + PipelineLoader 导出

---

## Phase 6: 验证

- `npm run build` 通过
- 所有现有 demo 功能不变

---

## 执行顺序

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

每步完成立即 git commit，commit message 格式: `refactor: <step description>`
