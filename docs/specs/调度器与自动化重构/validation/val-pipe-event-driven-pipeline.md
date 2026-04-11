# Validation Assertions: Event-Driven Pipeline (spec 02)

Prefix: `VAL-PIPE`

---

## A. Core Event Flow — video:discovered → auto subtitle

### VAL-PIPE-001: Auto subtitle triggered for auto_subtitle=1 intent
When a new video is discovered (`video:discovered` event) and its channel's intent has `auto_subtitle=1`, the video is enqueued into the in-memory subtitle queue for automatic subtitle fetching.
**Evidence:** After `onVideoDiscovered` fires, `state.subtitleQueue` contains a `SubtitleJob` for that video. `state.stats.subtitleQueued` increments by 1.

### VAL-PIPE-002: No subtitle fetch for auto_subtitle=0 intent
When a new video is discovered and its channel's intent has `auto_subtitle=0`, no subtitle job is enqueued. The pipeline terminates at this stage.
**Evidence:** `state.subtitleQueue` does not contain the video. `ensureSubtitleForVideo` is never called for that video.

### VAL-PIPE-003: No subtitle fetch for nonexistent intent
When a new video is discovered but its channel's intent name does not exist in the `intents` table, the pipeline terminates (safe default: no auto processing).
**Evidence:** `state.subtitleQueue` does not contain the video.

### VAL-PIPE-004: Already-fetched subtitle skipped
When a `video:discovered` event fires for a video that already has `subtitle_status='fetched'` or a non-null `subtitle_path`, the video is NOT enqueued.
**Evidence:** `enqueueSubtitleJob` is not called. Queue length does not change.

### VAL-PIPE-005: No-op for unknown channel
When `video:discovered` fires with a `channelId` that doesn't exist in the `channels` table, no job is enqueued and no error is thrown.
**Evidence:** `getChannelByChannelId` returns null; function returns early.

### VAL-PIPE-006: No-op for unknown video record
When `video:discovered` fires but `getVideoByVideoId` returns null (video not yet in DB), no job is enqueued.
**Evidence:** Function returns early without error.

---

## B. Core Event Flow — subtitle:ready → auto summary

### VAL-PIPE-007: Auto summary created for auto_summary=1 intent
When a subtitle completes (`subtitle:ready` event) and the video's channel intent has `auto_summary=1`, a `summary_tasks` record is created with `status='pending'` and the summary queue is started if not already running.
**Evidence:** `summary_tasks` table has a new row for (video_id, platform) with status='pending'. `isQueueRunning()` returns true.

### VAL-PIPE-008: No summary for auto_summary=0 intent
When `subtitle:ready` fires and the intent has `auto_summary=0`, no summary task is created. The pipeline terminates.
**Evidence:** No row inserted into `summary_tasks` for that video. `state.stats.summaryQueued` unchanged.

### VAL-PIPE-009: Duplicate summary task prevention
When `subtitle:ready` fires for a video that already has a summary task with status != 'failed', no new task is created.
**Evidence:** `getSummaryTask` returns existing task; `createSummaryTask` is NOT called again.

### VAL-PIPE-010: Failed summary task allows re-creation
When `subtitle:ready` fires for a video that has an existing summary task with `status='failed'`, a new summary task IS created (or the existing one is reset to pending).
**Evidence:** After event, the summary_tasks row for that video has `status='pending'`.

### VAL-PIPE-011: Summary queue auto-start on pending tasks
When a summary task is created by `onSubtitleReady` and the summary queue is not running, `startQueueProcessing()` is called.
**Evidence:** `isQueueRunning()` returns true after the function completes.

---

## C. Subtitle Queue Mechanics

### VAL-PIPE-012: FIFO processing order
Subtitle jobs are processed in the order they were enqueued (first-in, first-out).
**Evidence:** If jobs A, B, C are enqueued in order, `ensureSubtitleForVideo` is called for A first, then B, then C.

### VAL-PIPE-013: Serial processing (no concurrency)
Only one subtitle job is processed at a time. If `processSubtitleQueue` is called while already processing, the second call returns immediately.
**Evidence:** `state.subtitleProcessing` prevents re-entry. Only one `ensureSubtitleForVideo` call is active at any time.

