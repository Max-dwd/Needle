# CLAUDE.md

本文件是 Claude Code 在此仓库工作时的导航索引。写法原则：只列真正存在的东西，写过期内容比不写更糟糕。

## 项目简介

**Needle** — 本地优先的 Next.js 16 视频订阅管理工具，支持 YouTube 和 Bilibili。核心能力：

- 抓取频道元数据与视频列表
- 按配置的流水线顺序下载字幕（Needle Browser → Gemini 音频转录 fallback）
- 通过 OpenAI 兼容接口生成 AI 摘要
- **意图 × 主题** 双维度频道组织
- 内置调度器 + 事件驱动自动流水线（auto-subtitle / auto-summary）
- 研究收藏（Research Favorites）与集合导出
- 备份 / 恢复

所有数据存本地：SQLite 数据库 + 磁盘上的字幕与摘要 markdown。

## 常用命令

```bash
npm run dev              # 启动开发服务器（http://localhost:3000）
npm run build            # 生产构建
npm run start            # 启动生产服务
npm run stop             # 停止正在运行的服务
npm run restart          # stop → git pull → build → start
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # vitest run
npm run format           # prettier --write src/
npm run backup           # 生成备份归档（调用 backup-system.ts）
npm run restore          # 从备份归档恢复
npm run export:summary-md        # 导出字幕为 markdown 任务文件

# Needle Browser 子项目构建
npm run browser:prepare          # 同时构建 runtime 和 bridge 扩展
npm run browser:runtime:build    # 仅 browser-runtime
npm run browser:bridge:build     # 仅 browser-bridge/extension
npm run browser:bridge:package   # 打包可发布的扩展 zip

# MCP Server（供外部 agent 连接）
npm run mcp:start                # 启动 stdio MCP Server
```

独立脚本（不在 package.json 里）：
```bash
node scripts/generate-summary-json.mjs   # 将 data/summary-md/ 转成 data/summaries/ JSON
node scripts/export-subtitle-markdown.mjs --platform youtube --video <id> --clickable
```

## 技术栈

- **Next.js 16 / React 19** — App Router、服务端组件、API 路由
- **TypeScript strict**，`@/*` 别名指向 `src/*`
- **SQLite**（`better-sqlite3`，同步 API，仅服务端，WAL）
- **Tailwind CSS v4** + `tailwind-merge` + `class-variance-authority`
- **@base-ui/react** UI 原语
- **Vitest** 单元测试（vite 环境）

## 目录结构

```
src/
  app/
    page.tsx              # 首页视频流（按意图/主题/平台过滤）
    channels/             # 频道管理页
    research/             # 研究收藏工作台
    settings/             # 设置页（tab 路由由 SettingsShell 处理）
    api/                  # API 路由（详见下文）
  components/             # React 组件
    settings/             # 设置页各 tab 组件
    ui/                   # 基础 UI 组件
  lib/                    # 服务端逻辑（DB/爬虫/流水线/AI）
  mcp-server/             # MCP Server（stdio 模式，供外部 agent 连接）
  hooks/                  # React hooks
  contexts/               # React contexts
  types/                  # 共享类型

browser-runtime/          # 第一方 Needle Browser 守护进程（子项目，有独立 package.json）
browser-bridge/extension/ # Needle Browser Bridge Chrome 扩展源码（子项目）
browser-bridge-package/   # 预构建好的 bridge 扩展产物（运行时加载）
scripts/                  # 顶层 mjs 脚本（backup/restore/stop/export）
docs/                     # 历史设计文档（非活文档，多为 2026-03 时期规划）
data/                     # 运行时数据（gitignored）
```

`plans/`、`.factory/`、`.codex/`、`.forge/`、`.gstack/` 都是 gitignored 的 AI 工具链或临时规划产物，不属于应用源码目录；`biliscope-repo/` 也被 .gitignore 排除，只是共存的 Chrome 扩展伴生仓，Needle 构建不依赖它。`BilibiliSummaryPopup.tsx` 里出现的 `biliscope-*` CSS class name 只是作为 DOM hook，供扩展注入样式。

