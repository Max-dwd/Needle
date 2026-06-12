# Needle 文档

[English](./README.md)

最后源码扫描日期：2026-05-30。

这个目录承载根 README 不适合展开的内容：配置分支、设置页行为、路由清单、数据布局和架构说明。功能变化时优先更新这里，而不是继续加长根 README。

## 从这里开始

| 你要做什么 | 阅读 |
| --- | --- |
| 安装、配置、部署、导入订阅 | [配置文档](./configuration.zh.md) |
| 理解应用架构、API 路由、数据布局和流水线 | [项目细节](./project-details.zh.md) |
| 评测 llm-aligner 字幕流水线 | [Eval README](../eval/README.md) |
| 作为 coding agent 在仓库里工作 | [AGENTS.md](../AGENTS.md) |

## 文档分工

- 根 README 保持简洁：项目简介、快速开始、常用命令、文档链接。
- `docs/configuration*.md` 负责运行配置、环境变量、设置页、Docker 和可选字幕运行时。
- `docs/project-details*.md` 负责架构、路由、数据库表、数据流和子项目地图。
- `docs/design/` 与 `docs/specs/` 保留历史设计或功能专项记录。引用前请先对照当前源码。

## 当前源码锚点

| 领域 | 源码 |
| --- | --- |
| 页面 | `src/app/page.tsx`, `src/app/channels/page.tsx`, `src/app/settings/page.tsx`, `src/app/research/page.tsx` |
| API 路由 | `src/app/api/**/route.ts` |
| 设置页 | `src/components/settings/SettingsShell.tsx`, `src/components/settings/shared.ts` |
| 流水线 | `src/lib/pipeline-config.ts`, `src/lib/fetcher.ts`, `src/lib/subtitles.ts`, `src/lib/auto-pipeline.ts` |
| AI 设置与 prompt | `src/lib/ai-summary-settings.ts`, `src/lib/ai-summary-client.ts`, `src/lib/ai-chat-client.ts` |
| 数据库 | `src/lib/db.ts` |
| Browser 集成 | `browser-runtime/`, `browser-bridge/extension/`, `src/lib/browser-*.ts` |
| Eval harness | `eval/README.md`, `eval/config.example.yaml`, `eval/run-llm-aligner-eval.ts` |
