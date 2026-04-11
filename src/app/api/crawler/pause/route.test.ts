import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getCrawlerRuntimeStatus,
  setCrawlerPaused,
} = vi.hoisted(() => ({
  getCrawlerRuntimeStatus: vi.fn(),
  setCrawlerPaused: vi.fn(),
}));

const { getSubtitlePool } = vi.hoisted(() => ({
  getSubtitlePool: vi.fn(),
}));

const { getQueueState, requestQueueStop } = vi.hoisted(() => ({
  getQueueState: vi.fn(),
  requestQueueStop: vi.fn(),
}));

const { ensureScheduler, getSchedulerStatus } = vi.hoisted(() => ({
  ensureScheduler: vi.fn(),
  getSchedulerStatus: vi.fn(),
}));

vi.mock('@/lib/crawler-status', () => ({
  getCrawlerRuntimeStatus,
  setCrawlerPaused,
}));

vi.mock('@/lib/auto-pipeline', () => ({
  getSubtitlePool,
}));

vi.mock('@/lib/summary-queue', () => ({
  getQueueState,
  requestQueueStop,
}));

vi.mock('@/lib/scheduler', () => ({
  ensureScheduler,
  getSchedulerStatus,
}));

import { POST } from './route';

function makeReq(paused: boolean) {
  return new Request('http://localhost/api/crawler/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused, stopSummaryQueue: true }),
  });
}

describe('POST /api/crawler/pause', () => {
  const subtitlePool = {
    pause: vi.fn(),
    resume: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSubtitlePool.mockReturnValue(subtitlePool);
    getCrawlerRuntimeStatus.mockReturnValue({ paused: true, feed: { state: 'idle' } });
    getQueueState.mockReturnValue({ running: false, processed: 0, total: 0 });
    getSchedulerStatus.mockReturnValue({ running: true });
  });

  it('pauses the subtitle pool when pausing crawler tasks', async () => {
    const response = await POST(makeReq(true) as never);

    expect(response.status).toBe(200);
    expect(setCrawlerPaused).toHaveBeenCalledWith(true);
    expect(subtitlePool.pause).toHaveBeenCalledTimes(1);
    expect(subtitlePool.resume).not.toHaveBeenCalled();
    expect(requestQueueStop).toHaveBeenCalledTimes(1);
    expect(ensureScheduler).toHaveBeenCalledTimes(1);
  });

  it('resumes the subtitle pool when unpausing crawler tasks', async () => {
    getCrawlerRuntimeStatus.mockReturnValue({ paused: false, feed: { state: 'idle' } });

    const response = await POST(makeReq(false) as never);

    expect(response.status).toBe(200);
    expect(setCrawlerPaused).toHaveBeenCalledWith(false);
    expect(subtitlePool.resume).toHaveBeenCalledTimes(1);
    expect(subtitlePool.pause).not.toHaveBeenCalled();
    expect(requestQueueStop).not.toHaveBeenCalled();
  });
});