## 数据存储结构

```
data/
  folo.db                              # SQLite 数据库
  subtitles/<platform>/<videoId>/      # 字幕 JSON 文件
  summaries/<platform>/<videoId>.md    # AI 摘要 markdown（含 YAML frontmatter）
  summary-md/<platform>/<videoId>.md   # 导出的字幕任务文件
  agent-artifacts/<intentName>/         # 意图 Agent 产物 markdown
  logs/                                # JSONL 结构化日志
  backups/                             # 备份归档
```

## 数据库 Schema（src/lib/db.ts）

`channels`
- `id`、`platform`、`channel_id`（唯一）、`name`、`avatar_url`、`description`
- `category`、`category2`（历史两级分类字段，仍存在未删除）
- `intent`（TEXT，所属意图名，默认"未分类"，非外键）
- `topics`（TEXT，JSON 字符串数组，如 `["AI","科技"]`）
- `crawl_error_count`、`crawl_backoff_until`、`created_at`

`videos`
- `id`、`channel_id` FK `ON DELETE CASCADE`、`platform`、`video_id`（唯一）
- `title`、`thumbnail_url`、`published_at`、`duration`、`channel_name`、`source`
- `is_read`、`is_members_only`、`members_only_checked_at`、`access_status`
- `subtitle_status` / `subtitle_path` / `subtitle_language` / `subtitle_format` / `subtitle_error`
- `subtitle_last_attempt_at`、`subtitle_retry_count`、`subtitle_cooldown_until`
- `automation_tags`（JSON 数组）、`created_at`

`intents`
- `id`、`name`（唯一）、`sort_order`、`created_at`
- `auto_subtitle` / `auto_summary`（0/1 开关）
- `auto_summary_model_id`（意图级别的自动摘要模型覆盖）
- `agent_prompt`（TEXT）、`agent_trigger`（TEXT，`manual`/`daily`/`on_new_videos`）、`agent_memory`（TEXT）— 意图 Agent 配置
- 默认种入：工作、娱乐、探索、新闻、未分类

`summary_tasks`
- `id`、`video_id`、`platform`、UNIQUE(video_id, platform)
- `status`：`pending` / `processing` / `completed` / `failed` / `skipped`
- `method`、`error`、`created_at` / `started_at` / `completed_at`

`app_settings`
- `key` PRIMARY KEY、`value`（JSON 字符串）、`updated_at`
- 存调度器状态、爬虫暂停态、pipeline 配置、AI 设置、意图快捷键等

`research_intent_types`、`research_favorites`、`research_collections`、`research_collection_items`
- 研究收藏子系统。`research_favorites` 关联 `videos(id)` 级联删除，`research_collection_items` 是收藏与集合的多对多连接，支持 override。

## 核心数据流

1. **添加频道**：用户粘贴 URL → `resolveChannelFromUrl` 识别平台并解析 channel_id → `POST /api/channels/` 写入 `channels`
2. **发现视频**：`scheduler.ts` 定时或用户点击刷新 → `fetcher.ts` 按 `pipeline-config.ts` 的顺序依次尝试各平台 source → Needle Browser runtime 返回视频列表 → `INSERT OR IGNORE` 写入 `videos` → `events.emit('video:discovered')`
3. **自动字幕**：`auto-pipeline.ts` 监听 `video:discovered` → 查意图 `auto_subtitle` 标志 → 入 AsyncPool 字幕队列 → `subtitles.ts.ensureSubtitleForVideo()` → 按 `subtitle_pipeline_config` 顺序尝试 `browser` → `gemini` → 写磁盘 → `events.emit('subtitle:ready')`
4. **自动摘要**：`auto-pipeline.ts` 监听 `subtitle:ready` → 查意图 `auto_summary` → `summary-tasks.ts` 创建任务 → `summary-queue.ts` 顺序处理 → `ai-summary-client.ts` 调 OpenAI 兼容 API → 写 `data/summaries/*.md`
5. **SSE 推送**：`/api/sse` 订阅 `events.ts` 全局 EventEmitter，把 `video:new-skeleton` / `video:enriched` / `crawler-status` / `pipeline-status` / `summary-*` / `subtitle-status` 等事件推给前端
6. **研究收藏**：用户在播放器或视频卡片里收藏 → `POST /api/research/favorites/` 写 `research_favorites` → `/research` 工作台支持组织为集合并导出 ZIP 包
7. **AI 问答**：`ChatPanel` 里选定字幕时间范围 → `POST /api/videos/[id]/chat/` 带 `{rangeStart, rangeEnd, prompt, mode}` → `ai-chat-client.ts` 组 prompt（读取 `chatObsidian` 或 `chatRoast` 模板）→ `createChatStream` 经 `shared-ai-budget` 限速 → SSE 流式返回 `{delta, done, error}` 帧

