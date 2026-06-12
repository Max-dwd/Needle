# 配置文档

[English](./configuration.md)

最后源码扫描日期：2026-05-30。

Needle 有两层配置：

1. `.env.local` 配置本地路径、外部可执行文件、认证值、日志和 browser daemon 端口。
2. 设置页配置 AI provider、prompt 模板、流水线顺序、自动化、性能、备份、Bilibili 认证和 UI 偏好。

AI 模型 endpoint、API key 和 model ID 在**设置 -> 模型**里配置。除非代码发生变化，不要新增 AI provider 环境变量。

## 环境变量

复制 `.env.example` 为 `.env.local`。

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本地 `npm run dev` / `npm run start` 的 Next.js 端口 |
| `DATA_ROOT` | 运行时数据根目录 |
| `DATABASE_PATH` | SQLite 数据库路径 |
| `SUBTITLE_ROOT` | 字幕 JSON 根目录 |
| `SUMMARY_ROOT` | 摘要 markdown 根目录 |
| `SUMMARY_MD_ROOT` | 导出的字幕任务 markdown 根目录 |
| `PYTHON_BIN` | helper script 使用的 Python |
| `YT_DLP_BIN` | YouTube cookie 与音频提取链路使用的 `yt-dlp` |
| `FFMPEG_BIN` | `ffmpeg` 可执行文件 |
| `FFPROBE_BIN` | `ffprobe` 可执行文件 |
| `MLX_WHISPER_BIN` | Whisper + AI 校对字幕使用的 `mlx_whisper` |
| `WHISPER_MODEL_ID` | 默认 Whisper 模型 |
| `FORCED_ALIGNER_RUNTIME` | forced-aligner 模式：`local` 或 `remote` |
| `FORCED_ALIGNER_REMOTE_URL` | 远程 sidecar URL，Docker 下通常是 `http://host.docker.internal:8766` |
| `MLX_FORCED_ALIGNER_BIN` | 可选的本地 forced-aligner wrapper 路径；存在 `./scripts/mlx_forced_aligner_wrapper.py` 时默认使用它 |
| `FORCED_ALIGNER_MODEL_ID` | 默认 forced-aligner 模型 |
| `YOUTUBE_COOKIES_BROWSER` | YouTube 导入/提取 helper 的浏览器 cookie 来源 |
| `BILIBILI_SESSDATA` | 可选 Bilibili 登录 cookie |
| `LOG_LEVEL` | 结构化日志级别 |
| `FOLO_BROWSER_DAEMON_PORT` | Needle Browser daemon 端口，默认 `19825` |
| `FOLO_BROWSER_DAEMON_BIND_HOST` | Needle Browser daemon 绑定地址 |

## 设置页

设置页由 `src/components/settings/SettingsShell.tsx` 通过 `?tab=` 路由。

| Tab id | 组件 | 负责内容 |
| --- | --- | --- |
| `performance` | `PerformanceTab.tsx` | 爬虫性能档位、browser keepalive 预设、桌面/移动端前端性能模式 |
| `crawling` | `CrawlingTab.tsx` | 调度器运行时、爬取间隔、爬取来源顺序 |
| `subtitles` | `SubtitlesTab.tsx` | 字幕来源顺序、Whisper 状态、forced-aligner 状态、Gemini/API 字幕 prompt 与 fallback 模型规则 |
| `summary` | `SummaryTab.tsx` | 摘要、字幕 API、字幕分段、Chat Obsidian、Chat Roast 五套 prompt 模板 |
| `models` | `ModelsTab.tsx` | AI provider 列表、API key、协议、手动/自动默认模型、共享 RPM/TPM/RPD 预算 |
| `errors` | `ErrorHandlingTab.tsx` | 不可用/废弃视频隐藏策略与检查 |
| `backup` | `BackupTab.tsx` | 备份创建与恢复模式 |
| `logs` | `LogsTab.tsx` | JSONL 日志查看与统计 |
| `intents` | `IntentTab.tsx` | 意图 CRUD、排序、自动字幕、自动摘要、意图级模型覆盖、Agent 配置 |
| `bilibili` | `BilibiliSummaryTab.tsx` | Bilibili SESSDATA 与官方 AI 摘要访问 |
| `appearance` | `AppearanceTab.tsx` | 主题/显示偏好与播放器快捷键 |
| `research` | `ResearchIntentManagement.tsx` | 研究意图类型管理 |

