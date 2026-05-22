import fs from 'fs';
import path from 'path';
import { getDb, type SummaryTask, type Video } from './db';
import { getPositiveIntAppSetting } from './app-settings';
import type { SummaryTaskStats } from '@/types';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const SUMMARY_ROOT =
  process.env.SUMMARY_ROOT || path.join(DATA_ROOT, 'summaries');
const STALE_SUMMARY_PROCESSING_MS = 10 * 60 * 1000;
const SUMMARY_RETRY_MAX_ATTEMPTS_KEY = 'summary_retry_max_attempts';
const SUMMARY_RETRY_BASE_SECONDS_KEY = 'summary_retry_base_seconds';
const DEFAULT_SUMMARY_RETRY_MAX_ATTEMPTS = 5;
const DEFAULT_SUMMARY_RETRY_BASE_SECONDS = 2 * 60;
const MAX_SUMMARY_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

let summaryTaskRetryColumnsEnsured = false;

function getSummaryTasksDb() {
  const db = getDb();
  if (summaryTaskRetryColumnsEnsured) {
    return db;
  }

  const columns = (
    db.prepare('PRAGMA table_info(summary_tasks)').all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);

  if (!columns.includes('retry_count')) {
    db.exec(
      'ALTER TABLE summary_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!columns.includes('retry_after')) {
    db.exec('ALTER TABLE summary_tasks ADD COLUMN retry_after DATETIME');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_summary_tasks_retry ON summary_tasks(status, retry_after)',
  );

  summaryTaskRetryColumnsEnsured = true;
  return db;
}

function getStaleSummaryProcessingCutoff(now = Date.now()): string {
  return new Date(now - STALE_SUMMARY_PROCESSING_MS).toISOString();
}

function getSummaryRetryMaxAttempts(): number {
  return getPositiveIntAppSetting(
    SUMMARY_RETRY_MAX_ATTEMPTS_KEY,
    DEFAULT_SUMMARY_RETRY_MAX_ATTEMPTS,
  );
}

function getSummaryRetryDelayMs(retryCount: number): number {
  const baseSeconds = getPositiveIntAppSetting(
    SUMMARY_RETRY_BASE_SECONDS_KEY,
    DEFAULT_SUMMARY_RETRY_BASE_SECONDS,
  );
  const multiplier = 2 ** Math.max(0, retryCount - 1);
  return Math.min(baseSeconds * multiplier * 1000, MAX_SUMMARY_RETRY_DELAY_MS);
}

function getSummaryRetryAfter(retryCount: number, now = Date.now()): string {
  return new Date(now + getSummaryRetryDelayMs(retryCount)).toISOString();
}

export function createSummaryTask(
  videoId: string,
  platform: Video['platform'],
): SummaryTask | null {
  const db = getSummaryTasksDb();

  // Insert or ignore (idempotent)
  db.prepare(
    `
    INSERT OR IGNORE INTO summary_tasks (video_id, platform, status)
    VALUES (?, ?, 'pending')
  `,
  ).run(videoId, platform);

  return db
    .prepare('SELECT * FROM summary_tasks WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as SummaryTask | null;
}

export function claimSummaryTaskProcessing(
  videoId: string,
  platform: Video['platform'],
  method: SummaryTask['method'] = 'api',
): SummaryTask | null {
  const db = getSummaryTasksDb();
  const now = new Date().toISOString();
  const staleCutoff = getStaleSummaryProcessingCutoff();

  const transaction = db.transaction(() => {
    db.prepare(
      `
      INSERT OR IGNORE INTO summary_tasks (video_id, platform, status)
      VALUES (?, ?, 'pending')
    `,
    ).run(videoId, platform);

    const result = db
      .prepare(
        `
      UPDATE summary_tasks
      SET status = 'processing',
          method = ?,
          started_at = ?,
          completed_at = NULL,
          error = NULL,
          retry_after = NULL
      WHERE video_id = ?
        AND platform = ?
        AND (
          status != 'processing'
          OR started_at IS NULL
          OR started_at < ?
        )
    `,
      )
      .run(method, now, videoId, platform, staleCutoff);

    if (result.changes === 0) {
      return null;
    }

    return db
      .prepare(
        'SELECT * FROM summary_tasks WHERE video_id = ? AND platform = ?',
      )
      .get(videoId, platform) as SummaryTask | null;
  });

  return transaction();
}

export function requeueStaleSummaryTasks(): number {
  const db = getSummaryTasksDb();
  const staleCutoff = getStaleSummaryProcessingCutoff();

  const result = db
    .prepare(
      `
      UPDATE summary_tasks
      SET status = 'pending',
          method = NULL,
          started_at = NULL,
          completed_at = NULL,
          error = NULL,
          retry_after = NULL
      WHERE status = 'processing'
        AND (started_at IS NULL OR started_at < ?)
    `,
    )
    .run(staleCutoff);

  return result.changes;
}

export function requeueRetryableFailedSummaryTasks(
  limit = 25,
  now = new Date(),
): number {
  const db = getSummaryTasksDb();
  const maxAttempts = getSummaryRetryMaxAttempts();
  const rows = db
    .prepare(
      `
      SELECT id
      FROM summary_tasks
      WHERE status = 'failed'
        AND COALESCE(retry_count, 0) <= ?
        AND (retry_after IS NULL OR retry_after <= ?)
      ORDER BY COALESCE(retry_after, completed_at, created_at) ASC
      LIMIT ?
    `,
    )
    .all(
      maxAttempts,
      now.toISOString(),
      Math.max(1, Math.floor(limit)),
    ) as Array<{
    id: number;
  }>;

  if (rows.length === 0) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const result = db
    .prepare(
      `
      UPDATE summary_tasks
      SET status = 'pending',
          method = NULL,
          started_at = NULL,
          completed_at = NULL,
          error = NULL,
          retry_after = NULL
      WHERE id IN (${placeholders})
    `,
    )
    .run(...ids);

  return result.changes;
}

export function getSummaryTask(
  videoId: string,
  platform: Video['platform'],
): SummaryTask | null {
  const db = getSummaryTasksDb();
  return db
    .prepare('SELECT * FROM summary_tasks WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as SummaryTask | null;
}

export function getSummaryTaskByVideoDbId(
  videoDbId: number,
): SummaryTask | null {
  const db = getSummaryTasksDb();
  const video = db
    .prepare('SELECT video_id, platform FROM videos WHERE id = ?')
    .get(videoDbId) as Pick<Video, 'video_id' | 'platform'> | undefined;
  if (!video) return null;
  return getSummaryTask(video.video_id, video.platform);
}

export function getSummaryTaskStats(): SummaryTaskStats {
  const db = getSummaryTasksDb();
  const rows = db
    .prepare(
      `
    SELECT status, COUNT(*) as count FROM summary_tasks GROUP BY status
  `,
    )
    .all() as Array<{ status: string; count: number }>;

  const stats: SummaryTaskStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof SummaryTaskStats] = row.count;
    }
  }
  return stats;
}

