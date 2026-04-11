# Validation Contract: Layered Async Pipeline

## Area: Structured Logger

### VAL-LOG-001: JSONL output format
New log entries are written as single-line JSON objects to `.jsonl` files (e.g. `2026-03-26.jsonl`). Each line is valid JSON with required fields: `ts` (ISO 8601 timestamp), `level`, `scope`, `event`.
Evidence: unit test — write a log entry, read the file, `JSON.parse` each line, assert required fields present and correctly typed.

### VAL-LOG-002: Three-argument API
`log.info(scope, event, fields?)` produces a JSON entry where `scope` and `event` match the first two arguments, and all keys from `fields` are merged at the top level of the JSON object.
Evidence: unit test — call `log.info('subtitle', 'attempt', { platform: 'youtube', method: 'opencli', target: 'abc123' })`, parse the JSONL line, assert `scope === 'subtitle'`, `event === 'attempt'`, `platform === 'youtube'`, `method === 'opencli'`, `target === 'abc123'`.

### VAL-LOG-003: Two-argument backward compatibility
`log.info('subtitle', 'some free text message')` (old signature) still works. It produces a JSON entry with `event: "message"` and the second argument stored in a `message` or equivalent field. No runtime error.
Evidence: unit test — call old-style API, parse JSONL line, assert no crash, assert `event` is `"message"` and original text is preserved.

### VAL-LOG-004: Daily file rotation
Log files are named by date (e.g. `2026-03-26.jsonl`). A log written at 23:59 and another at 00:01 the next day go into different files.
Evidence: unit test with mocked clock — write logs across a date boundary, verify two separate `.jsonl` files are created with correct names.

### VAL-LOG-005: readRecentLogs reads both .log and .jsonl
`readRecentLogs()` returns entries from both legacy `.log` files and new `.jsonl` files, merged in reverse chronological order. Legacy entries parsed via existing regex; JSONL entries parsed via `JSON.parse` then formatted to the same human-readable structure.
Evidence: unit test — create a `.log` file with old-format entries and a `.jsonl` file with new-format entries, call `readRecentLogs()`, assert entries from both files are present and correctly parsed.

### VAL-LOG-006: readRecentLogs filters apply to both formats
`readRecentLogs({ level: 'warn', scope: 'subtitle' })` correctly filters entries from both `.log` and `.jsonl` files.
Evidence: unit test — populate both file types with mixed levels/scopes, assert only matching entries are returned.

### VAL-LOG-007: parseLogLine handles both formats
`parseLogLine` first attempts `JSON.parse`; on failure falls back to the existing regex parser. Both paths return a compatible `LogEntry` structure.
Evidence: unit test — pass a JSON string and a legacy log string, assert both return valid `LogEntry` objects with correct fields.

### VAL-LOG-008: Memory buffer and LogPanel compatibility
The in-memory log buffer used by LogPanel and SSE push receives entries formatted as human-readable text (same shape as before), even though file output is JSON. LogPanel does not need changes to display new-format logs.
Evidence: unit test — write a structured log, inspect the in-memory buffer, assert the entry is a human-readable string (not raw JSON).

### VAL-LOG-009: SSE push includes full JSON structure
SSE log events carry the complete JSON structure (all fields including `duration_ms`, `circuit_breaker`, etc.) so that advanced consumers can use structured data.
Evidence: integration test or manual curl to `/api/sse` — trigger a log event, verify SSE payload contains the JSON fields.

### VAL-LOG-010: debug level default behavior
`log.debug(...)` does NOT write to file and does NOT push via SSE when `LOG_LEVEL` is unset or set to `'info'`.
Evidence: unit test — call `log.debug(...)` without `LOG_LEVEL=debug`, assert no file write and no SSE emission.

### VAL-LOG-011: debug level when enabled
When `LOG_LEVEL=debug`, `log.debug(...)` writes to file and pushes via SSE like any other level.
Evidence: unit test — set env, call `log.debug(...)`, assert JSONL line is written.

### VAL-LOG-012: LogLevel type extended
`LogLevel` type is `'debug' | 'info' | 'warn' | 'error'`. TypeScript compilation succeeds with all four values.
Evidence: typecheck (`npm run typecheck`).

### VAL-LOG-013: Old .log files are not migrated
Existing `.log` files remain untouched on disk. No migration script runs. They are only read by `readRecentLogs`.
Evidence: manual inspection — after deploying new logger, old `.log` files still exist and are unchanged.

