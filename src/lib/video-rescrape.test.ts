import fs from 'fs';
import os from 'os';
import path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const mockAcquireRescrapeLock = vi.fn();
const mockReleaseRescrapeLock = vi.fn();
const mockEnrichVideo = vi.fn();
const mockEmit = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();

async function loadVideoRescrapeModule(tempDir: string) {
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
  process.env.DATA_ROOT = path.join(tempDir, 'data');
  process.env.SUBTITLE_ROOT = path.join(tempDir, 'data', 'subtitles');
  process.env.SUMMARY_ROOT = path.join(tempDir, 'data', 'summaries');

  vi.resetModules();

  vi.doMock('./enrichment-queue', () => ({
    acquireRescrapeLock: mockAcquireRescrapeLock,
    releaseRescrapeLock: mockReleaseRescrapeLock,
    enrichVideo: mockEnrichVideo,
  }));
  vi.doMock('./events', () => ({
    appEvents: {
      emit: mockEmit,
    },
  }));
  vi.doMock('./logger', () => ({
    log: {
      info: mockLogInfo,
      warn: mockLogWarn,
    },
  }));

  const videoRescrape = await import('./video-rescrape');
  const dbModule = await import('./db');
  return {
    ...videoRescrape,
    ...dbModule,
  };
}

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'needle-video-rescrape-'),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

function seedVideo(db: BetterSqlite3.Database) {
  db.prepare(
    `
    INSERT INTO channels (platform, channel_id, name, intent, topics)
    VALUES ('youtube', 'UC123', 'Test Channel', '工作', '[]')
  `,
  ).run();

  db.prepare(
    `
    INSERT INTO videos (
      id,
      channel_id,
      platform,
      video_id,
      title,
      thumbnail_url,
      published_at,
      duration,
      is_read,
      is_members_only,
      access_status,
      availability_status,
      availability_reason,
      availability_checked_at,
      subtitle_path,
      subtitle_language,
      subtitle_format,
      subtitle_status,
      subtitle_error,
      subtitle_last_attempt_at,
      subtitle_retry_count,
      subtitle_cooldown_until,
      members_only_checked_at,
      automation_tags,
      source,
      channel_name
    )
    VALUES (
      10,
      1,
      'youtube',
      'abc123',
      'Old title',
      'https://example.com/old.jpg',
      '2026-04-01T00:00:00.000Z',
      'PT10M',
      1,
      1,
      'members_only',
      'abandoned',
      'Gone',
      '2026-04-02T00:00:00.000Z',
      'youtube/abc123.json',
      'en',
      'json',
      'fetched',
      'old error',
      '2026-04-03T00:00:00.000Z',
      4,
      '2026-04-04T00:00:00.000Z',
      '2026-04-05T00:00:00.000Z',
      '["keep"]',
      'browser',
      'Old Channel'
    )
  `,
  ).run();

  db.prepare(
    `
    INSERT INTO summary_tasks (video_id, platform, status, method, error)
    VALUES ('abc123', 'youtube', 'failed', 'api', 'old failure')
  `,
  ).run();
}

