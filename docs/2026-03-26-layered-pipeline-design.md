# 分层异步流水线设计

> 日期: 2026-03-26
> 状态: 设计已确认，待实施

## 背景与动机

Needle 当前的爬取 → 字幕 → 摘要流水线存在多个严重的性能和健壮性问题：

1. `**execFileSync` 阻塞事件循环** — `opencli.ts` 和 `subtitles.ts` 中的同步子进程调用（120s 超时）会冻死整个 Node.js 服务器
2. **Bilibili enrichment 无限并发** — `Promise.all` 并行 20 个 API 请求，容易触发限流
3. **无断路器** — 当 Piped 全部实例不可用时（近期常态），每个视频仍尝试全部 15 个实例，每次浪费 ~15s
4. **统一 120s 超时** — 单个视频的完整回退链最坏可达 510s
5. **无快路径** — 用户必须等待 enrichment 完成才能看到新视频
6. **日志不支持分析** — 纯文本格式，缺少 `duration_ms` 等关键指标字段

### 日志证据

2026-03-26 日志（2900+ 行）显示：

- Piped 全部 15 个实例返回 500/502/521，但每个视频的字幕流程仍逐一尝试
- 每个失败视频的字幕尝试耗时 30-40s（opencli ~11s + piped ~15s + transcript-api ~1.3s + yt-dlp ~6s）
- Feed 爬取和字幕处理在同一事件循环上交替执行，互相影响

## 设计决策


| 决策项             | 选择                 | 理由                   |
| --------------- | ------------------ | -------------------- |
| 总体方案            | 分层流水线（Layer 0/1/2） | 兼顾快路径和健壮性            |
| 断路器粒度           | 方法级（非实例级）          | 简单有效，避免过度设计          |
| 日志格式            | 结构化 JSON（.jsonl）   | 支持 jq/脚本聚合分析         |
| execFileSync 迁移 | 全量一次性迁移            | 彻底消除阻塞风险             |
| 渐进式加载           | 完全接受 skeleton 模式   | 标题秒出，其余异步补齐          |
| 并发控制            | 自适应并发池             | 根据成功率/响应时间/限流信号动态调窗口 |


## 第 1 部分：结构化 JSON Logger

### 日志格式

每行一个 JSON 对象，固定字段 + 可选扩展字段：

```json
{
  "ts": "2026-03-26T21:47:35.432Z",
  "level": "warn",
  "scope": "subtitle",
  "event": "fallback",
  "platform": "youtube",
  "target": "w17fCuU6ZEk",
  "duration_ms": 1234,
  "method": "opencli",
  "fallback_to": "piped",
  "reason": "No captions available",
  "circuit_breaker": "closed",
  "attempt_index": 1,
  "run_id": "crawl-1711489655"
}
```

### 固定字段（每条日志必有）

- `ts` — ISO 时间戳
- `level` — `debug` | `info` | `warn` | `error`
- `scope` — `feed` | `subtitle` | `summary` | `system` | `api`
- `event` — 动作标识符：`attempt`、`success`、`fallback`、`failure`、`circuit_open`、`circuit_close` 等

### 常见扩展字段

- `platform` — `youtube` | `bilibili`
- `target` — video_id 或 channel_id
- `method` — `opencli` | `piped` | `yt-dlp` | `transcript-api` | `bilibili-api` | `rss`
- `duration_ms` — 本次操作耗时
- `attempt_index` — 回退链中的第几次尝试
- `circuit_breaker` — 断路器当前状态 `closed` | `open` | `half-open`
- `run_id` — 关联同一次调度轮次的所有日志
- `error` — 错误消息（压缩为单行）
- `concurrency` — 当前并发窗口大小
- `queue_depth` — 队列深度

### API 变更

```typescript
// 旧（向后兼容，作为 event:"message" 处理）
log.info('subtitle', `attempt platform=${video.platform}`);

// 新（推荐）
log.info('subtitle', 'attempt', {
  platform: video.platform,
  method,
  target: video.video_id,
});
```

三参数签名：`log.info(scope, event, fields?)`。旧的两参数签名保持兼容。

### 写入策略

- **文件写入** — JSON 行格式（`.jsonl`），按天切分（`2026-03-26.jsonl`）
- **内存缓冲 + LogPanel** — 从 JSON 字段自动格式化人类可读文本，前端 LogPanel 不需要改
- **SSE 推送** — 附带完整 JSON 结构
- **向后兼容** — 旧 `.log` 文件不迁移

