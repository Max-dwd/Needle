# 首页右键菜单「重抓视频」设计

## 背景

当前 VideoCard 右键菜单的"修 元数据"项（`src/components/VideoCard.tsx` 第 865-882 行）调用
`POST /api/videos/[id]/repair/`，内部走 `enrichVideo()`。但 `enrichVideo` 入口即通过
`needsEnrichment()` 判定，只要 `thumbnail_url` + `duration` + `published_at` +
`members_only_checked_at` 都非空就直接 `skip_already_complete`。结果是：

- 对字段"看起来齐全但其实有错"（错标题、旧缩略图、access_status 变化、被删/下架后又恢复）
  的视频，按钮**完全空转**。
- 对 `availability_status = 'abandoned'` 的视频，API 直接 409 拦截，不给复活机会。

用户诉求：点一下就**真正"重来一次"**——丢掉这条视频除身份之外的所有本地数据，然后走一遍
"抓取成功"路径，让元数据、字幕、摘要自然重生。

## 目标 / 非目标

**目标**

- 点击后：清理 `videos` 行上绝大多数字段 + 磁盘字幕/摘要文件 + `summary_tasks` 对应行，
  随即重新抓取单视频元数据并按意图自动化设置重跑字幕/摘要。
- 可用于"复活" `abandoned` 视频：若详情再能抓到，清掉 abandoned 标记；否则重新标记。
- 对同一视频的重复点击幂等（不并发多个重抓任务）。

**非目标**

- 不动 `channels` 表。
- 不动用户状态：`is_read`、`automation_tags` 保留。
- 不动研究收藏：`research_favorites` 行保留（`video_id` FK 不变）。
  但由于字幕/摘要被清，收藏里关联的字幕片段/摘要内容在重抓完成前会暂时失效——
  可接受。
- 不走频道 feed 路径（对老视频可能不包含该 video_id，代价还大）。

## 决策摘要（已与用户确认）

| 维度 | 选择 |
|---|---|
| 抓取路径 | 单视频 detail（`fetchYouTubeVideoDetail` / `fetchBilibiliVideoDetail`） |
| 清理范围 | videos 核心元数据 + 字幕状态字段 + 磁盘字幕目录 + 磁盘摘要（含历史） + summary_tasks 行；保留 is_read / automation_tags / research_favorites |
| 自动流水线 | 是，重抓后 emit `video:discovered`，让 `auto-pipeline` 按 intent 自动跑字幕+摘要 |
| UI | 原地替换"修 元数据" → "重抓视频"，仍在右键菜单第一项 |
| abandoned 视频 | 允许重抓，成功即复活（清 availability_status） |
| 并发保护 | 复用 enrichment pool + 增加按 videoDbId 的 in-flight dedupe |

## 变更清单

### 1. 新增：`rescrapeVideo(videoDbId)` —— `src/lib/video-rescrape.ts`（新文件）

纯服务端函数，所有改动聚合在这里，便于测试。流程：

1. **加载视频行**（JOIN channels 取 `channel_id`、`name`、`intent`、`avatar_url`）。
   404 则返回 `{ ok: false, reason: 'not_found' }`。
2. **in-flight dedupe**
   - 在 `src/lib/enrichment-queue.ts` 的 module state 里新增
     `inFlightRescrapes: Set<number>`（key = videoDbId）。
   - 若已在集合中 → `{ ok: false, reason: 'in_progress' }`。
   - 进入时 add，finally 移除。
3. **清理磁盘资产**（失败不阻塞主流程，仅 warn 日志）
   - `data/subtitles/<platform>/<videoId>/`：`fs.rm({ recursive: true, force: true })`
   - `data/summaries/<platform>/<videoId>.md` + 同目录下 `…<videoId>.<timestamp>.md` 历史版本：
     列目录后过滤删除。路径常量来自 `SUBTITLE_ROOT` / `SUMMARY_ROOT`
     （`src/lib/env.ts` 或 `app-settings.ts`，按现有取法）。
