# Needle

[English](./README.md) · [文档](./docs/README.zh.md)

**本地优先的 YouTube 与 Bilibili 视频订阅管理工具。**

Needle 抓取频道元数据与视频列表、提取字幕、通过 OpenAI 兼容服务生成 AI 摘要，并用 **意图 × 主题** 组织频道。数据保存在本地：SQLite 数据库，以及 `data/` 下的字幕、摘要、日志、备份和 Agent 产物文件。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen)](https://nodejs.org/)

> [!WARNING]
> **没有身份验证。** Needle 的 API 路由没有鉴权。请只在本机或可信私有网络运行。

## 能做什么

- 订阅 YouTube 和 Bilibili 频道
- 导入 YouTube OPML 和 Bilibili 关注列表
- 通过第一方 Needle Browser runtime 与 Chrome 扩展抓取视频
- 事件驱动自动流水线：新视频 -> 字幕 -> 摘要
- 支持原生字幕、Whisper + AI 校对、可选 LLM 转写 + forced aligner，以及 Gemini 风格多模态 fallback
- 在设置页维护 AI 模型、prompt 模板、共享 AI 预算和自动化开关
- 提供研究收藏工作台：收藏、集合、备注和 ZIP 导出
- 提供 MCP Server，供意图 Agent 和外部自动化连接

## 快速开始

```bash
npm install
cp .env.example .env.local
npm run browser:prepare
npm run dev
```

打开 `http://localhost:3000`。

首次安装 Chrome Bridge：

1. 打开 `chrome://extensions`
2. 开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `browser-bridge/extension`

AI provider 不在 `.env.local` 里配置，而是在**设置 -> 模型**里配置。

## Docker

```bash
cp .env.example .env.local
docker compose up -d --build
```

打开 `http://localhost:3000`。

Web 应用运行在 Docker 中，但 Chrome 扩展仍运行在宿主机，并通过 `19825` 端口连接。Docker、sidecar 和运行时细节见[配置文档](./docs/configuration.zh.md)。

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run stop
npm run typecheck
npm run test
npm run lint
npm run backup
npm run restore
npm run export:summary-md
npm run mcp:start
```

Browser 子项目：

```bash
npm run browser:prepare
npm run browser:runtime:build
npm run browser:bridge:build
npm run browser:bridge:package
```

Eval harness：

```bash
npm run eval:golden:build -- --config eval/config.local.yaml
npm run eval:llm-aligner -- --config eval/config.local.yaml
npm run eval:ui
```

## 文档

- [文档索引](./docs/README.zh.md)
- [配置文档](./docs/configuration.zh.md)：环境变量、设置页、Docker、Browser Bridge、字幕运行时、导入
- [项目细节](./docs/project-details.zh.md)：架构、路由、数据布局、数据库表、流水线、子项目
- [Eval harness](./eval/README.md)：golden dataset 与 llm-aligner 评测流程
- [Agent 指令](./AGENTS.md)：面向 Codex 类 agent 的当前仓库导航

## 技术栈

- Next.js 16 / React 19 App Router
- TypeScript strict，`@/*` 指向 `src/*`
- SQLite via `better-sqlite3`
- Tailwind CSS v4、`tailwind-merge`、`class-variance-authority`
- `@base-ui/react`
- Vitest

## 许可证

MIT，见 [LICENSE](./LICENSE)。
