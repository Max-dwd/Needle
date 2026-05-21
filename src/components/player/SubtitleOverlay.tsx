'use client';

import { useMemo } from 'react';
import {
  findActiveSegmentIndex,
  type SubtitleSegment,
} from '@/lib/subtitle-segments';

interface SubtitleOverlayProps {
  segments: SubtitleSegment[];
  currentTime: number;
  enabled: boolean;
  /** 底部偏移像素，用于避让 PlayerBottomBar 或其他控件。默认 48px。 */
  bottomOffset?: number;
  /** 字体大小像素（桌面）。移动端通过 CSS media query 降一级。 */
  fontSize?: number;
}

export default function SubtitleOverlay({
  segments,
  currentTime,
  enabled,
  bottomOffset = 48,
  fontSize = 20,
}: SubtitleOverlayProps) {
  const activeIndex = useMemo(
    () => findActiveSegmentIndex(segments, currentTime),
    [segments, currentTime],
  );

  if (!enabled) return null;
  if (activeIndex < 0) return null;

  const segment = segments[activeIndex];
  if (!segment) return null;
  const text = segment.text?.trim();
  if (!text) return null;
  const caption = segment.speaker ? `[${segment.speaker}] ${text}` : text;

  // 当前段已过期则不显示（seg.end 允许略超，保留 0.5s 宽容）
  if (typeof segment.end === 'number' && currentTime > segment.end + 0.5) {
    return null;
  }

  return (
    <div
      className="subtitle-overlay-caption"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: bottomOffset,
        transform: 'translateX(-50%)',
        minWidth: '70%',
        maxWidth: '90%',
        padding: '6px 14px',
        background: 'rgba(0, 0, 0, 0.72)',
        color: '#fff',
        fontSize,
        lineHeight: 1.4,
        fontWeight: 500,
        borderRadius: 6,
        textAlign: 'center',
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.85)',
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        zIndex: 25,
        userSelect: 'none',
      }}
    >
      {caption}
    </div>
  );
}
