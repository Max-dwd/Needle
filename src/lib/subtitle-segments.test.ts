import { describe, expect, it } from 'vitest';
import {
  findActiveSegmentIndex,
  getOverlayEligibleSubtitleSegments,
  inferSubtitleSegmentStyle,
} from './subtitle-segments';

describe('findActiveSegmentIndex', () => {
  const segments = [
    { start: 0, end: 5, text: 'a' },
    { start: 5, end: 10, text: 'b' },
    { start: 10, end: 15, text: 'c' },
  ];

  it('returns -1 for empty segments', () => {
    expect(findActiveSegmentIndex([], 3)).toBe(-1);
  });

  it('returns 0 when time is before any segment start but segments exist', () => {
    expect(findActiveSegmentIndex(segments, -1)).toBe(0);
  });

  it('returns the last segment whose start <= currentTime', () => {
    expect(findActiveSegmentIndex(segments, 0)).toBe(0);
    expect(findActiveSegmentIndex(segments, 4.9)).toBe(0);
    expect(findActiveSegmentIndex(segments, 5)).toBe(1);
    expect(findActiveSegmentIndex(segments, 7)).toBe(1);
    expect(findActiveSegmentIndex(segments, 10)).toBe(2);
    expect(findActiveSegmentIndex(segments, 999)).toBe(2);
  });
});

describe('overlay subtitle segment eligibility', () => {
  it('allows fine-grained segments even when an older payload is tagged coarse', () => {
    const segments = [
      { start: 0, end: 6, text: 'a' },
      { start: 6, end: 18, text: 'b' },
      { start: 18, end: 38, text: 'c' },
    ];

    expect(inferSubtitleSegmentStyle(segments)).toBe('fine');
    expect(getOverlayEligibleSubtitleSegments(segments, 'coarse')).toBe(
      segments,
    );
  });

  it('tolerates a small fraction of outlier long segments and filters them from the overlay', () => {
    // 模拟 AI 转录:大量短段 + 个别分片边界产生的超长段
    const segments = Array.from({ length: 100 }, (_, i) => ({
      start: i * 8,
      end: i * 8 + 7,
      text: `s${i}`,
    }));
    segments.push({ start: 800, end: 930, text: 'outlier-long' });

    expect(inferSubtitleSegmentStyle(segments)).toBe('fine');
    const eligible = getOverlayEligibleSubtitleSegments(segments);
    expect(eligible).toHaveLength(100);
    expect(eligible.some((s) => s.text === 'outlier-long')).toBe(false);
  });

  it('keeps genuinely coarse subtitle segments out of the overlay', () => {
    const segments = [
      { start: 0, end: 180, text: 'a' },
      { start: 180, end: 360, text: 'b' },
    ];

    expect(inferSubtitleSegmentStyle(segments)).toBe('coarse');
    expect(getOverlayEligibleSubtitleSegments(segments, 'coarse')).toEqual([]);
  });
});
