import fs from 'fs';
import path from 'path';
import { getDb, type SummaryTask, type Video } from './db';
import type { SummaryTaskStats } from '@/types';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const SUMMARY_ROOT =
  process.env.SUMMARY_ROOT || path.join(DATA_ROOT, 'summaries');
const STALE_SUMMARY_PROCESSING_MS = 10 * 60 * 1000;

function getStaleSummaryProcessingCutoff(now = Date.now()): string {
  return new Date(now - STALE_SUMMARY_PROCESSING_MS).toISOString();
}

export function createSummaryTask(
  videoId: string,
  platform: Video['platform'],
): SummaryTask | null {
  const db = getDb();

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
  const db = getDb();
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
          error = NULL
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
  const db = getDb();
  const staleCutoff = getStaleSummaryProcessingCutoff();

  const result = db
    .prepare(
      `
      UPDATE summary_tasks
      SET status = 'pending',
          method = NULL,
          started_at = NULL,
          completed_at = NULL,
          error = NULL
      WHERE status = 'processing'
        AND (started_at IS NULL OR started_at < ?)
    `,
    )
    .run(staleCutoff);

  return result.changes;
}

export function getSummaryTask(
  videoId: string,
  platform: Video['platform'],
): SummaryTask | null {
  const db = getDb();
  return db
    .prepare('SELECT * FROM summary_tasks WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as SummaryTask | null;
}

export function getSummaryTaskByVideoDbId(
  videoDbId: number,
): SummaryTask | null {
  const db = getDb();
  const video = db
    .prepare('SELECT video_id, platform FROM videos WHERE id = ?')
    .get(videoDbId) as Pick<Video, 'video_id' | 'platform'> | undefined;
  if (!video) return null;
  return getSummaryTask(video.video_id, video.platform);
}

export function getSummaryTaskStats(): SummaryTaskStats {
  const db = getDb();
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
  const db = getDb();
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
  const db = getDb();
  const now = new Date().toISOString();

  if (status === 'processing') {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, method = ?, started_at = ?, completed_at = NULL, error = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, opts?.method || null, now, videoId, platform);
  } else if (status === 'completed') {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, method = COALESCE(?, method), completed_at = ?, error = NULL
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
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, error = ?, completed_at = ?
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, opts?.error || null, now, videoId, platform);
  } else {
    db.prepare(
      `
      UPDATE summary_tasks
      SET status = ?, error = NULL, started_at = NULL, completed_at = NULL, method = NULL
      WHERE video_id = ? AND platform = ?
    `,
    ).run(status, videoId, platform);
  }
}

export function resetFailedTask(videoId: string, platform: string): void {
  updateTaskStatus(videoId, platform, 'pending');
}

export function syncExternalCompletions(): number {
  const db = getDb();
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
