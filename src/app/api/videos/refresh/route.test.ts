import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel } from '@/lib/db';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { prepareMock, getDbMock };
});

const {
  tryAcquireCrawlerScope,
  releaseCrawlerScope,
  resetCrawlerScopeStatus,
  updateCrawlerScopeStatus,
} = vi.hoisted(() => ({
  tryAcquireCrawlerScope: vi.fn().mockReturnValue(true),
  releaseCrawlerScope: vi.fn(),
  resetCrawlerScopeStatus: vi.fn(),
  updateCrawlerScopeStatus: vi.fn(),
}));

const { getCrawlerScopeOwner } = vi.hoisted(() => ({
  getCrawlerScopeOwner: vi.fn().mockReturnValue('manual'),
}));

const { appEvents } = vi.hoisted(() => ({
  appEvents: {
    emit: vi.fn(),
  },
}));

const { fetchYouTubeFeed, fetchBilibiliFeed } = vi.hoisted(() => ({
  fetchYouTubeFeed: vi.fn(),
  fetchBilibiliFeed: vi.fn(),
}));

const {
  finishManualRefreshRun,
  getActiveManualRefreshRun,
  isManualRefreshCancelled,
  requestManualRefreshCancel,
  startManualRefreshRun,
} = vi.hoisted(() => ({
  finishManualRefreshRun: vi.fn(),
  getActiveManualRefreshRun: vi.fn().mockReturnValue(null),
  isManualRefreshCancelled: vi.fn().mockReturnValue(false),
  requestManualRefreshCancel: vi.fn(),
  startManualRefreshRun: vi.fn().mockReturnValue({
    id: 'run-1',
    cancelRequested: false,
    startedAt: '2026-03-29T00:00:00.000Z',
  }),
}));

const { cleanupOldLogs, log } = vi.hoisted(() => ({
  cleanupOldLogs: vi.fn(),
  log: { info: vi.fn(), error: vi.fn() },
}));

const { getSchedulerConfig, startScheduler, stopScheduler } = vi.hoisted(
  () => ({
    getSchedulerConfig: vi.fn().mockReturnValue({ enabled: true }),
    startScheduler: vi.fn(),
    stopScheduler: vi.fn(),
  }),
);