## 第 2 部分：断路器（Circuit Breaker）

### 状态机

```
CLOSED ──失败次数达阈值──▶ OPEN ──冷却时间到期──▶ HALF_OPEN
  ▲                                                    │
  │              探测成功                               │
  └────────────────────────────────────────────────────┘
                     探测失败 → 回到 OPEN（冷却时间翻倍）
```

### 配置

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number;    // 连续失败多少次触发熔断
  cooldownMs: number;          // 初始冷却时间
  maxCooldownMs: number;       // 最大冷却时间
  cooldownMultiplier: number;  // 每次探测失败后冷却倍率
}
```

### 各方法默认配置


| 方法               | failureThreshold | cooldownMs | maxCooldownMs |
| ---------------- | ---------------- | ---------- | ------------- |
| `opencli`        | 3                | 5 min      | 30 min        |
| `piped`          | 2                | 10 min     | 60 min        |
| `transcript-api` | 3                | 5 min      | 30 min        |
| `yt-dlp`         | 3                | 10 min     | 60 min        |
| `bilibili-api`   | 3                | 5 min      | 30 min        |


Piped 阈值更低（2 次），因为它依赖外部公共实例，全挂概率更高。

### 注册表 API

```typescript
// circuit-breaker.ts — 新文件

function getBreaker(method: string): CircuitBreaker;
function recordSuccess(method: string): void;
function recordFailure(method: string): void;
function isAvailable(method: string): boolean;
function getStatus(method: string): BreakerStatus;
function getAllStatus(): Record<string, BreakerStatus>;
```

### 与回退链集成yes

```typescript
for (const method of fallbackChain) {
  if (!circuitBreaker.isAvailable(method)) {
    log.info('subtitle', 'circuit_skip', { method, state: 'open' });
    continue;
  }
  try {
    const result = await tryMethod(method, video, tieredTimeout[method]);
    circuitBreaker.recordSuccess(method);
    return result;
  } catch (error) {
    circuitBreaker.recordFailure(method);
  }
}
```

### 分层超时


| 回退位置 | 超时  |
| ---- | --- |
| 首选方法 | 15s |
| 第一回退 | 20s |
| 第二回退 | 30s |
| 最终回退 | 45s |


总最坏时间：510s → 110s。

### 持久化

不需要。进程重启后从 CLOSED 开始，最多浪费几次失败探测。

### 日志与可观测性

```json
{"level":"warn","scope":"system","event":"circuit_open","method":"piped","failures":2,"cooldown_ms":600000}
{"level":"info","scope":"system","event":"circuit_probe","method":"piped","result":"failure","next_cooldown_ms":1200000}
{"level":"info","scope":"system","event":"circuit_close","method":"piped","open_duration_ms":1200000}
```

SSE 推送 `circuit-breaker:changed` 事件。

## 第 3 部分：自适应并发池（AsyncPool）

### 核心接口

```typescript
interface AsyncPoolConfig {
  name: string;
  initialConcurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  adjustIntervalMs: number;       // 窗口调整周期，默认 30s
  rateLimit?: {
    requestsPerWindow: number;
    windowMs: number;
  };
}

interface AsyncPool<T> {
  enqueue(job: T, priority?: number): void;
  getStatus(): PoolStatus;
  pause(): void;
  resume(): void;
  drain(): Promise<void>;
}
```

### 自适应算法

每 `adjustIntervalMs` 执行一次窗口调整：

```
if rateLimitHits > 0:
    concurrency = max(min, concurrency - 2)    // 被限流，快速收缩
    冷却 60s

elif failureRate > 50%:
    concurrency = max(min, concurrency - 1)    // 失败率高，缓慢收缩

elif failureRate < 10% AND avgResponseMs < expectedMs:
    concurrency = min(max, concurrency + 1)    // 正常，缓慢扩张

else:
    保持不变