## Area: Circuit Breaker

### VAL-CB-001: CLOSED → OPEN transition
After `failureThreshold` consecutive failures on a method, `isAvailable(method)` returns `false` and a `circuit_open` log event is emitted.
Evidence: unit test — call `recordFailure` N times (where N = threshold), assert `isAvailable` flips to `false`, assert log output contains `circuit_open`.

### VAL-CB-002: OPEN → HALF_OPEN transition
After `cooldownMs` elapses in OPEN state, the next `isAvailable` check returns `true` (probe allowed). State is HALF_OPEN.
Evidence: unit test with mocked clock — advance time past cooldown, assert `isAvailable` returns `true`, assert `getStatus` shows `half-open`.

### VAL-CB-003: HALF_OPEN → CLOSED on probe success
In HALF_OPEN state, `recordSuccess` transitions to CLOSED. A `circuit_close` log event is emitted with `open_duration_ms`.
Evidence: unit test — trigger HALF_OPEN, call `recordSuccess`, assert state is `closed`, assert log output.

### VAL-CB-004: HALF_OPEN → OPEN on probe failure with cooldown doubling
In HALF_OPEN state, `recordFailure` transitions back to OPEN with cooldown doubled (multiplied by `cooldownMultiplier`).
Evidence: unit test — trigger HALF_OPEN, call `recordFailure`, assert state is `open`, assert new cooldown is `cooldownMs * cooldownMultiplier`.

### VAL-CB-005: Cooldown capped at maxCooldownMs
Repeated probe failures increase cooldown exponentially, but it never exceeds `maxCooldownMs`.
Evidence: unit test — trigger many HALF_OPEN→OPEN cycles, assert cooldown stops growing at `maxCooldownMs`.

### VAL-CB-006: Per-method configuration
Each method (`opencli`, `piped`, `transcript-api`, `yt-dlp`, `bilibili-api`) has its own independent breaker with the correct default config from the spec table (e.g. piped: threshold=2, cooldown=10min, max=60min, multiplier=2).
Evidence: unit test — assert `getBreaker('piped').config.failureThreshold === 2` etc. for all five methods.

### VAL-CB-007: Piped lower threshold
Piped breaker opens after only 2 consecutive failures (vs 3 for others), reflecting its higher unreliability.
Evidence: unit test — 2 failures on piped → OPEN; 2 failures on opencli → still CLOSED.

### VAL-CB-008: Success resets failure count
A `recordSuccess` in CLOSED state resets the consecutive failure counter to 0.
Evidence: unit test — record 2 failures (below threshold), then 1 success, then 2 more failures → still CLOSED (not OPEN).

### VAL-CB-009: No persistence across restarts
Breaker state is in-memory only. After process restart, all breakers start in CLOSED state.
Evidence: unit test — confirm initial state is CLOSED for all methods after module initialization.

### VAL-CB-010: getAllStatus returns all breaker states
`getAllStatus()` returns a `Record<string, BreakerStatus>` with entries for all registered methods.
Evidence: unit test — register multiple methods, call `getAllStatus`, assert all are present.

### VAL-CB-011: SSE circuit-breaker:changed event
When a breaker transitions state, a `circuit-breaker:changed` SSE event is emitted with the method name and new state.
Evidence: integration test — subscribe to SSE, trigger a state change, verify event is received.

### VAL-CB-012: Integration with fallback chain — skip OPEN methods
In the subtitle fallback loop, methods with OPEN breakers are skipped with a `circuit_skip` log entry. The loop proceeds to the next method.
Evidence: integration test — set piped breaker to OPEN, trigger subtitle fetch, verify piped is skipped and `circuit_skip` log is emitted.

### VAL-CB-013: All methods OPEN sets per-video cooldown
When all methods in the fallback chain are OPEN, the video's `subtitle_cooldown_until` is set to the shortest remaining breaker cooldown, preventing repeated futile queue entries.
Evidence: unit test — open all breakers, run fallback chain, assert `subtitle_cooldown_until` is set correctly.

### VAL-CB-014: Tiered timeouts in fallback chain
The first method in the fallback chain gets 15s timeout, second gets 20s, third gets 30s, last gets 45s. Total worst-case is ~110s (not 510s).
Evidence: unit test with mocked timers — verify timeout values passed to each `tryMethod` call in the fallback loop.

## Area: Async Pool