## API 路由

完整的 route.ts 清单如下。**只列实际存在的路由。**

**视频** (`/api/videos/`)
- `GET/PATCH /api/videos/` — 分页列表；PATCH 切换 `is_read`
- `POST/DELETE /api/videos/refresh/` — 手动触发频道刷新 / 取消运行中的刷新
- `GET /api/videos/lookup/` — 按 `video_id` + `platform` 查询视频行
- `GET/POST /api/videos/[id]/subtitle/` — 读字幕 / 按需抓字幕
- `GET /api/videos/[id]/summary/` — 读取摘要 markdown（含历史版本）
- `POST /api/videos/[id]/summary/generate/` — 触发单视频摘要生成
- `GET /api/videos/[id]/comments/` — 经 Piped 获取 YouTube 评论
- `POST /api/videos/[id]/repair/` — 清空本地视频元数据 / 字幕 / 摘要后重抓单视频 detail，并以手动优先级触发一次 auto-pipeline
- `POST /api/videos/[id]/chat/` — 字幕范围内的 AI 问答（SSE 流式），支持 `obsidian` / `roast` 两种 mode

**频道** (`/api/channels/`)
- `GET/POST /api/channels/`、`PATCH/DELETE /api/channels/[id]/`
- `GET /api/channels/categories/` — 遗留的 category 聚合
- `POST /api/channels/bulk-update/` — 批量改 intent / 追加 topics
- `GET/POST /api/channels/markdown/` — 导出 markdown

**订阅导入** (`/api/subscriptions/`)
- `GET/POST /api/subscriptions/youtube/` — YouTube OPML / yt-dlp 订阅导入
- `POST /api/subscriptions/youtube/browser/` — 在 Needle Browser 里打开 YT 登录页
- `POST /api/subscriptions/import/` — 统一写入入口（接收 `channels[]`）

**摘要任务** (`/api/summary-tasks/`)
- `GET /api/summary-tasks/` — 列表
- `POST/DELETE /api/summary-tasks/process/` — 启动 / 停止队列处理器
- `POST /api/summary-tasks/retry/` — 重试失败任务
- `GET /api/summary-tasks/stats/` — 按状态计数

**爬虫 / 运行时** (`/api/crawler/`、`/api/crawl-runtime/`、`/api/scheduler/`、`/api/task-queues/`)
- `GET /api/crawler/status/`、`POST /api/crawler/pause/`
- `GET/POST /api/crawl-runtime/` — 调度器运行时配置 + auto-pipeline 状态
- `GET/POST /api/scheduler/` — 旧版路径的兼容 shim
- `POST /api/task-queues/clear/` — 清空字幕或摘要内存队列

**设置** (`/api/settings/`) — 注意没有根 CRUD 路由，每个设置块都有自己的子路径
- `ai-summary/`、`ai-summary/test/`
- `bilibili-auth/`
- `browser-keepalive/`
- `crawl-pipeline/`、`subtitle-pipeline/`
- `crawler-performance/`、`frontend-performance/`
- `home-intent-shortcuts/`、`player-keyboard-mode/`
- `intents/`、`intents/[id]/`、`intents/reorder/`