export function listSummaryTasks(opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}): SummaryTask[] {
  const db = getSummaryTasksDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;

  return db
    .prepare(
      `
    SELECT * FROM summary_tasks ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset) as SummaryTask[];
}

export function updateTaskStatus(
  videoId: string,
  platform: string,
  status: SummaryTask['status'],
  opts?: { method?: SummaryTask['method']; error?: string },
): void {
  const db = getSummaryTasksDb();
  const now = new Date().toISOString();

  if (status === 'processing') {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?,
          method = ?,
          started_at = ?,
          completed_at = NULL,
          error = NULL,
          retry_after = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, opts?.method || null, now, videoId, platform);
  } else if (status === 'completed') {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?,
          method = COALESCE(?, method),
          completed_at = ?,
          error = NULL,
          retry_count = 0,
          retry_after = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, opts?.method || null, now, videoId, platform);
  } else if (status === 'skipped') {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, error = ?, completed_at = ?, method = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, opts?.error || null, now, videoId, platform);
  } else if (status === 'failed') {
    const current = db
      .prepare(
        'SELECT retry_count FROM summary_tasks WHERE video_id = ? AND platform = ?',
      )
      .get(videoId, platform) as Pick<SummaryTask, 'retry_count'> | undefined;
    const retryCount = (current?.retry_count || 0) + 1;
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, error = ?, completed_at = ?, retry_count = ?, retry_after = ?
      WHERE video_id = ? AND platform = ?
    `,
    ).run(
      status,
      opts?.error || null,
      now,
      retryCount,
      getSummaryRetryAfter(retryCount),
      videoId,
      platform,
    );
  } else {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, error = NULL, started_at = NULL, completed_at = NULL, method = NULL, retry_after = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, videoId, platform);
  }
}

export function resetFailedTask(videoId: string, platform: string): void {
  updateTaskStatus(videoId, platform, 'pending');
}

export function syncExternalCompletions(): number {
  const db = getSummaryTasksDb();
  const pendingTasks = db
    .prepare(
      `
    SELECT * FROM summary_tasks
    WHERE status IN ('pending', 'processing')
  `,
    )
    .all() as SummaryTask[];

  let synced = 0;
  for (const task of pendingTasks) {
    const summaryPath = path.join(
      SUMMARY_ROOT,
      task.platform,
      `${task.video_id}.md`,
    );
    if (fs.existsSync(summaryPath) && fs.statSync(summaryPath).size > 100) {
      updateTaskStatus(task.video_id, task.platform, 'completed', {
        method: 'external',
      });
      synced++;
    }
  }
  return synced;
}