### VAL-POOL-001: Concurrency limit enforced
With `initialConcurrency=3`, at most 3 jobs run simultaneously. A 4th enqueued job waits until one completes.
Evidence: unit test — enqueue 5 slow jobs, assert at most 3 are running concurrently at any point.

### VAL-POOL-002: Priority ordering
Higher-priority jobs (lower number = higher priority) are dequeued before lower-priority ones. Priority 0 (manual) runs before Priority 1 (auto).
Evidence: unit test — enqueue jobs with priorities [1, 0, 1, 0], track execution order, assert priority-0 jobs complete first.

### VAL-POOL-003: Adaptive concurrency — rate limit shrinks window
When `rateLimitHits > 0` during an adjustment interval, concurrency decreases by 2 (clamped to `minConcurrency`) and enters a 60s cooldown.
Evidence: unit test — simulate rate limit hits, trigger adjustment, assert concurrency decreased by 2.

### VAL-POOL-004: Adaptive concurrency — high failure rate shrinks window
When `failureRate > 50%` during an interval, concurrency decreases by 1.
Evidence: unit test — simulate >50% failure, trigger adjustment, assert concurrency decreased by 1.

### VAL-POOL-005: Adaptive concurrency — healthy conditions grow window
When `failureRate < 10%` and `avgResponseMs < expectedMs`, concurrency increases by 1 (capped at `maxConcurrency`).
Evidence: unit test — simulate healthy metrics, trigger adjustment, assert concurrency increased by 1.

### VAL-POOL-006: Concurrency stays within bounds
Concurrency never goes below `minConcurrency` or above `maxConcurrency`, regardless of adjustment signals.
Evidence: unit test — repeatedly trigger shrink at min and grow at max, assert bounds hold.

### VAL-POOL-007: pause / resume
`pool.pause()` stops dequeuing new jobs (in-flight jobs continue). `pool.resume()` restarts dequeuing.
Evidence: unit test — pause pool, enqueue job, assert it's not started, resume, assert it starts.

### VAL-POOL-008: drain
`pool.drain()` returns a Promise that resolves when all enqueued and in-flight jobs complete and the queue is empty.
Evidence: unit test — enqueue several jobs, call `drain()`, assert all completed when promise resolves, assert queue is empty.

### VAL-POOL-009: Pool-specific configurations
Four pools are created with correct defaults: `feed-crawl` (1/1/3), `enrichment` (3/1/6, Bilibili rate limit 10 req/5s), `subtitle` (2/1/4), `summary` (1/1/2).
Evidence: unit test — inspect each pool's config after initialization.

### VAL-POOL-010: Rate limiting
The `enrichment` pool with Bilibili rate limit `10 req/5s` does not exceed 10 requests in any 5-second window even when concurrency allows more.
Evidence: unit test — enqueue 20 fast jobs, track timestamps, assert no 5s window contains more than 10 completions.

### VAL-POOL-011: Event loop pressure integration
When `crawler-performance.ts` signals `busy`/`strained`, all pools' `maxConcurrency` is temporarily reduced by the throttle multiplier. Recovery restores original max.
Evidence: unit test — simulate event loop pressure signal, assert maxConcurrency is reduced; remove signal, assert restored.

### VAL-POOL-012: Pool status observability
`pool.getStatus()` returns a `PoolStatus` object with `currentConcurrency`, `queueDepth`, `activeJobs`, `successRate`, `avgResponseMs`.
Evidence: unit test — enqueue and complete some jobs, assert `getStatus()` returns reasonable values.

### VAL-POOL-013: SSE pool:status-changed event
When concurrency is adjusted, a `pool:status-changed` SSE event is emitted with pool name, old/new concurrency, success rate, and queue depth.
Evidence: integration test — subscribe to SSE, trigger adjustment, verify event.

### VAL-POOL-014: pool_adjust structured log
Each concurrency adjustment emits a `pool_adjust` log entry with pool name, previous/new concurrency, success_rate, avg_response_ms, queue_depth.
Evidence: unit test — trigger adjustment, parse JSONL, assert all fields present.

## Area: Async Migration

### VAL-ASYNC-001: opencli.ts — runOpenCliJson is async
`runOpenCliJson` uses `child_process.execFile` (promisified) instead of `execFileSync`. Returns a `Promise`.
Evidence: unit test — verify function returns a Promise; typecheck passes.