旧 tab 名在 `src/components/settings/shared.ts` 中归一化：`general` 和 `scheduler` 指向 `crawling`，`ai` 指向 `models`，`bilibili-summary` 指向 `bilibili`。

## Needle Browser Bridge

Needle 的爬取和浏览器导入依赖两个本地子项目：

| 目录 | 角色 |
| --- | --- |
| `browser-runtime/` | 驱动浏览器命令的 Node CLI/daemon |
| `browser-bridge/extension/` | 用户加载到 Chrome 的扩展 |
| `browser-bridge-package/` | 应用运行时读取的预构建 bridge 产物 |

构建两个子项目：

```bash
npm run browser:prepare
```

在 Chrome 中加载 `browser-bridge/extension`：

1. 打开 `chrome://extensions`
2. 开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `browser-bridge/extension`

## Docker

启动应用：

```bash
cp .env.example .env.local
docker compose up -d --build
```

重要细节：

- `compose.yaml` 默认将 Web 应用映射到宿主机 `3000`。
- Browser daemon 使用 `19825`；宿主机 Chrome 扩展连接这个映射端口。
- `./data` bind mount 到 `/app/data`。
- 存在 `.env.local` 时 compose 会加载它。
- Docker 运行 Linux，因此 Apple Silicon MLX runtime 应该放在宿主机作为 sidecar。

需要换 HTTP 端口时：

```bash
NEEDLE_HTTP_PORT=3001 docker compose up -d --build
```

## 宿主机 Forced-Aligner Sidecar

当主应用跑在 Docker、forced aligner 跑在 macOS 宿主机时：

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install mlx-audio mlx-forced-aligner
chmod +x scripts/mlx_forced_aligner_wrapper.py scripts/forced_aligner_sidecar.py

FORCED_ALIGNER_SIDECAR_PORT=8766 \
  .venv/bin/python scripts/forced_aligner_sidecar.py
```

然后这样运行 Needle：

```bash
FORCED_ALIGNER_RUNTIME=remote \
FORCED_ALIGNER_REMOTE_URL=http://host.docker.internal:8766 \
docker compose up -d --build
```

状态 API 是 `/api/settings/forced-aligner-status`。

## 字幕运行时

当前字幕 source id 定义在 `src/lib/pipeline-config.ts`。

| Source | 默认 | 说明 |
| --- | --- | --- |
| `browser` | 启用 | 通过 Needle Browser 获取原生字幕 |
| `whisper-ai` | 启用 | 本地 Whisper 时间戳 + 多模态 AI 校对 |
| `llm-aligner` | 关闭 | 多模态转写 + MLX forced alignment |
| `gemini` | 启用 | 多模态音频转录 fallback |

常见本地安装：

```bash
brew install yt-dlp ffmpeg
python3 -m pip install mlx-whisper
```

打开**设置 -> 字幕**检测 Whisper 和 forced-aligner，并调整字幕来源顺序。

普通 repo 本地 `llm-aligner` 运行通常可以不设置 `MLX_FORCED_ALIGNER_BIN`，因为 Needle 会在 bundled `./scripts/mlx_forced_aligner_wrapper.py` 存在时默认使用它。只有想改用自定义 aligner 可执行文件时才需要设置。

## 订阅导入

| 来源 | 路径 |
| --- | --- |
| YouTube OPML | 在应用 UI 中导入，后端走 `/api/subscriptions/youtube` |
| YouTube 浏览器登录流程 | `/api/subscriptions/youtube/browser` 在 Needle Browser 打开登录页 |
| Bilibili 关注列表 | 配置 `BILIBILI_SESSDATA` 或设置 -> Bilibili AI 后使用 `/api/bilibili/following` |
| 手动 URL | 在应用中粘贴频道/视频 URL，由频道/视频 API 处理 |

## 备份与恢复

使用设置页备份 tab，或运行：

```bash
npm run backup
npm run restore
```

备份包含 SQLite 数据库、字幕目录和摘要目录。