describe('rescrapeVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireRescrapeLock.mockReturnValue(true);
    mockEnrichVideo.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    try {
      const { closeDb } = await import('./db');
      closeDb();
    } catch {
      // Ignore cleanup failures from partially initialized modules.
    }

    delete process.env.DATABASE_PATH;
    delete process.env.DATA_ROOT;
    delete process.env.SUBTITLE_ROOT;
    delete process.env.SUMMARY_ROOT;

    vi.resetModules();
    vi.doUnmock('./enrichment-queue');
    vi.doUnmock('./events');
    vi.doUnmock('./logger');

    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears local state, deletes assets, emits auto-pipeline event, and enqueues enrichment', async () => {
    const tempDir = makeTempDir();
    const { getDb, rescrapeVideo } = await loadVideoRescrapeModule(tempDir);
    const db = getDb();
    seedVideo(db);

    const subtitleDir = path.join(tempDir, 'data', 'subtitles', 'youtube');
    const summaryDir = path.join(tempDir, 'data', 'summaries', 'youtube');
    fs.mkdirSync(path.join(subtitleDir, 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(subtitleDir, 'abc123', 'chunk.json'), '{}');
    fs.writeFileSync(path.join(subtitleDir, 'abc123.json'), '{}');
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(path.join(summaryDir, 'abc123.md'), 'summary');
    fs.writeFileSync(path.join(summaryDir, 'abc123.prev.md'), 'previous');
    fs.writeFileSync(path.join(summaryDir, 'abc123.2026-04-01.md'), 'history');
    fs.writeFileSync(path.join(summaryDir, 'other.md'), 'other');

    const result = await rescrapeVideo(10);

    expect(result).toEqual({
      ok: true,
      videoId: 'abc123',
      platform: 'youtube',
    });

    const row = db
      .prepare('SELECT * FROM videos WHERE id = ?')
      .get(10) as Record<string, unknown>;
    expect(row.title).toBeNull();
    expect(row.thumbnail_url).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.duration).toBeNull();
    expect(row.channel_name).toBeNull();
    expect(row.source).toBeNull();
    expect(row.is_members_only).toBe(0);
    expect(row.access_status).toBeNull();
    expect(row.availability_status).toBeNull();
    expect(row.subtitle_status).toBeNull();
    expect(row.subtitle_path).toBeNull();
    expect(row.subtitle_retry_count).toBe(0);
    expect(row.is_read).toBe(1);
    expect(row.automation_tags).toBe('["keep"]');

    const task = db
      .prepare(
        'SELECT * FROM summary_tasks WHERE video_id = ? AND platform = ?',
      )
      .get('abc123', 'youtube');
    expect(task).toBeUndefined();

    expect(fs.existsSync(path.join(subtitleDir, 'abc123'))).toBe(false);
    expect(fs.existsSync(path.join(subtitleDir, 'abc123.json'))).toBe(false);
    expect(fs.existsSync(path.join(summaryDir, 'abc123.md'))).toBe(false);
    expect(fs.existsSync(path.join(summaryDir, 'abc123.prev.md'))).toBe(false);
    expect(fs.existsSync(path.join(summaryDir, 'abc123.2026-04-01.md'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(summaryDir, 'other.md'))).toBe(true);

    expect(mockEmit).toHaveBeenCalledWith('video:discovered', {
      videoId: 'abc123',
      platform: 'youtube',
      channelId: 'UC123',
      channelName: 'Test Channel',
      priority: 0,
      at: expect.any(String),
    });
    expect(mockEnrichVideo).toHaveBeenCalledWith(10, 'UC123', 'Test Channel', {
      priority: 0,
      onSettled: expect.any(Function),
    });
    expect(mockReleaseRescrapeLock).not.toHaveBeenCalled();

    const options = mockEnrichVideo.mock.calls[0][3] as {
      onSettled: () => void;
    };
    options.onSettled();
    options.onSettled();
    expect(mockReleaseRescrapeLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseRescrapeLock).toHaveBeenCalledWith(10);
  });

  it('returns not_found for missing videos', async () => {
    const tempDir = makeTempDir();
    const { rescrapeVideo } = await loadVideoRescrapeModule(tempDir);

    await expect(rescrapeVideo(404)).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(mockAcquireRescrapeLock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent rescrapes', async () => {
    const tempDir = makeTempDir();
    const { getDb, rescrapeVideo } = await loadVideoRescrapeModule(tempDir);
    seedVideo(getDb());
    mockAcquireRescrapeLock.mockReturnValueOnce(false);

    await expect(rescrapeVideo(10)).resolves.toEqual({
      ok: false,
      reason: 'in_progress',
    });
    expect(mockEnrichVideo).not.toHaveBeenCalled();
    expect(mockReleaseRescrapeLock).not.toHaveBeenCalled();
  });
});
