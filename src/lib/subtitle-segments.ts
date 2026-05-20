export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * 根据当前播放时间返回当前活跃的字幕段索引。
 * 选取最后一个 `start <= currentSeconds` 的段。
 * segments 为空返回 -1。
 */
export function findActiveSegmentIndex(
  segments: SubtitleSegment[],
  currentSeconds: number,
): number {
  if (!segments.length) return -1;
  return segments.reduce(
    (bestIdx, seg, idx) => (seg.start <= currentSeconds ? idx : bestIdx),
    0,
  );
}
