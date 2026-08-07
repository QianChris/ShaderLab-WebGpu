# ShaderLab-WebGPU 文档

本目录是 ShaderLab-WebGPU 引擎的参考文档。面向两类读者：**人类开发者**与**AI 代理（Agent）**。Agent 在进行 App/插件开发前应先通读相关文档，再动手。

## 文档索引

| 文档 | 内容 | 适用场景 |
|------|------|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构宪法：三层依赖方向、双通道通信、双入口隔离、插件驱动铁律、引擎关键机制概览 | 任何改动前必读 |
| [features.md](./features.md) | 引擎能力总览：机制层提供什么、各插件提供什么、各 demo 演示什么 | 选型/查能力 |
| [app-development.md](./app-development.md) | App 开发指南（Agent 友好）：组合层 JSON 约定、装载流程、常见模式、陷阱 | 写一个新 app |
| [plugin-development.md](./plugin-development.md) | 插件开发指南（Agent 友好）：EnginePlugin 结构、声明字段、生命周期、PluginContext API、相对导入规则 | 写一个新插件 |
| [json-schemas.md](./json-schemas.md) | 所有 JSON 声明的 schema 锚定：声明字段 + app 层 + common 层 + 管线/着色器 JSON，含完整字段表与示例 | 写/查任何 JSON |
| [code-conventions.md](./code-conventions.md) | 非 JSON 代码规范：WGSL 着色器、游戏脚本、渲染脚本、着色器图、插件 TS、value 原子、相位行为 | 写 shader / 脚本 / 插件代码 |

## 阅读路径建议

- **新人**：`ARCHITECTURE.md` → `features.md` → `app-development.md`
- **Agent 写 app**：`app-development.md` + `json-schemas.md`（必要时 `code-conventions.md` 的着色器/脚本节）
- **Agent 写插件**：`plugin-development.md` + `json-schemas.md` + `code-conventions.md`
- **查单个 JSON 字段**：直接查 `json-schemas.md` 目录

## 与 AGENTS.md 的关系

仓库根 `AGENTS.md` 是 Agent 行为准则（构建/校验命令、目录速查、速查陷阱），偏向"操作指令"。本目录是"参考文档"，偏向"为什么 + 怎么写"。两者互补，不重复。

## 约定

- 所有文档中文撰写，代码/标识符保持英文。
- 示例优先取自真实仓库文件（`public/plugins/`、`public/apps/`），保证可运行。
- schema 字段表标注：**必填** / 可选 / 默认值 / 类型 / 锚定来源（`src/...:行号`）。
- "fail-loud" = 缺失/重名/未注册一律 throw，不静默回退——这是引擎铁律。
