import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatSecondsLabel,
  formatSecondsToDisplay,
  getSubtitleBadgeLabel,
  getSubtitleDisplayState,
  hasSubtitleReady,
  normalizeCommentUrl,
  parseSeekSeconds,
  timeAgo,
} from '@/lib/format';

describe('formatSecondsToDisplay', () => {
  it('formats zero seconds as 00:00', () => {
    expect(formatSecondsToDisplay(0)).toBe('00:00');
  });

  it('formats small values as minutes and seconds', () => {
    expect(formatSecondsToDisplay(65)).toBe('01:05');
  });

  it('formats large values as total minutes and seconds', () => {
    expect(formatSecondsToDisplay(3671)).toBe('61:11');
  });

  it('clamps negative values to zero', () => {
    expect(formatSecondsToDisplay(-10)).toBe('00:00');
  });
});

describe('timeAgo', () => {
  const fixedNow = new Date('2026-03-23T12:00:00.000Z').getTime();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 刚刚 for dates within one minute', () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    expect(timeAgo('2026-03-23T11:59:31.000Z')).toBe('刚刚');
  });

  it('returns minutes ago for dates within one hour', () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    expect(timeAgo('2026-03-23T11:55:00.000Z')).toBe('5分钟前');
  });

  it('returns hours ago for dates within one day', () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    expect(timeAgo('2026-03-23T09:00:00.000Z')).toBe('3小时前');
  });

  it('returns days ago for dates within one week', () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    expect(timeAgo('2026-03-21T12:00:00.000Z')).toBe('2天前');
  });

  it('returns raw published text for non-date values', () => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    expect(timeAgo('3天前')).toBe('3天前');
    expect(timeAgo('12小时前')).toBe('12小时前');
  });
});

describe('formatSecondsLabel', () => {
  it('formats seconds under one hour with mm:ss', () => {
    expect(formatSecondsLabel(125)).toBe('02:05');
  });

  it('formats durations over one hour with h:mm:ss', () => {
    expect(formatSecondsLabel(3661)).toBe('1:01:01');
  });

  it('clamps negative values to zero', () => {
    expect(formatSecondsLabel(-1)).toBe('00:00');
  });
});

describe('getSubtitleBadgeLabel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 🇨 only for fetched subtitles', () => {
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'fetched',
        subtitle_cooldown_until: null,
      }),
    ).toBe('🇨');
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'empty',
        subtitle_cooldown_until: null,
      }),
    ).toBeNull();
  });

  it('returns ! for error and legacy cooldown statuses', () => {
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'error',
        subtitle_cooldown_until: null,
      }),
    ).toBe('!');
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'cooldown',
        subtitle_cooldown_until: '2026-03-23T12:01:05.000Z',
      }),
    ).toBe('!');
  });

  it('returns 抓取中 while subtitles are fetching', () => {
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'fetching',
        subtitle_cooldown_until: null,
      }),
    ).toBe('抓取中');
  });

  it('returns null for unknown statuses', () => {
    expect(
      getSubtitleBadgeLabel({
        subtitle_status: 'pending',
        subtitle_cooldown_until: null,
      }),
    ).toBeNull();
  });
});

describe('getSubtitleDisplayState', () => {
  it('maps fetched to ready', () => {
    expect(
      getSubtitleDisplayState({
        subtitle_status: 'fetched',
        subtitle_cooldown_until: null,
      }),
    ).toBe('ready');
  });

  it('treats cooldownUntil as cooldown', () => {
    expect(
      getSubtitleDisplayState({
        subtitle_status: 'error',
        subtitle_cooldown_until: '2026-03-23T12:01:05.000Z',
      }),
    ).toBe('cooldown');
  });

  it('maps missing and empty to missing', () => {
    expect(
      getSubtitleDisplayState({
        subtitle_status: 'missing',
        subtitle_cooldown_until: null,
      }),
    ).toBe('missing');
    expect(
      getSubtitleDisplayState({
        subtitle_status: 'empty',
        subtitle_cooldown_until: null,
      }),
    ).toBe('missing');
  });
});

describe('hasSubtitleReady', () => {
  it('returns true only for ready subtitles', () => {
    expect(
      hasSubtitleReady({
        subtitle_status: 'fetched',
        subtitle_cooldown_until: null,
      }),
    ).toBe(true);
    expect(
      hasSubtitleReady({
        subtitle_status: 'fetching',
        subtitle_cooldown_until: null,
      }),
    ).toBe(false);
  });
});

describe('normalizeCommentUrl', () => {
  it('keeps absolute http and https URLs unchanged', () => {
    expect(normalizeCommentUrl('https://example.com/comments')).toBe(
      'https://example.com/comments',
    );
    expect(normalizeCommentUrl('http://example.com/comments')).toBe(
      'http://example.com/comments',
    );
  });

  it('normalizes root-relative YouTube comment URLs', () => {
    expect(normalizeCommentUrl('/watch?v=abc123&lc=comment')).toBe(
      'https://www.youtube.com/watch?v=abc123&lc=comment',
    );
  });

  it('returns null for undefined and unsupported URL shapes', () => {
    expect(normalizeCommentUrl(undefined)).toBeNull();
    expect(normalizeCommentUrl('watch?v=abc123')).toBeNull();
    expect(normalizeCommentUrl('mailto:test@example.com')).toBeNull();
  });
});

describe('parseSeekSeconds', () => {
  const youtubeVideo = { platform: 'youtube' as const, video_id: 'abc123' };
  const bilibiliVideo = {
    platform: 'bilibili' as const,
    video_id: 'BV1xx411c7mD',
  };

  it('parses YouTube timestamps from t and start query parameters', () => {
    expect(
      parseSeekSeconds(
        'https://www.youtube.com/watch?v=abc123&t=90s',
        youtubeVideo,
      ),
    ).toBe(90);
    expect(
      parseSeekSeconds('https://youtu.be/abc123?start=1m30s', youtubeVideo),
    ).toBe(90);
  });

  it('parses Bilibili timestamps from the t query parameter', () => {
    expect(
      parseSeekSeconds(
        'https://www.bilibili.com/video/BV1xx411c7mD?t=75',
        bilibiliVideo,
      ),
    ).toBe(75);
  });

  it('returns null for URLs pointing at the wrong video id', () => {
    expect(
      parseSeekSeconds(
        'https://www.youtube.com/watch?v=other&t=30s',
        youtubeVideo,
      ),
    ).toBeNull();
    expect(
      parseSeekSeconds(
        'https://www.bilibili.com/video/BV999?t=75',
        bilibiliVideo,
      ),
    ).toBeNull();
  });

  it('returns null for unsupported or malformed URLs', () => {
    expect(
      parseSeekSeconds(
        'https://example.com/watch?v=abc123&t=90s',
        youtubeVideo,
      ),
    ).toBeNull();
    expect(parseSeekSeconds('http://[', youtubeVideo)).toBeNull();
  });

  it('returns null when timestamp parameters are missing or invalid', () => {
    expect(
      parseSeekSeconds('https://www.youtube.com/watch?v=abc123', youtubeVideo),
    ).toBeNull();
    expect(
      parseSeekSeconds(
        'https://www.bilibili.com/video/BV1xx411c7mD?t=oops',
        bilibiliVideo,
      ),
    ).toBeNull();
  });
});