### VAL-PIPE-014: Rate limiting — 1 second between requests
After each subtitle fetch, the queue waits at least 1 second (`sleep(1000)`) before processing the next job.
**Evidence:** Time between consecutive `ensureSubtitleForVideo` calls is ≥ 1000ms.

### VAL-PIPE-015: Queue cap at 100
When the subtitle queue already contains 100 jobs, new `enqueueSubtitleJob` calls return `false` and the job is not added. A warning is logged.
**Evidence:** `state.subtitleQueue.length` never exceeds `MAX_SUBTITLE_QUEUE` (100). `enqueueSubtitleJob` returns `false`. Log contains "subtitle queue full".

### VAL-PIPE-016: Queue deduplication by videoId
If a job with the same `videoId` is already in the queue, `enqueueSubtitleJob` returns `false` and does not add a duplicate.
**Evidence:** `state.subtitleQueue` has at most one entry per videoId.

### VAL-PIPE-017: Cooldown-checked jobs are skipped and removed
When the queue processes a job whose video has `subtitle_cooldown_until` in the future, the job is removed from the queue (shifted) without calling `ensureSubtitleForVideo`.
**Evidence:** `ensureSubtitleForVideo` is not called; job is removed from `state.subtitleQueue`.

### VAL-PIPE-018: subtitle:ready emitted on successful fetch
When `ensureSubtitleForVideo` returns a result with `subtitle_path` set and `subtitle_status='fetched'`, the `subtitle:ready` event is emitted with the correct `videoId` and `platform`.
**Evidence:** `appEvents.emit('subtitle:ready', ...)` is called with matching payload.

### VAL-PIPE-019: Failed subtitle fetch updates stats
When `ensureSubtitleForVideo` throws an error, `state.stats.subtitleFailed` increments and an error log is written. The job is still removed from the queue and processing continues.
**Evidence:** `subtitleFailed` stat incremented. Next job in queue is processed. Error logged with prefix 'auto-pipeline'.

### VAL-PIPE-020: subtitle:ready NOT emitted on failed/empty fetch
When `ensureSubtitleForVideo` returns without a `subtitle_path` or with `subtitle_status != 'fetched'` (e.g., 'missing', 'empty'), `subtitle:ready` is NOT emitted.
**Evidence:** No `subtitle:ready` event for that video.

---

## D. Initialization

### VAL-PIPE-021: Initialization only registers listeners
On `ensureAutoPipeline()` init, the pipeline only registers the `video:discovered` and `subtitle:ready` listeners.
**Evidence:** Initialization does not query the database, enqueue subtitle jobs, or start the summary queue.

### VAL-PIPE-022: Initialization runs only once
`ensureAutoPipeline` is guarded by `state.initialized`. Calling it multiple times does not re-register event listeners.
**Evidence:** Second call to `ensureAutoPipeline()` returns immediately. Event listeners are not duplicated.

---

## E. Scheduler Simplification

### VAL-PIPE-026: Only crawl timer remains
After refactoring, the scheduler has only one timer slot: `crawl`. There are no `subtitle` or `summary` timer slots.
**Evidence:** `SchedulerRuntimeState.tasks` only has a `crawl` key. `scheduleTask` is only called with `'crawl'`. No `setInterval`/`setTimeout` for subtitle or summary ticks.

### VAL-PIPE-027: runSubtitleTick removed
The `runSubtitleTick` function no longer exists in `scheduler.ts`.
**Evidence:** Grep for `runSubtitleTick` in `src/lib/scheduler.ts` returns no results.

### VAL-PIPE-028: runSummaryTick removed
The `runSummaryTick` function no longer exists in `scheduler.ts`.
**Evidence:** Grep for `runSummaryTick` in `src/lib/scheduler.ts` returns no results.

### VAL-PIPE-029: SchedulerTaskName type is 'crawl' only
The `SchedulerTaskName` type is simplified to just `'crawl'` (no longer includes `'subtitle'` or `'summary'`).
**Evidence:** `src/types/index.ts` defines `SchedulerTaskName = 'crawl'`.

### VAL-PIPE-030: SchedulerConfig has no subtitle/summary intervals
`SchedulerConfig` interface only has `enabled` and `crawlInterval`. `subtitleInterval` and `summaryInterval` are removed.
**Evidence:** `SchedulerConfig` type definition has exactly two fields: `enabled: boolean` and `crawlInterval: number`.