**Bilibili** (`/api/bilibili/`)
- `GET/POST /api/bilibili/following/` — WBI 签名关注列表；POST 批量导入为频道
- `POST /api/bilibili/following/browser/` — Needle Browser 打开登录页
- `GET /api/bilibili/playback/` — 解析播放直链
- `GET/HEAD /api/bilibili/media/` — 媒体字节代理（支持 Range）
- `GET /api/bilibili/summary/` — Bilibili 官方 AI 摘要

**研究** (`/api/research/`)
- `GET/POST/PATCH /api/research/favorites/`、`DELETE /api/research/favorites/[id]/`
- `POST /api/research/favorites/from-url/` — 从视频 URL 直接创建收藏（自动解析/导入视频）
- `GET/POST /api/research/intent-types/`、`PATCH/DELETE /api/research/intent-types/[id]/`
- `GET/POST /api/research/collections/`、`GET/PATCH/DELETE /api/research/collections/[id]/`
- `POST/PATCH/DELETE /api/research/collections/[id]/items/`
- `POST /api/research/exports/` — 集合导出为 ZIP 包
- `GET /api/research/videos/resolve/` — URL → 视频行

**备份 / 浏览器 / 日志 / SSE**
- `GET /api/backup/download/`、`GET/POST /api/backup/restore/`
- `GET /api/browser/bridge/`、`POST /api/browser/keepalive/`
- `GET /api/logs/`、`GET /api/logs/stats/`
- `GET /api/sse/`

## src/lib 关键文件

**爬虫与调度**
- `scheduler.ts` — 定时爬取调度器（globalThis 单例，支持退避）
- `fetcher.ts` — 抓取分派器，依赖 pipeline-config 的来源顺序
- `pipeline-config.ts` — 爬取 + 字幕流水线配置读写（定义来源、从 `app_settings` 读取用户启用状态与顺序）
- `crawler-status.ts` — scope 锁、暂停状态
- `crawler-performance.ts` — 性能档位与节流
- `manual-refresh.ts` — 手动刷新运行 ID / 取消令牌
- `refresh-history.ts` — 按频道/意图记录最后成功抓取时间

**字幕**
- `subtitles.ts` — `ensureSubtitleForVideo` 入口，按 pipeline 顺序尝试 browser → Gemini fallback
- `subtitle-backoff.ts` — `missing` / `empty` 状态的阶梯重试
- `subtitle-api-fallback-settings.ts`、`subtitle-browser-fetch-settings.ts` — 字幕来源的细粒度配置

**AI 摘要 / 问答 / 共享预算**
- `ai-summary-client.ts` — OpenAI 兼容 API 调用 + 流式 + 写文件
- `ai-summary-settings.ts` — 多模型、**五套** prompt 模板（`default`/`subtitleApi`/`subtitleSegment`/`chatObsidian`/`chatRoast`）、双默认模型、共享预算参数；config 文档 version 5
- `ai-chat-client.ts` — 播放器 AI 问答的 prompt 构建（`buildChatPrompt`）+ 流式调用（`createChatStream`）；两种 mode：`obsidian`（输出带 YAML frontmatter 的 markdown 笔记）/ `roast`（输出吐槽短评）。两种 system prompt 都可被用户在设置里覆盖
- `summary-queue.ts` — 批量摘要单例队列
- `summary-tasks.ts` — 任务 CRUD 和状态机
- `video-summary.ts` — 从磁盘读摘要 + 历史版本
- `shared-ai-budget.ts` — 摘要、Gemini 字幕 fallback、AI 问答共享的 RPM/TPM/RPD 预算调度器

**事件驱动流水线**
- `auto-pipeline.ts` — 监听 `video:discovered` / `subtitle:ready` 自动触发字幕/摘要；三层架构（Layer 0 骨架 → Layer 1 enrichment → Layer 2 字幕/摘要池）
- `enrichment-queue.ts` — Layer 1 元数据补全队列；当前是手动补救通道，不从 scheduler/auto-pipeline 主流程自动回扫
- `video-rescrape.ts` — 首页右键"重抓"入口：清理单视频本地状态、删除磁盘字幕/摘要、重发 `video:discovered` 并排入 enrichment
- `async-pool.ts` — 自适应并发池（优先级队列、速率限制、暂停/恢复）
- `events.ts` — `globalThis` 上的单例 EventEmitter（供 SSE 推送）