### VAL-ASYNC-002: opencli.ts — all exported functions are async
`runOpenCliJsonCompat`, `fetchOpenCliBilibiliUserVideos`, `fetchOpenCliBilibiliSubtitleRows`, `fetchOpenCliYoutubeTranscriptRows` all return Promises.
Evidence: typecheck + unit test — assert each function returns a Promise.

### VAL-ASYNC-003: subtitles.ts — runYtDlpSubtitleAttempts is async
`runYtDlpSubtitleAttempts` uses `execFile` (promisified) instead of `execFileSync`. Returns a `Promise`.
Evidence: unit test — verify function returns a Promise.

### VAL-ASYNC-004: subtitles.ts — fetchYoutubeSubtitleViaTranscriptApi is async
Uses `execFile` (promisified) for the Python subprocess call.
Evidence: unit test — verify function returns a Promise.

### VAL-ASYNC-005: subtitles.ts — fetchYoutubeSubtitleViaOpenCli awaits async opencli
No `execFileSync` calls remain. Calls flow through the now-async opencli functions.
Evidence: grep for `execFileSync` in `subtitles.ts` — zero matches.

### VAL-ASYNC-006: subtitles.ts — fetchBilibiliSubtitleViaOpenCli awaits async opencli
Same as above for Bilibili path.
Evidence: grep for `execFileSync` in `subtitles.ts` — zero matches.

### VAL-ASYNC-007: fetcher.ts — fetchBilibiliFeed awaits async opencli
No `execFileSync` in `fetcher.ts`.
Evidence: grep for `execFileSync` in `fetcher.ts` — zero matches.

### VAL-ASYNC-008: Zero execFileSync in codebase
After migration, `grep -r execFileSync src/lib/` returns zero matches (excluding test files and non-subprocess usage like the osascript window management which may be a separate concern, but spec lists only the items in the migration table).
Evidence: `rg execFileSync src/lib/` — zero matches (or only the osascript calls if those are out of scope).

### VAL-ASYNC-009: Callers updated to await
All callers of the migrated functions (in `auto-pipeline.ts`, `scheduler.ts`, `fetcher.ts`, API routes) properly `await` the now-async functions. No fire-and-forget Promises.
Evidence: typecheck passes; grep for unhandled promise patterns.

### VAL-ASYNC-010: Timeout behavior preserved
Each migrated subprocess call still enforces a timeout (previously via `execFileSync` `timeout` option, now via `AbortSignal.timeout()` or equivalent). Timeouts cause the child process to be killed and an error to be thrown.
Evidence: unit test — mock a subprocess that hangs, assert it throws after timeout.

## Area: Piped Instance Optimization

### VAL-PIPED-001: Instance blocklist
Failed instances are added to an in-memory blocklist with a 5-minute TTL. `isInstanceBlocked(instance)` returns `true` for blocked instances.
Evidence: unit test — record a failure for instance X, assert blocked; advance clock 5 min, assert unblocked.

### VAL-PIPED-002: Max 3 instance attempts per pipedRequest
`pipedRequest` tries at most 3 non-blocked instances before throwing. Even if 15 instances are available, only 3 are attempted.
Evidence: unit test — mock all instances to fail, assert exactly 3 attempts (not 15).

### VAL-PIPED-003: Blocked instances skipped
When 12 of 15 instances are blocked, `pipedRequest` only tries the 3 unblocked ones.
Evidence: unit test — block 12 instances, call `pipedRequest`, assert only 3 unblocked instances are tried.

### VAL-PIPED-004: All instances blocked → fast failure
When all instances are blocked, `pipedRequest` fails immediately without making any HTTP requests.
Evidence: unit test — block all instances, call `pipedRequest`, assert immediate failure, assert zero HTTP calls.

### VAL-PIPED-005: Worst-case time reduction
With max 3 attempts × 8s timeout = 24s worst case (down from 15 × 8s = 120s).
Evidence: unit test with mocked timers — all 3 attempts time out, measure total elapsed time ≤ 24s.

### VAL-PIPED-006: Blocklist is in-memory only
Process restart clears the blocklist. All instances start unblocked.
Evidence: unit test — after module re-initialization, all instances are unblocked.

### VAL-PIPED-007: Successful instance not blocked
A successful request to an instance does not add it to the blocklist.
Evidence: unit test — successful request, assert instance is not blocked.

## Area: Layer 0 Fast Path

