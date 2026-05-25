export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
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

  let low = 0;
  let high = segments.length - 1;
  let bestIndex = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (segments[mid].start <= currentSeconds) {
      bestIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestIndex;
}
