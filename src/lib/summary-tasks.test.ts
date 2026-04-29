import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSummaryTasksModule(dbPath: string) {
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();

  const summaryTasks = await import('./summary-tasks');
  const db = await import('./db');

  return {
    ...summaryTasks,
    ...db,
  };
}

describe('summary-tasks', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    try {
      const { closeDb } = await import('./db');
      closeDb();
    } catch {
      // Ignore cleanup failures from partially initialized modules.
    }

    delete process.env.DATABASE_PATH;
    vi.useRealTimers();
    vi.resetModules();

    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not allow reclaiming a fresh processing task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T04:00:00.000Z'));

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'folo-summary-tasks-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const { claimSummaryTaskProcessing, createSummaryTask } =
      await loadSummaryTasksModule(dbPath);

    createSummaryTask('fresh-video', 'youtube');

    const firstClaim = claimSummaryTaskProcessing(
      'fresh-video',
      'youtube',
      'api',
    );
    expect(firstClaim).not.toBeNull();

    const secondClaim = claimSummaryTaskProcessing(
      'fresh-video',
      'youtube',
      'api',
    );
    expect(secondClaim).toBeNull();
  });

  it('allows reclaiming a stale processing task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T04:00:00.000Z'));

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'folo-summary-tasks-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const { claimSummaryTaskProcessing, createSummaryTask } =
      await loadSummaryTasksModule(dbPath);

    createSummaryTask('stale-video', 'youtube');

    const firstClaim = claimSummaryTaskProcessing(
      'stale-video',
      'youtube',
      'api',
    );
    expect(firstClaim?.started_at).toBe('2026-04-10T04:00:00.000Z');

    vi.setSystemTime(new Date('2026-04-10T04:11:00.000Z'));

    const reclaimed = claimSummaryTaskProcessing(
      'stale-video',
      'youtube',
      'api',
    );
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.started_at).toBe('2026-04-10T04:11:00.000Z');
  });

  it('requeues only stale processing tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T04:00:00.000Z'));

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'folo-summary-tasks-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      claimSummaryTaskProcessing,
      createSummaryTask,
      getSummaryTask,
      requeueStaleSummaryTasks,
    } = await loadSummaryTasksModule(dbPath);

    createSummaryTask('stale-video', 'youtube');
    createSummaryTask('fresh-video', 'youtube');

    claimSummaryTaskProcessing('stale-video', 'youtube', 'api');

    vi.setSystemTime(new Date('2026-04-10T04:11:00.000Z'));

    claimSummaryTaskProcessing('fresh-video', 'youtube', 'api');

    const changes = requeueStaleSummaryTasks();
    expect(changes).toBe(1);

    expect(getSummaryTask('stale-video', 'youtube')).toMatchObject({
      status: 'pending',
      started_at: null,
      completed_at: null,
      method: null,
      error: null,
    });
    expect(getSummaryTask('fresh-video', 'youtube')).toMatchObject({
      status: 'processing',
      method: 'api',
      started_at: '2026-04-10T04:11:00.000Z',
    });
  });

  it('requeues failed summary tasks only after their retry delay expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T04:00:00.000Z'));

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'folo-summary-tasks-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      createSummaryTask,
      getSummaryTask,
      requeueRetryableFailedSummaryTasks,
      updateTaskStatus,
    } = await loadSummaryTasksModule(dbPath);

    createSummaryTask('retry-video', 'youtube');
    updateTaskStatus('retry-video', 'youtube', 'failed', {
      error: 'HTTP 500',
    });

    expect(getSummaryTask('retry-video', 'youtube')).toMatchObject({
      status: 'failed',
      retry_count: 1,
      retry_after: '2026-04-10T04:02:00.000Z',
    });

    expect(requeueRetryableFailedSummaryTasks()).toBe(0);

    vi.setSystemTime(new Date('2026-04-10T04:02:01.000Z'));

    expect(requeueRetryableFailedSummaryTasks()).toBe(1);
    expect(getSummaryTask('retry-video', 'youtube')).toMatchObject({
      status: 'pending',
      retry_count: 1,
      retry_after: null,
      error: null,
    });
  });

  it('migrates legacy summary_tasks tables before retry index creation', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'folo-summary-tasks-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE summary_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        method TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        UNIQUE(video_id, platform)
      );
      CREATE INDEX idx_summary_tasks_status ON summary_tasks(status);
    `);
    legacyDb.close();

    const { getDb, getSummaryTaskStats } = await loadSummaryTasksModule(dbPath);

    expect(getSummaryTaskStats()).toEqual({
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    });

    const columns = (
      getDb().prepare('PRAGMA table_info(summary_tasks)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columns).toContain('retry_count');
    expect(columns).toContain('retry_after');
  });
});