**Browser 集成**
- `browser-runtime.ts` — 调用 Needle Browser 守护进程 CLI
- `browser-session-manager.ts` — 浏览器会话生命周期
- `browser-source-shared.ts` — `runBrowserCliJson` + 平台共享工具
- `browser-youtube-source.ts` / `browser-bilibili-source.ts` — 平台特定命令封装
- `browser-distribution.ts` — 读取 `browser-bridge-package/` 的 bundled 产物路径
- `browser-keepalive.ts` + `browser-keepalive-client.ts` — 会话保活（服务端 + 客户端配合）

**Bilibili**
- `wbi.ts` — WBI 签名（12 小时 keys 缓存）
- `bilibili-auth.ts` — SESSDATA 管理
- `bilibili-following.ts` — 关注列表三级回退
- `bilibili-playback.ts` — playurl 解析 + 媒体代理

**导入 / 导出 / 研究**
- `import-subscriptions.ts` — OPML / 关注列表解析
- `channel-markdown.ts` — 频道数据导出为 markdown
- `research.ts` — 研究集合导出成 ZIP 包
- `backup-system.ts` — 创建与恢复备份归档

**播放器 / 前端性能**
- `player-keyboard-arbiter.ts` + `player-keyboard-mode.ts` — 播放器键盘焦点仲裁
- `youtube-player.ts` — YouTube iframe postMessage 协议纯工具库（`createYouTubeListeningMessage` / `isTrustedYouTubeOrigin` / `parseYouTubePlayerMessage`）
- `frontend-performance.ts` — 读写 `frontend_performance_desktop` / `frontend_performance_mobile` 两个 `app_settings` key，返回 `{desktop, mobile}`，两者均为 `'full' | 'reduced'`

**意图 Agent**
- `intent-agent.ts` — Agent 上下文构建、产物存储/读取（`data/agent-artifacts/`）、视频搜索、字幕读取、记忆更新
- `src/mcp-server/index.ts` — MCP Server（stdio），5 个 tools：`get_intent_agent_context` / `search_videos` / `read_subtitle` / `save_artifact` / `update_memory`；配置见 `.mcp.json`

**基础**
- `db.ts` — SQLite 初始化 + 迁移 + 类型
- `app-settings.ts` — 通用 key-value 配置读写
- `logger.ts` — JSONL 结构化日志
- `url-utils.ts`、`utils.ts`、`format.ts`
- `piped.ts` — Piped 实例客户端（仅 `/api/videos/[id]/comments/` 使用）

## 主要组件（src/components/）

**首页 / 视频**
- `VideoCard.tsx` — 视频卡片（字幕/摘要徽章）
- `PlayerModal.tsx` — 桌面播放器弹窗：`EmbeddedPlayer` + `VideoInfoPanel` + `ChatPanel`，集成 `useMediaSession` 和 `player-keyboard-arbiter`
- `player/EmbeddedPlayer.tsx` — YouTube iframe / Bilibili `<video>` 统一播放组件，支持音频模式切换，内嵌静音心跳 MP3 维持 iOS 锁屏音频
- `AudioModeOverlay.tsx` — 音频模式全屏覆盖层（模糊封面 + 标题 + 播放控制 + 进度条），移动端默认启用
- `ChatPanel.tsx` — 播放器 AI 问答面板（笔记模式 / 吐槽模式切换 + 流式输出 + 导出 md / 截图 PNG）
- `TimelineRange.tsx` — 双滑块字幕范围选择器，供 `ChatPanel` 选定问答输入
- `ShareCard.tsx` — 固定 540px 深色分享卡（吐槽模式专用，`html-to-image` 导出 PNG）
- `VideoInfoPanel.tsx` — 播放器与移动端 sheet 共用的信息面板（字幕 / 摘要 / 评论 / 研究收藏）
- `SummaryHoverPreview.tsx` — 摘要 hover 预览
- `SummaryTaskBadge.tsx` — 摘要任务实时徽章
- `TaskStatusBar.tsx` — 爬虫 + 调度器 + 两个队列的统一状态栏
- `CrawlerCompactBar.tsx` — 顶部紧凑爬虫状态
- `MarkdownRenderer.tsx` — 摘要 markdown 渲染
- `MobileIntentBar.tsx`、`MobileVideoSheet.tsx`、`MobileVideoOverlay.tsx` — 移动端布局
- `BrowserKeepalive.tsx` — 客户端 keepalive 定时器
- `ExternalVideoAddModal.tsx` — 外部 URL 添加视频为研究收藏

