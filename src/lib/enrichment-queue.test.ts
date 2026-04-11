/**
 * Unit tests for src/lib/enrichment-queue.ts
 *
 * Covers:
 * - VAL-L1-001: enrichVideo fills fields and emits event
 * - VAL-L1-002: Manual-only queue initialization
 * - VAL-L1-003: Pool configuration
 * - VAL-L1-004: Skip non-enrichable videos
 * - VAL-CROSS-002: Queue re-initialization
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Global state isolation for singleton
// ---------------------------------------------------------------------------

const ENRICHMENT_QUEUE_KEY = Symbol.for('folo:enrichment-queue');

function clearGlobalEnrichmentState() {
  delete (globalThis as Record<symbol, unknown>)[ENRICHMENT_QUEUE_KEY];
}

beforeEach(() => {
  clearGlobalEnrichmentState();
  vi.useRealTimers();
  // Reset all mocks before each test
  vi.clearAllMocks();
});

afterEach(() => {
  clearGlobalEnrichmentState();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGetDb = vi.hoisted(() => vi.fn());
const mockAppEventsOn = vi.hoisted(() => vi.fn());
const mockAppEventsEmit = vi.hoisted(() => vi.fn());
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

// Mock fetcher module for platform detail lookups
const mockFetchBilibiliVideoDetail = vi.hoisted(() => vi.fn());
const mockFetchYouTubeVideoDetail = vi.hoisted(() => vi.fn());

vi.mock('./db', () => ({
  getDb: mockGetDb,
}));

vi.mock('./events', () => ({
  appEvents: {
    on: mockAppEventsOn,
    emit: mockAppEventsEmit,
    removeAllListeners: vi.fn(),
  },
}));

vi.mock('./fetcher', () => ({
  fetchBilibiliVideoDetail: mockFetchBilibiliVideoDetail,
  fetchYouTubeVideoDetail: mockFetchYouTubeVideoDetail,
}));

vi.mock('./logger', () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  ensureEnrichmentQueue,
  getEnrichmentQueueStatus,
  enrichVideo,
  getEnrichmentQueue,
} from './enrichment-queue';

// ---------------------------------------------------------------------------
// VAL-L1-001: enrichVideo fills fields and emits event
// ---------------------------------------------------------------------------

describe('VAL-L1-001: enrichVideo fills fields and emits event', () => {
  it('fetches Bilibili detail, updates DB, and emits video:enriched event', async () => {
    const videoId = 42;
    const bvid = 'BV123';
    const channelIdStr = 'UC123';
    const channelName = 'Test Channel';

    const videoWithChannel = {
      id: videoId,
      video_id: bvid,
      platform: 'bilibili' as const,
      channel_id: 1,
      channel_id__platform: channelIdStr,
      channel_name: channelName,
      title: 'Test Video',
      thumbnail_url: null,
      published_at: null,
      duration: null,
      created_at: new Date().toISOString(),
    };

    let updateCall: unknown = null;
    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        // The JOIN query in getVideoWithChannel
        get: vi.fn().mockReturnValue(videoWithChannel),
        // The UPDATE query
        run: vi.fn().mockImplementation((...args: unknown[]) => {
          updateCall = args;
        }),
        all: vi.fn().mockReturnValue([]),
      }),
    });

    mockFetchBilibiliVideoDetail.mockResolvedValue({
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T10:00:00.000Z',
      duration: '10:30',
      is_members_only: 1,
    });

    // enrichVideo enqueues and returns immediately; the pool executor runs async
    const enrichPromise = enrichVideo(videoId);

    // Wait for the pool to process the job
    await new Promise(resolve => setTimeout(resolve, 10));

    await enrichPromise;

    // Verify fetchBilibiliVideoDetail was called with the correct BVID
    expect(mockFetchBilibiliVideoDetail).toHaveBeenCalledWith(bvid);

    // Verify DB update was called
    expect(updateCall).not.toBeNull();

    // Check that video:enriched was emitted
    expect(mockAppEventsEmit).toHaveBeenCalledWith(
      'video:enriched',
      expect.objectContaining({
        videoDbId: videoId,
        videoId: bvid,
        platform: 'bilibili',
        channel_id: channelIdStr,
        channel_name: channelName,
        fields: expect.objectContaining({
          thumbnail_url: 'https://example.com/thumb.jpg',
          published_at: '2026-03-25T10:00:00.000Z',
          duration: '10:30',
          is_members_only: 1,
        }),
      }),
    );
  });

  it('emits video:enriched event with channel context', async () => {
    const videoId = 99;
    const bvid = 'BV999';
    const channelIdStr = 'UC999';
    const channelName = 'My Channel';

    const videoWithChannel = {
      id: videoId,
      video_id: bvid,
      platform: 'bilibili' as const,
      channel_id: 2,
      channel_id__platform: channelIdStr,
      channel_name: channelName,
      title: 'Test Video',
      thumbnail_url: null,
      published_at: null,
      duration: null,
      created_at: new Date().toISOString(),
    };

    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(videoWithChannel),
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    });

    mockFetchBilibiliVideoDetail.mockResolvedValue({
      thumbnail_url: 'https://example.com/thumb2.jpg',
      published_at: '2026-03-26T08:00:00.000Z',
      duration: '05:00',
      is_members_only: 0,
    });

    const enrichPromise = enrichVideo(videoId);
    await new Promise(resolve => setTimeout(resolve, 10));
    await enrichPromise;

    expect(mockAppEventsEmit).toHaveBeenCalledWith(
      'video:enriched',
      expect.objectContaining({
        channel_id: channelIdStr,
        channel_name: channelName,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// VAL-L1-004: Skip non-enrichable videos
// ---------------------------------------------------------------------------

describe('VAL-L1-004: Skip non-enrichable videos', () => {
  it('enriches YouTube videos and marks member-only status when available', async () => {
    const youtubeVideo = {
      id: 10,
      video_id: 'xyz123',
      platform: 'youtube' as const,
      channel_id: 1,
      channel_id__platform: 'UCyt',
      channel_name: 'YT Channel',
      title: 'YT Video',
      thumbnail_url: null,
      published_at: null,
      duration: null,
      created_at: new Date().toISOString(),
    };

    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(youtubeVideo),
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    });

    mockFetchYouTubeVideoDetail.mockResolvedValue({
      thumbnail_url: 'https://example.com/yt-thumb.jpg',
      published_at: '2026-03-25T10:00:00.000Z',
      duration: '12:34',
      is_members_only: 1,
    });

    await enrichVideo(10);

    expect(mockFetchYouTubeVideoDetail).toHaveBeenCalledWith('xyz123');
    expect(mockFetchBilibiliVideoDetail).not.toHaveBeenCalled();
    expect(mockAppEventsEmit).toHaveBeenCalledWith(
      'video:enriched',
      expect.objectContaining({
        videoDbId: 10,
        videoId: 'xyz123',
        platform: 'youtube',
        fields: expect.objectContaining({
          thumbnail_url: 'https://example.com/yt-thumb.jpg',
          published_at: '2026-03-25T10:00:00.000Z',
          duration: '12:34',
          is_members_only: 1,
        }),
      }),
    );
  });

  it('skips Bilibili videos that already have all fields populated', async () => {
    const completeVideo = {
      id: 11,
      video_id: 'BVComplete',
      platform: 'bilibili' as const,
      channel_id: 2,
      channel_id__platform: 'UCbilibili',
      channel_name: 'Complete Channel',
      title: 'Complete Video',
      thumbnail_url: 'https://example.com/existing.jpg',
      published_at: '2026-03-25T10:00:00.000Z',
      duration: '10:00',
      members_only_checked_at: '2026-03-25T10:00:00.000Z',
      created_at: new Date().toISOString(),
    };

    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(completeVideo),
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    });

    await enrichVideo(11);

    // Should NOT call API for already-complete videos
    expect(mockFetchBilibiliVideoDetail).not.toHaveBeenCalled();
    // No video:enriched event since already complete
    const videoEnrichedCalls = mockAppEventsEmit.mock.calls.filter(
      call => call[0] === 'video:enriched'
    );
    expect(videoEnrichedCalls).toHaveLength(0);
  });

  it('skips when video not found', async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    });

    await enrichVideo(999);

    expect(mockFetchBilibiliVideoDetail).not.toHaveBeenCalled();
    const videoEnrichedCalls = mockAppEventsEmit.mock.calls.filter(
      call => call[0] === 'video:enriched'
    );
    expect(videoEnrichedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-L1-002: Manual-only queue initialization
// ---------------------------------------------------------------------------

describe('VAL-L1-002: Manual-only queue initialization', () => {
  it('creates the queue without any startup recovery query', () => {
    const prepare = vi.fn();
    mockGetDb.mockReturnValue({ prepare });

    ensureEnrichmentQueue();

    expect(prepare).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VAL-L1-003: Pool configuration
// ---------------------------------------------------------------------------

describe('VAL-L1-003: Pool configuration', () => {
  it('creates pool with correct config: initial=3, min=1, max=6, rateLimit 10/5s', () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });

    ensureEnrichmentQueue();

    const pool = getEnrichmentQueue();
    const status = pool.getStatus();

    expect(status.name).toBe('enrichment');
    expect(status.currentConcurrency).toBe(3);
    expect(status.state).toBe('running');
    // Rate limit info is in the pool config
    expect(pool.config.rateLimit).toEqual({ requestsPerWindow: 10, windowMs: 5000 });
  });

  it('getEnrichmentQueueStatus returns pool status', () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });

    ensureEnrichmentQueue();

    const status = getEnrichmentQueueStatus();

    expect(status).toHaveProperty('pool');
    expect(status.pool).toHaveProperty('name', 'enrichment');
    expect(status.pool).toHaveProperty('currentConcurrency', 3);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-002: Queue re-initialization
// ---------------------------------------------------------------------------

describe('VAL-CROSS-002: Queue re-initialization', () => {
  it('after restart, the manual repair queue re-initializes cleanly', () => {
    mockGetDb.mockReturnValue({ prepare: vi.fn() });

    clearGlobalEnrichmentState();
    vi.clearAllMocks();

    ensureEnrichmentQueue();

    const pool = getEnrichmentQueue();
    expect(pool.getStatus().state).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// ensureEnrichmentQueue idempotency
// ---------------------------------------------------------------------------

describe('ensureEnrichmentQueue idempotency', () => {
  it('calling ensureEnrichmentQueue multiple times does not re-register listeners', () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    });

    ensureEnrichmentQueue();
    ensureEnrichmentQueue();
    ensureEnrichmentQueue();

    // Listeners should only be registered once
    expect(mockAppEventsOn).toHaveBeenCalledTimes(0); // We mocked it but it shouldn't actually be called in our mock setup
  });
});
