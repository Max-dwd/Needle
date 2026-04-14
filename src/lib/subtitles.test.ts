import fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { Video } from './db';

const mockHasAvailableAiBudget = vi.hoisted(() =>
  vi.fn().mockReturnValue(true),
);

vi.mock('./shared-ai-budget', () => ({
  acquireSharedAiBudget: vi.fn(),
  hasAvailableAiBudget: mockHasAvailableAiBudget,
}));

import {
  __subtitleRetryTestUtils,
  shouldRetrySubtitleFetch,
} from './subtitles';

function createVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 1,
    channel_id: 1,
    platform: 'youtube',
    video_id: 'abc123',
    title: 'Test Video',
    thumbnail_url: null,
    published_at: '2026-03-27T00:00:00.000Z',
    duration: null,
    is_read: 0,
    is_members_only: 0,
    access_status: null,
    availability_status: null,
    availability_reason: null,
    availability_checked_at: null,
    subtitle_path: null,
    subtitle_language: null,
    subtitle_format: null,
    subtitle_status: null,
    subtitle_error: null,
    subtitle_last_attempt_at: null,
    subtitle_retry_count: 0,
    subtitle_cooldown_until: null,
    members_only_checked_at: null,
    created_at: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('subtitle retry schedule', () => {
  it('does not escape to api before the first subtitle attempt', () => {
    expect(
      __subtitleRetryTestUtils.shouldEscapeToApi(
        createVideo({
          created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          subtitle_last_attempt_at: null,
        }),
        {
          source: 'global',
          maxWaitSeconds: 300,
          modelId: null,
          ruleId: null,
        },
      ),
    ).toBe(false);
  });

  it('escapes to api after the wait threshold once budget is available', () => {
    expect(
      __subtitleRetryTestUtils.shouldEscapeToApi(
        createVideo({
          created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          subtitle_last_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        }),
        {
          source: 'global',
          maxWaitSeconds: 300,
          modelId: null,
          ruleId: null,
        },
      ),
    ).toBe(true);
  });

  it('defaults retry delay to the configured subtitle interval', () => {
    expect(
      __subtitleRetryTestUtils.getSubtitleRetryDelayMs(),
    ).toBeGreaterThanOrEqual(0);
  });

  it('resets retry count for missing-like failures', () => {
    const state = __subtitleRetryTestUtils.buildFailureState(
      createVideo({ subtitle_retry_count: 2 }),
      'missing',
      'No subtitle file found',
      '2026-03-27T01:00:00.000Z',
    );

    expect(state.subtitle_retry_count).toBe(3);
  });

  it('increments retry count for generic errors', () => {
    const state = __subtitleRetryTestUtils.buildFailureState(
      createVideo({ subtitle_retry_count: 2 }),
      'error',
      'Network timeout',
      '2026-03-27T01:00:00.000Z',
    );

    expect(state.subtitle_retry_count).toBe(3);
  });

  it('treats bilibili no-subtitle empty-result errors as missing', () => {
    expect(
      __subtitleRetryTestUtils.classifySubtitleFailure(
        'error',
        'bilibili subtitle returned no data 此视频没有发现外挂或智能字幕。',
      ),
    ).toBe('missing');
  });

  it('treats membership-gated subtitle errors as missing', () => {
    expect(
      __subtitleRetryTestUtils.classifySubtitleFailure(
        'error',
        'This video is members-only and subtitles are unavailable.',
      ),
    ).toBe('missing');
  });

  it('does not record platform backoff for no-caption style failures', () => {
    expect(
      __subtitleRetryTestUtils.shouldRecordSubtitleBackoff(
        'bilibili subtitle returned no data 此视频没有发现外挂或智能字幕。',
      ),
    ).toBe(false);
  });

  it('does not record platform backoff for aborted browser timeouts', () => {
    expect(
      __subtitleRetryTestUtils.shouldRecordSubtitleBackoff(
        'browser runtime returned invalid JSON: The operation was aborted',
      ),
    ).toBe(false);
  });

  it('does not retry immediately under the default interval', () => {
    const video = createVideo({
      subtitle_status: 'missing',
      subtitle_last_attempt_at: new Date(Date.now() - 1000).toISOString(),
      subtitle_retry_count: 0,
    });
    expect(shouldRetrySubtitleFetch(video)).toBe(false);
  });

  it('does not retry while a subtitle fetch is already in progress', () => {
    const fetching = createVideo({
      subtitle_status: 'fetching',
      subtitle_last_attempt_at: new Date().toISOString(),
    });
    expect(shouldRetrySubtitleFetch(fetching)).toBe(false);
  });

  it('uses api fallback after browser retries are exhausted', () => {
    expect(
      __subtitleRetryTestUtils.getAutoApiFallbackReason(
        createVideo({
          subtitle_retry_count: 8,
          created_at: new Date().toISOString(),
          subtitle_last_attempt_at: new Date().toISOString(),
        }),
        {
          source: 'global',
          maxWaitSeconds: 0,
          modelId: null,
          ruleId: null,
        },
        'after-browser',
      ),
    ).toContain('browser retries exhausted');
  });

  it('cleans up temp subtitle directories asynchronously', async () => {
    const pendingCleanup = new Promise<void>(() => {});
    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockReturnValue(pendingCleanup as Promise<void>);

    expect(() => {
      __subtitleRetryTestUtils.cleanupTempDirBestEffort('/tmp/folo-test');
    }).not.toThrow();

    await Promise.resolve();

    expect(rmSpy).toHaveBeenCalledWith('/tmp/folo-test', {
      recursive: true,
      force: true,
    });

    rmSpy.mockRestore();
  });
});

describe('segmented ai subtitle helpers', () => {
  it('parses video durations into seconds', () => {
    expect(__subtitleRetryTestUtils.parseVideoDurationSeconds('14:59')).toBe(
      899,
    );
    expect(__subtitleRetryTestUtils.parseVideoDurationSeconds('15:00')).toBe(
      900,
    );
    expect(__subtitleRetryTestUtils.parseVideoDurationSeconds('1:02:03')).toBe(
      3723,
    );
    expect(__subtitleRetryTestUtils.parseVideoDurationSeconds('')).toBeNull();
  });

  it('appends per-chunk timestamp constraints to the base prompt', () => {
    const prompt = __subtitleRetryTestUtils.buildSegmentedSubtitlePrompt(
      '输出完整字幕',
      '只处理当前切片，时间戳从 00:00 开始。',
      0,
      900,
    );

    expect(prompt).toContain('输出完整字幕');
    expect(prompt).toContain('只处理当前切片');
    expect(prompt).toContain('00:00 到 15:00');
    expect(prompt).toContain('原视频 00:00 到 15:00');
  });

  it('shifts chunk-relative timestamps back to global time', () => {
    expect(
      __subtitleRetryTestUtils.shiftSubtitleSegments(
        [{ start: 0, end: 23, text: '主持人：开场' }],
        900,
      ),
    ).toEqual([{ start: 900, end: 923, text: '主持人：开场' }]);
  });
});
