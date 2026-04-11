import fs from 'fs';
import os from 'os';
import path from 'path';
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

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-summary-tasks-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      claimSummaryTaskProcessing,
      createSummaryTask,
    } = await loadSummaryTasksModule(dbPath);

    createSummaryTask('fresh-video', 'youtube');

    const firstClaim = claimSummaryTaskProcessing('fresh-video', 'youtube', 'api');
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

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-summary-tasks-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      claimSummaryTaskProcessing,
      createSummaryTask,
    } = await loadSummaryTasksModule(dbPath);

    createSummaryTask('stale-video', 'youtube');

    const firstClaim = claimSummaryTaskProcessing('stale-video', 'youtube', 'api');
    expect(firstClaim?.started_at).toBe('2026-04-10T04:00:00.000Z');

    vi.setSystemTime(new Date('2026-04-10T04:11:00.000Z'));

    const reclaimed = claimSummaryTaskProcessing('stale-video', 'youtube', 'api');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.started_at).toBe('2026-04-10T04:11:00.000Z');
  });

  it('requeues only stale processing tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T04:00:00.000Z'));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-summary-tasks-'));
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
});
