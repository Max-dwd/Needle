import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { type SummaryChapter, findChapterIndexForSeconds } from '@/lib/summary-chapters';
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
  followMode?: boolean;
  onCursorChapterChange?: (index: number | null) => void;
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
  followMode = false,
  onCursorChapterChange,
}: PlayerBottomBarProps) {
  const [isDetailedMode, setIsDetailedMode] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  
  const [hoverActive, setHoverActive] = useState(false);
  const [cursorSeconds, setCursorSeconds] = useState(0);
  const [cursorChapterIndex, setCursorChapterIndex] = useState<number | -1>(-1);
  const [tooltipLeft, setTooltipLeft] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (e.key === 'Shift') {
        setIsDetailedMode((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, x / rect.width));
    const cSecs = ratio * duration;
    setCursorSeconds(cSecs);

    const cIndex = findChapterIndexForSeconds(chapters, cSecs);
    if (cIndex !== cursorChapterIndex) {
      setCursorChapterIndex(cIndex);
      onCursorChapterChange?.(cIndex === -1 ? null : cIndex);
    }

    let tWidth = 320;
    if (tooltipRef.current) {
      tWidth = tooltipRef.current.offsetWidth;
    }
    const tooltipCenterViewport = e.clientX;
    const minCenter = tWidth / 2 + 8;
    const maxCenter = window.innerWidth - tWidth / 2 - 8;
    const clampedCenter = Math.max(minCenter, Math.min(tooltipCenterViewport, maxCenter));
    setTooltipLeft(clampedCenter - rect.left);
  };

  const handleMouseEnter = () => {
    setHoverActive(true);
  };

  const handleMouseLeave = () => {
    setHoverActive(false);
    if (cursorChapterIndex !== -1) {
      setCursorChapterIndex(-1);
      onCursorChapterChange?.(null);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    onSeek(ratio * duration);
  };

  useLayoutEffect(() => {
    if (hoverActive && tooltipRef.current && trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect();
      const tooltipCenterViewport = rect.left + tooltipLeft;
      const tWidth = tooltipRef.current.offsetWidth;
      const minCenter = tWidth / 2 + 8;
      const maxCenter = window.innerWidth - tWidth / 2 - 8;
      const clampedCenter = Math.max(minCenter, Math.min(tooltipCenterViewport, maxCenter));
      if (clampedCenter !== tooltipCenterViewport) {
        setTooltipLeft(clampedCenter - rect.left);
      }
    }
  }, [isDetailedMode, hoverActive, tooltipLeft]);

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {followMode && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--accent-purple)',
              display: 'flex',
              alignItems: 'center',
              fontWeight: 600,
            }}
          >
            ↓ 追随
          </div>
        )}
        <div
          style={{
            fontSize: 12,
            color: playbackRate === 1 ? 'var(--text-muted)' : 'var(--accent-purple)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {playbackRate.toFixed(playbackRate % 1 === 0 ? 0 : 2)}×
        </div>
      </div>

      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentSeconds}
        aria-valuetext={formatSecondsLabel(currentSeconds)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        onClick={handleProgressClick}
        style={{
          position: 'relative',
          flex: 1,
          height: 6,
          padding: '8px 0',
          backgroundClip: 'content-box',
          display: 'flex',
          alignItems: 'center',
          cursor: duration > 0 ? 'pointer' : 'default',
        }}
      >
        {/* 1. Visual Layer: Background, Progress, and Separators. Clips to track rounds. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 6,
            borderRadius: 3,
            overflow: 'hidden',
            background: 'var(--bg-hover)',
            pointerEvents: 'none',
          }}
        >
          {/* Progress fill */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${progressRatio * 100}%`,
              background: 'var(--accent-purple)',
              opacity: 0.75,
            }}
          />

          {/* Separators: Rendered on top of progress to keep them visible */}
          {hasChapters &&
            chapters.map((ch, i) => {
              if (i === 0) return null;
              const leftPct =
                (Math.min(duration, Math.max(0, ch.seconds)) / duration) * 100;
              return (
                <div
                  key={`sep-${i}`}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    width: 2,
                    height: '100%',
                    background: 'var(--bg-secondary)',
                    zIndex: 1,
                  }}
                />
              );
            })}
        </div>

        {/* 2. visual thick layer for hover */}
        {hasChapters && hoverActive && cursorChapterIndex !== -1 && (() => {
          const ch = chapters[cursorChapterIndex];
          if (!ch) return null;
          const startSeconds = Math.min(duration, Math.max(0, ch.seconds));
          const nextSeconds = Math.min(
            duration,
            Math.max(startSeconds, chapters[cursorChapterIndex + 1]?.seconds ?? duration),
          );
          const segDuration = nextSeconds - startSeconds;
          if (segDuration <= 0) return null;
          const leftPct = (startSeconds / duration) * 100;
          const widthPct = (segDuration / duration) * 100;
          
          return (
            <div
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                top: 'calc(50% - 5px)',
                height: 10,
                background: 'var(--accent-purple)',
                opacity: 0.9,
                borderRadius: 3,
                transition: 'top 80ms, height 80ms, opacity 80ms',
                zIndex: 2,
              }}
            />
          );
        })()}

        {/* 3. Interaction Layer (a11y buttons) */}
        {hasChapters && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: 6,
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
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    height: '100%',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
              );
            })}
          </div>
        )}

        {/* 4. Tooltip */}
        {hoverActive && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              bottom: 'calc(50% + 12px)',
              left: tooltipLeft,
              transform: 'translateX(-50%)',
            }}
            className="player-bottom-bar-tooltip"
          >
            <div
              ref={tooltipRef}
              style={{
                position: 'relative',
                left: 0,
                maxWidth: isDetailedMode ? 500 : 320,
                width: 'max-content',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 14px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                pointerEvents: 'none',
                zIndex: 100,
                transition: 'width 120ms',
              }}
            >
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  marginBottom: cursorChapterIndex !== -1 && chapters[cursorChapterIndex] ? 2 : 0,
                }}
              >
                {formatSecondsLabel(cursorSeconds)}
              </div>
              
              {cursorChapterIndex !== -1 && chapters[cursorChapterIndex] && (
                <>
                  <div
                    style={{
                      color: 'var(--text-primary)',
                      fontSize: 13,
                      fontWeight: 600,
                      display: '-webkit-box',
                      WebkitLineClamp: isDetailedMode ? 'none' : 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      whiteSpace: 'normal',
                      lineHeight: 1.4,
                    }}
                  >
                    {chapters[cursorChapterIndex].title}
                  </div>
                  {isDetailedMode && chapters[cursorChapterIndex].body && (
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
                        markdown={chapters[cursorChapterIndex].body}
                        video={video}
                        onTimestampClick={onSeek}
                        tone="dark"
                        fontSizeVariant="compact"
                        hideTimestamps={true}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {trailing && <div style={{ marginLeft: 'auto' }}>{trailing}</div>}
    </div>
  );
}

