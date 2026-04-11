import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Intent, Video } from './db';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGetDb = vi.hoisted(() => vi.fn());
const mockAppEventsOn = vi.hoisted(() => vi.fn());
const mockAppEventsEmit = vi.hoisted(() => vi.fn());
const mockEnsureSubtitleForVideo = vi.hoisted(() => vi.fn());
const mockCreateSummaryTask = vi.hoisted(() => vi.fn());
const mockGetSummaryTask = vi.hoisted(() => vi.fn());
const mockIsQueueRunning = vi.hoisted(() => vi.fn());
const mockStartQueueProcessing = vi.hoisted(() => vi.fn());
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());
const mockGetEffectiveIntervalMs = vi.hoisted(() => vi.fn());
const mockGetRateLimitCooldownRemainingMs = vi.hoisted(() => vi.fn());
const mockGetSubtitleBackoffState = vi.hoisted(() => vi.fn());
const mockGetSubtitleBrowserFetchConfig = vi.hoisted(() => vi.fn());
const mockResolveSubtitleApiFallbackMatch = vi.hoisted(() => vi.fn());
const mockShouldEscapeToApi = vi.hoisted(() => vi.fn());

// Mock for async-pool module
const mockPoolEnqueue = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, durationMs: 100 }),
);
const mockPoolClearQueued = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockPoolAbortActive = vi.hoisted(() => vi.fn().mockReturnValue(0));
const mockPoolGetStatus = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    name: 'subtitle',
    currentConcurrency: 2,
    queueDepth: 0,
    activeJobs: 0,
    successRate: 1,
    avgResponseMs: 100,
    rateLimitHits: 0,
    failureRate: 0,
    state: 'running',
    loadMultiplier: 1,
    adjustedMaxConcurrency: 4,
  }),
);
const mockPoolGetOrCreate = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    enqueue: mockPoolEnqueue,
    clearQueued: mockPoolClearQueued,
    abortActive: mockPoolAbortActive,
    getStatus: mockPoolGetStatus,
  }),
);

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

vi.mock('./subtitles', () => ({
  ensureSubtitleForVideo: mockEnsureSubtitleForVideo,
  shouldEscapeToApi: mockShouldEscapeToApi,
}));

vi.mock('./summary-tasks', () => ({
  createSummaryTask: mockCreateSummaryTask,
  getSummaryTask: mockGetSummaryTask,
}));

vi.mock('./summary-queue', () => ({
  isQueueRunning: mockIsQueueRunning,
  startQueueProcessing: mockStartQueueProcessing,
}));

