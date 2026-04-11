import {
  getCrawlerPerformanceSummary,
  throttleCrawlerStage,
} from './crawler-performance';
import { getDb, type Channel } from './db';
import { appEvents } from './events';
import { fetchBilibiliFeed, fetchYouTubeFeed } from './fetcher';
import { BROWSER_METHOD_ID } from './browser-method';
import { getPreferredCrawlMethod } from './pipeline-config';
import { log } from './logger';
import {
  getAppSetting,
  getPositiveIntAppSetting,
  setAppSetting,
} from './app-settings';
import {
  getCrawlerScopeOwner,
  releaseCrawlerScope,
  resetCrawlerScopeStatus,
  tryAcquireCrawlerScope,
  updateCrawlerScopeStatus,
  waitIfCrawlerPaused,
} from './crawler-status';
import { getOrCreatePool, type AsyncPool } from './async-pool';
import type { JobResult } from './async-pool';
import { recordChannelRefresh, recordIntentRefresh } from './refresh-history';
import type {
  SchedulerConfig,
  SchedulerIndicatorStatus,
  SchedulerStatus,
  SchedulerTaskName,
} from '@/types';

const DEFAULT_CRAWL_INTERVAL = 2 * 60 * 60;
const DEFAULT_SUBTITLE_INTERVAL = 0;
const CRAWL_BACKOFF_BASE_MS = 30 * 60 * 1000;
const CRAWL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

const SETTINGS_KEYS = {
  enabled: 'scheduler_enabled',
  crawlInterval: 'scheduler_crawl_interval',
  subtitleInterval: 'scheduler_subtitle_interval',
  lastCrawl: 'scheduler_last_crawl',
} as const;

const OBSOLETE_KEYS = [
  'scheduler_summary_interval',
  'scheduler_last_subtitle',
  'scheduler_last_summary',
] as const;

