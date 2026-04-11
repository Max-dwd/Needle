import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAppSetting = vi.hoisted(() => vi.fn());
const mockGetPositiveIntAppSetting = vi.hoisted(() => vi.fn());
const mockSetAppSetting = vi.hoisted(() => vi.fn());

vi.mock('./app-settings', () => ({
  getAppSetting: mockGetAppSetting,
  getPositiveIntAppSetting: mockGetPositiveIntAppSetting,
  setAppSetting: mockSetAppSetting,
}));

import {
  __subtitleBackoffTestUtils,
  getAllSubtitleBackoffStates,
  getEffectiveIntervalMs,
  getRateLimitCooldownRemainingMs,
  getSubtitleBackoffState,
  recordSubtitleError,
  recordSubtitleRateLimit,
  recordSubtitleSuccess,
} from './subtitle-backoff';

describe('subtitle backoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __subtitleBackoffTestUtils.clearCache();
    mockGetAppSetting.mockReturnValue(null);
    mockGetPositiveIntAppSetting.mockReturnValue(20);
  });

  it('keeps independent state per platform', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        youtube: {
          consecutiveErrors: 2,
          multiplier: 4,
          lastErrorAt: '2026-03-30T10:00:00.000Z',
          rateLimitedUntil: null,
        },
        bilibili: {
          consecutiveErrors: 0,
          multiplier: 1,
          lastErrorAt: null,
          rateLimitedUntil: null,
        },
      }),
    );

    expect(getSubtitleBackoffState('youtube')).toMatchObject({
      consecutiveErrors: 2,
      multiplier: 4,
    });
    expect(getSubtitleBackoffState('bilibili')).toMatchObject({
      consecutiveErrors: 0,
      multiplier: 1,
    });
    expect(getEffectiveIntervalMs('youtube')).toBe(80_000);
    expect(getEffectiveIntervalMs('bilibili')).toBe(20_000);
  });

  it('migrates legacy shared state onto both platforms', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        consecutiveErrors: 1,
        multiplier: 2,
        lastErrorAt: '2026-03-30T10:00:00.000Z',
      }),
    );

    expect(getAllSubtitleBackoffStates()).toEqual({
      youtube: {
        consecutiveErrors: 1,
        multiplier: 2,
        lastErrorAt: '2026-03-30T10:00:00.000Z',
        rateLimitedUntil: null,
      },
      bilibili: {
        consecutiveErrors: 1,
        multiplier: 2,
        lastErrorAt: '2026-03-30T10:00:00.000Z',
        rateLimitedUntil: null,
      },
    });
  });

  it('records errors and resets only the targeted platform', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        youtube: {
          consecutiveErrors: 0,
          multiplier: 1,
          lastErrorAt: null,
          rateLimitedUntil: null,
        },
        bilibili: {
          consecutiveErrors: 2,
          multiplier: 4,
          lastErrorAt: '2026-03-30T10:00:00.000Z',
          rateLimitedUntil: null,
        },
      }),
    );

    const youtubeState = recordSubtitleError('youtube');
    expect(youtubeState).toMatchObject({
      consecutiveErrors: 1,
      multiplier: 2,
    });

    const bilibiliState = recordSubtitleSuccess('bilibili');
    expect(bilibiliState).toEqual({
      consecutiveErrors: 0,
      multiplier: 2,
      lastErrorAt: null,
      rateLimitedUntil: null,
    });

    expect(mockSetAppSetting).toHaveBeenCalled();
    const persistedPayload = JSON.parse(
      mockSetAppSetting.mock.calls.at(-1)?.[1] || '{}',
    ) as ReturnType<typeof getAllSubtitleBackoffStates>;
    expect(persistedPayload.youtube).toMatchObject({
      consecutiveErrors: 1,
      multiplier: 2,
    });
    expect(persistedPayload.bilibili).toEqual({
      consecutiveErrors: 0,
      multiplier: 2,
      lastErrorAt: null,
      rateLimitedUntil: null,
    });
  });

  it('jumps to aggressive cooldown on rate limit and recovers gradually', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T10:00:00.000Z'));

    const state = recordSubtitleRateLimit('youtube');
    expect(state).toMatchObject({
      consecutiveErrors: 1,
      multiplier: 32,
      lastErrorAt: '2026-03-31T10:00:00.000Z',
      rateLimitedUntil: '2026-03-31T10:05:00.000Z',
    });
    expect(getRateLimitCooldownRemainingMs('youtube')).toBe(300_000);

    const recovered = recordSubtitleSuccess('youtube');
    expect(recovered).toEqual({
      consecutiveErrors: 0,
      multiplier: 16,
      lastErrorAt: null,
      rateLimitedUntil: null,
    });

    vi.useRealTimers();
  });
});