**侧边栏 / 导航 / 管理**
- `AppSidebar.tsx` — 主侧边栏（意图分组、平台/主题过滤）
- `IntentManagement.tsx` — 意图 CRUD + 自动化开关 + 拖拽排序
- `LogPanel.tsx` — 日志面板与统计

**研究**
- `ResearchFavoriteModal.tsx` — 收藏新建/编辑弹窗
- `ResearchIntentManagement.tsx` — 研究意图类型管理

**订阅导入**
- `ImportSubscriptionsPanel.tsx` / `UnifiedImportModal.tsx` — 订阅导入 UI
- `BilibiliFollowingModal.tsx` — B 站关注列表导入
- `BilibiliSummaryPopup.tsx` — B 站官方 AI 摘要弹窗

## Hooks & Contexts

- `src/hooks/useMediaSession.ts` — 把视频元数据推给浏览器 Media Session API，注册 play/pause/seek/skip action handlers，`setPositionState` 同步锁屏进度条；handler 用 ref 持有，避免重复注册
- `src/contexts/PerformanceContext.tsx` — 页面挂载时从 `/api/settings/frontend-performance` 拉取设置，检测设备类型（width ≤ 900px 或 UA），切换 `<html>` 的 `performance-reduced` class；监听 `frontend-performance-changed` 自定义 window 事件实时刷新，无需 reload。暴露 `usePerformance()` hook

## 设置页（src/components/settings/）

`SettingsShell.tsx` 用 `?tab=` URL 参数驱动路由。各 tab：

- `CrawlingTab.tsx` — 爬虫性能档位、爬取间隔、爬取来源顺序
- `SubtitlesTab.tsx` — 字幕来源顺序（含 Gemini）、Gemini 字幕 prompt 模板、backoff 流程可视化
- `SummaryTab.tsx` — 五套 prompt 模板编辑（摘要 + 字幕 API + 字幕分段 + 笔记模式 + 吐槽模式），各自支持重置默认
- `ModelsTab.tsx` — 多模型管理、手动/自动默认模型、共享预算参数
- `IntentTab.tsx` — 包装 `IntentManagement`
- `LogsTab.tsx` — 包装 `LogPanel`
- `BilibiliSummaryTab.tsx` — SESSDATA 认证 + 官方 AI 摘要开关
- `PerformanceTab.tsx` — 爬虫性能档位 + 浏览器 keepalive 预设 + **前端性能**（桌面 / 移动端各自 `full` / `reduced`）
- `BackupTab.tsx` — 备份创建 / 恢复
- `AppearanceTab.tsx` — 主题与显示偏好
- `shared.ts` — 共享类型与 `useAiSettings` hook
- `subtitle-backoff-flow.ts` — 为 SubtitlesTab 准备的 backoff 可视化纯数据

## 环境变量（.env.example）

核心路径：`DATABASE_PATH`、`DATA_ROOT`、`SUBTITLE_ROOT`、`SUMMARY_ROOT`、`SUMMARY_MD_ROOT`

外部工具：`PYTHON_BIN`、`YT_DLP_BIN`、`FFMPEG_BIN`、`FFPROBE_BIN`