vi.mock('./logger', () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

vi.mock('./async-pool', () => ({
  getOrCreatePool: mockPoolGetOrCreate,
  getPool: vi.fn().mockReturnValue({
    enqueue: mockPoolEnqueue,
    clearQueued: mockPoolClearQueued,
    abortActive: mockPoolAbortActive,
    getStatus: mockPoolGetStatus,
  }),
}));

vi.mock('./subtitle-backoff', () => ({
  getEffectiveIntervalMs: mockGetEffectiveIntervalMs,
  getRateLimitCooldownRemainingMs: mockGetRateLimitCooldownRemainingMs,
  getSubtitleBackoffState: mockGetSubtitleBackoffState,
}));

vi.mock('./subtitle-browser-fetch-settings', () => ({
  getSubtitleBrowserFetchConfig: mockGetSubtitleBrowserFetchConfig,
}));

vi.mock('./subtitle-api-fallback-settings', () => ({
  resolveSubtitleApiFallbackMatch: mockResolveSubtitleApiFallbackMatch,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  clearSubtitleQueue,
  ensureAutoPipeline,
  getAutoPipelineStatus,
  getChannelByChannelId,
  getChannelForVideo,
  getIntentByName,
  getVideoById,
  getVideoByVideoId,
  enqueueSubtitleJob,
} from './auto-pipeline';
import { appEvents } from './events';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function createIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 1,
    name: '工作',
    auto_subtitle: 1,
    auto_summary: 1,
    sort_order: 0,
    auto_summary_model_id: null,
    agent_prompt: null,
    agent_trigger: null,
    agent_schedule_time: '09:00',
    agent_memory: null,
    created_at: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

function createChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    platform: 'youtube',
    channel_id: 'UC123',
    name: 'Test Channel',
    avatar_url: null,
    intent: '工作',
    topics: [],
    category: '',
    category2: '',
    crawl_error_count: 0,
    crawl_backoff_until: null,
    created_at: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

function createVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 1,
    channel_id: 1,
    platform: 'youtube',
    video_id: 'abc123',
    title: 'Test Video',
    thumbnail_url: null,
    published_at: '2026-03-23T12:00:00.000Z',
    duration: null,
    is_read: 0,
    is_members_only: 0,
    access_status: null,
    subtitle_path: null,
    subtitle_language: null,
    subtitle_format: null,
    subtitle_status: null,
    subtitle_error: null,
    subtitle_last_attempt_at: null,
    subtitle_retry_count: 0,
    subtitle_cooldown_until: null,
    members_only_checked_at: null,
    created_at: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAutoPipelineState(): void {
  const globalKey = Symbol.for('folo-auto-pipeline');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)[globalKey];
  // Also reset pool registry
  const poolKey = Symbol.for('folo:pool:registry');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)[poolKey];
  // Reset mock function return values
  mockPoolEnqueue.mockResolvedValue({ success: true, durationMs: 100 });
  mockPoolClearQueued.mockReturnValue(0);
  mockPoolAbortActive.mockReturnValue(0);
  mockPoolGetStatus.mockReturnValue({
    name: 'subtitle',
    currentConcurrency: 2,
    queueDepth: 0,
    activeJobs: 0,
    successRate: 1,
    avgResponseMs: 100,
    rateLimitHits: 0,
    failureRate: 0,
    state: 'running',
    loadMultiplier: 1,
    adjustedMaxConcurrency: 4,
  });
}

// Default mock setup that returns safe values
function setupDefaultMocks(): void {
  mockGetDb.mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    }),
  });
  mockIsQueueRunning.mockReturnValue(false);
  mockCreateSummaryTask.mockReturnValue({ id: 1 } as ReturnType<
    typeof mockCreateSummaryTask
  >);
  mockGetEffectiveIntervalMs.mockReturnValue(0);
  mockGetRateLimitCooldownRemainingMs.mockReturnValue(0);
  mockGetSubtitleBackoffState.mockReturnValue({
    consecutiveErrors: 0,
    multiplier: 1,
    lastErrorAt: null,
    rateLimitedUntil: null,
  });
  mockGetSubtitleBrowserFetchConfig.mockReturnValue({
    maxRetries: 2,
    updatedAt: null,
  });
  mockResolveSubtitleApiFallbackMatch.mockReturnValue(null);
  mockShouldEscapeToApi.mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto-pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAutoPipelineState();
    appEvents.removeAllListeners();
    setupDefaultMocks();
  });

  // -------------------------------------------------------------------------
  // Helper function tests
  // -------------------------------------------------------------------------

  describe('getIntentByName', () => {
    it('returns intent when found', () => {
      const intent = createIntent({
        name: '工作',
        auto_subtitle: 1,
        auto_summary: 1,
      });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(intent),
        }),
      });

      const result = getIntentByName('工作');
      expect(result).toEqual(intent);
    });

    it('returns null when intent not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(undefined),
        }),
      });

      const result = getIntentByName('NonExistent');
      expect(result).toBeNull();
    });

    it('falls back to 未分类 for empty intent name', () => {
      const intent = createIntent({
        name: '未分类',
        auto_subtitle: 0,
        auto_summary: 0,
      });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(intent),
        }),
      });

      const result = getIntentByName('');
      expect(result).toEqual(intent);
    });
  });

  describe('getChannelByChannelId', () => {
    it('returns channel when found', () => {
      const channel = createChannel({ channel_id: 'UC123' });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(channel),
        }),
      });

      const result = getChannelByChannelId('UC123');
      expect(result).toEqual(channel);
    });

    it('returns null when channel not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      });

      const result = getChannelByChannelId('NONEXISTENT');
      expect(result).toBeNull();
    });
  });

  describe('getChannelForVideo', () => {
    it('returns channel for video when found', () => {
      const channel = createChannel({ channel_id: 'UC123' });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(channel),
        }),
      });

      const result = getChannelForVideo('abc123', 'youtube');
      expect(result).toEqual(channel);
    });

    it('returns null when video not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      });

      const result = getChannelForVideo('NONEXISTENT', 'youtube');
      expect(result).toBeNull();
    });
  });

  describe('getVideoByVideoId', () => {
    it('returns video when found', () => {
      const video = createVideo({ video_id: 'abc123' });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(video),
        }),
      });

      const result = getVideoByVideoId('abc123', 'youtube');
      expect(result).toEqual(video);
    });

    it('returns null when video not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      });

      const result = getVideoByVideoId('NONEXISTENT', 'youtube');
      expect(result).toBeNull();
    });
  });

  describe('getVideoById', () => {
    it('returns video when found', () => {
      const video = createVideo({ id: 1 });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(video),
        }),
      });

      const result = getVideoById(1);
      expect(result).toEqual(video);
    });

    it('returns null when video not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      });

      const result = getVideoById(999);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // enqueueSubtitleJob tests (don't need ensureAutoPipeline)
  // -------------------------------------------------------------------------

  describe('enqueueSubtitleJob', () => {
    it('enqueues job successfully', () => {
      const job = {
        videoDbId: 1,
        videoId: 'abc123',
        title: 'Test Video',
        platform: 'youtube' as const,
        channelId: 'UC123',
        channelName: 'Test Channel',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      };

      const result = enqueueSubtitleJob(job);
      expect(result).toBe(true);
    });

    it('returns false when queue is full (100 items)', () => {
      // Fill the queue to 100
      for (let i = 0; i < 100; i++) {
        enqueueSubtitleJob({
          videoDbId: i + 1,
          videoId: `video${i}`,
          title: `Video ${i}`,
          platform: 'youtube',
          channelId: 'UC123',
          channelName: 'Test Channel',
          intentName: '工作',
          enqueuedAt: new Date().toISOString(),
          priority: 1,
        });
      }

      // Next one should be rejected
      const result = enqueueSubtitleJob({
        videoDbId: 999,
        videoId: 'overflow',
        title: 'Overflow Video',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Test Channel',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });

      expect(result).toBe(false);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'system',
        'auto_pipeline_subtitle_queue_full',
        expect.objectContaining({
          capacity: 100,
          videoId: 'overflow',
        }),
      );
    });

    it('deduplicates by videoId', () => {
      const job = {
        videoDbId: 1,
        videoId: 'abc123',
        title: 'Test Video',
        platform: 'youtube' as const,
        channelId: 'UC123',
        channelName: 'Test Channel',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      };

      enqueueSubtitleJob(job);
      const result = enqueueSubtitleJob(job); // duplicate

      expect(result).toBe(false);
    });
  });

  describe('clearSubtitleQueue', () => {
    it('aborts the active subtitle job and clears queued jobs', () => {
      enqueueSubtitleJob({
        videoDbId: 1,
        videoId: 'active-video',
        title: 'Active Video',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Test Channel',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });
      enqueueSubtitleJob({
        videoDbId: 2,
        videoId: 'queued-video',
        title: 'Queued Video',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Test Channel',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });

      const globalKey = Symbol.for('folo-auto-pipeline');
      (
        globalThis as typeof globalThis & {
          [key: symbol]: { currentSubtitleJob?: { videoId: string } | null };
        }
      )[globalKey].currentSubtitleJob = { videoId: 'active-video' };

      mockPoolClearQueued.mockReturnValue(1);
      mockPoolAbortActive.mockReturnValue(1);

      const result = clearSubtitleQueue();

      expect(result.cleared).toBe(2);
      expect(mockPoolClearQueued).toHaveBeenCalledTimes(1);
      expect(mockPoolAbortActive).toHaveBeenCalledTimes(1);
      expect(mockPoolAbortActive).toHaveBeenCalledWith(
        expect.any(Function),
        'subtitle queue cleared',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Event handling tests
  // -------------------------------------------------------------------------

  describe('video:discovered event handling', () => {
    it('does NOT enqueue when intent.auto_subtitle=0', () => {
      const intent = createIntent({ name: '娱乐', auto_subtitle: 0 });
      const channel = createChannel({ channel_id: 'UC123', intent: '娱乐' });
      const video = createVideo({ video_id: 'abc123' });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return channel;
            if (callCount === 2) return intent;
            return video;
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('video:discovered', {
        videoId: 'abc123',
        platform: 'youtube',
        channelId: 'UC123',
      });

      expect(mockEnsureSubtitleForVideo).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when video already has subtitle', () => {
      const intent = createIntent({ name: '工作', auto_subtitle: 1 });
      const channel = createChannel({ channel_id: 'UC123', intent: '工作' });
      const video = createVideo({
        video_id: 'abc123',
        subtitle_path: '/existing/path.json',
        subtitle_status: 'fetched',
      });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return channel;
            if (callCount === 2) return intent;
            return video;
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('video:discovered', {
        videoId: 'abc123',
        platform: 'youtube',
        channelId: 'UC123',
      });

      expect(mockEnsureSubtitleForVideo).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when channel not found', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ c: 0 }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('video:discovered', {
        videoId: 'abc123',
        platform: 'youtube',
        channelId: 'NONEXISTENT',
      });

      expect(mockEnsureSubtitleForVideo).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when intent not found', () => {
      const channel = createChannel({
        channel_id: 'UC123',
        intent: 'NonExistentIntent',
      });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return channel;
            return null; // intent not found
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('video:discovered', {
        videoId: 'abc123',
        platform: 'youtube',
        channelId: 'UC123',
      });

      expect(mockEnsureSubtitleForVideo).not.toHaveBeenCalled();
    });
  });

  describe('subtitle:ready event handling', () => {
    it('does NOT create summary task when intent.auto_summary=0', () => {
      // Intent with auto_summary=0 - not directly used but sets up the scenario
      createIntent({ name: '娱乐', auto_summary: 0 });
      const channel = createChannel({ channel_id: 'UC123', intent: '娱乐' });
      const video = createVideo({ video_id: 'abc123' });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return video;
            return channel;
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('subtitle:ready', {
        videoId: 'abc123',
        platform: 'youtube',
      });

      expect(mockCreateSummaryTask).not.toHaveBeenCalled();
    });

    it('revives failed summary task to pending instead of creating new one', () => {
      const channel = createChannel({ channel_id: 'UC123', intent: '工作' });
      const video = createVideo({ video_id: 'abc123' });

      // getSummaryTask returns a failed task
      mockGetSummaryTask.mockReturnValue({
        id: 1,
        status: 'failed',
        error: 'Previous error',
      });

      mockIsQueueRunning.mockReturnValue(false);

      // Mock getDb to return a chain that can handle video, channel, intent lookups and UPDATE
      const mockRun = vi.fn();
      let getDbCallCount = 0;
      mockGetDb.mockImplementation(() => {
        getDbCallCount++;
        return {
          prepare: vi.fn().mockImplementation((sql: string) => {
            if (sql.includes('UPDATE')) {
              return { run: mockRun };
            }
            return {
              get: vi
                .fn()
                .mockReturnValueOnce(video)
                .mockReturnValueOnce(channel)
                .mockReturnValue(null),
              all: vi.fn().mockReturnValue([]),
            };
          }),
        };
      });

      ensureAutoPipeline();

      appEvents.emit('subtitle:ready', {
        videoId: 'abc123',
        platform: 'youtube',
      });

      expect(mockCreateSummaryTask).not.toHaveBeenCalled();
      expect(getDbCallCount).toBe(0);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('does NOT create summary task when existing task is processing', () => {
      const channel = createChannel({ channel_id: 'UC123', intent: '工作' });
      const video = createVideo({ video_id: 'abc123' });

      mockGetSummaryTask.mockReturnValue({
        id: 1,
        status: 'processing',
      });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return video;
            return channel;
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('subtitle:ready', {
        videoId: 'abc123',
        platform: 'youtube',
      });

      expect(mockCreateSummaryTask).not.toHaveBeenCalled();
    });

    it('does NOT create summary task when existing task is completed', () => {
      const channel = createChannel({ channel_id: 'UC123', intent: '工作' });
      const video = createVideo({ video_id: 'abc123' });

      mockGetSummaryTask.mockReturnValue({
        id: 1,
        status: 'completed',
      });

      let callCount = 0;
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return video;
            return channel;
          }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      ensureAutoPipeline();

      appEvents.emit('subtitle:ready', {
        videoId: 'abc123',
        platform: 'youtube',
      });

      expect(mockCreateSummaryTask).not.toHaveBeenCalled();
    });
  });

  describe('ensureAutoPipeline', () => {
    it('registers listeners without any startup database scan', () => {
      const prepare = vi.fn();
      mockGetDb.mockReturnValue({ prepare });

      ensureAutoPipeline();

      expect(mockAppEventsOn).toHaveBeenCalledTimes(2);
      expect(prepare).not.toHaveBeenCalled();
      expect(mockPoolEnqueue).not.toHaveBeenCalled();
      expect(mockStartQueueProcessing).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getAutoPipelineStatus tests
  // -------------------------------------------------------------------------

  describe('getAutoPipelineStatus', () => {
    it('returns correct status structure', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('COUNT(*) AS c FROM summary_tasks')) {
            return {
              get: vi.fn().mockReturnValue({ c: 0 }),
              all: vi.fn().mockReturnValue([]),
            };
          }
          if (
            sql.includes('FROM videos') &&
            sql.includes('subtitle_retry_count')
          ) {
            return {
              get: vi.fn().mockReturnValue({ c: 0 }),
              all: vi.fn().mockReturnValue([]),
            };
          }
          return {
            get: vi.fn().mockReturnValue({ c: 0 }),
            all: vi.fn().mockReturnValue([]),
          };
        }),
      });

      mockIsQueueRunning.mockReturnValue(false);

      ensureAutoPipeline();

      const status = getAutoPipelineStatus();

      expect(status).toHaveProperty('subtitle');
      expect(status.subtitle).toHaveProperty('queueLength');
      expect(status.subtitle).toHaveProperty('videoCount');
      expect(status.subtitle).toHaveProperty('processing');
      expect(status.subtitle).toHaveProperty('currentVideoId');
      expect(status.subtitle).toHaveProperty('currentVideoTitle');
      expect(status.subtitle).toHaveProperty('currentBatchId');
      expect(status.subtitle).toHaveProperty('currentBatchLabel');
      expect(status.subtitle).toHaveProperty('currentBatchVideoCount');
      expect(status.subtitle).toHaveProperty('nextRunAt');
      expect(status.subtitle).toHaveProperty('stats');
      expect(status.subtitle).toHaveProperty('throttle');
      expect(status.subtitle.stats).toHaveProperty('completed');
      expect(status.subtitle.stats).toHaveProperty('failed');
      expect(status.subtitle.stats).toHaveProperty('queued');
      expect(status.subtitle.throttle).toHaveProperty('state');
      expect(status.subtitle.throttle).toHaveProperty('platform');
      expect(status.subtitle.throttle).toHaveProperty('maxRetries');
      expect(status.subtitle.throttle).toHaveProperty('exhaustedCount');
      expect(status.subtitle.throttle).toHaveProperty('platforms');

      expect(status).toHaveProperty('summary');
      expect(status.summary).toHaveProperty('queueLength');
      expect(status.summary).toHaveProperty('processing');
      expect(status.summary).toHaveProperty('currentVideoId');
    });

    it('exposes the queued subtitle video title in status', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ c: 0 }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      enqueueSubtitleJob({
        videoDbId: 1,
        videoId: 'abc123',
        title: 'Readable Video Title',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Channel Name',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });

      const status = getAutoPipelineStatus();
      expect(status.subtitle.currentVideoId).toBe('abc123');
      expect(status.subtitle.currentVideoTitle).toBe('Readable Video Title');
      expect(status.subtitle.currentBatchId).toBe('video:youtube:abc123');
      expect(status.subtitle.currentBatchLabel).toBe('Readable Video Title');
      expect(status.subtitle.currentBatchVideoCount).toBe(1);
    });

    it('counts multiple videos in the same custom batch as one logical job batch', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ c: 0 }),
          all: vi.fn().mockReturnValue([]),
        }),
      });

      enqueueSubtitleJob({
        videoDbId: 1,
        videoId: 'batch-a',
        title: 'Batch Video A',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Channel Name',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
        batchId: 'manual-batch:1',
        batchLabel: '手动批次 #1',
        batchSize: 2,
      });
      enqueueSubtitleJob({
        videoDbId: 2,
        videoId: 'batch-b',
        title: 'Batch Video B',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Channel Name',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
        batchId: 'manual-batch:1',
        batchLabel: '手动批次 #1',
        batchSize: 2,
      });

      const status = getAutoPipelineStatus();

      expect(status.subtitle.queueLength).toBe(1);
      expect(status.subtitle.videoCount).toBe(2);
      expect(status.subtitle.currentBatchId).toBe('manual-batch:1');
      expect(status.subtitle.currentBatchLabel).toBe('手动批次 #1');
      expect(status.subtitle.currentBatchVideoCount).toBe(2);
    });

    it('falls back to the stored DB title when the queued title is just the id', () => {
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('COUNT(*) AS c FROM summary_tasks')) {
            return {
              get: vi.fn().mockReturnValue({ c: 0 }),
              all: vi.fn().mockReturnValue([]),
            };
          }
          if (
            sql.includes(
              'SELECT title FROM videos WHERE video_id = ? AND platform = ?',
            )
          ) {
            return {
              get: vi.fn().mockReturnValue({ title: 'Stored Title' }),
            };
          }
          return {
            get: vi.fn().mockReturnValue({ c: 0 }),
            all: vi.fn().mockReturnValue([]),
          };
        }),
      });

      enqueueSubtitleJob({
        videoDbId: 1,
        videoId: 'abc123',
        title: 'abc123',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Channel Name',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });

      const status = getAutoPipelineStatus();
      expect(status.subtitle.currentVideoTitle).toBe('Stored Title');
    });

    it('reports subtitle backoff timing and exhausted retry state', () => {
      mockGetEffectiveIntervalMs.mockReturnValue(60_000);
      mockGetRateLimitCooldownRemainingMs.mockReturnValue(0);
      mockGetSubtitleBackoffState.mockReturnValue({
        consecutiveErrors: 2,
        multiplier: 4,
        lastErrorAt: '2026-03-23T12:00:00.000Z',
        rateLimitedUntil: null,
      });
      mockGetSubtitleBrowserFetchConfig.mockReturnValue({
        maxRetries: 2,
        updatedAt: null,
      });
      mockGetDb.mockReturnValue({
        prepare: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('COUNT(*) AS c FROM summary_tasks')) {
            return {
              get: vi.fn().mockReturnValue({ c: 0 }),
              all: vi.fn().mockReturnValue([]),
            };
          }
          if (
            sql.includes('FROM videos') &&
            sql.includes('subtitle_retry_count')
          ) {
            return {
              get: vi.fn().mockReturnValue({ c: 3 }),
              all: vi.fn().mockReturnValue([]),
            };
          }
          return {
            get: vi.fn().mockReturnValue({ c: 0 }),
            all: vi.fn().mockReturnValue([]),
          };
        }),
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-23T12:00:00.000Z'));

      enqueueSubtitleJob({
        videoDbId: 1,
        videoId: 'abc123',
        title: 'Readable Video Title',
        platform: 'youtube',
        channelId: 'UC123',
        channelName: 'Channel Name',
        intentName: '工作',
        enqueuedAt: new Date().toISOString(),
        priority: 1,
      });

      const globalKey = Symbol.for('folo-auto-pipeline');
      (
        globalThis as typeof globalThis & {
          [key: symbol]: {
            lastSubtitleStartedAt?: {
              youtube: number | null;
              bilibili: number | null;
            };
          };
        }
      )[globalKey].lastSubtitleStartedAt = {
        youtube: Date.now(),
        bilibili: null,
      };

      const status = getAutoPipelineStatus();

      expect(status.subtitle.nextRunAt).toBe('2026-03-23T12:01:00.000Z');
      expect(status.subtitle.throttle).toMatchObject({
        state: 'exhausted',
        platform: 'youtube',
        multiplier: 4,
        consecutiveErrors: 2,
        maxRetries: 2,
        exhaustedCount: 3,
      });
      expect(status.subtitle.throttle.platforms.youtube).toMatchObject({
        state: 'exhausted',
        multiplier: 4,
        consecutiveErrors: 2,
        maxRetries: 2,
        exhaustedCount: 3,
        nextRunAt: '2026-03-23T12:01:00.000Z',
        intervalMs: 60_000,
      });

      vi.useRealTimers();
    });
  });
});
