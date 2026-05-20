import { describe, expect, it } from 'vitest';
import { findActiveSegmentIndex } from './subtitle-segments';

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
