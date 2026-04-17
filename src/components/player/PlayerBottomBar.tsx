import React, { useState, useEffect, useRef } from 'react';
import type { SummaryChapter } from '@/lib/summary-chapters';
import type { VideoWithMeta } from '@/types';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { formatSecondsLabel } from '@/lib/format';

interface PlayerBottomBarProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentSeconds: number;
  duration: number; // 0 表示未知
  playbackRate: number;
  chapters: SummaryChapter[];
  onSeek: (seconds: number) => void;
  video: VideoWithMeta;
  disabled?: boolean; // 播放源尚未就绪时置灰
  trailing?: React.ReactNode; // B 站画质/错误/重试按钮插槽
}

export default function PlayerBottomBar({
  isPlaying,
  onTogglePlay,
  currentSeconds,
  duration,
  playbackRate,
  chapters,
  onSeek,
  video,
  disabled,
  trailing,
}: PlayerBottomBarProps) {
  const [hoveredChapterIndex, setHoveredChapterIndex] = useState<number | null>(
    null,
  );
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [tooltipLeft, setTooltipLeft] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    if (hoveredChapterIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftHeld(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [hoveredChapterIndex]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setTrackWidth((current) => (current === rect.width ? current : rect.width));
    setTooltipLeft(Math.max(8, Math.min(x, rect.width - 8)));
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    onSeek(ratio * duration);
  };

  const progressRatio =
    duration > 0 ? Math.min(1, Math.max(0, currentSeconds / duration)) : 0;

  const hasChapters = chapters.length > 0 && duration > 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 48,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        gap: 16,
      }}
    >
      <button
        onClick={onTogglePlay}
        disabled={disabled}
        aria-label={isPlaying ? '暂停' : '播放'}
        onMouseDown={(e) => e.preventDefault()}
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'var(--bg-hover)',
          border: 'none',
          color: 'var(--text-primary)',
          fontSize: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          flexShrink: 0,
        }}
      >
        {isPlaying ? 'Ⅱ' : '▶'}
      </button>

      <div
        style={{
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-primary)',
          flexShrink: 0,
        }}
      >
        {formatSecondsLabel(currentSeconds)} / {formatSecondsLabel(duration)}
      </div>

      <div
        style={{
          fontSize: 12,
          color:
            playbackRate === 1 ? 'var(--text-muted)' : 'var(--accent-purple)',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {playbackRate.toFixed(playbackRate % 1 === 0 ? 0 : 2)}×
      </div>

      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentSeconds}
        aria-valuetext={formatSecondsLabel(currentSeconds)}
        onMouseLeave={() => {
          setHoveredChapterIndex(null);
          setIsShiftHeld(false);
        }}
        onMouseMove={handleMouseMove}
        onClick={handleProgressClick}
        style={{
          position: 'relative',
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--bg-hover)',
          display: 'flex',
          alignItems: 'center',
          cursor: duration > 0 ? 'pointer' : 'default',
        }}
      >
        {hasChapters && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
            }}
          >
            {chapters.map((ch, i) => {
              const startSeconds = Math.min(duration, Math.max(0, ch.seconds));
              const nextSeconds = Math.min(
                duration,
                Math.max(startSeconds, chapters[i + 1]?.seconds ?? duration),
              );
              const segDuration = nextSeconds - startSeconds;
              if (segDuration <= 0) return null;
              const leftPct = (startSeconds / duration) * 100;
              const widthPct = (segDuration / duration) * 100;
              return (
                <div
                  key={i}
                  role="button"
                  aria-label={`跳转到章节：${ch.title}（${formatSecondsLabel(ch.seconds)}）`}
                  onMouseEnter={(event) => {
                    setHoveredChapterIndex(i);
                    setIsShiftHeld(event.shiftKey);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(ch.seconds);
                  }}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    height: '100%',
                    background: 'var(--bg-hover)',
                    borderRadius: 3,
                    boxShadow:
                      i > 0 ? 'inset 2px 0 0 var(--bg-secondary)' : undefined,
                  }}
                />
              );
            })}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progressRatio * 100}%`,
            background: 'var(--accent-purple)',
            opacity: 0.75,
            borderRadius: 3,
            pointerEvents: 'none',
            mixBlendMode: 'normal',
          }}
        />

        {hoveredChapterIndex !== null && chapters[hoveredChapterIndex] && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: Math.max(
                8,
                Math.min(tooltipLeft, Math.max(8, trackWidth - 8)),
              ),
              transform: 'translateX(-50%)',
            }}
            className="player-bottom-bar-tooltip"
          >
            <div
              style={{
                position: 'relative',
                left: 0,
                transform: `translateX(calc(-50%))`,
                maxWidth: isShiftHeld ? 500 : 320,
                width: 'max-content',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 14px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                pointerEvents: 'none',
                zIndex: 100,
                transition: 'all 120ms',
              }}
            >
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  marginBottom: 2,
                }}
              >
                {formatSecondsLabel(chapters[hoveredChapterIndex].seconds)}
              </div>
              <div
                style={{
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontWeight: 600,
                  display: '-webkit-box',
                  WebkitLineClamp: isShiftHeld ? 'none' : 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  whiteSpace: 'normal',
                  lineHeight: 1.4,
                }}
              >
                {chapters[hoveredChapterIndex].title}
              </div>
              {isShiftHeld && chapters[hoveredChapterIndex].body && (
                <div
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    marginTop: 6,
                    maxHeight: 'min(600px, 80vh)',
                    overflowY: 'auto',
                    pointerEvents: 'auto',
                  }}
                >
                  <MarkdownRenderer
                    markdown={chapters[hoveredChapterIndex].body}
                    video={video}
                    onTimestampClick={onSeek}
                    tone="dark"
                    fontSizeVariant="compact"
                    hideTimestamps={true}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {trailing && <div style={{ marginLeft: 'auto' }}>{trailing}</div>}
    </div>
  );
}