```

### 与 crawler-performance.ts 整合

事件循环延迟进入 `busy`/`strained` 时，所有池的 maxConcurrency 临时下调（乘以 throttleMultiplier 的倒数）。

### 各池默认配置


| 池            | initial | min | max | 限流                  |
| ------------ | ------- | --- | --- | ------------------- |
| `feed-crawl` | 1       | 1   | 3   | 无                   |
| `enrichment` | 3       | 1   | 6   | Bilibili: 10 req/5s |
| `subtitle`   | 2       | 1   | 4   | 按平台独立               |
| `summary`    | 1       | 1   | 2   | AI 提供方 quota        |


### 优先级队列

- **优先级 0** — 用户手动触发
- **优先级 1** — 当前页面可见的视频
- **优先级 2** — 自动流水线常规任务

### 可观测性

```json
{
  "level": "info",
  "scope": "system",
  "event": "pool_adjust",
  "pool": "subtitle",
  "prev_concurrency": 2,
  "new_concurrency": 3,
  "success_rate": 0.92,
  "avg_response_ms": 3200,
  "queue_depth": 7
}
```

SSE 推送 `pool:status-changed`。

## 第 4 部分：三层流水线架构

### 整体数据流

```
┌─ Layer 0: Fast Path ─────────────────────────────────────┐
│  调度器/手动刷新 → 爬取频道列表                           │
│  → 最小数据写入 DB（video_id, title, platform, channel）  │
│  → SSE: video:new-skeleton                               │
│  → 触发 Layer 1 & Layer 2                                │
└──────────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
┌─ Layer 1: Enrichment ───┐  ┌─ Layer 2: Deep Processing ──────┐
│  补齐缩略图/时长/发布时间  │  │  字幕抓取（回退链+断路器）       │
│  → SSE: video:enriched  │  │  → SSE: subtitle:status-changed │
│  并发池: enrichment      │  │  摘要生成                        │
└─────────────────────────┘  │  → SSE: summary:status-changed  │
                             │  并发池: subtitle / summary      │
                             └─────────────────────────────────┘
```

### Layer 0: Fast Path

**改造对象：** `fetcher.ts` 的 feed 函数 + `scheduler.ts` 的 `insertOrUpdateVideos`

```typescript
interface VideoSkeleton {
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string;
  thumbnail_url: string;    // 可能为空
  published_at: string;     // 可能为空
  duration: string;         // 可能为空
  needs_enrichment: boolean;
}
```

流程：

1. 写入 skeleton 到 DB
2. 发 `video:discovered` 事件（触发 Layer 2）
3. 发 `video:new-skeleton` SSE 事件（前端立即显示）
4. `needs_enrichment=true` 的入队 enrichment 池

YouTube 不受影响（Piped/RSS 返回完整数据）。Bilibili `fetchBilibiliFeed` 不再调用 `enrichBilibiliVideos`。

### Layer 1: Enrichment

**新模块：** `enrichment-queue.ts`

```typescript
async function enrichVideo(videoDbId: number): Promise<void> {
  const video = getVideoById(videoDbId);
  if (!video || !needsEnrichment(video)) return;

  const detail = await fetchBilibiliVideoDetail(video.video_id, sessdata);
  if (!detail) return;

  updateVideoFields(videoDbId, {
    thumbnail_url: detail.thumbnail_url,
    published_at: detail.published_at,
    duration: detail.duration,
  });

  appEvents.emit('video:enriched', {
    videoDbId,
    videoId: video.video_id,
    platform: video.platform,
    fields: { thumbnail_url, published_at, duration },
  });
}
```

### Layer 2: Deep Processing

改造 `auto-pipeline.ts`：

- `processSubtitleQueue` 从串行改为并发池调度
- 回退链内每个方法检查 `circuitBreaker.isAvailable(method)`
- 全部方法被熔断时直接标记 error + 设置冷却

`summary-queue.ts`：接入 summary 并发池替代串行处理。

### execFileSync → async 迁移清单


| 文件             | 函数                                     | 变更                                  |
| -------------- | -------------------------------------- | ----------------------------------- |
| `opencli.ts`   | `runOpenCliJson`                       | `execFileSync` → `execFile` Promise |
| `opencli.ts`   | `runOpenCliJsonCompat`                 | → async                             |
| `opencli.ts`   | `fetchOpenCliBilibiliUserVideos`       | → async                             |
| `opencli.ts`   | `fetchOpenCliBilibiliSubtitleRows`     | → async                             |
| `opencli.ts`   | `fetchOpenCliYoutubeTranscriptRows`    | → async                             |
| `subtitles.ts` | `runYtDlpSubtitleAttempts`             | → async + `execFile`                |
| `subtitles.ts` | `fetchYoutubeSubtitleViaTranscriptApi` | → async + `execFile`                |
| `subtitles.ts` | `fetchYoutubeSubtitleViaOpenCli`       | → await async opencli               |
| `subtitles.ts` | `fetchBilibiliSubtitleViaOpenCli`      | → await async opencli               |
| `fetcher.ts`   | `fetchBilibiliFeed`                    | → await async opencli               |


### 事件流总览

```
Layer 0:                          Layer 1:              Layer 2:
video:new-skeleton ──SSE──▶ 前端   video:enriched ──SSE──▶ 前端更新卡片
       │                                                    ▲
       ├── needs_enrichment? ──▶ enrichment 池 ─────────────┘
       │
       └── video:discovered ──▶ auto-pipeline ──▶ subtitle 池 ──▶ subtitle:ready
                                                                       │
                                                                       ▼
                                                              summary 池 ──▶ summary:completed