// Feed-crawl pool configuration (per spec section 5.8)
// Concurrency=1 initially, mainly for unified monitoring
const FEED_CRAWL_POOL_CONFIG = {
  name: 'feed-crawl' as const,
  initialConcurrency: 1,
  minConcurrency: 1,
  maxConcurrency: 3,
  adjustIntervalMs: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedCrawlJob {
  channel: Channel;
  runId: number;
  index: number;
  total: number;
}

interface TaskRuntimeSlot {
  timer: NodeJS.Timeout | null;
  running: boolean;
  nextRunAt: string | null;
}

interface SchedulerRuntimeState {
  initialized: boolean;
  enabled: boolean;
  runId: number;
  currentTask: SchedulerTaskName | null;
  message: string | null;
  updatedAt: string;
  crawlTimer: TaskRuntimeSlot;
}

const globalKey = Symbol.for('folo-scheduler-runtime');

function getRuntime(): SchedulerRuntimeState {
  const g = globalThis as typeof globalThis & {
    [globalKey]?: SchedulerRuntimeState;
  };
  if (!g[globalKey]) {
    g[globalKey] = {
      initialized: false,
      enabled: false,
      runId: 0,
      currentTask: null,
      message: null,
      updatedAt: new Date().toISOString(),
      crawlTimer: { timer: null, running: false, nextRunAt: null },
    };
  }
  return g[globalKey]!;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isServerlessRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function parseInterval(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getSchedulerConfig(): SchedulerConfig {
  return {
    enabled: getAppSetting(SETTINGS_KEYS.enabled) === '1',
    crawlInterval: parseInterval(
      getAppSetting(SETTINGS_KEYS.crawlInterval),
      DEFAULT_CRAWL_INTERVAL,
    ),
    subtitleInterval: getPositiveIntAppSetting(
      SETTINGS_KEYS.subtitleInterval,
      DEFAULT_SUBTITLE_INTERVAL,
    ),
  };
}

function persistSchedulerConfig(config: SchedulerConfig) {
  setAppSetting(SETTINGS_KEYS.enabled, config.enabled ? '1' : '0');
  setAppSetting(SETTINGS_KEYS.crawlInterval, String(config.crawlInterval));
  setAppSetting(
    SETTINGS_KEYS.subtitleInterval,
    String(Math.max(0, Math.floor(config.subtitleInterval))),
  );
}

function setLastRun(value: string) {
  setAppSetting(SETTINGS_KEYS.lastCrawl, value);
}

function getLastRun(): string | null {
  return getAppSetting(SETTINGS_KEYS.lastCrawl);
}

function clearCrawlTimer() {
  const slot = getRuntime().crawlTimer;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  slot.nextRunAt = null;
}

function updateRuntime(
  patch: Partial<
    Pick<SchedulerRuntimeState, 'enabled' | 'currentTask' | 'message'>
  >,
) {
  const runtime = getRuntime();
  Object.assign(runtime, patch);
  runtime.updatedAt = nowIso();
}

export function getSchedulerIndicatorStatus(): SchedulerIndicatorStatus {
  const runtime = getRuntime();
  if (!runtime.enabled) {
    return {
      state: 'idle',
      message: runtime.message || '自动化已关闭',
      updatedAt: runtime.updatedAt,
    };
  }

  if (runtime.currentTask) {
    return {
      state: 'running',
      currentTask: runtime.currentTask,
      nextRunAt: runtime.crawlTimer.nextRunAt,
      message: runtime.message || `自动化正在执行 ${runtime.currentTask}`,
      updatedAt: runtime.updatedAt,
    };
  }

  return {
    state: 'waiting',
    nextRunAt: runtime.crawlTimer.nextRunAt,
    message: runtime.message || '自动化等待下次执行',
    updatedAt: runtime.updatedAt,
  };
}

function getTodayStats() {
  const db = getDb();
  const videos = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM videos
    WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')
  `,
    )
    .get() as { count: number };
  const subtitles = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM videos
    WHERE subtitle_path IS NOT NULL
      AND subtitle_status = 'fetched'
      AND DATE(subtitle_last_attempt_at, 'localtime') = DATE('now', 'localtime')
  `,
    )
    .get() as { count: number };
  const summaries = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM summary_tasks
    WHERE status = 'completed'
      AND DATE(completed_at, 'localtime') = DATE('now', 'localtime')
  `,
    )
    .get() as { count: number };

  return {
    videos: videos.count || 0,
    subtitles: subtitles.count || 0,
    summaries: summaries.count || 0,
  };
}

export function getSchedulerStatus(): SchedulerStatus {
  const runtime = getRuntime();
  return {
    running: runtime.enabled,
    state: getSchedulerIndicatorStatus().state,
    currentTask: runtime.currentTask,
    lastCrawl: getLastRun(),
    nextCrawl: runtime.crawlTimer.nextRunAt,
    todayStats: getTodayStats(),
    message: runtime.message,
    updatedAt: runtime.updatedAt,
  };
}

export function getSchedulerSnapshot() {
  return {
    config: getSchedulerConfig(),
    status: getSchedulerStatus(),
  };
}

function emitTick(
  task: SchedulerTaskName,
  phase: 'start' | 'complete' | 'skip' | 'error',
  message?: string,
) {
  appEvents.emit('scheduler:tick', {
    task,
    phase,
    at: nowIso(),
    message,
  });
}

function emitLifecycle(
  event: 'scheduler:start' | 'scheduler:stop',
  enabled: boolean,
) {
  appEvents.emit(event, {
    enabled,
    at: nowIso(),
  });
}

class SchedulerAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerAbortError';
  }
}

function isTaskRunCancelled(runId: number): boolean {
  const runtime = getRuntime();
  return !runtime.enabled || runtime.runId !== runId;
}

function assertTaskRunActive(runId: number, task: SchedulerTaskName) {
  if (isTaskRunCancelled(runId)) {
    throw new SchedulerAbortError(`scheduler ${task} stopped`);
  }
}

function scheduleCrawlTask(delaySeconds: number) {
  const runtime = getRuntime();
  const slot = runtime.crawlTimer;
  const scheduledRunId = runtime.runId;
  clearCrawlTimer();

  if (!runtime.enabled) return;

  const delayMs = Math.max(1000, delaySeconds * 1000);
  slot.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  runtime.updatedAt = nowIso();

  slot.timer = setTimeout(async () => {
    slot.timer = null;

    if (!getRuntime().enabled || getRuntime().runId !== scheduledRunId) return;
    if (slot.running) {
      log.warn(
        'system',
        'scheduler_crawl_skip',
        { reason: 'previous-tick-still-running' },
      );
      emitTick('crawl', 'skip', 'previous tick still running');
      scheduleCrawlTask(getSchedulerConfig().crawlInterval);
      return;
    }

    const acquiredScope = tryAcquireCrawlerScope('feed', 'scheduler');
    if (!acquiredScope) {
      const owner = getCrawlerScopeOwner('feed');
      const message =
        owner === 'manual'
          ? '手动刷新进行中，已跳过本轮自动任务'
          : '已有后台任务执行中，已跳过本轮自动任务';
      updateRuntime({ message });
      emitTick('crawl', 'skip', message);
      scheduleCrawlTask(getSchedulerConfig().crawlInterval);
      return;
    }

    slot.running = true;
    slot.nextRunAt = null;
    updateRuntime({
      currentTask: 'crawl',
      message: '自动化正在执行 crawl',
    });
    emitTick('crawl', 'start', 'scheduler crawl started');

    try {
      await executeCrawlTick(scheduledRunId);
      setLastRun(nowIso());
      emitTick('crawl', 'complete', 'scheduler crawl completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SchedulerAbortError) {
        emitTick('crawl', 'skip', message);
      } else {
        log.error('system', 'scheduler_crawl_failed', { error: message });
        updateRuntime({ message: `crawl 执行失败：${message}` });
        emitTick('crawl', 'error', message);
      }
    } finally {
      releaseCrawlerScope('feed', 'scheduler');
      resetCrawlerScopeStatus('feed');
      slot.running = false;
      if (getRuntime().runId !== scheduledRunId) {
        return;
      }
      updateRuntime({
        currentTask: null,
        message: '自动化等待下次执行',
      });
      if (getRuntime().enabled) {
        scheduleCrawlTask(getSchedulerConfig().crawlInterval);
      }
    }
  }, delayMs);

  slot.timer.unref?.();
}

function resetChannelBackoff(channelId: number) {
  getDb()
    .prepare(
      `
    UPDATE channels
    SET crawl_error_count = 0,
        crawl_backoff_until = NULL
    WHERE id = ?
  `,
    )
    .run(channelId);
}

function getVideoDbId(videoId: string, platform: string): number | null {
  const row = getDb()
    .prepare('SELECT id FROM videos WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as { id: number } | undefined;
  return row?.id ?? null;
}

function markChannelBackoff(channel: Channel, errorMessage: string) {
  const nextCount = (channel.crawl_error_count || 0) + 1;
  const delayMs = Math.min(
    CRAWL_BACKOFF_BASE_MS * 2 ** Math.max(0, nextCount - 1),
    CRAWL_BACKOFF_MAX_MS,
  );
  const backoffUntil = new Date(Date.now() + delayMs).toISOString();

  getDb()
    .prepare(
      `
    UPDATE channels
    SET crawl_error_count = ?,
        crawl_backoff_until = ?
    WHERE id = ?
  `,
    )
    .run(nextCount, backoffUntil, channel.id);

  log.warn(
    'system',
    'scheduler_crawl_backoff',
    {
      channel: channel.name || channel.channel_id,
      count: nextCount,
      until: backoffUntil,
      error: errorMessage,
    },
  );
}

export function insertOrUpdateVideos(
  channel: Channel,
  videos: Awaited<ReturnType<typeof fetchYouTubeFeed>>,
  options: {
    emitEvents?: boolean;
    emitDiscoveredEvent?: boolean;
    eventPriority?: number;
  } = {},
) {
  const emitEvents = options.emitEvents ?? true;
  const emitDiscoveredEvent = options.emitDiscoveredEvent ?? emitEvents;
  const eventPriority = options.eventPriority === 0 ? 0 : 1;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO videos (channel_id, platform, video_id, title, thumbnail_url, published_at, duration, is_members_only, access_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const enrich = db.prepare(`
    UPDATE videos
    SET
      title = CASE WHEN ? <> '' THEN ? ELSE title END,
      thumbnail_url = CASE WHEN ? <> '' THEN ? ELSE thumbnail_url END,
      published_at = CASE WHEN ? <> '' THEN ? ELSE published_at END,
      duration = CASE WHEN ? <> '' THEN ? ELSE duration END,
      is_members_only = CASE WHEN ? IS NOT NULL THEN ? ELSE is_members_only END,
      access_status = CASE WHEN ? IS NOT NULL THEN ? ELSE access_status END
    WHERE video_id = ?
  `);

  let added = 0;
  for (const video of videos) {
    const result = insert.run(
      channel.id,
      video.platform,
      video.video_id,
      video.title,
      video.thumbnail_url,
      video.published_at || null,
      video.duration || null,
      video.is_members_only ?? 0,
      video.access_status ?? null,
    );
    if (result.changes > 0) {
      added += 1;
      if (emitDiscoveredEvent) {
        appEvents.emit('video:discovered', {
          videoId: video.video_id,
          platform: video.platform,
          channelId: channel.channel_id,
          channelName: channel.name || channel.channel_id,
          priority: eventPriority,
          at: nowIso(),
        });
      }

      if (emitEvents) {
        // Emit video:new-skeleton for SSE real-time push to frontend
        const videoDbId = getVideoDbId(video.video_id, video.platform);
        if (videoDbId !== null) {
          appEvents.emit('video:new-skeleton', {
            id: videoDbId,
            video_id: video.video_id,
            platform: video.platform,
            title: video.title || '',
            thumbnail_url: video.thumbnail_url || null,
            published_at: video.published_at || null,
            duration: video.duration || null,
            channel_name: channel.name || channel.channel_id,
            avatar_url: channel.avatar_url || null,
            channel_id: channel.channel_id,
            intent: channel.intent || '未分类',
            is_read: 0,
            is_members_only: video.is_members_only ?? 0,
            access_status: video.access_status ?? null,
            subtitle_status: null,
            summary_status: null,
            automation_tags: null,
          });
        }
      }
    }

    const title = video.title || '';
    const duration = video.duration || '';
    const thumbnail = video.thumbnail_url || '';
    const publishedAt = video.published_at || '';
    const isMembersOnly = video.is_members_only ?? null;
    const accessStatus = video.access_status ?? null;
    enrich.run(
      title,
      title,
      thumbnail,
      thumbnail,
      publishedAt,
      publishedAt,
      duration,
      duration,
      isMembersOnly,
      isMembersOnly,
      accessStatus,
      accessStatus,
      video.video_id,
    );
  }

  return added;
}

// ---------------------------------------------------------------------------
// Feed-crawl pool executor
// ---------------------------------------------------------------------------

/**
 * Executor function for feed crawl jobs in the async pool.
 * Handles a single channel crawl.
 */
async function runFeedCrawlJob(job: FeedCrawlJob): Promise<JobResult> {
  const startTime = Date.now();
  const { channel, runId, index, total } = job;

  try {
    const resumed = await waitIfCrawlerPaused(
      () => {
        updateCrawlerScopeStatus('feed', {
          state: 'running',
          platform: channel.platform,
          targetId: channel.channel_id,
          targetLabel: channel.name || channel.channel_id,
          message: `已暂停，等待继续 ${channel.name || channel.channel_id}`,
          progress: index + 1,
          total,
        });
      },
      () => isTaskRunCancelled(runId),
    );
    if (!resumed) {
      throw new SchedulerAbortError('scheduler crawl stopped while paused');
    }
    assertTaskRunActive(runId, 'crawl');

    const throttle = index === 0 ? null : await throttleCrawlerStage('feed');
    assertTaskRunActive(runId, 'crawl');
    const preferredMethod =
      getPreferredCrawlMethod(channel.platform) || BROWSER_METHOD_ID;
    updateCrawlerScopeStatus('feed', {
      state: 'running',
      platform: channel.platform,
      preferredMethod,
      activeMethod: preferredMethod,
      isFallback: false,
      targetId: channel.channel_id,
      targetLabel: channel.name || channel.channel_id,
      message: throttle
        ? `自动爬取 ${channel.name || channel.channel_id} · ${getCrawlerPerformanceSummary(throttle)}`
        : `自动爬取 ${channel.name || channel.channel_id}`,
      progress: index + 1,
      total,
    });

    assertTaskRunActive(runId, 'crawl');
    const videos =
      channel.platform === 'youtube'
        ? await fetchYouTubeFeed(channel.channel_id, channel.name ?? undefined)
        : await fetchBilibiliFeed(
            channel.channel_id,
            channel.name ?? undefined,
          );
    assertTaskRunActive(runId, 'crawl');
    insertOrUpdateVideos(channel, videos);
    const refreshedAt = nowIso();
    recordChannelRefresh(channel.id, refreshedAt);
    recordIntentRefresh(channel.intent, refreshedAt);
    resetChannelBackoff(channel.id);
    appEvents.emit('crawl:auto-refresh', {
      channelId: channel.channel_id,
      platform: channel.platform,
      at: nowIso(),
    });

    return { success: true, durationMs: Date.now() - startTime };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof SchedulerAbortError) {
      throw error;
    }

    updateCrawlerScopeStatus('feed', {
      state: 'error',
      platform: channel.platform,
      targetId: channel.channel_id,
      targetLabel: channel.name || channel.channel_id,
      message,
    });
    markChannelBackoff(channel, message);

    return {
      success: false,
      durationMs: Date.now() - startTime,
      error: message,
    };
  }
}

/**
 * Gets the feed-crawl pool instance (for testing and status).
 */
export function getFeedCrawlPool(): AsyncPool<FeedCrawlJob> {
  return getOrCreatePool<FeedCrawlJob>(
    FEED_CRAWL_POOL_CONFIG.name,
    FEED_CRAWL_POOL_CONFIG,
  );
}

// ---------------------------------------------------------------------------
// Crawl tick
// ---------------------------------------------------------------------------

async function executeCrawlTick(runId: number) {
  const db = getDb();
  const channels = db
    .prepare(
      `
    SELECT *
    FROM channels
    WHERE crawl_backoff_until IS NULL OR crawl_backoff_until <= ?
    ORDER BY created_at ASC
  `,
    )
    .all(nowIso()) as Channel[];

  log.info(
    'system',
    'scheduler_crawl_tick_start',
    { channels: channels.length },
  );

  if (channels.length === 0) {
    updateRuntime({ message: '自动化爬取暂无可执行频道' });
    return;
  }

  // Dispatch each channel crawl as a pool job
  const pool = getFeedCrawlPool();

  for (let index = 0; index < channels.length; index += 1) {
    assertTaskRunActive(runId, 'crawl');
    const channel = channels[index];

    const job: FeedCrawlJob = {
      channel,
      runId,
      index,
      total: channels.length,
    };

    // Dispatch to pool with priority 1 (auto)
    pool.enqueue(job, 1, runFeedCrawlJob).catch((err) => {
      if (err instanceof SchedulerAbortError) {
        return;
      }

      log.error('system', 'feed_crawl_dispatch_error', { error: String(err) });
      markChannelBackoff(channel, String(err));
    });
  }

  // Wait for all pool jobs to complete by draining
  // Note: With concurrency=1 initially, this is effectively serial
  await pool.drain();
}

function clearAllTimers() {
  clearCrawlTimer();
}

function scheduleAllFromConfig() {
  scheduleCrawlTask(getSchedulerConfig().crawlInterval);
}

export function stopScheduler(opts: { persist?: boolean } = {}) {
  clearAllTimers();
  getRuntime().runId += 1;
  updateRuntime({
    enabled: false,
    currentTask: null,
    message: '自动化已关闭',
  });

  if (opts.persist !== false) {
    const config = getSchedulerConfig();
    persistSchedulerConfig({ ...config, enabled: false });
  }

  emitLifecycle('scheduler:stop', false);
}

export function startScheduler(configOverride?: Partial<SchedulerConfig>) {
  if (isServerlessRuntime()) {
    stopScheduler({ persist: true });
    updateRuntime({
      enabled: false,
      currentTask: null,
      message: '检测到 serverless 运行环境，已禁用自动化调度器',
    });
    log.warn(
      'system',
      'scheduler_disabled',
      { reason: 'serverless-runtime-detected' },
    );
    return getSchedulerSnapshot();
  }

  const current = getSchedulerConfig();
  const nextConfig: SchedulerConfig = {
    ...current,
    ...configOverride,
    enabled: true,
  };
  persistSchedulerConfig(nextConfig);
  clearAllTimers();
  getRuntime().runId += 1;
  updateRuntime({
    enabled: true,
    currentTask: null,
    message: '自动化等待下次执行',
  });
  scheduleAllFromConfig();
  emitLifecycle('scheduler:start', true);
  return getSchedulerSnapshot();
}

export function updateSchedulerConfig(
  next: Partial<Omit<SchedulerConfig, 'enabled'>>,
) {
  const current = getSchedulerConfig();
  const merged: SchedulerConfig = {
    ...current,
    ...next,
  };
  persistSchedulerConfig(merged);

  if (getRuntime().enabled) {
    clearAllTimers();
    scheduleAllFromConfig();
    updateRuntime({ message: '自动化设置已更新，等待下次执行' });
  }

  return getSchedulerSnapshot();
}

function cleanupObsoleteSettings() {
  const db = getDb();
  for (const key of OBSOLETE_KEYS) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
}

export function ensureSchedulerAndPipeline() {
  // Dynamically import to avoid circular dependency at module load time
  import('./auto-pipeline').then(({ ensureAutoPipeline }) => {
    ensureAutoPipeline();
  });
  import('./intent-agent-runner').then(({ ensureIntentAgentRunner }) => {
    ensureIntentAgentRunner();
  });

  cleanupObsoleteSettings();

  const runtime = getRuntime();
  if (runtime.initialized) {
    return getSchedulerSnapshot();
  }

  runtime.initialized = true;
  const config = getSchedulerConfig();
  if (config.enabled) {
    return startScheduler(config);
  }

  updateRuntime({
    enabled: false,
    currentTask: null,
    message: '自动化已关闭',
  });
  return getSchedulerSnapshot();
}

// Backwards compatibility alias
export const ensureScheduler = ensureSchedulerAndPipeline;
