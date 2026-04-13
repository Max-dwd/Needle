import { getDb, type SummaryTask } from './db';
import {
  claimSummaryTaskProcessing,
  requeueStaleSummaryTasks,
  updateTaskStatus,
} from './summary-tasks';
import { generateSummaryViaApi, hasSubtitleData } from './ai-summary-client';
import { appEvents } from './events';
import { log } from './logger';
import { getOrCreatePool, type AsyncPool, type JobResult } from './async-pool';

// ---------------------------------------------------------------------------
// Summary pool configuration (per spec section 5.8)
// ---------------------------------------------------------------------------

const SUMMARY_POOL_CONFIG = {
  name: 'summary' as const,
  initialConcurrency: 1,
  minConcurrency: 1,
  maxConcurrency: 2,
  adjustIntervalMs: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SummaryJob {
  videoId: string;
  platform: 'youtube' | 'bilibili';
  taskId: number;
  intentName: string | null;
}

export interface SummaryQueueState {
  running: boolean;
  stopRequested: boolean;
  processed: number;
  total: number;
  currentVideoId: string | null;
  currentTitle: string | null;
  startedAt: string | null;
}

interface PendingSummaryTask extends SummaryTask {
  title: string | null;
  intentName: string | null;
}

interface SummaryQueueTracking {
  queuedTaskIds: Set<number>;
  activeTaskIds: Set<number>;
}

const queueState: SummaryQueueState = {
  running: false,
  stopRequested: false,
  processed: 0,
  total: 0,
  currentVideoId: null,
  currentTitle: null,
  startedAt: null,
};

const tracking: SummaryQueueTracking = {
  queuedTaskIds: new Set<number>(),
  activeTaskIds: new Set<number>(),
};

function getActiveSummaryTaskSnapshot(): {
  videoId: string;
  title: string | null;
  startedAt: string | null;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT st.video_id AS videoId,
             st.started_at AS startedAt,
             v.title AS title
      FROM summary_tasks st
      LEFT JOIN videos v
        ON v.video_id = st.video_id
       AND v.platform = st.platform
      WHERE st.status = 'processing'
      ORDER BY COALESCE(st.started_at, st.created_at) DESC
      LIMIT 1
    `,
    )
    .get() as
    | {
        videoId: string;
        title: string | null;
        startedAt: string | null;
      }
    | undefined;

  return row ?? null;
}

export function getQueueState(): SummaryQueueState {
  const activeTask =
    queueState.currentVideoId || queueState.currentTitle
      ? null
      : getActiveSummaryTaskSnapshot();

  return {
    ...queueState,
    running: queueState.running || Boolean(activeTask),
    currentVideoId: queueState.currentVideoId ?? activeTask?.videoId ?? null,
    currentTitle: queueState.currentTitle ?? activeTask?.title ?? null,
    startedAt: queueState.startedAt ?? activeTask?.startedAt ?? null,
  };
}

export function isQueueRunning(): boolean {
  return queueState.running;
}

export function requestQueueStop(): void {
  queueState.stopRequested = true;
  log.warn('summary', 'stop', { source: 'queue', reason: 'user-request' });
}

export function clearSummaryQueue(): { clearedPending: number; clearedQueued: number } {
  const db = getDb();
  const pool = getSummaryPool();

  queueState.stopRequested = true;

  const queuedTaskIds = new Set(tracking.queuedTaskIds);
  const clearedQueued = pool.clearQueued(
    (job) => queuedTaskIds.has(job.taskId),
    'summary queue cleared',
  );

  if (clearedQueued > 0) {
    const placeholders = Array.from(queuedTaskIds)
      .map(() => '?')
      .join(', ');
    if (placeholders) {
      db.prepare(
        `UPDATE summary_tasks
         SET status = 'skipped',
             error = 'queue cleared',
             completed_at = ?,
             method = NULL
         WHERE id IN (${placeholders})`,
      ).run(new Date().toISOString(), ...Array.from(queuedTaskIds));
    }
    tracking.queuedTaskIds.clear();
  }

  const pendingResult = db
    .prepare(
      `UPDATE summary_tasks
       SET status = 'skipped',
           error = 'queue cleared',
           completed_at = ?,
           method = NULL
       WHERE status = 'pending'`,
    )
    .run(new Date().toISOString());

  queueState.total = tracking.activeTaskIds.size;

  log.warn(
    'summary',
    'clear',
    {
      source: 'queue',
      pending: pendingResult.changes,
      queued: clearedQueued,
    },
  );

  return {
    clearedPending: pendingResult.changes,
    clearedQueued,
  };
}

// ---------------------------------------------------------------------------
// Summary pool executor
// ---------------------------------------------------------------------------

/**
 * Executor function for summary jobs in the async pool.
 */
async function runSummaryJob(job: SummaryJob): Promise<JobResult> {
  const startTime = Date.now();
  tracking.queuedTaskIds.delete(job.taskId);
  tracking.activeTaskIds.add(job.taskId);

  try {
    log.info(
      'summary',
      'start',
      {
        source: 'pool',
        platform: job.platform,
        method: 'api',
        target: job.videoId,
      },
    );
    appEvents.emit('summary:start', {
      videoId: job.videoId,
      platform: job.platform,
      taskId: job.taskId,
    });

    if (!hasSubtitleData(job.videoId, job.platform)) {
      updateTaskStatus(job.videoId, job.platform, 'failed', {
        error: 'no subtitle',
      });
      log.error(
        'summary',
        'failure',
        {
          source: 'pool',
          platform: job.platform,
          method: 'api',
          target: job.videoId,
          error: 'no subtitle',
        },
      );
      appEvents.emit('summary:error', {
        videoId: job.videoId,
        error: 'no subtitle',
        taskId: job.taskId,
      });
      return { success: true, durationMs: Date.now() - startTime }; // Not a pool failure
    }

    const result = await generateSummaryViaApi(job.videoId, job.platform, {
      triggerSource: 'auto',
      intentName: job.intentName,
    });
    updateTaskStatus(job.videoId, job.platform, 'completed', {
      method: 'api',
    });
    log.info(
      'summary',
      'success',
      {
        source: 'pool',
        platform: job.platform,
        method: 'api',
        target: job.videoId,
        chars: result.markdown.length,
      },
    );
    appEvents.emit('summary:complete', {
      videoId: job.videoId,
      platform: job.platform,
      preview: result.markdown.slice(0, 200),
    });
    return { success: true, durationMs: Date.now() - startTime };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTaskStatus(job.videoId, job.platform, 'failed', {
      error: message,
    });
    log.error(
      'summary',
      'failure',
      {
        source: 'pool',
        platform: job.platform,
        method: 'api',
        target: job.videoId,
        error: message,
      },
    );
    appEvents.emit('summary:error', {
      videoId: job.videoId,
      error: message,
      taskId: job.taskId,
    });
    return { success: false, durationMs: Date.now() - startTime, error: message };
  } finally {
    tracking.activeTaskIds.delete(job.taskId);
  }
}

/**
 * Gets the summary pool instance (for testing and status).
 */
export function getSummaryPool(): AsyncPool<SummaryJob> {
  return getOrCreatePool<SummaryJob>(SUMMARY_POOL_CONFIG.name, SUMMARY_POOL_CONFIG);
}

// ---------------------------------------------------------------------------
// Queue processing
// ---------------------------------------------------------------------------

async function runQueueLoop(): Promise<void> {
  const pool = getSummaryPool();

  try {
    const db = getDb();
    const reclaimed = requeueStaleSummaryTasks();
    if (reclaimed > 0) {
      log.warn('summary', 'requeue_stale', {
        source: 'queue',
        count: reclaimed,
      });
    }
    const tasks = db
      .prepare(
        `
      SELECT st.*, v.title, c.intent as intentName
      FROM summary_tasks st
      LEFT JOIN videos v ON v.video_id = st.video_id AND v.platform = st.platform
      LEFT JOIN channels c ON c.id = v.channel_id
      WHERE st.status = 'pending'
      ORDER BY st.created_at ASC
    `,
      )
      .all() as PendingSummaryTask[];

    queueState.total = tasks.length;
    log.info('summary', 'start', { source: 'queue', total: tasks.length });

    for (const task of tasks) {
      if (queueState.stopRequested) {
        log.warn(
          'summary',
          'stop',
          {
            source: 'queue',
            processed: queueState.processed,
            total: queueState.total,
          },
        );
        break;
      }

      queueState.currentVideoId = task.video_id;
      queueState.currentTitle = task.title;

      // Claim the task (to prevent duplicate processing by other calls)
      const claimed = claimSummaryTaskProcessing(
        task.video_id,
        task.platform,
        'api',
      );
      if (!claimed) {
        log.warn(
          'summary',
          'skip',
          {
            source: 'queue',
            platform: task.platform,
            target: task.video_id,
            reason: 'already-processing',
          },
        );
        queueState.processed += 1;
        continue;
      }

      // Dispatch to pool for processing (pool handles concurrency)
      const job: SummaryJob = {
        videoId: task.video_id,
        platform: task.platform as 'youtube' | 'bilibili',
        taskId: claimed.id,
        intentName: task.intentName,
      };

      // Dispatch to pool with priority 1 (auto)
      tracking.queuedTaskIds.add(job.taskId);
      pool.enqueue(job, 1, runSummaryJob).catch((err) => {
        tracking.queuedTaskIds.delete(job.taskId);
        tracking.activeTaskIds.delete(job.taskId);
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'summary queue cleared') {
          updateTaskStatus(job.videoId, job.platform, 'skipped', {
            error: 'queue cleared',
          });
          return;
        }
        log.error('summary', 'dispatch_error', {
          source: 'pool',
          platform: job.platform,
          target: job.videoId,
          error: message,
        });
        updateTaskStatus(job.videoId, job.platform, 'failed', {
          error: `pool dispatch error: ${message}`,
        });
      });

      queueState.processed += 1;

      // Small delay between dispatches to avoid overwhelming the pool queue
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    // Wait for all dispatched pool jobs to complete before marking idle
    await pool.drain();
  } finally {
    log.info(
      'summary',
      'complete',
      {
        source: 'queue',
        processed: queueState.processed,
        total: queueState.total,
        stop_requested: queueState.stopRequested,
      },
    );
    queueState.running = false;
    queueState.currentVideoId = null;
    queueState.currentTitle = null;
    tracking.queuedTaskIds.clear();
    tracking.activeTaskIds.clear();
  }
}

export function startQueueProcessing(): boolean {
  if (queueState.running) {
    return false;
  }

  queueState.running = true;
  queueState.stopRequested = false;
  queueState.processed = 0;
  queueState.total = 0;
  queueState.currentVideoId = null;
  queueState.currentTitle = null;
  queueState.startedAt = new Date().toISOString();

  void runQueueLoop();
  return true;
}