```

### 前端改动

- `**VideoCard.tsx**` — skeleton 状态：缩略图空时显示渐变占位符，时长空时显示 `--:--`
- **SSE** — 订阅 `video:enriched`，局部更新卡片字段
- **现有** `subtitle:status-changed` 和 `summary:status-changed` 不变

## 新增/修改文件清单

### 新文件


| 文件                            | 职责                      |
| ----------------------------- | ----------------------- |
| `src/lib/circuit-breaker.ts`  | 断路器注册表与状态机              |
| `src/lib/async-pool.ts`       | 自适应并发池                  |
| `src/lib/enrichment-queue.ts` | Layer 1 enrichment 任务队列 |


### 主要修改文件


| 文件                               | 改动范围                                             |
| -------------------------------- | ------------------------------------------------ |
| `src/lib/logger.ts`              | 输出格式改为 JSON，三参数 API                              |
| `src/lib/opencli.ts`             | 所有 `execFileSync` → async `execFile`             |
| `src/lib/subtitles.ts`           | 同步→异步，接入断路器+分层超时                                 |
| `src/lib/fetcher.ts`             | Bilibili 去掉同步 enrichment，返回 skeleton             |
| `src/lib/auto-pipeline.ts`       | 字幕队列→并发池，接入断路器                                   |
| `src/lib/summary-queue.ts`       | 接入 summary 并发池                                   |
| `src/lib/scheduler.ts`           | `insertOrUpdateVideos` 支持 skeleton+enrichment 入队 |
| `src/lib/crawler-performance.ts` | 暴露 throttle 状态给并发池                               |
| `src/components/VideoCard.tsx`   | skeleton 占位符 + `video:enriched` SSE 监听           |


## 预期收益


| 指标                     | 当前                   | 改后               |
| ---------------------- | -------------------- | ---------------- |
| 新视频出现在前端的延迟            | 5-10s（等 enrichment）  | <1s（skeleton 秒出） |
| 单视频字幕回退最坏耗时            | 510s                 | 110s             |
| Piped 全挂时每视频浪费         | ~15s（遍历 15 实例）       | 0s（断路器跳过）        |
| Bilibili enrichment 并发 | 20（无限制）              | 3-6（自适应）         |
| 事件循环阻塞风险               | 高（execFileSync 120s） | 无（全异步）           |
| 日志分析能力                 | 手动 grep              | jq/脚本结构化查询       |


## 第 5 部分：补充设计（Reviewer 反馈）

以下是 spec review 过程中识别出的遗漏和需要澄清的设计点。

### 5.1 Enrichment 启动补偿（已移除）

该补偿方案未保留。当前实现明确选择 manual-only repair：进程重启后不做 enrichment 回扫，也不从数据库重建队列。

### 5.2 断路器与现有冷却机制的优先级（Critical）

问题：`subtitles.ts` 已有 per-video 冷却（`subtitle_cooldown_until`）和全局 scope 冷却（`getActiveSubtitleCooldownUntil`）。新增的断路器是第三层保护。三者关系需要明确。

优先级链（从外到内）：

```
1. 断路器（方法级）— 最先检查，OPEN 时直接跳过该方法
2. 全局 scope 冷却 — 限流触发后的全局暂停
3. Per-video 冷却 — 单视频级别的重试间隔
```

具体规则：

- 断路器在回退链循环的最外层检查，优先级最高
- 如果所有方法都被断路器跳过（全部 OPEN），设置 per-video 冷却时间 = 最短断路器剩余冷却时间，避免在断路器恢复前重复入队
- 全局 scope 冷却保留现有逻辑不变，用于 rate limit 场景
- Per-video 冷却保留现有逻辑不变，用于单视频的重试间隔

### 5.3 Logger 的 readRecentLogs 兼容（Major）

问题：现有 `readRecentLogs` 过滤 `.log` 文件，改为 `.jsonl` 后会找不到新日志。

解决方案：`readRecentLogs` 同时读取 `.log` 和 `.jsonl` 文件。解析时：

- `.log` 文件用现有 regex 解析（向后兼容旧日志）
- `.jsonl` 文件按行 `JSON.parse`，然后格式化为人类可读文本

`parseLogLine` 增加分支：先尝试 JSON.parse，失败则走旧 regex。这保证 LogPanel 和 `/api/logs/` 在迁移期间两种格式都能正常显示。

### 5.4 video:new-skeleton 替代 video:new-full（Major）

问题：现有 `scheduler.ts` 发 `video:new-full` 事件推送完整视频数据到前端。新增的 `video:new-skeleton` 需要与之协调。

解决方案：**替换**，不共存。

- `video:new-full` 改为 `video:new-skeleton`，推送 skeleton 数据（标题必有，缩略图/时长可能为空）
- 前端 SSE 监听从 `video:new-full` 改为 `video:new-skeleton`
- 新增 `video:enriched` 事件补齐缺失字段
- 如果视频数据本身就是完整的（YouTube），skeleton 事件的数据和 full 事件一样，前端无感知差异

### 5.5 优先级简化为两级（Major）

问题：优先级 1（"当前页面可见的视频"）缺少客户端→服务端的通信机制。

解决方案：**简化为两级优先级**，去掉 Priority 1。

- **优先级 0** — 用户手动触发（点击按钮）
- **优先级 1** — 自动流水线常规任务

理由：当前 SSE 是单向的（服务端→客户端），引入 viewport 感知需要新的 API 调用和前端 IntersectionObserver，复杂度不值得。手动触发已经覆盖了"用户关心这个视频"的核心场景。后续如有需要可以再加。

### 5.6 Piped 实例轮转优化（Major）

问题：方法级断路器只在 `pipedRequest` 全部失败后才记录一次 failure，前 2 次失败仍然浪费 ~15s（遍历所有实例）。

解决方案：在 `piped.ts` 的 `pipedRequest` 内部增加轻量级实例健康追踪：

```typescript
const instanceBlocklist = new Map<string, number>(); // instance → blockUntil timestamp

