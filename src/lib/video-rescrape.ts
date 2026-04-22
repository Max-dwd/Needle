import fs from 'fs/promises';
import path from 'path';
import { getDb } from './db';
import { appEvents } from './events';
import { log } from './logger';
import {
  acquireRescrapeLock,
  enrichVideo,
  releaseRescrapeLock,
} from './enrichment-queue';

type RescrapePlatform = 'youtube' | 'bilibili';

interface RescrapeVideoRow {
  id: number;
  video_id: string;
  platform: RescrapePlatform;
  channel_id: number;
  channel_platform_id: string;
  channel_name: string | null;
}

export type RescrapeVideoResult =
  | {
      ok: true;
      videoId: string;
      platform: RescrapePlatform;
    }
  | {
      ok: false;
      reason: 'not_found' | 'in_progress';
    };

function getDataRoot(): string {
  return process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
}

function getSubtitleRoot(): string {
  return process.env.SUBTITLE_ROOT || path.join(getDataRoot(), 'subtitles');
}

function getSummaryRoot(): string {
  return process.env.SUMMARY_ROOT || path.join(getDataRoot(), 'summaries');
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function clearSubtitleFiles(
  platform: RescrapePlatform,
  videoId: string,
): Promise<void> {
  const platformDir = path.join(getSubtitleRoot(), platform);
  await Promise.all([
    removePath(path.join(platformDir, videoId)),
    removePath(path.join(platformDir, `${videoId}.json`)),
  ]);
}

async function clearSummaryFiles(
  platform: RescrapePlatform,
  videoId: string,
): Promise<void> {
  const platformDir = path.join(getSummaryRoot(), platform);
  let entries: string[];
  try {
    entries = await fs.readdir(platformDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }

  const targets = entries.filter(
    (entry) =>
      entry === `${videoId}.md` ||
      entry === `${videoId}.json` ||
      (entry.startsWith(`${videoId}.`) &&
        (entry.endsWith('.md') || entry.endsWith('.json'))),
  );

  await Promise.all(
    targets.map((entry) => removePath(path.join(platformDir, entry))),
  );
}

async function clearDiskAssets(row: RescrapeVideoRow): Promise<void> {
  await Promise.all([
    clearSubtitleFiles(row.platform, row.video_id),
    clearSummaryFiles(row.platform, row.video_id),
  ]);
}

function getVideoRow(videoDbId: number): RescrapeVideoRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT
        v.id,
        v.video_id,
        v.platform,
        v.channel_id,
        c.channel_id AS channel_platform_id,
        c.name AS channel_name
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      WHERE v.id = ?
      LIMIT 1
    `,
    )
    .get(videoDbId) as RescrapeVideoRow | undefined;
  return row ?? null;
}

function clearDatabaseState(row: RescrapeVideoRow): void {
  const db = getDb();
  const clear = db.transaction(() => {
    db.prepare(
      `
      UPDATE videos SET
        title = NULL,
        thumbnail_url = NULL,
        published_at = NULL,
        duration = NULL,
        channel_name = NULL,
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
      WHERE id = ?
    `,
    ).run(row.id);

    db.prepare(
      'DELETE FROM summary_tasks WHERE video_id = ? AND platform = ?',
    ).run(row.video_id, row.platform);
  });

  clear();
}

function emitResetEvents(row: RescrapeVideoRow): void {
  appEvents.emit('video:availability-changed', {
    videoDbId: row.id,
    videoId: row.video_id,
    platform: row.platform,
    status: null,
    reason: null,
  });

  appEvents.emit('video:discovered', {
    videoId: row.video_id,
    platform: row.platform,
    channelId: row.channel_platform_id,
    channelName: row.channel_name || row.channel_platform_id,
    priority: 0,
    at: new Date().toISOString(),
  });
}

export async function rescrapeVideo(
  videoDbId: number,
): Promise<RescrapeVideoResult> {
  const row = getVideoRow(videoDbId);
  if (!row) {
    return { ok: false, reason: 'not_found' };
  }

  if (!acquireRescrapeLock(videoDbId)) {
    return { ok: false, reason: 'in_progress' };
  }

  let lockReleased = false;
  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    releaseRescrapeLock(videoDbId);
  };

  log.info('enrichment', 'rescrape_started', {
    videoDbId,
    videoId: row.video_id,
    platform: row.platform,
    channel_id: row.channel_platform_id,
  });

  try {
    try {
      await clearDiskAssets(row);
      log.info('enrichment', 'rescrape_disk_cleared', {
        videoDbId,
        videoId: row.video_id,
        platform: row.platform,
      });
    } catch (error) {
      log.warn('enrichment', 'rescrape_disk_clear_failed', {
        videoDbId,
        videoId: row.video_id,
        platform: row.platform,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    clearDatabaseState(row);
    log.info('enrichment', 'rescrape_db_cleared', {
      videoDbId,
      videoId: row.video_id,
      platform: row.platform,
    });

    emitResetEvents(row);
    log.info('enrichment', 'rescrape_enqueued', {
      videoDbId,
      videoId: row.video_id,
      platform: row.platform,
      channel_id: row.channel_platform_id,
    });

    void enrichVideo(
      videoDbId,
      row.channel_platform_id,
      row.channel_name ?? undefined,
      {
        priority: 0,
        onSettled: releaseLock,
      },
    ).catch((error) => {
      releaseLock();
      log.warn('enrichment', 'rescrape_enqueue_failed', {
        videoDbId,
        videoId: row.video_id,
        platform: row.platform,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return {
      ok: true,
      videoId: row.video_id,
      platform: row.platform,
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}