### VAL-L0-001: Skeleton written to DB immediately
When a feed crawl discovers new videos, the `videos` table receives rows with `video_id`, `platform`, `title`, and `channel_id` populated. `thumbnail_url`, `published_at`, and `duration` may be NULL/empty for Bilibili.
Evidence: integration test — trigger feed crawl for a Bilibili channel, query DB, assert video rows exist with title but possibly empty thumbnail.

### VAL-L0-002: video:new-skeleton SSE event emitted
After skeleton DB write, a `video:new-skeleton` SSE event is emitted with at minimum `video_id`, `platform`, `title`.
Evidence: integration test — subscribe to SSE, trigger feed, verify event received with correct fields.

### VAL-L0-003: video:discovered event still emitted
The existing `video:discovered` event continues to fire for each new video, triggering the auto-pipeline (Layer 2).
Evidence: unit test — mock event listener, trigger feed, assert `video:discovered` is emitted for each new video.

### VAL-L0-004: video:new-full replaced by video:new-skeleton
The old `video:new-full` event is no longer emitted anywhere. All occurrences replaced by `video:new-skeleton`.
Evidence: grep for `video:new-full` in `src/` — zero matches.

### VAL-L0-005: YouTube data is already complete
For YouTube channels (Piped/RSS), skeleton data includes full thumbnail, duration, and published_at. The `video:new-skeleton` event carries complete data (same as old `video:new-full`). Frontend shows no skeleton placeholder.
Evidence: integration test — trigger YouTube feed, assert DB row has all fields populated.

### VAL-L0-006: Bilibili feed no longer calls enrichBilibiliVideos inline
`fetchBilibiliFeed` returns skeleton data without calling `enrichBilibiliVideos`. Enrichment is deferred to Layer 1.
Evidence: code inspection + unit test — mock `enrichBilibiliVideos`, trigger Bilibili feed, assert it was NOT called.

### VAL-L0-007: needs_enrichment videos enqueued to enrichment pool
Videos with missing thumbnail/duration/published_at are enqueued into the enrichment pool after skeleton write.
Evidence: unit test — trigger Bilibili feed with incomplete data, assert enrichment pool receives the job.

### VAL-L0-008: Manual refresh also uses skeleton path
`/api/videos/refresh/` follows the same skeleton + enrichment queue path as the scheduler, not a separate full-data path.
Evidence: integration test — call `/api/videos/refresh/`, verify `video:new-skeleton` (not `video:new-full`) is emitted and enrichment queue receives jobs.

### VAL-L0-009: Sub-second frontend appearance
From the moment a feed response is received to `video:new-skeleton` SSE emission, elapsed time is under 1 second (no enrichment blocking).
Evidence: performance test with mocked feed — measure time from feed return to SSE emission, assert < 1s.

## Area: Layer 1 Enrichment

### VAL-L1-001: enrichVideo fills missing fields
`enrichVideo(videoDbId)` fetches Bilibili video detail and updates `thumbnail_url`, `published_at`, `duration` in the DB.
Evidence: unit test — create skeleton row, call `enrichVideo` with mocked API, assert DB row updated.

### VAL-L1-002: video:enriched SSE event emitted
After successful enrichment, a `video:enriched` event is emitted via SSE with `videoDbId`, `videoId`, `platform`, and the updated `fields`.
Evidence: unit test — mock event listener, call `enrichVideo`, assert event emitted with correct payload.

### VAL-L1-003: Enrichment skipped for non-Bilibili / already-complete videos
`enrichVideo` returns early without API call if the video is YouTube or already has all fields populated.
Evidence: unit test — call with a YouTube video, assert no API call made; call with a complete Bilibili video, assert no API call.

### VAL-L1-004: No startup compensation
On process start, `enrichment-queue.ts` does not scan the database or enqueue recovery work automatically. Enrichment remains manual-only unless another runtime path explicitly enqueues a video.
Evidence: unit test — initialize the queue and assert no DB prepare/enqueue calls happen.

### VAL-L1-007: Enrichment pool concurrency and rate limiting
The enrichment pool runs at initial concurrency 3, max 6, with Bilibili rate limit of 10 requests per 5 seconds.
Evidence: unit test — verify pool config; load test with 20 jobs, assert rate limit respected.

### VAL-L1-008: Failed enrichment does not crash
If the Bilibili detail API fails, the video row is not updated, no event is emitted, and the error is logged. The pool continues processing other jobs.
Evidence: unit test — mock API failure, assert no DB change, assert error logged, assert pool continues.

