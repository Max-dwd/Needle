export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export type SubtitleSegmentStyle = 'coarse' | 'fine';

const FINE_SEGMENT_MAX_SECONDS = 45;
const FINE_SEGMENT_AVG_SECONDS = 20;

function getValidDurations(segments: SubtitleSegment[]): number[] {
  return segments
    .map((segment) => segment.end - segment.start)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
}

export function hasFineGrainedSubtitleSegments(
  segments: SubtitleSegment[],
): boolean {
  const durations = getValidDurations(segments);
  if (durations.length === 0) return false;

  // AI 转录链路偶尔产出个别超长段(分片边界、长静音等),
  // 用 p95 而不是 max 判定,避免 1% 的离群段否决整份字幕
  const sorted = [...durations].sort((a, b) => a - b);
  const p95Duration = sorted[Math.floor((sorted.length - 1) * 0.95)];
  const averageDuration =
    durations.reduce((total, duration) => total + duration, 0) /
    durations.length;

  return (
    p95Duration <= FINE_SEGMENT_MAX_SECONDS &&
    averageDuration <= FINE_SEGMENT_AVG_SECONDS
  );
}

export function inferSubtitleSegmentStyle(
  segments: SubtitleSegment[],
): SubtitleSegmentStyle {
  return hasFineGrainedSubtitleSegments(segments) ? 'fine' : 'coarse';
}

export function getOverlayEligibleSubtitleSegments(
  segments: SubtitleSegment[],
  segmentStyle?: SubtitleSegmentStyle,
): SubtitleSegment[] {
  if (segments.length === 0) return [];
  if (segmentStyle !== 'fine' && !hasFineGrainedSubtitleSegments(segments)) {
    return [];
  }
  // 离群超长段不进悬浮层:浮层在这些区间自动隐藏,
  // 而不是把一大块文本糊在画面上
  const eligible = segments.filter((segment) => {
    const duration = segment.end - segment.start;
    return !(Number.isFinite(duration) && duration > FINE_SEGMENT_MAX_SECONDS);
  });
  return eligible.length === segments.length ? segments : eligible;
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
