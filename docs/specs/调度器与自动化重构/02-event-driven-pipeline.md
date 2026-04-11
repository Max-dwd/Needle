# 02 — 事件驱动流水线

## 目标

将现有的三个独立定时器（crawl / subtitle / summary）重构为事件驱动流水线。只保留爬取定时器作为源头，字幕和总结由事件自动串联。意图（intent）的 `auto_subtitle` / `auto_summary` 成为唯一的自动化开关。

## 依赖

- **01-dual-model-config** — 需要 `triggerSource` 和意图级模型解析

## 当前架构问题

1. `scheduler.ts` 维护三个独立定时器，subtitle/summary tick 按固定间隔全量扫描数据库
2. `pipeline.ts` 监听事件触发规则引擎 → 即将移除
3. `rules.ts` 的 `getSummaryControlDecision` 有逻辑缺陷：存在控制规则时非匹配视频被 skip
4. 爬取完一个频道后不触发该频道视频的字幕下载，要等下一轮 subtitle 定时器
5. 字幕完成后不直接触发总结入队，要等下一轮 summary 定时器扫描

## 新架构

```
                    ┌─────────────┐
                    │ 爬取定时器   │  (唯一的定时器，可配置间隔)
                    │ crawl timer │
                    └──────┬──────┘
                           │
                    逐频道爬取，每发现一个新视频 emit:
                           │
                    ┌──────▼──────┐
                    │video:discovered│
                    └──────┬──────┘
                           │
              ┌────────────▼─────────────┐
              │ 查询频道所属 intent       │
              │ intent.auto_subtitle = 1?│
              └────┬──────────────┬──────┘
                   │yes           │no
          ┌────────▼────────┐     │
          │ 抓取字幕         │     │(流水线终止)
          │ ensureSubtitle  │     │
          └────────┬────────┘     │
                   │              │
          ┌────────▼────────┐     │
          │ subtitle:ready  │     │
          └────────┬────────┘     │
                   │              │
          ┌────────▼─────────────┐│
          │ intent.auto_summary?  │
          └────┬──────────┬──────┘
               │yes       │no
      ┌────────▼────────┐ │
      │ 创建 summary    │ │(流水线终止)
      │ task → pending  │ │
      └────────┬────────┘ │
               │          │
      ┌────────▼────────┐ │
      │ summary-queue   │ │
      │ 处理 pending    │ │
      │ tasks           │ │
      └────────┬────────┘ │
               │          │
      ┌────────▼────────┐ │
      │summary:complete │ │
      └─────────────────┘ │
```

## 新模块：`src/lib/auto-pipeline.ts`

替代 `pipeline.ts`（规则引擎桥接）和 `scheduler.ts` 中的 subtitle/summary tick 逻辑。

### 核心接口

```typescript
interface AutoPipelineState {
  initialized: boolean;
  subtitleQueue: SubtitleJob[];
  subtitleProcessing: boolean;
  stats: {
    subtitleQueued: number;
    subtitleCompleted: number;
    subtitleFailed: number;
    summaryQueued: number;
  };
}

interface SubtitleJob {
  videoDbId: number;
  videoId: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
  intentName: string;
  enqueuedAt: string;
}
```

### 事件监听器注册

```typescript
export function ensureAutoPipeline(): void {
  if (state.initialized) return;
  state.initialized = true;

  appEvents.on('video:discovered', onVideoDiscovered);
  appEvents.on('subtitle:ready', onSubtitleReady);
}
```

### 启动行为

自动管线初始化时只注册事件监听器，不做数据库回扫。进程重启后，内存队列直接丢失；只有新的 `video:discovered` 和 `subtitle:ready` 事件会继续驱动流程。

```typescript
export function ensureAutoPipeline(): void {
  const state = getState();
  if (state.initialized) return;
  state.initialized = true;

  appEvents.on('video:discovered', onVideoDiscovered);
  appEvents.on('subtitle:ready', onSubtitleReady);
}
```

### 队列大小限制

内存字幕队列上限 `MAX_SUBTITLE_QUEUE = 100`。超出时新任务不入队，也不会在下次重启时自动捡回：

```typescript
const MAX_SUBTITLE_QUEUE = 100;

function enqueueSubtitleJob(job: SubtitleJob): boolean {
  if (state.subtitleQueue.length >= MAX_SUBTITLE_QUEUE) {
    log.warn('auto-pipeline', `subtitle queue full (${MAX_SUBTITLE_QUEUE}), skipping ${job.videoId}`);
    return false;
  }
  // 去重
  if (state.subtitleQueue.some(j => j.videoId === job.videoId)) return false;
  state.subtitleQueue.push(job);
  state.stats.subtitleQueued++;
  void processSubtitleQueue().catch(err =>
    log.error('auto-pipeline', `subtitle queue error: ${err}`)
  );
  return true;
}
```