认证：`YOUTUBE_COOKIES_BROWSER`、`BILIBILI_SESSDATA`

诊断：`LOG_LEVEL`

> 旧的 OPENCLI 相关环境变量已不再使用。不要基于它们写新逻辑。

AI 模型的 endpoint / API key / model 不走环境变量，全部在设置页 → 模型标签页配置。

## 注意事项

- **better-sqlite3 是同步的**，所有 DB 访问必须在服务端。不要在 client component 里 `import '@/lib/db'`
- **全局单例**：`scheduler.ts`、`summary-queue.ts`、`events.ts`、`shared-ai-budget.ts`、`manual-refresh.ts`、`auto-pipeline.ts` 都通过 `globalThis[Symbol.for(...)]` 持有状态，防止 Next.js HMR 重复实例化
- **意图系统**：`channels.intent` 是纯 TEXT（非 FK），删除意图时旗下频道 intent 字段被重置为"未分类"。`channels.topics` 是 JSON 字符串数组，与 category/category2 并存
- **字幕冷却与退避**：状态机 `none` → `pending` → `completed` / `error` / `missing` / `empty`；`subtitle_retry_count` 与 `subtitle_cooldown_until` 控制阶梯重试
- **流水线配置**：`app_settings` 的 `crawl_pipeline_config` / `subtitle_pipeline_config` 由 `pipeline-config.ts` 单一管理；`fetcher.ts` 和 `subtitles.ts` 运行时从这里取顺序。当前爬取链只剩 `browser`，字幕链只剩 `browser` + `gemini`，其它旧来源（opencli / rss / piped / pipepipe / yt-dlp）会在读取时被归一化掉
- **共享 AI 预算**：字幕 Gemini fallback 与摘要生成共用 `shared-ai-budget.ts`；RPM/TPM 60 秒滑动窗口，RPD 近 24 小时窗口；优先级 manual-summary > manual-subtitle > auto-summary > auto-subtitle；`subtitleFallbackTokenReserve` 限制字幕占比
- **Gemini 字幕 fallback**：需要本地 `ffmpeg` / `ffprobe` 切分音频；默认每段 15 分钟（`AI_SUBTITLE_CHUNK_SECONDS`）
- **Bilibili WBI**：`wbi.ts` 12 小时缓存 mixin key；跳过会破坏大多数 Bilibili API 调用
- **Needle Browser**：这是仓内子项目（`browser-runtime/` + `browser-bridge/`），预构建产物放在 `browser-bridge-package/`；需要先 `npm run browser:prepare`，再在 Chrome 里 Load unpacked 加载 `browser-bridge/extension`
- **Settings 路由**：没有 `/api/settings/` 根路径，所有配置都有独立子路径；URL `?tab=` 用 `SettingsShell` 的 `legacyTabMap` 兼容旧 tab 名
- **AI 问答 prompt 模板**：`ai-summary-settings.ts` 的 `promptTemplates` 现在有 5 个 key：`default`、`subtitleApi`、`subtitleSegment`、`chatObsidian`、`chatRoast`；config 文档 version 为 5。`chatObsidian` 的默认模板里有一个**故意拼错**的 `creat_at` 字段，`ai-chat-client.ts` 的 `buildChatPrompt` 也保持一致，不要"修"它
- **前端性能模式**：`PerformanceContext` 在 client 端通过 `performance-reduced` class 切换 CSS 级特效；配置保存在 `app_settings` 的 `frontend_performance_desktop` / `frontend_performance_mobile`。`PerformanceTab` 保存后 dispatch `frontend-performance-changed` 自定义事件，context 实时更新无需 reload
- **音频模式 / 锁屏**：`EmbeddedPlayer` 持续循环播放一段静音 MP3 来维持 iOS 锁屏音频会话，移动端（≤ 900px）挂载时自动启用音频模式；媒体会话 metadata 和 action handler 由 `useMediaSession` 统一注入
- **.gstack 目录**：`.gstack/` / `.factory/` / `.codex/` / `.forge/` 都是 AI 工具链产物，不是应用的一部分
