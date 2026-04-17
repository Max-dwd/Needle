import React, { useState, useEffect, useRef } from 'react';
import type { SummaryChapter } from '@/lib/summary-chapters';
import { formatSecondsLabel } from '@/lib/format';

interface PlayerBottomBarProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentSeconds: number;
  duration: number;            // 0 表示未知
  playbackRate: number;
  chapters: SummaryChapter[];
  onSeek: (seconds: number) => void;
  disabled?: boolean;          // 播放源尚未就绪时置灰
  trailing?: React.ReactNode;  // B 站画质/错误/重试按钮插槽
}

export default function PlayerBottomBar({
  isPlaying,
  onTogglePlay,
  currentSeconds,
  duration,
  playbackRate,
  chapters,
  onSeek,
  disabled,
  trailing,
}: PlayerBottomBarProps) {
  const [hoveredChapterIndex, setHoveredChapterIndex] = useState<number | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [tooltipLeft, setTooltipLeft] = useState(0);

  useEffect(() => {
    if (hoveredChapterIndex === null) {
      setIsShiftHeld(false);
      return;
    }

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
    const cw = rect.width;
    const tw = isShiftHeld ? 420 : 320; // max width
    
    // clamp center position
    const minCenter = 8 + tw / 2;
    const maxCenter = Math.max(minCenter, cw - 8 - tw / 2);
    
    // Actually, setting left strictly clamped avoids overflow.
    // If the tooltip is narrower than tw, it's safer.
    setTooltipLeft(Math.max(8, Math.min(x, cw - 8)));
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0 || chapters.length > 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    onSeek(ratio * duration);
  };

  const progressRatio = duration > 0 ? Math.min(1, Math.max(0, currentSeconds / duration)) : 0;
  
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

      <div style={{
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--text-primary)',
        flexShrink: 0,
      }}>
        {formatSecondsLabel(currentSeconds)} / {formatSecondsLabel(duration)}
      </div>

      <div style={{
        fontSize: 12,
        color: playbackRate === 1 ? 'var(--text-muted)' : 'var(--accent-purple)',
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}>
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
        onClick={hasChapters ? undefined : handleProgressClick}
        style={{
          position: 'relative',
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: hasChapters ? 'transparent' : 'var(--bg-hover)',
          display: 'flex',
          alignItems: 'center',
          cursor: duration > 0 ? 'pointer' : 'default',
        }}
      >
        {hasChapters && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            gap: 2,
          }}>
            {chapters.map((ch, i) => {
              const nextSeconds = chapters[i + 1]?.seconds ?? duration;
              const segDuration = Math.max(0, Math.min(duration, nextSeconds) - ch.seconds);
              const widthPct = (segDuration / duration) * 100;
              return (
                <div
                  key={i}
                  role="button"
                  aria-label={`跳转到章节：${ch.title}（${formatSecondsLabel(ch.seconds)}）`}
                  onMouseEnter={() => setHoveredChapterIndex(i)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(ch.seconds);
                  }}
                  style={{
                    width: `${widthPct}%`,
                    height: '100%',
                    background: 'var(--bg-hover)',
                    borderRadius: 3,
                  }}
                />
              );
            })}
          </div>
        )}

        <div style={{
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
        }} />

        {hoveredChapterIndex !== null && chapters[hoveredChapterIndex] && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: Math.max(8, Math.min(tooltipLeft, (trackRef.current?.getBoundingClientRect().width || 0) - 8)),
              transform: 'translateX(-50%)',
              // Use CSS to bound the translation
              // better: just compute transform clamp if needed, but left/right max avoids spilling.
              // Let's use simple negative margin hack if bounded.
            }}
            // To prevent overflow, we can just use CSS:
            className="player-bottom-bar-tooltip"
          >
            <div 
              style={{
                position: 'relative',
                left: 0,
                transform: `translateX(calc(-50%))`,
                maxWidth: isShiftHeld ? 420 : 320,
                width: 'max-content',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 12px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.24)',
                pointerEvents: 'none',
                zIndex: 20,
                transition: 'max-width 120ms',
              }}
            >
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 2 }}>
                {formatSecondsLabel(chapters[hoveredChapterIndex].seconds)}
              </div>
              <div style={{
                color: 'var(--text-primary)',
                fontSize: 13,
                fontWeight: 600,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                whiteSpace: 'normal',
              }}>
                {chapters[hoveredChapterIndex].title}
              </div>
              {isShiftHeld && chapters[hoveredChapterIndex].body && (
                <div style={{
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  marginTop: 6,
                  display: '-webkit-box',
                  WebkitLineClamp: 8,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {chapters[hoveredChapterIndex].body}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {trailing && (
        <div style={{ marginLeft: 'auto' }}>
          {trailing}
        </div>
      )}
    </div>
  );
}