### `onVideoDiscovered` 处理

```typescript
async function onVideoDiscovered(payload: {
  videoId: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
}) {
  // 1. 查询频道所属 intent
  const channel = getChannelByChannelId(payload.channelId);
  if (!channel) return;

  const intent = getIntentByName(channel.intent);
  if (!intent || !intent.auto_subtitle) return;

  // 2. 查询视频 DB 记录
  const video = getVideoByVideoId(payload.videoId, payload.platform);
  if (!video) return;
  if (video.subtitle_status === 'fetched' || video.subtitle_path) return;

  // 3. 加入字幕处理队列
  enqueueSubtitleJob({
    videoDbId: video.id,
    videoId: payload.videoId,
    platform: payload.platform,
    channelId: payload.channelId,
    intentName: channel.intent,
    enqueuedAt: new Date().toISOString(),
  });
}
```

### 字幕队列处理

内存队列，FIFO 顺序串行处理，避免并发冲突和限速问题：

```typescript
async function processSubtitleQueue(): Promise<void> {
  if (state.subtitleProcessing) return;
  state.subtitleProcessing = true;

  try {
    while (state.subtitleQueue.length > 0) {
      const job = state.subtitleQueue[0];

      // 检查 cooldown
      const video = getVideoById(job.videoDbId);
      if (video?.subtitle_cooldown_until && new Date(video.subtitle_cooldown_until) > new Date()) {
        state.subtitleQueue.shift();
        continue;
      }

      try {
        const result = await ensureSubtitleForVideo(job.videoDbId);
        state.stats.subtitleCompleted++;

        if (result?.subtitle_path && result.subtitle_status === 'fetched') {
          appEvents.emit('subtitle:ready', {
            videoId: job.videoId,
            platform: job.platform,
            at: new Date().toISOString(),
          });
        }
      } catch (error) {
        state.stats.subtitleFailed++;
        log.error('auto-pipeline', `subtitle failed: ${job.videoId} ${error}`);
      }

      state.subtitleQueue.shift();

      // 限速：字幕请求间隔 ≥ 1s
      await sleep(1000);
    }
  } finally {
    state.subtitleProcessing = false;
  }
}
```

### `onSubtitleReady` 处理

```typescript
async function onSubtitleReady(payload: {
  videoId: string;
  platform: 'youtube' | 'bilibili';
}) {
  // 1. 查询视频和频道
  const video = getVideoByVideoId(payload.videoId, payload.platform);
  if (!video) return;

  const channel = getChannelById(video.channel_id);
  if (!channel) return;

  const intent = getIntentByName(channel.intent);
  if (!intent || !intent.auto_summary) return;

  // 2. 检查是否已有 summary task
  const existing = getSummaryTask(payload.videoId, payload.platform);
  if (existing && existing.status !== 'failed') return;

  // 3. 创建 summary task
  createSummaryTask(payload.videoId, payload.platform);
  state.stats.summaryQueued++;

  // 4. 确保 summary queue 在运行
  if (!isQueueRunning()) {
    startQueueProcessing();
  }
}
```

## `scheduler.ts` 精简

### 移除内容

- `runSubtitleTick` 函数 — 被 auto-pipeline 字幕队列取代
- `runSummaryTick` 函数 — 被 auto-pipeline `onSubtitleReady` 取代
- `subtitle` 和 `summary` 的定时器槽位
- `SchedulerTaskName` 类型精简为只含 `'crawl'`

### 保留内容

- `runCrawlTick` — 爬取逻辑不变，但需要确保 `video:discovered` 事件携带 `channelId`
- 爬取定时器（间隔可配置）
- 爬取退避机制（`markChannelBackoff` / `resetChannelBackoff`）
- 爬取暂停/继续控制
- `getSchedulerConfig` / `getSchedulerStatus` — 精简字段

### `SchedulerConfig` 精简

```typescript
interface SchedulerConfig {
  enabled: boolean;
  crawlInterval: number;  // 保留
  // subtitleInterval 移除
  // summaryInterval 移除
}
```

### `SchedulerStatus` 精简