function isInstanceBlocked(instance: string): boolean {
  const until = instanceBlocklist.get(instance);
  if (!until) return false;
  if (Date.now() > until) { instanceBlocklist.delete(instance); return false; }
  return true;
}
```

在 `pipedRequest` 的 catch 块里：失败的实例加入 blocklist 屏蔽 5 分钟。同时限制每次 `pipedRequest` 最多尝试 3 个实例（而非全部 15 个），超过则快速失败。这样即使在断路器尚未触发时，单次 Piped 调用的最坏耗时也从 15 × 8s = 120s 降至 3 × 8s = 24s。

### 5.7 cooldownMultiplier 默认值补全（Major）

各方法完整默认配置：


| 方法               | failureThreshold | cooldownMs | maxCooldownMs | cooldownMultiplier |
| ---------------- | ---------------- | ---------- | ------------- | ------------------ |
| `opencli`        | 3                | 5 min      | 30 min        | 2                  |
| `piped`          | 2                | 10 min     | 60 min        | 2                  |
| `transcript-api` | 3                | 5 min      | 30 min        | 2                  |
| `yt-dlp`         | 3                | 10 min     | 60 min        | 2                  |
| `bilibili-api`   | 3                | 5 min      | 30 min        | 2                  |


### 5.8 feed-crawl 池与 executeCrawlTick 的关系（Minor）

澄清：`feed-crawl` 池**包裹现有的逐频道串行逻辑**，`concurrency=1` 时行为等同现状，主要作为统一的调度/暂停/监控入口。每个频道是池内的一个 job，保留 `throttleCrawlerStage` 延迟。未来可以把 `max` 调到 2-3 实现频道级并发，但初始阶段保持 1。

### 5.9 单例模式（Minor）

所有新增的全局状态（并发池实例、断路器注册表）使用 `globalThis[Symbol.for(...)]` 单例模式，与 `auto-pipeline.ts`、`scheduler.ts`、`events.ts` 保持一致，防止 Next.js HMR 导致重复实例化。

### 5.10 手动刷新路径（Minor）

手动刷新（`/api/videos/refresh/`）**也走 skeleton + enrichment 队列路径**，与调度器保持一致。理由：

- 手动刷新的用户已经在看列表，skeleton 秒出体验更好
- enrichment 通过 SSE 实时补齐，延迟感知极低（Bilibili API 响应通常 <500ms）
- 统一路径减少代码分支

### 5.11 debug 日志级别（Minor）

`debug` 是新增的日志级别。默认不写入文件、不推送 SSE。通过环境变量 `LOG_LEVEL=debug` 启用，用于开发调试。`LogLevel` 类型从 `'info' | 'warn' | 'error'` 扩展为 `'debug' | 'info' | 'warn' | 'error'`。

### 5.12 测试策略


| 模块                    | 测试类型 | 覆盖点                                                |
| --------------------- | ---- | -------------------------------------------------- |
| `circuit-breaker.ts`  | 单元测试 | 状态机转换（CLOSED→OPEN→HALF_OPEN→CLOSED/OPEN）、指数退避、阈值边界 |
| `async-pool.ts`       | 单元测试 | 并发上限、优先级排序、自适应窗口调整、pause/resume/drain              |
| `logger.ts`           | 单元测试 | JSON 输出格式、向后兼容两参数签名、readRecentLogs 双格式解析           |
| `enrichment-queue.ts` | 集成测试 | enrichment→SSE 事件链、手动队列初始化                        |
| `subtitles.ts`        | 集成测试 | 断路器跳过 + 分层超时的端到端回退链                                |
| `piped.ts`            | 单元测试 | 实例屏蔽、最多 3 实例快速失败                                   |


### 5.13 频道上下文（Channel Context）

**问题：** 当前日志和事件中 `target` 仅记录 `video_id`，无法在日志中直接看出这条字幕任务属于哪个频道。调试时需要额外查 DB 才能知道"哪个频道的哪个视频出问题了"。

**解决方案：** 在流水线各层的日志字段和事件载荷中补充频道上下文。

#### 日志扩展字段补充

在 `subtitle`、`enrichment` 等 scope 的日志中新增以下字段：

```json
{
  "ts": "2026-03-26T21:47:35.432Z",
  "level": "warn",
  "scope": "subtitle",
  "event": "fallback",
  "platform": "youtube",
  "channel_id": "UCxxxxxx",
  "channel_name": "某频道名称",
  "target": "w17fCuU6ZEk",
  "method": "opencli",
  "fallback_to": "piped",
  "duration_ms": 1234
}
```

新增字段：

- `channel_id` — 视频所属频道的平台 channel_id（对应 `channels.channel_id`）
- `channel_name` — 频道名称（用于人类可读，调试友好）

#### 事件载荷补充

涉及视频处理的内部事件统一携带频道上下文：

```typescript
// video:discovered
appEvents.emit('video:discovered', {
  videoDbId: number,
  videoId: string,
  platform: string,
  channelId: string,      // 新增
  channelName: string,    // 新增
});