## Area: Layer 2 Deep Processing

### VAL-L2-001: Subtitle queue uses concurrent pool
`processSubtitleQueue` dispatches subtitle jobs through the `subtitle` async pool (concurrency 2-4) instead of processing them serially.
Evidence: unit test — enqueue 4 subtitle jobs, assert up to 2 run concurrently (initial concurrency).

### VAL-L2-002: Circuit breaker checked before each fallback method
In the subtitle fallback chain, `circuitBreaker.isAvailable(method)` is called before attempting each method. OPEN methods are skipped.
Evidence: unit test — open breaker for `piped`, run fallback chain, assert piped is skipped.

### VAL-L2-003: Summary queue uses concurrent pool
`summary-queue.ts` dispatches summary tasks through the `summary` async pool (concurrency 1-2) instead of serial processing.
Evidence: unit test — enqueue 3 summary tasks, verify pool dispatch.

### VAL-L2-004: Priority 0 (manual) processed before Priority 1 (auto)
A manually triggered subtitle/summary job (priority 0) jumps ahead of auto-pipeline jobs (priority 1) in the pool queue.
Evidence: unit test — enqueue auto job, then manual job, assert manual job is dequeued first.

### VAL-L2-005: All breakers open → video cooldown set
When all subtitle methods have OPEN breakers, the video's `subtitle_cooldown_until` is set to the shortest remaining breaker cooldown time.
Evidence: unit test — open all breakers with known remaining times, run subtitle for a video, assert `subtitle_cooldown_until` matches the min remaining cooldown.

### VAL-L2-006: Existing auto-pipeline event flow preserved
`video:discovered` → auto subtitle (if `intent.auto_subtitle=1`) and `subtitle:ready` → auto summary (if `intent.auto_summary=1`) event chain still works end-to-end.
Evidence: integration test — emit `video:discovered` for an intent with both flags on, assert subtitle is attempted and on `subtitle:ready`, summary task is created.

## Area: Channel Context

### VAL-CTX-001: Logs include channel_id and channel_name
Subtitle, enrichment, and feed logs include `channel_id` and `channel_name` fields in the JSONL output.
Evidence: unit test — trigger a subtitle operation, parse the log, assert `channel_id` and `channel_name` are present.

### VAL-CTX-002: video:discovered event includes channel context
The `video:discovered` event payload includes `channelId` and `channelName` fields.
Evidence: unit test — mock event listener on `video:discovered`, trigger feed, assert payload has `channelId` and `channelName`.

### VAL-CTX-003: subtitle:ready event includes channel context
The `subtitle:ready` event payload includes `channelId` and `channelName` fields.
Evidence: unit test — mock event listener on `subtitle:ready`, trigger subtitle completion, assert payload.

### VAL-CTX-004: Channel info obtained via JOIN query
Layer 1 and Layer 2 obtain channel context by JOINing `videos` with `channels` table on `v.channel_id = c.id`, not by separate lookups.
Evidence: code inspection — verify SQL uses JOIN pattern from the spec.

### VAL-CTX-005: Layer 0 passes channel context from crawl scope
In `scheduler.ts`, the channel being crawled is already known, so `channel_id` and `channel_name` are passed directly to skeleton events without additional DB queries.
Evidence: code inspection + unit test.

### VAL-CTX-006: CrawlerCompactBar uses channel_name from SSE
SSE events carrying `channel_name` are used by `CrawlerCompactBar` to display progress like "正在抓取《频道名》的字幕" without frontend-side DB lookups.
Evidence: browser inspection — verify the status bar shows channel names during crawl.

## Area: Frontend Skeleton UX

### VAL-FE-001: Skeleton thumbnail placeholder
When `thumbnail_url` is null/empty, `VideoCard` displays a gradient placeholder instead of a broken image.
Evidence: browser inspection — create a skeleton video with no thumbnail, verify gradient placeholder renders.

### VAL-FE-002: Skeleton duration placeholder
When `duration` is null/empty, `VideoCard` displays `--:--` instead of `0:00` or blank.
Evidence: browser inspection — create a skeleton video with no duration, verify `--:--` displays.

### VAL-FE-003: SSE video:new-skeleton triggers card appearance
When the frontend receives a `video:new-skeleton` SSE event, a new VideoCard appears in the list immediately (with possible skeleton placeholders).
Evidence: browser inspection — subscribe to SSE in devtools, trigger feed crawl, verify card appears.