### VAL-PIPE-031: SchedulerStatus has no subtitle/summary fields
`SchedulerStatus` no longer contains `lastSubtitle`, `lastSummary`, `nextSubtitle`, or `nextSummary`.
**Evidence:** `SchedulerStatus` type only has `lastCrawl`, `nextCrawl`, and no subtitle/summary timing fields.

### VAL-PIPE-032: Scheduler API rejects subtitleInterval/summaryInterval
The `/api/scheduler` POST endpoint no longer accepts `subtitleInterval` or `summaryInterval` parameters. If provided, they are ignored.
**Evidence:** `parseInterval` is only called for `crawlInterval`. Response `config` object does not contain subtitle/summary intervals.

### VAL-PIPE-033: getSchedulerConfig returns simplified config
`getSchedulerConfig()` returns `{ enabled, crawlInterval }` only.
**Evidence:** Return value has no `subtitleInterval` or `summaryInterval` keys.

### VAL-PIPE-034: Crawl timer still works correctly
The crawl timer continues to run at configured intervals, iterating channels, fetching feeds, and calling `insertOrUpdateVideos` which emits `video:discovered`.
**Evidence:** After `startScheduler()`, crawl tick fires at `crawlInterval` seconds, channels are fetched, and new videos trigger `video:discovered` events.

---

## F. Obsolete Settings Cleanup

### VAL-PIPE-035: Deprecated settings deleted on init
On `ensureSchedulerAndPipeline()`, the following `app_settings` keys are deleted:
- `scheduler_subtitle_interval`
- `scheduler_summary_interval`
- `scheduler_last_subtitle`
- `scheduler_last_summary`
**Evidence:** After initialization, `getAppSetting('scheduler_subtitle_interval')` returns null for all four keys.

### VAL-PIPE-036: Settings cleanup is idempotent
Running the cleanup when keys don't exist causes no error.
**Evidence:** Calling `deleteAppSetting` on non-existent keys does not throw.

---

## G. Manual Refresh Integration

### VAL-PIPE-037: Manual refresh triggers pipeline
When `/api/videos/refresh/` discovers new videos, `video:discovered` events are emitted, which trigger the auto-pipeline (auto subtitle → auto summary) identically to scheduler-driven crawl.
**Evidence:** Manual refresh → `insertOrUpdateVideos` → `video:discovered` → `onVideoDiscovered` → subtitle queue (if auto_subtitle=1).

### VAL-PIPE-038: Manual refresh subtitle behavior changes
After refactoring, the manual refresh endpoint (`/api/videos/refresh/`) no longer needs its own subtitle fetching loop — the pipeline handles it via events. Or, if it retains its own subtitle logic, the auto-pipeline deduplicates via `enqueueSubtitleJob`.
**Evidence:** Either the refresh route's subtitle loop is removed (relying on pipeline), or duplicate jobs are prevented by videoId dedup in the queue.

---

## H. Entry Point & Initialization

### VAL-PIPE-039: ensureScheduler renamed to ensureSchedulerAndPipeline
The main entry function is `ensureSchedulerAndPipeline()` which calls `ensureAutoPipeline()` (replacing `ensureAutomationPipeline()`).
**Evidence:** `ensureSchedulerAndPipeline` function exists in `scheduler.ts`. It calls `ensureAutoPipeline()` from `auto-pipeline.ts`.

### VAL-PIPE-040: SSE route uses new entry point
The SSE route (`/api/sse/route.ts`) calls `ensureSchedulerAndPipeline()` instead of `ensureScheduler()`.
**Evidence:** Import and call updated in SSE route.

### VAL-PIPE-041: Scheduler API uses new entry point
The scheduler API route (`/api/scheduler/route.ts`) calls `ensureSchedulerAndPipeline()`.
**Evidence:** Import and call updated in scheduler route.

### VAL-PIPE-042: Auto-pipeline event listeners registered once
`ensureAutoPipeline` registers listeners for `video:discovered` and `subtitle:ready` exactly once (guarded by `state.initialized`).
**Evidence:** `appEvents.listenerCount('video:discovered')` for the auto-pipeline handler is exactly 1 after multiple calls.

---

## I. Pipeline Status Reporting