vi.mock('@/lib/db', () => ({ getDb: getDbMock }));
vi.mock('@/lib/crawler-status', () => ({
  tryAcquireCrawlerScope,
  releaseCrawlerScope,
  resetCrawlerScopeStatus,
  updateCrawlerScopeStatus,
  getCrawlerScopeOwner,
  waitIfCrawlerPaused: vi.fn().mockResolvedValue(undefined),
  getCrawlerScopeStatus: vi.fn().mockReturnValue({ state: 'idle' }),
}));
vi.mock('@/lib/crawler-performance', () => ({
  throttleCrawlerStage: vi.fn().mockResolvedValue(null),
  getCrawlerPerformanceSummary: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/events', () => ({ appEvents }));
vi.mock('@/lib/fetcher', () => ({ fetchYouTubeFeed, fetchBilibiliFeed }));
vi.mock('@/lib/pipeline-config', () => ({
  getPreferredCrawlMethod: vi.fn().mockReturnValue('opencli'),
}));
vi.mock('@/lib/logger', () => ({ log, cleanupOldLogs }));
vi.mock('@/lib/manual-refresh', () => ({
  finishManualRefreshRun,
  getActiveManualRefreshRun,
  isManualRefreshCancelled,
  requestManualRefreshCancel,
  startManualRefreshRun,
}));
vi.mock('@/lib/scheduler', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/scheduler')>('@/lib/scheduler');
  return {
    ...actual,
    getSchedulerConfig,
    startScheduler,
    stopScheduler,
  };
});

// Helper to create a mock statement
function mockStmt(
  overrides: {
    get?: ReturnType<typeof vi.fn>;
    run?: ReturnType<typeof vi.fn>;
    all?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    get: overrides.get ?? vi.fn(),
    run: overrides.run ?? vi.fn(),
    all: overrides.all ?? vi.fn(),
  };
}

function mockCountStmt(...counts: number[]) {
  return mockStmt({
    get: vi
      .fn()
      .mockImplementationOnce(() => ({ c: counts[0] ?? 0 }))
      .mockImplementation(() => ({ c: counts[counts.length - 1] ?? 0 })),
  });
}

import { DELETE, POST } from './route';
import type { NextRequest } from 'next/dist/server/web/spec-extension/request';
import { getPreferredCrawlMethod } from '@/lib/pipeline-config';

const mockChannel: Channel = {
  id: 1,
  platform: 'youtube',
  channel_id: 'UC123',
  name: 'Test Channel',
  avatar_url: 'https://example.com/avatar.png',
  intent: '工作',
  topics: ['Tech'],
  category: '',
  category2: '',
  crawl_error_count: 0,
  crawl_backoff_until: null,
  created_at: '2026-03-23T12:00:00.000Z',
};

function makeReq(body: Record<string, unknown> = {}) {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/videos/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReset();
    tryAcquireCrawlerScope.mockReturnValue(true);
    getCrawlerScopeOwner.mockReturnValue('manual');
    getSchedulerConfig.mockReturnValue({ enabled: true });
    startManualRefreshRun.mockReturnValue({
      id: 'run-1',
      cancelRequested: false,
      startedAt: '2026-03-29T00:00:00.000Z',
    });
    getActiveManualRefreshRun.mockReturnValue(null);
    isManualRefreshCancelled.mockReturnValue(false);
  });

  it('emits manual refresh events with high priority after the initial import crawl', async () => {
    const newVideo = {
      video_id: 'abc123',
      title: 'Test Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 600,
      platform: 'youtube' as const,
    };

    // Setup: count existing videos, channel query, INSERT (changes=1),
    // UPDATE, SELECT for getVideoDbId
    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([newVideo]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.added).toBe(1);
    expect(appEvents.emit).toHaveBeenCalledWith(
      'video:discovered',
      expect.objectContaining({
        videoId: 'abc123',
        priority: 0,
      }),
    );
  });

  it('skips subtitle and summary automation on the first crawl for a newly imported channel', async () => {
    const newVideo = {
      video_id: 'first-import-1',
      title: 'First Import Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 600,
      platform: 'youtube' as const,
    };

    prepareMock
      .mockReturnValueOnce(mockCountStmt(0))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([newVideo]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.added).toBe(1);
    expect(appEvents.emit).not.toHaveBeenCalledWith(
      'video:discovered',
      expect.anything(),
    );
    expect(appEvents.emit).toHaveBeenCalledWith(
      'video:new-skeleton',
      expect.objectContaining({
        video_id: 'first-import-1',
      }),
    );
  });

  it('falls back to browser when no preferred crawl method is configured', async () => {
    vi.mocked(getPreferredCrawlMethod).mockReturnValueOnce(null);

    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([]);

    const response = await POST(makeReq() as unknown as NextRequest);

    expect(response.status).toBe(200);
    expect(updateCrawlerScopeStatus).toHaveBeenCalledWith(
      'feed',
      expect.objectContaining({
        preferredMethod: 'browser',
        activeMethod: 'browser',
      }),
    );
  });

  it('does not emit event when video already exists (changes = 0)', async () => {
    const existingVideo = {
      video_id: 'abc123',
      title: 'Existing Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 600,
      platform: 'youtube' as const,
    };

    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([existingVideo]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.added).toBe(0);
    expect(appEvents.emit).not.toHaveBeenCalled();
  });

  it('returns 409 when crawler scope lock cannot be acquired', async () => {
    tryAcquireCrawlerScope.mockReturnValue(false);
    getCrawlerScopeOwner.mockReturnValue('manual');

    const response = await POST(makeReq() as unknown as NextRequest);

    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.error).toBe('后台抓取任务正在运行，请稍后再试');
  });

  it('forces refresh when the scheduler owns the feed lock', async () => {
    const newVideo = {
      video_id: 'force-1',
      title: 'Forced Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 600,
      platform: 'youtube' as const,
    };

    getCrawlerScopeOwner.mockReturnValue('scheduler');

    tryAcquireCrawlerScope.mockReturnValueOnce(false).mockReturnValueOnce(true);

    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([newVideo]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.added).toBe(1);
    expect(stopScheduler).toHaveBeenCalledWith({ persist: false });
    expect(startScheduler).toHaveBeenCalled();
  });

  it('stops before the next channel when cancellation was requested', async () => {
    const secondChannel: Channel = {
      ...mockChannel,
      id: 2,
      channel_id: 'UC456',
      name: 'Another Channel',
    };
    const newVideo = {
      video_id: 'cancel-1',
      title: 'Video Before Cancel',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 600,
      platform: 'youtube' as const,
    };

    isManualRefreshCancelled
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    prepareMock
      .mockReturnValueOnce(mockCountStmt(2, 2))
      .mockReturnValueOnce(
        mockStmt({
          all: vi.fn().mockReturnValue([mockChannel, secondChannel]),
        }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([newVideo]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.cancelled).toBe(true);
    expect(fetchYouTubeFeed).toHaveBeenCalledTimes(1);
    expect(finishManualRefreshRun).toHaveBeenCalledWith('run-1');
  });

  it('returns 409 when cancelling without an active manual refresh', async () => {
    getActiveManualRefreshRun.mockReturnValue(null);

    const response = await DELETE();
    const result = await response.json();

    expect(response.status).toBe(409);
    expect(result.error).toBe('当前没有进行中的手动刷新');
  });

  it('marks the active manual refresh as cancelled', async () => {
    getActiveManualRefreshRun.mockReturnValue({
      id: 'run-1',
      cancelRequested: false,
      startedAt: '2026-03-29T00:00:00.000Z',
    });
    requestManualRefreshCancel.mockReturnValue({
      id: 'run-1',
      cancelRequested: true,
      startedAt: '2026-03-29T00:00:00.000Z',
    });

    const response = await DELETE();
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.cancelled).toBe(true);
    expect(result.requested).toBe(true);
  });

  it('processes multiple channels and marks discovered videos high priority', async () => {
    const channel2: Channel = {
      ...mockChannel,
      id: 2,
      channel_id: 'UC456',
      name: 'Channel 2',
    };

    const video1 = {
      video_id: 'vid1',
      title: 'Video 1',
      thumbnail_url: '',
      published_at: '',
      duration: null,
      platform: 'youtube' as const,
    };
    const video2 = {
      video_id: 'vid2',
      title: 'Video 2',
      thumbnail_url: '',
      published_at: '',
      duration: null,
      platform: 'youtube' as const,
    };

    // count existing videos, channel query, INSERT x2 (both new), UPDATE x2
    prepareMock
      .mockReturnValueOnce(mockCountStmt(3, 4))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel, channel2]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 2 }) }),
      );

    fetchYouTubeFeed
      .mockResolvedValueOnce([video1])
      .mockResolvedValueOnce([video2]);

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.total_channels).toBe(2);
    expect(appEvents.emit).toHaveBeenCalledWith(
      'video:discovered',
      expect.objectContaining({ priority: 0 }),
    );
  });

  it('releases crawler scope lock after completion', async () => {
    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      );

    fetchYouTubeFeed.mockResolvedValue([]);

    await POST(makeReq() as unknown as NextRequest);

    expect(releaseCrawlerScope).toHaveBeenCalledWith('feed', 'manual');
    expect(resetCrawlerScopeStatus).toHaveBeenCalledWith('feed');
  });

  it('handles fetch errors gracefully and continues', async () => {
    prepareMock
      .mockReturnValueOnce(mockCountStmt(2))
      .mockReturnValueOnce(
        mockStmt({ all: vi.fn().mockReturnValue([mockChannel]) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      )
      .mockReturnValueOnce(
        mockStmt({ run: vi.fn().mockReturnValue({ changes: 0 }) }),
      );

    fetchYouTubeFeed.mockRejectedValue(new Error('Network error'));

    const response = await POST(makeReq() as unknown as NextRequest);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Network error');
  });
});