4. **清理 DB 字段**（单个 `UPDATE`，保留 `id / channel_id / platform / video_id /
   created_at / is_read / automation_tags`）
   ```sql
   UPDATE videos SET
     title = NULL,
     thumbnail_url = NULL,
     published_at = NULL,
     duration = NULL,
     channel_name = NULL,              -- 会被 detail 或 feed 重填；保留也行，这里置空更彻底
     source = NULL,
     is_members_only = 0,
     access_status = NULL,
     members_only_checked_at = NULL,
     availability_status = NULL,
     availability_reason = NULL,
     availability_checked_at = NULL,
     subtitle_status = NULL,
     subtitle_path = NULL,
     subtitle_language = NULL,
     subtitle_format = NULL,
     subtitle_error = NULL,
     subtitle_last_attempt_at = NULL,
     subtitle_retry_count = 0,
     subtitle_cooldown_until = NULL
   WHERE id = ?;
   ```
5. **删除 summary_tasks 行**
   ```sql
   DELETE FROM summary_tasks WHERE video_id = ? AND platform = ?;
   ```
6. **Emit `video:enriched` 让前端清空卡片视觉状态**（可选；若前端依赖 SSE 立刻刷新）。
   更简单也可以复用现有 `video:availability-changed` / dispatch 一个
   `video:reset` 自定义事件——需要先决定前端监听方式（见 §3）。
7. **Emit `video:discovered`**（进 auto-pipeline）
   - payload 按 `scheduler.ts:insertOrUpdateVideos` 里的形态：
     `{ videoId, platform, channelId: channel.channel_id, channelName, priority: 0, at }`。
   - priority 0 = 手动优先，和手动刷新一致。
   - auto-pipeline `onVideoDiscovered` 的 skip 条件
     （`subtitle_status === 'fetched' || subtitle_path`）因为我们已清空，故自然进入
     队列；若 intent 的 `auto_subtitle=1` 就入字幕池，字幕完成后 `subtitle:ready`
     自动建 summary_task。
8. **调用 `enrichVideo(videoDbId)`**（异步进 enrichment pool）
   - 已经清空的字段会让 `needsEnrichment()` 返回 true，正常刷元数据。
   - `abandoned` 视频：因 `availability_status` 已被清空，不会再被 line 144-146
     的分支短路。
   - 若详情抓取失败 + 目标为 YouTube → 现有逻辑会 probe 可用性，必要时重新标记
     unavailable。这条路径对 abandoned 重试也兼容。

### 2. 改造：`src/app/api/videos/[id]/repair/route.ts` → 调用 `rescrapeVideo`

为保持 URL 稳定（同时接受小重命名），将 POST handler 改为调 `rescrapeVideo`：

- 入参校验不变。
- 去掉 `availability_status === 'abandoned'` 的 409 分支。
- 返回：
  - 202 + `{ accepted: true, videoId, platform }` 表示清理已完成、抓取已入队。
  - 409 + `{ error: 'rescrape_in_progress' }` 当 in-flight dedupe 命中。
  - 404 / 400 保持。

选项：同时新增 `POST /api/videos/[id]/rescrape/` 作为更语义化的别名，`repair`
保留一个 deprecated 的转发（实现上都调同一个 `rescrapeVideo`）。如果只改 `repair`
更省事——因为调用方只有 VideoCard 和一个测试文件。

**推荐：仅改 `repair`，不新增路径**（最小改动、不污染 API 表面）。

### 3. 前端：`src/components/VideoCard.tsx`

- `triggerMetadataRepair` → 改名 `triggerRescrape`；对应 state
  `metadataRepairing` → `rescraping`。
- 去掉 `video.availability_status === 'abandoned'` 的禁用条件（改后允许重抓）。
- 右键菜单第一项文案：
  - 标签："重抓"
  - hint：`abandoned` 时提示"复活重抓"；`rescraping` 时 `"处理中…"`；
    否则 `"视频"` 或 `"元数据+字幕+摘要"`（短一点）。
- 按钮点击二次确认**不做**（和其它菜单项保持一致，清理范围写清楚到 hint/tooltip 即可）。
- SSE 已有 `video:enriched`、`summary-*`、`subtitle-status` 可以驱动卡片实时更新。
  **无需**额外广播 `video:reset`——UI 在清理后瞬间会短暂看到空字段，随后 SSE
  推来元数据/字幕/摘要更新，体验可接受。