### VAL-PIPE-043: getAutoPipelineStatus returns subtitle queue state
`getAutoPipelineStatus()` returns an object with `subtitle.queueLength`, `subtitle.processing`, `subtitle.currentVideoId`, and `subtitle.stats`.
**Evidence:** Call returns `{ subtitle: { queueLength: N, processing: bool, currentVideoId: string|null, stats: { completed: N, failed: N } }, ... }`.

### VAL-PIPE-044: getAutoPipelineStatus returns summary queue state
`getAutoPipelineStatus()` returns `summary.queueLength` (from `summary_tasks` pending count), `summary.processing` (from `isQueueRunning()`), and `summary.currentVideoId` (from `getQueueState()`).
**Evidence:** Summary portion of the status reflects actual DB and queue state.

### VAL-PIPE-045: Pipeline status reflects real-time queue changes
As subtitle jobs are enqueued and completed, `getAutoPipelineStatus().subtitle.queueLength` reflects the current queue size.
**Evidence:** Immediately after enqueuing, `queueLength` increases. After processing, it decreases.

---

## J. CrawlerRuntimeStatus Changes

### VAL-PIPE-046: CrawlerRuntimeStatus.subtitle field removed
The `CrawlerRuntimeStatus` type no longer has a `subtitle` field. Subtitle processing status is provided by `AutoPipelineStatus` instead.
**Evidence:** `CrawlerRuntimeStatus` in `src/types/index.ts` only has `feed`, `paused`, `pauseUpdatedAt`, and `scheduler` fields.

### VAL-PIPE-047: SSE no longer pushes subtitle scope status in crawler-status
The `crawler-status` SSE event payload no longer includes a `subtitle` scope from `getCrawlerRuntimeStatus()`.
**Evidence:** SSE `crawler-status` payload has `feed` and `scheduler` but no `subtitle` key.

### VAL-PIPE-048: New pipeline-status SSE event
A new SSE event type (`pipeline-status` or equivalent) delivers `AutoPipelineStatus` to the frontend, covering subtitle and summary queue state.
**Evidence:** SSE route emits a `pipeline-status` event using data from `getAutoPipelineStatus()`.

---

## K. video:discovered Event Enhancement

### VAL-PIPE-049: video:discovered carries full video metadata
The `video:discovered` event payload includes: `videoId`, `platform`, `channelId`, `title`, `thumbnailUrl`, `publishedAt`, `duration`, `channelName`, `avatarUrl`, `at`.
**Evidence:** `insertOrUpdateVideos` emits the event with all listed fields populated from the video and channel records.

### VAL-PIPE-050: video:discovered still emitted only for truly new videos
The event is emitted only when `INSERT OR IGNORE` results in `result.changes > 0` (i.e., the video was actually new, not a duplicate).
**Evidence:** Existing videos that already exist in DB do not trigger `video:discovered`.

---

## L. Old Pipeline/Rules Removal

### VAL-PIPE-051: pipeline.ts rule-engine calls removed
The old `processAutomationStage` function (rule engine integration) is no longer invoked by the auto-pipeline. Intent `auto_subtitle`/`auto_summary` are the sole automation switches.
**Evidence:** `auto-pipeline.ts` does not import from `pipeline.ts` or `rules.ts`. No `getMatchingRulesForStage` or `getSummaryControlDecision` calls in the new pipeline.

### VAL-PIPE-052: ensureAutomationPipeline no longer called
The old `ensureAutomationPipeline()` from `pipeline.ts` is not called anywhere in the new init path. It's replaced by `ensureAutoPipeline()`.
**Evidence:** Grep for `ensureAutomationPipeline` finds no active call sites (only the definition pending removal in spec 05).

---

## M. summary-queue.ts Adaptation

### VAL-PIPE-053: Summary queue passes triggerSource 'auto'
When `runQueueLoop` calls `generateSummaryViaApi`, it passes `triggerSource: 'auto'` for auto-pipeline-originated tasks.
**Evidence:** `generateSummaryViaApi` is called with `{ triggerSource: 'auto' }` option.

### VAL-PIPE-054: Summary queue resolves intent for model selection
A `getChannelForVideo` helper (or equivalent) joins `videos` → `channels` to get the intent name, which is passed to `generateSummaryViaApi` for intent-level model resolution.
**Evidence:** `generateSummaryViaApi` receives `intentName` derived from the channel's intent field.

---