### VAL-FE-004: SSE video:enriched updates card in-place
When the frontend receives a `video:enriched` SSE event, the corresponding VideoCard updates its thumbnail, duration, and published_at fields without a full page reload.
Evidence: browser inspection — observe card transition from skeleton to enriched state.

### VAL-FE-005: YouTube videos show no skeleton state
Since YouTube data is always complete, VideoCards for YouTube videos never show skeleton placeholders.
Evidence: browser inspection — trigger YouTube feed crawl, verify all cards render with full data immediately.

### VAL-FE-006: SSE listener migration
Frontend SSE code listens for `video:new-skeleton` instead of `video:new-full`. No references to `video:new-full` remain in frontend code.
Evidence: grep for `video:new-full` in `src/components/` and `src/app/` — zero matches.

### VAL-FE-007: Existing subtitle/summary SSE events unchanged
`subtitle:status-changed` and `summary:status-changed` SSE events continue to work as before. No regression.
Evidence: browser inspection — trigger subtitle/summary operations, verify badges update.

## Area: Singleton Pattern

### VAL-SINGLE-001: Circuit breaker registry is a singleton
`circuit-breaker.ts` stores its registry via `globalThis[Symbol.for('folo:circuit-breaker')]`. Multiple imports in the same process share one instance.
Evidence: unit test — import from two different modules, assert same registry instance; verify HMR does not create duplicates.

### VAL-SINGLE-002: Async pool instances are singletons
Each pool (`feed-crawl`, `enrichment`, `subtitle`, `summary`) is stored via `globalThis[Symbol.for('folo:pool:<name>')]`. Multiple imports share the same instance.
Evidence: unit test — import pool getter from two modules, assert same instance returned.

### VAL-SINGLE-003: Enrichment queue is a singleton
`enrichment-queue.ts` uses `globalThis[Symbol.for(...)]` pattern consistent with `auto-pipeline.ts`.
Evidence: code inspection + unit test.

## Area: Priority System

### VAL-PRIO-001: Two-level priority only
Priority system has exactly two levels: 0 (user manual trigger) and 1 (auto pipeline). No priority level 1 "viewport" exists.
Evidence: code inspection — assert only values 0 and 1 are used; typecheck passes.

### VAL-PRIO-002: Manual trigger uses priority 0
When a user clicks a subtitle/summary button via the API, the resulting pool job has priority 0.
Evidence: unit test — call the manual trigger API endpoint, assert the enqueued job has priority 0.

### VAL-PRIO-003: Auto pipeline uses priority 1
Jobs created by `auto-pipeline.ts` event handlers use priority 1.
Evidence: unit test — trigger `video:discovered` auto flow, assert enqueued job has priority 1.

## Area: Cooldown Priority Chain

### VAL-COOL-001: Three-layer priority order
The protection priority chain is: (1) circuit breaker, (2) global scope cooldown, (3) per-video cooldown. Circuit breaker is checked first.
Evidence: unit test — set all three protections active, verify circuit breaker check occurs before scope cooldown and video cooldown checks.

### VAL-COOL-002: Global scope cooldown preserved
The existing `getActiveSubtitleCooldownUntil` mechanism continues to function as before for rate-limit scenarios, unaffected by the new circuit breaker.
Evidence: unit test — trigger a global scope cooldown, verify subtitle processing is paused globally.

### VAL-COOL-003: Per-video cooldown preserved
The existing `subtitle_cooldown_until` per-video mechanism continues to function as before.
Evidence: unit test — set per-video cooldown, verify subtitle is not attempted before cooldown expires.

## Cross-Area Flows

### VAL-CROSS-001: End-to-end Bilibili skeleton → enrichment → subtitle → summary
A new Bilibili video discovered by the scheduler goes through: (1) skeleton write + `video:new-skeleton` SSE, (2) enrichment pool fills metadata + `video:enriched` SSE, (3) subtitle pool fetches subtitles with circuit breaker protection + `subtitle:ready`, (4) summary pool generates summary. All layers execute asynchronously without blocking each other.
Evidence: integration test — trigger a full crawl for a Bilibili channel with auto_subtitle=1 and auto_summary=1, verify all four stages complete and all SSE events fire in order.