### 4. `src/lib/enrichment-queue.ts`

- 新增 `inFlightRescrapes: Set<number>`（module state，`globalThis` symbol 保护）。
- 导出两个 helper 供 `video-rescrape.ts` 使用：`acquireRescrapeLock(videoDbId): boolean`、
  `releaseRescrapeLock(videoDbId): void`。
- `enrichVideo` 本身不变——它对清空后的视频行天然会走 enrich 分支。

### 5. 删除 / 更新测试

- `src/app/api/videos/[id]/repair/route.test.ts`
  - 移除 "abandoned → 409" 的断言（现在允许重抓）。
  - 新增：路由会调用 `rescrapeVideo`；mock 其成功/失败分支。
  - 新增：in-flight 冲突 → 409。
- 新增 `src/lib/video-rescrape.test.ts`
  - ✅ 会 `DELETE FROM summary_tasks`
  - ✅ 会 `UPDATE videos` 清指定字段，保留 `is_read/automation_tags`
  - ✅ 会尝试 `rm` 字幕目录 + 摘要 md + 历史版本（用临时目录 + mock fs）
  - ✅ emit `video:discovered` 且 payload 携带 channelId/channelName/priority=0
  - ✅ 调用 `enrichVideo`
  - ✅ abandoned 视频也允许进入（不 early-return）
  - ✅ 并发重抓被 dedupe

### 6. 文档

- `CLAUDE.md` / `AGENTS.md` 的 API 路由段：把 `/api/videos/[id]/repair/` 的描述
  从"加入 enrichment-queue 补全缺失元数据"改成"清空本地数据后重抓元数据，
  并触发一次 auto-pipeline（等同于新发现一次）"。
- 同时在"注意事项"里备注：enrichment-queue 是**手动补救通道**，**不**出现在
  scheduler/auto-pipeline 主流程里——这是当前真实状态，文档现在的"三层架构"表述会误导。

## 非功能

- **幂等性**：in-flight set + fire-and-forget 的 enrichVideo，双触发时第二次 409。
- **原子性**：DB 清理用一个 `UPDATE` + 一个 `DELETE`，无事务也可接受（两条都失败
  的概率极低，且即使失败状态仍是合理中间态）。真要稳，可包 `db.transaction`。
- **AI 配额**：重抓会触发 `auto_subtitle`/`auto_summary`，走 `shared-ai-budget`。
  对一次点击、单视频而言代价可控；若用户大量连点会被共享预算削峰。不加额外速率限制。
- **日志**：`log.info('rescrape', 'started' | 'db_cleared' | 'disk_cleared' |
  'enqueued', { videoDbId, videoId, platform, channel_id })`。

## 风险 / 权衡

1. 清掉磁盘摘要的"历史版本"是有损操作——用户如果珍视历史，重抓会擦除。
   由于用户明确勾选了 `summary_files`，按需保留历史版本可放到 v2（eg. 改名
   到 `…<videoId>.rescraped-<ts>.md` 保留）。
2. `research_favorites` 保留但关联的字幕/摘要被清。若用户要导出收藏集合，
   需要等重抓完成。当前不做额外提示。
3. `enrichVideo` 对 `abandoned` 的 YouTube 视频会触发 `probeYouTubeVideoAvailability`
   （会 `runYtDlp`，耗时 20s 超时）。对用户手动点的场景这是 OK 的——反而是
   复活判断所必须。

## 验收

1. 对一条字段齐全但"感觉有错"的视频点"重抓"→ 几秒后卡片所有字段刷新。
2. 对一条 `abandoned` 视频点"重抓"→ 若平台仍可访问，卡片复活；否则再次标
   unavailable。
3. 连点两次：第二次 API 返回 409，按钮保持 disabled。
4. 对一条 intent 开启 `auto_subtitle + auto_summary` 的视频点"重抓"→
   元数据刷新的同时字幕开始抓取，字幕完成后摘要任务入队。
5. 单测：`video-rescrape.test.ts` 全绿；`repair/route.test.ts` 更新后全绿。
