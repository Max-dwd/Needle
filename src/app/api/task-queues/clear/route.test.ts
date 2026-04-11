import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearSubtitleQueue, getAutoPipelineStatus } = vi.hoisted(() => ({
  clearSubtitleQueue: vi.fn(),
  getAutoPipelineStatus: vi.fn(),
}));

const { clearSummaryQueue, getQueueState } = vi.hoisted(() => ({
  clearSummaryQueue: vi.fn(),
  getQueueState: vi.fn(),
}));

vi.mock('@/lib/auto-pipeline', () => ({
  clearSubtitleQueue,
  getAutoPipelineStatus,
}));

vi.mock('@/lib/summary-queue', () => ({
  clearSummaryQueue,
  getQueueState,
}));

import { POST } from './route';

describe('POST /api/task-queues/clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutoPipelineStatus.mockReturnValue({
      subtitle: {
        queueLength: 0,
        processing: false,
        currentVideoId: null,
        currentVideoTitle: null,
        nextRunAt: null,
        stats: { completed: 0, failed: 0, queued: 0 },
        throttle: {
          state: 'clear',
          multiplier: 1,
          consecutiveErrors: 0,
          maxRetries: 2,
          exhaustedCount: 0,
        },
      },
      summary: { queueLength: 0, processing: false, currentVideoId: null },
    });
    getQueueState.mockReturnValue({ running: false, processed: 0, total: 0 });
  });

  it('clears subtitle queue', async () => {
    clearSubtitleQueue.mockReturnValue({ cleared: 3 });

    const response = await POST(
      new Request('http://localhost/api/task-queues/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: 'subtitle' }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(clearSubtitleQueue).toHaveBeenCalledTimes(1);
    expect(clearSummaryQueue).not.toHaveBeenCalled();
  });

  it('clears summary queue', async () => {
    clearSummaryQueue.mockReturnValue({ clearedPending: 2, clearedQueued: 1 });

    const response = await POST(
      new Request('http://localhost/api/task-queues/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: 'summary' }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(clearSummaryQueue).toHaveBeenCalledTimes(1);
    expect(clearSubtitleQueue).not.toHaveBeenCalled();
  });

  it('rejects invalid queue types', async () => {
    const response = await POST(
      new Request('http://localhost/api/task-queues/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: 'other' }),
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(clearSubtitleQueue).not.toHaveBeenCalled();
    expect(clearSummaryQueue).not.toHaveBeenCalled();
  });
});