// subtitle:ready
appEvents.emit('subtitle:ready', {
  videoDbId: number,
  videoId: string,
  platform: string,
  channelId: string,      // 新增
  channelName: string,    // 新增
  subtitlePath: string,
});
```

#### 数据获取策略

频道信息已存在于 `videos` 表的 `channel_id` 外键（指向 `channels.id`），`channels` 表包含 `channel_id`（平台 ID）和 `name`。

- **Layer 0（Fast Path）：** `scheduler.ts` 在 `insertOrUpdateVideos` 时已知当前爬取的频道，直接透传给 skeleton 事件
- **Layer 1（Enrichment）：** `enrichVideo` 收到 `videoDbId` 后，通过 JOIN 查询一次获取频道信息
- **Layer 2（字幕处理）：** `auto-pipeline.ts` 的 `processSubtitleQueue` 在取出任务时 JOIN `channels` 表补充上下文

```sql
-- 字幕/enrichment 队列出队时的查询模板
SELECT v.id, v.video_id, v.platform, c.channel_id, c.name AS channel_name
FROM videos v
JOIN channels c ON v.channel_id = c.id
WHERE v.id = ?
```

#### CrawlerCompactBar 展示

前端爬虫状态栏（`CrawlerCompactBar.tsx`）展示进度时，SSE 事件中携带 `channel_name`，可直接显示"正在抓取《频道名》的字幕"，无需前端再做关联查询。