## N. Behavioral Change: Intent-Scoped Automation Only

### VAL-PIPE-055: auto_subtitle=0 videos never auto-fetched
Videos belonging to channels with `auto_subtitle=0` intent are never automatically fetched by the pipeline, even if they have `subtitle_status='none'`. This is a deliberate change from the old scheduler which fetched ALL unfetched videos.
**Evidence:** Only videos whose channel → intent has `auto_subtitle=1` appear in the subtitle queue when `video:discovered` is emitted.

### VAL-PIPE-056: Existing videos not retro-processed on intent change
If a user changes an intent from `auto_subtitle=0` to `auto_subtitle=1`, existing videos under that intent are NOT immediately processed (no retro-trigger). They are only processed if they are re-discovered and emit a fresh `video:discovered` event.
**Evidence:** Changing intent settings does not emit events or trigger queue processing for existing videos. `onVideoDiscovered` is the only automatic subtitle enqueue path.

---

## O. Edge Cases & Error Handling

### VAL-PIPE-057: Queue survives individual job failures
If `ensureSubtitleForVideo` throws for one job, the queue continues processing remaining jobs.
**Evidence:** Error is caught, logged, stats updated, queue processing continues with next job.

### VAL-PIPE-058: Queue processing flag correctly reset on completion
When all jobs are processed (or queue empties), `state.subtitleProcessing` is set to `false` in the `finally` block.
**Evidence:** After queue drains, `state.subtitleProcessing === false`, allowing future `processSubtitleQueue` calls to proceed.

### VAL-PIPE-059: Concurrent processSubtitleQueue calls are no-ops
If `processSubtitleQueue` is called while already running, it returns immediately without processing.
**Evidence:** `if (state.subtitleProcessing) return;` guard prevents concurrent execution.

### VAL-PIPE-060: Empty channel intent treated as '未分类'
If a channel has `intent = NULL` or `intent = ''`, it is treated as '未分类' for automation decisions.
**Evidence:** `getIntentByName` or equivalent handles null/empty by defaulting to '未分类' intent lookup.

### VAL-PIPE-061: Pipeline initialization is HMR-safe
The auto-pipeline state is stored via `globalThis[Symbol.for(...)]` to prevent duplicate instances during Next.js hot module replacement.
**Evidence:** `auto-pipeline.ts` uses a global symbol key for state storage, consistent with `scheduler.ts` and `events.ts` patterns.

### VAL-PIPE-062: Queue overflow jobs are dropped unless re-discovered
Jobs dropped due to queue cap (VAL-PIPE-015) are not recovered automatically on process restart. They only re-enter the pipeline if another runtime path emits a fresh enqueue event for that video.
**Evidence:** There is no startup compensation path; overflow handling logs and skips the job immediately.

---

## P. End-to-End Integration

### VAL-PIPE-063: Full pipeline chain — crawl → subtitle → summary
When scheduler crawl discovers a new video in an intent with `auto_subtitle=1` AND `auto_summary=1`:
1. `video:discovered` → subtitle enqueued
2. Subtitle fetched → `subtitle:ready` emitted
3. `subtitle:ready` → summary task created → summary queue started
4. Summary completed → `summary:complete` emitted
**Evidence:** Starting from a crawl tick, trace through events/DB to confirm all four stages execute.

### VAL-PIPE-064: Full pipeline chain halts at subtitle stage
When intent has `auto_subtitle=1` but `auto_summary=0`:
1. `video:discovered` → subtitle enqueued
2. Subtitle fetched → `subtitle:ready` emitted
3. `onSubtitleReady` checks intent → `auto_summary=0` → no summary task
**Evidence:** `summary_tasks` table has no row for that video after subtitle completes.

### VAL-PIPE-065: Full pipeline chain halts immediately
When intent has `auto_subtitle=0`:
1. `video:discovered` → `onVideoDiscovered` checks intent → returns early
2. No subtitle fetch, no summary task
**Evidence:** Neither subtitle queue nor summary_tasks contain entries for that video.

### VAL-PIPE-066: Multiple videos from single crawl all enter pipeline
When a crawl tick discovers N new videos from a single channel, all N emit `video:discovered` and all N (if eligible) are enqueued for subtitle processing.
**Evidence:** `state.subtitleQueue.length` increases by N. All N videos eventually get processed.
