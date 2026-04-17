# Needle

[English](./README.md)

**本地优先的 YouTube 与 Bilibili 视频订阅管理工具。**

Needle 抓取频道元数据与视频列表、下载字幕、通过任意 OpenAI 兼容后端生成 AI 摘要，并以 **意图 × 主题** 两个维度组织频道。事件驱动的自动流水线可将新视频从发现到字幕、摘要全程自动完成。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen)](https://nodejs.org/)

> [!WARNING]
> **无身份验证。** 所有 API 端点均无鉴权保护。请仅在本机或受信任的私有网络中运行 Needle，**不要将其暴露到公网。**

---

## 功能一览

- **意图 × 主题** 双维度频道组织 — 每个意图独立配置 auto-subtitle / auto-summary 开关和模型覆盖
- **事件驱动流水线** — 新视频 → 字幕 → 摘要，全自动完成
- **字幕流水线** — Needle Browser → Whisper 锚定的 AI 字幕 → Gemini 音频转录 fallback，分级退避重试
- **AI 摘要** — 兼容 OpenAI 协议（OpenAI、Ollama、Gemini、任意端点）；共享 RPM/TPM/RPD 预算
- **AI 问答面板** — 圈定字幕时间范围后自由问答；输出 Obsidian 风格 markdown 笔记或吐槽分享卡（PNG 导出）
- **音频模式 + 媒体会话** — 移动端全锁屏控制，静音 MP3 心跳维持 iOS 音频会话
- **意图 Agent** — 每个意图可配置 AI Agent，支持持久记忆，手动 / 每日 / 有新视频时触发；通过 MCP server 暴露能力
- **研究收藏** — 收藏视频并组织为集合，导出含字幕与摘要的 ZIP 包
- **备份 / 恢复** — 一条命令归档 SQLite 数据库、字幕与摘要
- **实时推送** — SSE 推送爬虫状态、流水线进度、字幕与摘要事件，无需轮询

---

## 快速开始

```bash
npm install
cp .env.example .env.local
npm run browser:prepare   # 首次需构建 Needle Browser 子项目
npm run dev               # http://localhost:3000
```

首次启动时会自动创建 SQLite 数据库和所需目录。

---

## Docker 快速开始

如果 Docker 和 Chrome 跑在同一台机器上，可直接这样启动：

```bash
cp .env.example .env.local   # 可选，用于本地覆盖和敏感配置
docker compose up -d --build
```

然后打开 `http://localhost:3000`。

Docker 部署时请注意：
- Web 应用运行在容器里，但 **Needle Browser Bridge 扩展仍然运行在宿主机的 Chrome 中**。
- `compose.yaml` 暴露了 `19825:19825`；请保持该端口可用，因为宿主机扩展会连接 `localhost:19825`。
- `./data` 会 bind mount 到 `/app/data`，因此 SQLite、字幕、摘要、日志和备份都会持久化到宿主机目录。
- 若存在 `.env.local`，compose 会将其加载进容器。核心数据路径和 daemon 绑定地址由 compose 固定；`.env.local` 更适合放 `BILIBILI_SESSDATA`、`LOG_LEVEL` 或工具路径覆盖。
- **不需要**为了启动容器而在宿主机先运行 `npm run browser:prepare`。只有当你想从源码重建本地 browser runtime / 扩展产物时，才需要手动执行它。

从当前仓库安装或刷新宿主机侧 Chrome 扩展：

1. 打开 `chrome://extensions`
2. 开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `browser-bridge/extension`

常用 Docker 命令：

```bash
docker compose logs -f
docker compose down
docker compose up -d --build
NEEDLE_HTTP_PORT=3001 docker compose up -d --build  # 如果 3000 已被占用
```

> [!NOTE]
> `YOUTUBE_COOKIES_BROWSER=chrome` 指向的是容器内的浏览器配置目录，而不是宿主机 Chrome 的 profile。Docker 部署下更推荐使用 OPML 导入、浏览器引导导入流程，或直接提供 `BILIBILI_SESSDATA` 这类显式认证信息。

---

## 依赖

**最小启动：**
- Node.js 20+
- Google Chrome 或 Chromium（Needle Browser 运行时和 Bridge 扩展使用）

**按功能启用：**

| 工具 | 用途 |
|------|------|
| `yt-dlp` | YouTube cookie 导入、Gemini 字幕音频提取 |
| `ffmpeg` / `ffprobe` | Gemini 和 Whisper 字幕的音频切片 |
| `mlx-whisper` | Apple Silicon 上的 Whisper 锚定字幕源 |

```bash
# macOS
brew install yt-dlp ffmpeg
python3 -m pip install mlx-whisper

# Ubuntu / Debian
sudo apt install -y ffmpeg
sudo add-apt-repository ppa:tomtomtom/yt-dlp && sudo apt install -y yt-dlp
```

`mlx-whisper` 是 Needle 调用本地 Whisper 锚定字幕源时使用的 CLI。当前只面向 Apple Silicon Mac，首次运行会自动从 Hugging Face 下载所选 Whisper 模型。

---

## 配置

### 环境变量

复制 `.env.example` 为 `.env.local` 后按需修改：

```env
# 核心路径
PORT=3000
DATA_ROOT=./data
DATABASE_PATH=./data/folo.db
SUBTITLE_ROOT=./data/subtitles
SUMMARY_ROOT=./data/summaries
SUMMARY_MD_ROOT=./data/summary-md

# 可选：外部工具
PYTHON_BIN=python3
YT_DLP_BIN=yt-dlp
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
MLX_WHISPER_BIN=mlx_whisper
WHISPER_MODEL_ID=mlx-community/whisper-base-mlx-q4

# 可选：受保护内容需要登录态
YOUTUBE_COOKIES_BROWSER=chrome
BILIBILI_SESSDATA=your_sessdata

# 可选：日志
LOG_LEVEL=info

# Needle Browser daemon
FOLO_BROWSER_DAEMON_PORT=19825
FOLO_BROWSER_DAEMON_BIND_HOST=127.0.0.1
```

AI 模型的 endpoint、API Key 和 model 不走环境变量——启动后在**设置 → 模型**里配置。

### 安装 Needle Browser Bridge 扩展

爬取与订阅导入链路通过第一方 `browser-runtime` 守护进程和 `browser-bridge` Chrome 扩展完成。

```bash
npm run browser:prepare
```

然后打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `browser-bridge/extension`。

如果是 Docker 部署，这个扩展仍然运行在宿主机 Chrome 中，并通过映射出来的 `19825` 端口与容器内 daemon 通信。

### 安装 mlx-whisper

Needle 在尝试 Whisper 锚定字幕源前会先检测本地 `mlx_whisper` 可执行文件。Apple Silicon macOS 上可直接这样安装：

```bash
brew install ffmpeg
python3 -m pip install mlx-whisper
```

如果二进制不在 `PATH` 里，就把 `MLX_WHISPER_BIN` 设成完整路径。默认模型是 `mlx-community/whisper-base-mlx-q4`，可以通过 `WHISPER_MODEL_ID` 覆盖，也可以在设置 → 字幕里切换模型。

安装完成后，进入设置 → 字幕，点击**检测环境**。Needle 会调用 `/api/settings/whisper-status` 来确认 `mlx_whisper` 是否可用。

### 首次导入订阅

| 来源 | 方式 |
|------|------|
| YouTube | 在设置 → 导入里上传 OPML 文件 |
| Bilibili | 配置 `BILIBILI_SESSDATA` 后导入关注列表 |
| 手动 | 粘贴任意频道或视频 URL — 支持 `/channel/{id}`、`/@handle`、`/c/{name}`、`/space/{uid}`、`/video/{bvid}`、`watch?v=...` |

---

## 工作原理

### 意图 × 主题

**意图（Intent）** 是主导航维度，每个意图拥有：
- 独立的 `auto_subtitle` / `auto_summary` 开关
- 可选的意图级模型覆盖（`auto_summary_model_id`）
- Agent 配置（指令、触发方式、持久记忆）

内置五个意图：工作、娱乐、探索、新闻、未分类。

**主题（Topics）** 是自由标签，以 JSON 数组存储在频道上，可跨意图过滤。

在**设置 → 意图与自动化**里管理意图。

### 爬取

内置定时调度器（默认每 2 小时一次）。失败频道指数退避（30 分钟起，最多 24 小时）。可随时暂停或手动触发；调度器与手动刷新之间有作用域锁互斥。

爬取来源顺序可在**设置 → 抓取**里配置。

### 字幕流水线

1. Needle Browser 下载原生字幕
2. Fallback：Whisper 锚定的 AI 字幕（本地 `mlx_whisper` 先产出时间戳锚点，再由多模态 LLM 校对文本；如果这一步失败，则保留原始 Whisper 文本作为最后兜底）
3. 如果 Whisper 锚定字幕不可用，再回退到 Gemini 音频转录
4. 失败重试间隔：`10 分钟 → 30 分钟 → 2 小时 → 6 小时 → 24 小时`（按错误类型分级）

VTT、SRT、JSON3 格式统一归一化为 `SubtitleSegment[]`。

### AI 摘要

- 兼容任意 OpenAI 协议端点（OpenAI、Ollama、Gemini、LM Studio 等）
- 双默认模型：一个供手动触发，一个供自动流水线
- 五套可编辑 prompt 模板：默认 · 字幕 API · 字幕分段 · 问答（Obsidian）· 问答（吐槽）
- 摘要写入 `data/summaries/{platform}/{videoId}.md`，含完整 YAML frontmatter（模型、端点、token 用量、耗时、触发来源）
- 重新生成前自动将旧文件备份为 `.prev.md`
- SSE 流式推送，实时展示字符进度、TTFT 和 TPS

**共享 AI 预算：** 摘要、Gemini 字幕转录、AI 问答共用同一个 RPM/TPM/RPD 调度器。优先级：`manual-summary > manual-subtitle > auto-summary > auto-subtitle`。

### AI 问答面板

在播放器内用双滑块 `TimelineRange` 圈定字幕时间范围后，可对该片段内容自由提问。

| 模式 | 输出 |
|------|------|
| **Obsidian** | 带 YAML frontmatter 的 markdown 笔记，可一键复制或下载 `.md` |
| **吐槽** | 短评渲染为 540px 深色分享卡，通过 `html-to-image` 导出 PNG |

两套 prompt 模板均可在**设置 → 总结**里编辑和重置。

### 意图 Agent

每个意图可配置一个 AI Agent：
- **指令（Prompt）** — 告诉 Agent 要做什么（如"提取本周新视频中的可执行投资信号"）
- **触发方式（Trigger）** — `manual`（手动）、`daily`（每日）、`on_new_videos`（有新视频时）
- **持久记忆（Memory）** — Agent 可跨次运行读写自身记忆

Agent 通过 MCP server（`npm run mcp:start`）与 Needle 交互，拥有五个 tool：

| Tool | 用途 |
|------|------|
| `get_intent_agent_context` | 获取意图配置 + 近期视频列表（含字幕全文） |
| `search_videos` | 按关键词、平台、时间范围跨意图搜索视频 |
| `read_subtitle` | 读取单个视频的字幕文本 |
| `save_artifact` | 保存分析产物到 `data/agent-artifacts/{intentName}/` |
| `update_memory` | 读写 Agent 持久记忆 |

MCP 连接配置见 `.mcp.json`。

### 研究收藏

`/research` 是独立的深度研究工作台：
- **收藏** — 任意视频可带备注收藏，按研究意图类型归类（预置：信息验证 / Deep Research / 学习探索，可自定义）
- **集合** — 将多个收藏组织为命名集合，支持条目级标注覆盖
- **导出** — 将集合打包为 ZIP（含字幕与摘要），供外部 LLM 或工作流使用

### 音频模式

移动端（视口宽度 ≤ 900px）进入播放器时自动启用音频模式：
- `AudioModeOverlay` 展示专辑封面风格界面（封面 + 标题 + 频道 + 播放/暂停 + ±10 秒跳转 + 可点击进度条）
- 集成 Media Session API，锁屏与耳机控制按钮可用
- 循环播放静音 MP3 维持 iOS 锁屏音频会话

---

## 字幕导出工作流

将字幕导出为自包含的 Markdown 任务文件，外部 LLM 无需额外 prompt 即可直接摘要：

```bash
npm run export:summary-md

# 可选过滤
node scripts/export-subtitle-markdown.mjs --platform youtube
node scripts/export-subtitle-markdown.mjs --platform bilibili --video BV18TAkzbETb --overwrite
node scripts/export-subtitle-markdown.mjs --platform youtube --video I9cnH-D0FRY --clickable
```

`--clickable` 会将时间戳展开为 `https://youtu.be/{id}?t={sec}` 链接。每个文件含 YAML frontmatter（video_id、platform、source_url、channel、duration、subtitle_language）和完整字幕文本。

将 Markdown 任务文件转为结构化 JSON 摘要：

```bash
node scripts/generate-summary-json.mjs  # 输出到 data/summaries/
```

---

## 数据目录结构

```
data/
  folo.db                            # SQLite 数据库（WAL 模式）
  subtitles/<platform>/<videoId>/    # 下载的字幕 JSON
  summaries/<platform>/<videoId>.md  # AI 摘要（YAML frontmatter + 正文）
  summary-md/<platform>/<videoId>.md # 导出的字幕任务文件
  agent-artifacts/<intentName>/      # 意图 Agent 分析产物
  logs/                              # JSONL 结构化日志
  backups/                           # 备份归档
```

---

## 常用命令

```bash
# 开发
npm run dev              # 启动开发服务器（http://localhost:3000）
npm run build            # 生产构建
npm run start            # 启动生产服务
npm run stop             # 停止生产服务
npm run restart          # stop → git pull → build → start

# 代码质量
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest
npm run format           # Prettier

# 数据
npm run backup           # 生成备份归档
npm run restore          # 从备份归档恢复
npm run export:summary-md  # 导出字幕 markdown 任务文件

# Needle Browser 子项目
npm run browser:prepare          # 同时构建 runtime + bridge（首次运行）
npm run browser:runtime:build    # 仅 browser-runtime
npm run browser:bridge:build     # 仅 browser-bridge/extension
npm run browser:bridge:package   # 打包可发布的扩展 zip

# MCP Server
npm run mcp:start        # 启动 stdio MCP server（供外部 Agent 连接）
```

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 框架 | Next.js 16 / React 19（App Router、服务端组件） |
| 语言 | TypeScript strict，`@/*` 别名指向 `src/*` |
| 数据库 | SQLite via `better-sqlite3`（同步 API、WAL、仅服务端） |
| 样式 | Tailwind CSS v4 + `tailwind-merge` + `class-variance-authority` |
| UI 原语 | `@base-ui/react` |
| 图片导出 | `html-to-image`（吐槽分享卡 → PNG） |
| 测试 | Vitest |

---

## 子项目

| 目录 | 用途 |
|------|------|
| `browser-runtime/` | 第一方 Needle Browser 守护进程（独立 `package.json`） |
| `browser-bridge/extension/` | Needle Browser Bridge Chrome 扩展源码 |
| `browser-bridge-package/` | 预构建的 bridge 扩展产物（运行时由 Needle 加载） |

---

## 开发者文档

架构、数据库 schema、API 路由清单、内部单例与注意事项详见 [`CLAUDE.md`](./CLAUDE.md)。

---

## 许可证

MIT — 详见 [`LICENSE`](./LICENSE)。