### VAL-CROSS-002: End-to-end YouTube fast path
A new YouTube video discovered by the scheduler: (1) full data written (no skeleton gaps) + `video:new-skeleton` SSE with complete data, (2) no enrichment needed, (3) subtitle pool with circuit breaker, (4) summary. Layer 1 is skipped entirely.
Evidence: integration test — trigger YouTube crawl, verify no enrichment job enqueued, subtitle proceeds directly.

### VAL-CROSS-003: All Piped instances down + circuit breaker
When all Piped instances are unreachable: (1) instance blocklist blocks all after ≤3 attempts, (2) `pipedRequest` fails fast, (3) piped circuit breaker opens after 2 such failures, (4) subsequent videos skip piped entirely, (5) fallback chain proceeds to next method (e.g. transcript-api, yt-dlp).
Evidence: integration test — mock all Piped instances as 500, process multiple videos, verify piped breaker opens, subsequent videos skip piped, total time is dramatically reduced.

### VAL-CROSS-004: Circuit breaker recovery flow
After piped breaker opens and cooldown expires: (1) breaker enters HALF_OPEN, (2) one probe request is allowed, (3) if successful → breaker closes and piped is fully available again.
Evidence: integration test — open piped breaker, advance time past cooldown, trigger subtitle, verify piped is attempted as probe.

### VAL-CROSS-005: Process restart resets in-memory state only
After a process restart: (1) all circuit breakers start CLOSED and (2) all pools start fresh with initial concurrency. Queued work is not re-hydrated from database compensation queries.
Evidence: integration test — re-initialize modules and verify fresh in-memory state without startup recovery scans.

### VAL-CROSS-006: Event loop pressure throttles all pools
When `crawler-performance.ts` detects event loop pressure (busy/strained): (1) all pool maxConcurrency values are reduced, (2) when pressure clears, maxConcurrency values are restored, (3) in-flight jobs are not interrupted.
Evidence: unit test — simulate pressure signal, verify all pools reduce max; clear pressure, verify restoration.

### VAL-CROSS-007: Structured log enables full request tracing
A single `run_id` (e.g., `crawl-1711489655`) appears in all log entries from one scheduler tick — feed, subtitle, enrichment, and summary logs. Filtering by `run_id` with `jq` shows the complete lifecycle.
Evidence: integration test — trigger a scheduler tick, collect all JSONL lines, filter by `run_id`, verify they span all relevant scopes.

### VAL-CROSS-008: Channel context flows through all layers
A video's `channel_id` and `channel_name` appear in: (1) `video:discovered` event, (2) `video:new-skeleton` SSE, (3) enrichment logs, (4) `subtitle:ready` event, (5) subtitle fallback logs. No layer loses channel context.
Evidence: integration test — process one video end-to-end, collect all events and logs, assert `channel_id`/`channel_name` present throughout.

### VAL-CROSS-009: feed-crawl pool wraps existing scheduler
The `feed-crawl` pool with `concurrency=1` wraps the existing `executeCrawlTick` per-channel loop. Behavior is identical to current serial execution but gains pool infrastructure (pause/resume/monitoring).
Evidence: unit test — verify feed-crawl pool config is initial=1, min=1, max=3; verify each channel is a pool job.

### VAL-CROSS-010: Manual refresh through skeleton path
`/api/videos/refresh/` uses the same skeleton + enrichment queue path as the scheduler. A Bilibili manual refresh shows skeleton cards immediately, enriched shortly after.
Evidence: curl test — `POST /api/videos/refresh/` for a Bilibili channel, verify `video:new-skeleton` SSE fires, then `video:enriched` SSE fires.

## Area: Build Integrity

### VAL-BUILD-001: TypeScript typecheck passes
`npm run typecheck` completes with zero errors after all changes.
Evidence: CI / local run of `npm run typecheck`.

### VAL-BUILD-002: ESLint passes
`npm run lint` completes with zero errors after all changes.
Evidence: CI / local run of `npm run lint`.

### VAL-BUILD-003: Production build succeeds
`npm run build` completes successfully.
Evidence: CI / local run of `npm run build`.

### VAL-BUILD-004: All existing tests pass
`npm run test` (vitest) passes with no regressions.
Evidence: CI / local run of `npm run test`.

### VAL-BUILD-005: No new TypeScript `any` types in new modules
New files (`circuit-breaker.ts`, `async-pool.ts`, `enrichment-queue.ts`) do not use explicit `any` type (strict mode compliance).
Evidence: grep for `: any` in new files — zero matches (excluding necessary type assertions with justification comments).