```typescript
interface SchedulerStatus {
  running: boolean;
  state: 'idle' | 'running' | 'waiting';
  currentTask: 'crawl' | null;  // 只有 crawl
  lastCrawl: string | null;
  nextCrawl: string | null;
  todayStats: { videos: number; subtitles: number; summaries: number };
  message: string | null;
  updatedAt: string;
}
```

## `summary-queue.ts` 适配

`runQueueLoop` 中调用 `generateSummaryViaApi` 时传递 `triggerSource: 'auto'`：

```typescript
const channel = getChannelForVideo(task.video_id, task.platform);
const result = await generateSummaryViaApi(task.video_id, task.platform, {
  triggerSource: 'auto',
  intentName: channel?.intent || undefined,
});
```

需要新增辅助函数 `getChannelForVideo` 从 videos JOIN channels 查询 intent。

## 手动刷新行为

手动刷新频道（`/api/videos/refresh/`）也会触发 `video:discovered` 事件，因此手动刷新发现的新视频同样进入自动字幕/总结流水线。这是期望行为——用户手动刷新后，新视频会自动走完整个处理链。

## 行为变更说明

**重要**：现有 `runSubtitleTick` 处理所有 `subtitle_status` 未完成的视频，不区分意图。新 pipeline 只处理 `auto_subtitle=1` 的意图下的视频。这意味着 `auto_subtitle=0` 的意图下的已有视频不会再被自动补字幕。这是正确的行为——意图开关是唯一的自动化控制。

## `CrawlerRuntimeStatus.subtitle` 处理

移除 subtitle 定时器后，`CrawlerRuntimeStatus.subtitle` scope 不再被更新。处理方式：
- 从 `CrawlerRuntimeStatus` 类型中移除 `subtitle` 字段
- SSE route 中不再推送 subtitle scope 状态
- 字幕处理状态改由 `AutoPipelineStatus.subtitle` 提供（通过新的 `pipeline-status` SSE 事件）

## 废弃设置清理

移除 `app_settings` 中的废弃 key：
- `scheduler_subtitle_interval` — 不再有字幕定时器
- `scheduler_summary_interval` — 不再有总结定时器
- `scheduler_last_subtitle` — 不再追踪
- `scheduler_last_summary` — 不再追踪

在 `ensureSchedulerAndPipeline` 中执行一次性清理：
```typescript
for (const key of ['scheduler_subtitle_interval', 'scheduler_summary_interval', 'scheduler_last_subtitle', 'scheduler_last_summary']) {
  deleteAppSetting(key);
}
```

## `video:discovered` 事件增强

当前事件 payload：

```typescript
{ videoId, platform, channelId, at }
```

新增字段供前端使用（spec 03）：

```typescript
{
  videoId: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string | null;
  duration: string | null;
  channelName: string;
  avatarUrl: string | null;
  at: string;
}
```

在 `insertOrUpdateVideos` 中，当 `result.changes > 0` 时发送完整数据。

## 入口变更

### `ensureScheduler` → `ensureSchedulerAndPipeline`

```typescript
export function ensureSchedulerAndPipeline() {
  ensureAutoPipeline();  // 替代 ensureAutomationPipeline()
  // ... 现有 scheduler 初始化逻辑
}
```

## 全局状态导出

新增 `getAutoPipelineStatus()` 供 SSE 和 API 使用：

```typescript
interface AutoPipelineStatus {
  subtitle: {
    queueLength: number;
    processing: boolean;
    currentVideoId: string | null;
    stats: { completed: number; failed: number };
  };
  summary: {
    queueLength: number;  // 从 summary_tasks 表查 pending count
    processing: boolean;  // isQueueRunning()
    currentVideoId: string | null;  // getQueueState().currentVideoId
  };
}
```

## 验收标准

1. 调度器只有一个爬取定时器，没有 subtitle/summary 定时器
2. 新视频发现后，如果 intent 开启了 auto_subtitle，自动下载字幕（无需等待定时器）
3. 字幕就绪后，如果 intent 开启了 auto_summary，自动创建总结任务并启动队列
4. 自动总结使用正确的模型（意图模型 > 全局自动模型 > 兜底）
5. 字幕处理队列有限速（≥1s 间隔），支持 cooldown 检查
6. `getAutoPipelineStatus()` 返回字幕/总结队列的实时状态
7. `pipeline.ts` 和 `rules.ts` 中的规则引擎调用全部移除（代码清理在 spec 05）
8. 手动刷新频道仍然正常工作，且手动触发的 `video:discovered` 同样进入流水线
9. 进程重启后，pipeline 不会自动恢复遗留的字幕/总结任务；只处理新的事件输入
