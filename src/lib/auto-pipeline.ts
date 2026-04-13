/**
 * Event-driven auto-pipeline for subtitle and summary automation.
 *
 * Architecture:
 * - video:discovered → auto subtitle (if intent.auto_subtitle=1)
 * - subtitle:ready → auto summary (if intent.auto_summary=1)
 *
 * Replaces the intent fallback logic in pipeline.ts with a dedicated,
 * self-contained pipeline that manages its own subtitle queue.
 */

import { appEvents } from './events';
import { getDb, type Channel, type Intent, type Video } from './db';
import { ensureSubtitleForVideo, shouldEscapeToApi } from './subtitles';
import { createSummaryTask, getSummaryTask } from './summary-tasks';
import {
  getQueueState as getSummaryQueueState,
  isQueueRunning,
  startQueueProcessing,
} from './summary-queue';
import { log } from './logger';
import { getOrCreatePool, type AsyncPool } from './async-pool';
import type { JobResult } from './async-pool';
import {
  getEffectiveIntervalMs,
  getRateLimitCooldownRemainingMs,
  getSubtitleBackoffState,
  type SubtitleBackoffPlatform,
} from './subtitle-backoff';
import { getSubtitleBrowserFetchConfig } from './subtitle-browser-fetch-settings';
import { resolveSubtitleApiFallbackMatch } from './subtitle-api-fallback-settings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SUBTITLE_QUEUE = 100;
// Subtitle pool configuration (per spec section 5.8)
const SUBTITLE_POOL_CONFIG = {
  name: 'subtitle' as const,
  initialConcurrency: 1,
  minConcurrency: 1,
  maxConcurrency: 1,
  adjustIntervalMs: 30_000,
} as const;

const SUBTITLE_PLATFORMS: SubtitleBackoffPlatform[] = ['youtube', 'bilibili'];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SubtitleJob {
  videoDbId: number;
  videoId: string;
  title: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
  channelName: string;
  intentName: string;
  enqueuedAt: string;
  /** Priority: 0 = manual, 1 = auto-first, 2 = auto-retry */
  priority: number;
  /** Logical batch/job identifier. Single-video jobs default to video:<platform>:<videoId>. */
  batchId?: string;
  /** Human-readable job label shown in the task panel. */
  batchLabel?: string;
  /** Total number of videos contained in the logical job. */
  batchSize?: number;
}

export interface AutoPipelineStats {
  subtitleQueued: number;
  subtitleCompleted: number;
  subtitleFailed: number;
  summaryQueued: number;
}

export interface AutoPipelineState {
  initialized: boolean;
  subtitleQueue: SubtitleJob[];
  subtitleInflight: Set<string>; // videoIds currently being processed by pool
  subtitleProcessing: boolean;
  currentSubtitleJob: SubtitleJob | null;
  lastSubtitleStartedAt: Record<SubtitleBackoffPlatform, number | null>;
  stats: AutoPipelineStats;
}

export interface AutoPipelineStatus {
  subtitle: {
    queueLength: number;
    videoCount: number;
    processing: boolean;
    currentVideoId: string | null;
    currentVideoTitle: string | null;
    currentBatchId: string | null;
    currentBatchLabel: string | null;
    currentBatchVideoCount: number;
    nextRunAt: string | null;
    stats: { completed: number; failed: number; queued: number };
    throttle: {
      state: 'clear' | 'backoff' | 'exhausted';
      platform: SubtitleBackoffPlatform | null;
      multiplier: number;
      consecutiveErrors: number;
      maxRetries: number;
      exhaustedCount: number;
      platforms: Record<
        SubtitleBackoffPlatform,
        {
          state: 'clear' | 'backoff' | 'exhausted';
          multiplier: number;
          consecutiveErrors: number;
          maxRetries: number;
          exhaustedCount: number;
          nextRunAt: string | null;
          intervalMs: number;
        }
      >;
    };
    pool: {
      name: string;
      currentConcurrency: number;
      activeJobs: number;
      queueDepth: number;
      state: string;
    };
  };
  summary: {
    queueLength: number;
    processing: boolean;
    currentVideoId: string | null;
  };
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const globalKey = Symbol.for('folo-auto-pipeline');

function getState(): AutoPipelineState {
  const g = globalThis as typeof globalThis & {
    [globalKey]?: AutoPipelineState;
  };
  if (!g[globalKey]) {
    g[globalKey] = {
      initialized: false,
      subtitleQueue: [],
      subtitleInflight: new Set<string>(),
      subtitleProcessing: false,
      currentSubtitleJob: null,
      lastSubtitleStartedAt: {
        youtube: null,
        bilibili: null,
      },
      stats: {
        subtitleQueued: 0,
        subtitleCompleted: 0,
        subtitleFailed: 0,
        summaryQueued: 0,
      },
    };
  }
  return g[globalKey]!;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Gets intent by name. Returns null if not found.
 */
export function getIntentByName(intentName: string): Intent | null {
  const effectiveIntent =
    intentName && intentName.trim() ? intentName.trim() : '未分类';
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM intents WHERE name = ?')
    .get(effectiveIntent) as Intent | undefined;
  return row ?? null;
}

/**
 * Gets channel by its channel_id (platform-independent identifier).
 */
export function getChannelByChannelId(channelId: string): Channel | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM channels WHERE channel_id = ?')
    .get(channelId) as Channel | undefined;
  return row ?? null;
}

/**
 * Gets channel info for a video by joining videos → channels.
 */
export function getChannelForVideo(
  videoId: string,
  platform: 'youtube' | 'bilibili',
): Channel | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT c.*
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      WHERE v.video_id = ? AND v.platform = ?
      LIMIT 1
    `,
    )
    .get(videoId, platform) as Channel | undefined;
  return row ?? null;
}

/**
 * Gets video by platform video_id.
 */
export function getVideoByVideoId(
  videoId: string,
  platform: 'youtube' | 'bilibili',
): Video | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM videos WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as Video | undefined;
  return row ?? null;
}

/**
 * Gets video by internal DB id.
 */
export function getVideoById(videoDbId: number): Video | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoDbId) as
    | Video
    | undefined;
  return row ?? null;
}

function getVideoDisplayTitle(
  video: Pick<Video, 'title' | 'video_id'>,
): string {
  return video.title?.trim() || video.video_id;
}

function resolveSubtitleJobTitle(job: SubtitleJob | null): string | null {
  if (!job) return null;

  const trimmedTitle = job.title.trim();
  if (trimmedTitle && trimmedTitle !== job.videoId) {
    return trimmedTitle;
  }

  const video = getDb()
    .prepare(
      'SELECT title FROM videos WHERE video_id = ? AND platform = ? LIMIT 1',
    )
    .get(job.videoId, job.platform) as { title?: string | null } | undefined;
  const dbTitle = video?.title?.trim();
  if (dbTitle && dbTitle !== job.videoId) {
    return dbTitle;
  }

  return trimmedTitle || dbTitle || null;
}

function getDefaultBatchId(
  job: Pick<SubtitleJob, 'platform' | 'videoId'>,
): string {
  return `video:${job.platform}:${job.videoId}`;
}

function getDefaultBatchLabel(
  job: Pick<SubtitleJob, 'title' | 'videoId'>,
): string {
  return job.title.trim() || job.videoId;
}

function normalizeSubtitleJob(job: SubtitleJob): SubtitleJob {
  return {
    ...job,
    batchId: (job.batchId || getDefaultBatchId(job)).trim(),
    batchLabel: (job.batchLabel || getDefaultBatchLabel(job)).trim(),
    batchSize:
      Number.isFinite(job.batchSize) && Number(job.batchSize) > 0
        ? Math.max(1, Math.floor(Number(job.batchSize)))
        : 1,
  };
}

function countQueuedSubtitleBatches(queue: SubtitleJob[]): number {
  return new Set(queue.map((job) => normalizeSubtitleJob(job).batchId)).size;
}

function getSubtitleNextRunAt(
  lastSubtitleStartedAt: number | null,
  intervalMs: number,
): string | null {
  if (lastSubtitleStartedAt === null || intervalMs <= 0) return null;

  const nextRunAt = lastSubtitleStartedAt + intervalMs;
  if (nextRunAt <= Date.now()) return null;
  return new Date(nextRunAt).toISOString();
}

function getExhaustedSubtitleCount(
  maxRetries: number,
  platform?: SubtitleBackoffPlatform,
): number {
  const platformFilter = platform ? 'AND platform = ?' : '';
  const row = getDb()
    .prepare(
      `
        SELECT COUNT(*) AS c
        FROM videos
        WHERE subtitle_path IS NULL
          AND subtitle_status IN ('error', 'missing', 'empty')
          AND COALESCE(subtitle_retry_count, 0) > ?
          ${platformFilter}
      `,
    )
    .get(...(platform ? [maxRetries, platform] : [maxRetries])) as
    | { c?: number }
    | undefined;

  return row?.c || 0;
}

function createAbortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError(
    signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === 'string'
        ? signal.reason
        : 'Aborted',
  );
}

async function waitForSubtitleInterval(
  platform: SubtitleBackoffPlatform,
  signal?: AbortSignal,
): Promise<void> {
  const state = getState();
  const intervalMs = getEffectiveIntervalMs(platform);
  const cooldownMs = getRateLimitCooldownRemainingMs(platform);
  const lastStartedAt = state.lastSubtitleStartedAt[platform];
  let waitMs = 0;
  if (intervalMs > 0 && lastStartedAt !== null) {
    waitMs = Math.max(waitMs, lastStartedAt + intervalMs - Date.now());
  }
  waitMs = Math.max(waitMs, cooldownMs);
  if (waitMs <= 0) return;
  const jitter = waitMs * 0.3 * (2 * Math.random() - 1);
  waitMs = Math.max(1000, Math.round(waitMs + jitter));
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(
        createAbortError(
          signal?.reason instanceof Error
            ? signal.reason.message
            : typeof signal?.reason === 'string'
              ? signal.reason
              : 'Aborted',
        ),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Subtitle pool
// ---------------------------------------------------------------------------

/**
 * Executor function for subtitle jobs in the async pool.
 * Handles cooldown checking and subtitle fetch.
 */
async function runSubtitleJob(
  job: SubtitleJob,
  signal?: AbortSignal,
): Promise<JobResult> {
  const startTime = Date.now();
  const state = getState();
  const browserFetchConfig = getSubtitleBrowserFetchConfig();

  throwIfAborted(signal);
  await waitForSubtitleInterval(job.platform, signal);
  throwIfAborted(signal);
  state.lastSubtitleStartedAt[job.platform] = Date.now();
  state.currentSubtitleJob = job;

  // Emit intermediate "fetching" status for SSE real-time badge update
  appEvents.emit('subtitle:status-changed', {
    videoId: job.videoId,
    platform: job.platform,
    status: 'fetching',
  });

  try {
    const initialVideo = getDb()
      .prepare(
        `
        SELECT v.*, i.id AS intent_id
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        LEFT JOIN intents i ON i.name = c.intent
        WHERE v.id = ?
      `,
      )
      .get(job.videoDbId) as SubtitleJobVideoContext | undefined;
    if (!initialVideo) {
      return { success: true, durationMs: Date.now() - startTime };
    }

    const apiFallbackMatch = resolveSubtitleApiFallbackMatch({
      channelId: initialVideo.channel_id,
      intentId: initialVideo.intent_id,
    });
    const shouldUseApiFirst = shouldEscapeToApi(initialVideo, apiFallbackMatch);
    const result = await ensureSubtitleForVideo(
      job.videoDbId,
      shouldUseApiFirst
        ? {
            preferredMethod: 'gemini',
            apiModelId: apiFallbackMatch?.modelId || undefined,
            signal,
            force: true,
          }
        : { signal },
    );
    const latestVideo = getVideoById(job.videoDbId);

    if (result?.subtitle_path && result.subtitle_status === 'fetched') {
      state.stats.subtitleCompleted++;
      // Emit subtitle:ready for auto-summary trigger
      appEvents.emit('subtitle:ready', {
        videoId: job.videoId,
        platform: job.platform,
        channelId: job.channelId,
        channelName: job.channelName,
        at: new Date().toISOString(),
      });
      return { success: true, durationMs: Date.now() - startTime };
    }

    if (
      latestVideo &&
      !latestVideo.subtitle_path &&
      latestVideo.subtitle_status &&
      ['error', 'missing', 'empty'].includes(latestVideo.subtitle_status)
    ) {
      const retriesUsed = latestVideo.subtitle_retry_count || 0;
      if (retriesUsed <= browserFetchConfig.maxRetries) {
        enqueueSubtitleJob({
          ...job,
          title: getVideoDisplayTitle(latestVideo),
          enqueuedAt: new Date().toISOString(),
          priority: 2,
        });
        // Re-queued for retry — not counted as completed or failed
        return { success: true, durationMs: Date.now() - startTime };
      } else if (apiFallbackMatch) {
        const apiResult = await ensureSubtitleForVideo(job.videoDbId, {
          preferredMethod: 'gemini',
          apiModelId: apiFallbackMatch.modelId || undefined,
          signal,
          force: true,
        });
        if (
          apiResult?.subtitle_path &&
          apiResult.subtitle_status === 'fetched'
        ) {
          state.stats.subtitleCompleted++;
          appEvents.emit('subtitle:ready', {
            videoId: job.videoId,
            platform: job.platform,
            channelId: job.channelId,
            channelName: job.channelName,
            at: new Date().toISOString(),
          });
          return { success: true, durationMs: Date.now() - startTime };
        }
      }
      // Subtitle fetch failed and no more retries/fallbacks available
      state.stats.subtitleFailed++;
      return { success: false, durationMs: Date.now() - startTime, error: latestVideo.subtitle_error || 'subtitle not available' };
    }

    // Video no longer needs subtitle fetch (already has path, or status not actionable)
    state.stats.subtitleCompleted++;
    return { success: true, durationMs: Date.now() - startTime };
  } catch (error) {
    const state = getState();
    state.stats.subtitleFailed++;
    const msg = error instanceof Error ? error.message : String(error);
    log.error('system', 'auto_pipeline_subtitle_failed', {
      videoId: job.videoId,
      error: msg,
    });
    return { success: false, durationMs: Date.now() - startTime, error: msg };
  } finally {
    // Remove from inflight set and from pending queue
    state.currentSubtitleJob = null;
    state.subtitleInflight.delete(job.videoId);
    const idx = state.subtitleQueue.findIndex((j) => j.videoId === job.videoId);
    if (idx !== -1) state.subtitleQueue.splice(idx, 1);
  }
}

/**
 * Gets the subtitle pool instance (for testing and status).
 */
export function getSubtitlePool(): AsyncPool<SubtitleJob> {
  return getOrCreatePool<SubtitleJob>(
    SUBTITLE_POOL_CONFIG.name,
    SUBTITLE_POOL_CONFIG,
  );
}

function dispatchSubtitleJob(job: SubtitleJob): Promise<JobResult> | null {
  const state = getState();
  const normalizedJob = normalizeSubtitleJob(job);

  if (state.subtitleQueue.length >= MAX_SUBTITLE_QUEUE) {
    log.warn(
      'system',
      'auto_pipeline_subtitle_queue_full',
      {
        capacity: MAX_SUBTITLE_QUEUE,
        videoId: normalizedJob.videoId,
      },
    );
    return null;
  }

  // Dedup by videoId (check both queue and in-flight)
  if (
    state.subtitleQueue.some((j) => j.videoId === normalizedJob.videoId) ||
    state.subtitleInflight.has(normalizedJob.videoId)
  ) {
    return null;
  }

  state.subtitleQueue.push(normalizedJob);
  state.stats.subtitleQueued++;
  state.subtitleInflight.add(normalizedJob.videoId);

  const pool = getSubtitlePool();
  const promise = pool.enqueue(
    normalizedJob,
    normalizedJob.priority,
    runSubtitleJob,
  );
  promise.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== 'subtitle queue cleared') {
      log.error('system', 'auto_pipeline_subtitle_pool_error', {
        error: message,
      });
    }
    state.subtitleInflight.delete(normalizedJob.videoId);
    const idx = state.subtitleQueue.findIndex(
      (j) => j.videoId === normalizedJob.videoId,
    );
    if (idx !== -1) state.subtitleQueue.splice(idx, 1);
  });

  return promise;
}

/**
 * Adds a subtitle job to the pool if not full and not already in-flight.
 * Manual triggers use priority 0, auto-first uses priority 1, retries use priority 2.
 * Returns true if dispatched, false if skipped (full, duplicate, or in-flight).
 */
export function enqueueSubtitleJob(job: SubtitleJob): boolean {
  return dispatchSubtitleJob(job) !== null;
}

function buildSubtitleJobFromSeed(
  seed: SubtitleJobSeed,
  priority: 0 | 1 | 2,
): SubtitleJob {
  return {
    videoDbId: seed.id,
    videoId: seed.video_id,
    platform: seed.platform,
    channelId:
      seed.platform_channel_id?.trim() ||
      `research:${seed.platform}:${seed.video_id}`,
    channelName: seed.channel_name?.trim() || '',
    title: seed.title?.trim() || seed.video_id,
    intentName: seed.intent?.trim() || '未分类',
    enqueuedAt: new Date().toISOString(),
    priority,
  };
}

export function enqueueSubtitleJobForVideoDbId(
  videoDbId: number,
  priority: 0 | 1 | 2 = 0,
): boolean {
  ensureAutoPipeline();

  const seed = getDb()
    .prepare(
      `
        SELECT v.id, v.video_id, v.platform, v.title, v.subtitle_status, v.subtitle_path,
               COALESCE(c.name, v.channel_name) AS channel_name,
               c.channel_id AS platform_channel_id,
               c.intent
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        WHERE v.id = ?
        LIMIT 1
      `,
    )
    .get(videoDbId) as SubtitleJobSeed | undefined;

  if (!seed) return false;
  if (
    seed.subtitle_path ||
    seed.subtitle_status === 'fetched' ||
    seed.subtitle_status === 'fetching'
  ) {
    return false;
  }

  return enqueueSubtitleJob(buildSubtitleJobFromSeed(seed, priority));
}

export function clearSubtitleQueue(): { cleared: number } {
  const state = getState();
  const pool = getSubtitlePool();
  const activeVideoId = state.currentSubtitleJob?.videoId ?? null;

  const queuedVideoIds = new Set(
    state.subtitleQueue
      .map((job) => job.videoId)
      .filter((videoId) => videoId && videoId !== activeVideoId),
  );

  const clearedQueued = pool.clearQueued(
    (job) => queuedVideoIds.has(job.videoId),
    'subtitle queue cleared',
  );
  const abortedActive = activeVideoId
    ? pool.abortActive(
        (job) => job.videoId === activeVideoId,
        'subtitle queue cleared',
      )
    : 0;
  const cleared = clearedQueued + abortedActive;

  if (cleared > 0) {
    state.subtitleQueue =
      activeVideoId && abortedActive === 0
        ? state.subtitleQueue.filter((job) => job.videoId === activeVideoId)
        : [];
    for (const videoId of queuedVideoIds) {
      state.subtitleInflight.delete(videoId);
    }
    if (abortedActive > 0 && activeVideoId) {
      state.subtitleInflight.delete(activeVideoId);
    }
  }

  log.warn('system', 'auto_pipeline_subtitle_queue_cleared', { cleared });
  return { cleared };
}

/**
 * Backward-compatible alias: enqueueSubtitleJob with priority=1 (auto-first).
 */
export function enqueueSubtitleJobAuto(
  job: Omit<SubtitleJob, 'priority'>,
): boolean {
  return enqueueSubtitleJob({ ...job, priority: 1 });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handles video:discovered event.
 * Looks up channel → intent, checks auto_subtitle=1, enqueues subtitle job.
 * Auto-pipeline uses priority 1 by default; manual refresh can override to 0.
 */
async function onVideoDiscovered(payload: {
  videoId: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
  priority?: number;
}): Promise<void> {
  const { videoId, platform, channelId } = payload;
  const priority = payload.priority === 0 ? 0 : 1;

  // 1. Lookup channel
  const channel = getChannelByChannelId(channelId);
  if (!channel) return;

  // 2. Lookup intent
  const intent = getIntentByName(channel.intent);
  if (!intent || !intent.auto_subtitle) return;

  // 3. Lookup video
  const video = getVideoByVideoId(videoId, platform);
  if (!video) return;

  // 4. Skip if already fetched
  if (video.subtitle_status === 'fetched' || video.subtitle_path) return;

  // 5. Enqueue subtitle job with the requested priority.
  enqueueSubtitleJob({
    videoDbId: video.id,
    videoId,
    platform,
    channelId,
    channelName: channel.name || '',
    title: getVideoDisplayTitle(video),
    intentName: channel.intent,
    enqueuedAt: new Date().toISOString(),
    priority,
  });
}

/**
 * Handles subtitle:ready event.
 * Looks up video → channel → intent, checks auto_summary=1,
 * creates summary task and starts queue if not running.
 */
async function onSubtitleReady(payload: {
  videoId: string;
  platform: 'youtube' | 'bilibili';
}): Promise<void> {
  const { videoId, platform } = payload;

  // 1. Lookup video
  const video = getVideoByVideoId(videoId, platform);
  if (!video) return;

  // 2. Lookup channel
  const channel = getChannelForVideo(videoId, platform);
  if (!channel) return;

  // 3. Lookup intent
  const intent = getIntentByName(channel.intent);
  if (!intent || !intent.auto_summary) return;

  // 4. Check existing summary task
  const existing = getSummaryTask(videoId, platform);
  if (existing && existing.status !== 'failed') return;

  // 5. If existing task is failed, revive it to pending instead of inserting
  if (existing && existing.status === 'failed') {
    const db = getDb();
    db.prepare(
      "UPDATE summary_tasks SET status = 'pending', error = NULL WHERE video_id = ? AND platform = ?",
    ).run(videoId, platform);
  } else {
    createSummaryTask(videoId, platform);
  }
  getState().stats.summaryQueued++;

  // 6. Ensure queue is running
  if (!isQueueRunning()) {
    startQueueProcessing();
  }
}

interface SubtitleJobVideoContext extends Video {
  intent_id?: number | null;
}

interface SummaryPendingCount {
  c: number;
}

interface SubtitleJobSeed {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string | null;
  subtitle_status: string | null;
  subtitle_path: string | null;
  channel_name?: string | null;
  platform_channel_id?: string | null;
  intent?: string | null;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Registers event listeners for the auto-pipeline.
 * Idempotent — subsequent calls are no-ops.
 */
export function ensureAutoPipeline(): void {
  const state = getState();
  if (state.initialized) return;
  state.initialized = true;

  appEvents.on('video:discovered', onVideoDiscovered);
  appEvents.on('subtitle:ready', onSubtitleReady);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Returns the current auto-pipeline status for SSE and API use.
 */
export function getAutoPipelineStatus(): AutoPipelineStatus {
  const state = getState();
  const db = getDb();
  const browserFetchConfig = getSubtitleBrowserFetchConfig();
  const summaryQueueState = getSummaryQueueState();

  const pendingSummaryCount = db
    .prepare("SELECT COUNT(*) AS c FROM summary_tasks WHERE status = 'pending'")
    .get() as SummaryPendingCount;

  // Get subtitle pool status
  const subtitlePool = getSubtitlePool();
  const poolStatus = subtitlePool.getStatus();
  const activeSubtitleJob =
    state.currentSubtitleJob
      ? normalizeSubtitleJob(state.currentSubtitleJob)
      : state.subtitleQueue[0]
        ? normalizeSubtitleJob(state.subtitleQueue[0])
        : null;
  const currentVideoTitle = resolveSubtitleJobTitle(activeSubtitleJob);
  const queueBatchCount = countQueuedSubtitleBatches(state.subtitleQueue);
  const currentBatchId = activeSubtitleJob?.batchId ?? null;
  const currentBatchLabel = activeSubtitleJob?.batchLabel ?? null;
  const currentBatchVideoCount = activeSubtitleJob?.batchSize ?? 0;
  const throttlePlatforms = Object.fromEntries(
    SUBTITLE_PLATFORMS.map((platform) => {
      const backoff = getSubtitleBackoffState(platform);
      const intervalMs = getEffectiveIntervalMs(platform);
      const cooldownMs = getRateLimitCooldownRemainingMs(platform);
      const exhaustedCount = getExhaustedSubtitleCount(
        browserFetchConfig.maxRetries,
        platform,
      );
      const throttleState =
        exhaustedCount > 0
          ? 'exhausted'
          : cooldownMs > 0
            ? 'backoff'
          : backoff.consecutiveErrors > 0
            ? 'backoff'
            : 'clear';
      const nextRunAt = getSubtitleNextRunAt(
        state.lastSubtitleStartedAt[platform],
        Math.max(intervalMs, cooldownMs),
      );

      return [
        platform,
        {
          state: throttleState,
          multiplier: backoff.multiplier,
          consecutiveErrors: backoff.consecutiveErrors,
          maxRetries: browserFetchConfig.maxRetries,
          exhaustedCount,
          nextRunAt,
          intervalMs,
        },
      ];
    }),
  ) as AutoPipelineStatus['subtitle']['throttle']['platforms'];

  const aggregatePlatform =
    activeSubtitleJob?.platform ??
    SUBTITLE_PLATFORMS.reduce<SubtitleBackoffPlatform | null>(
      (selected, platform) => {
        if (!selected) return platform;
        const current = throttlePlatforms[selected];
        const candidate = throttlePlatforms[platform];
        const currentRank =
          current.state === 'exhausted'
            ? 3
            : current.state === 'backoff'
              ? 2
              : 1;
        const candidateRank =
          candidate.state === 'exhausted'
            ? 3
            : candidate.state === 'backoff'
              ? 2
              : 1;

        if (candidateRank !== currentRank) {
          return candidateRank > currentRank ? platform : selected;
        }
        if (candidate.multiplier !== current.multiplier) {
          return candidate.multiplier > current.multiplier
            ? platform
            : selected;
        }
        if (candidate.exhaustedCount !== current.exhaustedCount) {
          return candidate.exhaustedCount > current.exhaustedCount
            ? platform
            : selected;
        }
        return selected;
      },
      null,
    );
  const aggregateThrottle = aggregatePlatform
    ? throttlePlatforms[aggregatePlatform]
    : {
        state: 'clear' as const,
        multiplier: 1,
        consecutiveErrors: 0,
        maxRetries: browserFetchConfig.maxRetries,
        exhaustedCount: 0,
        nextRunAt: null,
        intervalMs: 0,
      };
  const nextRunAt = activeSubtitleJob?.platform
    ? throttlePlatforms[activeSubtitleJob.platform].nextRunAt
    : (SUBTITLE_PLATFORMS.map(
        (platform) => throttlePlatforms[platform].nextRunAt,
      )
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null);

  return {
    subtitle: {
      queueLength: queueBatchCount,
      videoCount: state.subtitleQueue.length,
      processing: poolStatus.activeJobs > 0,
      currentVideoId: activeSubtitleJob?.videoId ?? null,
      currentVideoTitle,
      currentBatchId,
      currentBatchLabel,
      currentBatchVideoCount,
      nextRunAt,
      stats: {
        completed: state.stats.subtitleCompleted,
        failed: state.stats.subtitleFailed,
        queued: state.stats.subtitleQueued,
      },
      throttle: {
        state: aggregateThrottle.state,
        platform: aggregatePlatform,
        multiplier: aggregateThrottle.multiplier,
        consecutiveErrors: aggregateThrottle.consecutiveErrors,
        maxRetries: aggregateThrottle.maxRetries,
        exhaustedCount: aggregateThrottle.exhaustedCount,
        platforms: throttlePlatforms,
      },
      pool: {
        name: poolStatus.name,
        currentConcurrency: poolStatus.currentConcurrency,
        activeJobs: poolStatus.activeJobs,
        queueDepth: poolStatus.queueDepth,
        state: poolStatus.state,
      },
    },
    summary: {
      queueLength: pendingSummaryCount.c,
      processing: summaryQueueState.running,
      currentVideoId: summaryQueueState.currentVideoId ?? null,
    },
  };
}
