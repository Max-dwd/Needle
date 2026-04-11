'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { formatSecondsLabel } from '@/lib/format';

interface TimelineRangeProps {
  totalDuration: number;
  rangeStart: number;
  rangeEnd: number;
  onRangeChange: (start: number, end: number) => void;
  onSeek: (seconds: number) => void;
  currentPlayerSeconds: number;
}

export const TimelineRange: React.FC<TimelineRangeProps> = ({
  totalDuration,
  rangeStart,
  rangeEnd,
  onRangeChange,
  onSeek,
  currentPlayerSeconds,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'start' | 'end' | null>(null);
  const rafRef = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState<'start' | 'end' | null>(null);
  const [activeThumb, setActiveThumb] = useState<'start' | 'end' | null>(null);

  // Sync active thumb with player time
  useEffect(() => {
    if (!activeThumb || draggingRef.current) return;

    if (activeThumb === 'start') {
        const nextStart = Math.max(0, Math.min(currentPlayerSeconds, rangeEnd - 0.1));
        if (Math.abs(nextStart - rangeStart) > 0.01) {
            onRangeChange(nextStart, rangeEnd);
        }
    } else {
        const nextEnd = Math.min(totalDuration, Math.max(currentPlayerSeconds, rangeStart + 0.1));
        if (Math.abs(nextEnd - rangeEnd) > 0.01) {
            onRangeChange(rangeStart, nextEnd);
        }
    }
  }, [currentPlayerSeconds, activeThumb, rangeStart, rangeEnd, totalDuration, onRangeChange]);

  const calculateSeconds = useCallback((clientX: number) => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return (x / rect.width) * totalDuration;
  }, [totalDuration]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const seconds = Math.max(0, Math.min((x / rect.width) * totalDuration, totalDuration));

    const distStart = Math.abs(seconds - rangeStart);
    const distEnd = Math.abs(seconds - rangeEnd);

    // If clicking on empty space, move whichever is closer
    if (distStart < distEnd) {
      draggingRef.current = 'start';
      setIsDragging('start');
      setActiveThumb('start');
      onRangeChange(seconds, rangeEnd);
      onSeek(seconds);
    } else {
      draggingRef.current = 'end';
      setIsDragging('end');
      setActiveThumb('end');
      onRangeChange(rangeStart, seconds);
      onSeek(seconds);
    }

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;

    const seconds = calculateSeconds(e.clientX);
    
    if (draggingRef.current === 'start') {
      const nextStart = Math.min(seconds, rangeEnd - 0.1);
      onRangeChange(nextStart, rangeEnd);
      
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => onSeek(nextStart));
    } else {
      const nextEnd = Math.max(seconds, rangeStart + 0.1);
      onRangeChange(rangeStart, nextEnd);
      
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => onSeek(nextEnd));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    draggingRef.current = null;
    setIsDragging(null);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const target = e.currentTarget as HTMLElement;
    target.releasePointerCapture(e.pointerId);
  };

  const startPercent = totalDuration > 0 ? (rangeStart / totalDuration) * 100 : 0;
  const endPercent = totalDuration > 0 ? (rangeEnd / totalDuration) * 100 : 100;
  const currentPercent =
    totalDuration > 0
      ? Math.max(
          0,
          Math.min((currentPlayerSeconds / totalDuration) * 100, 100),
        )
      : 0;

  return (
    <div 
      className="timeline-range-container" 
      style={{ 
        padding: '24px 8px 32px 8px', 
        userSelect: 'none',
        position: 'relative'
      }}
      onMouseDown={(e) => {
          // Deselect if clicking container but not the track
          if (e.target === e.currentTarget) setActiveThumb(null);
      }}
    >
      {/* Time display at top */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        marginBottom: 12,
        fontSize: '11px',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono, monospace)',
        fontWeight: 500
      }}>
        <span 
            style={{ cursor: 'pointer', color: activeThumb === null ? 'var(--text-muted)' : 'var(--text-primary)' }}
            onClick={() => setActiveThumb(null)}
        >
            {activeThumb ? '点击此处取消锁定' : '00:00'}
        </span>
        <span style={{ color: 'var(--accent-purple)', fontWeight: 700 }}>
            {formatSecondsLabel(rangeStart)} - {formatSecondsLabel(rangeEnd)}
        </span>
        <span>{formatSecondsLabel(totalDuration)}</span>
      </div>

      <div 
        ref={containerRef}
        className="timeline-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          position: 'relative',
          height: '6px',
          background: 'var(--bg-hover)',
          borderRadius: '3px',
          cursor: 'pointer',
          touchAction: 'none'
        }}
      >
        {/* Playback Progress Track (faint) */}
        <div 
          style={{
            position: 'absolute',
            left: 0,
            width: `${currentPercent}%`,
            height: '100%',
            background: 'var(--accent-purple)',
            opacity: 0.1,
            borderRadius: '3px',
            pointerEvents: 'none'
          }}
        />

        {/* Selected Range Track */}
        <div 
          className="selected-track"
          style={{
            position: 'absolute',
            left: `${startPercent}%`,
            width: `${endPercent - startPercent}%`,
            height: '100%',
            background: 'var(--accent-purple)',
            borderRadius: '3px',
            pointerEvents: 'none',
            boxShadow: '0 0 8px rgba(139, 92, 246, 0.4)'
          }}
        />

        {/* Current Position Marker */}
        <div 
          className="current-pos-marker"
          style={{
            position: 'absolute',
            left: `${currentPercent}%`,
            top: '-4px',
            bottom: '-4px',
            width: '2px',
            background: '#ff4d4f',
            zIndex: 5,
            pointerEvents: 'none',
            transition: isDragging ? 'none' : 'left 0.1s linear'
          }}
        />

        {/* Start Thumb */}
        <div 
          className="timeline-thumb start-thumb"
          style={{
            position: 'absolute',
            left: `${startPercent}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '16px',
            height: '16px',
            background: activeThumb === 'start' ? 'var(--accent-purple)' : '#fff',
            border: `2px solid var(--accent-purple)`,
            borderRadius: '50%',
            zIndex: 10,
            cursor: 'grab',
            boxShadow: activeThumb === 'start' 
                ? '0 0 0 4px rgba(139, 92, 246, 0.2), 0 2px 4px rgba(0,0,0,0.2)' 
                : '0 2px 4px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'box-shadow 0.2s, background-color 0.2s'
          }}
        >
            {/* Active Indicator Pulse */}
            {activeThumb === 'start' && !isDragging && (
                <div style={{
                    position: 'absolute',
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    border: '2px solid var(--accent-purple)',
                    animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
                    pointerEvents: 'none'
                }} />
            )}

            {/* Label for start thumb */}
            <div style={{
                position: 'absolute',
                top: '20px',
                fontSize: '10px',
                color: 'var(--accent-purple)',
                fontWeight: 600,
                whiteSpace: 'nowrap'
            }}>
                {formatSecondsLabel(rangeStart)}
            </div>
        </div>

        {/* End Thumb */}
        <div 
          className="timeline-thumb end-thumb"
          style={{
            position: 'absolute',
            left: `${endPercent}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '16px',
            height: '16px',
            background: activeThumb === 'end' ? 'var(--accent-purple)' : '#fff',
            border: `2px solid var(--accent-purple)`,
            borderRadius: '50%',
            zIndex: 10,
            cursor: 'grab',
            boxShadow: activeThumb === 'end' 
                ? '0 0 0 4px rgba(139, 92, 246, 0.2), 0 2px 4px rgba(0,0,0,0.2)' 
                : '0 2px 4px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'box-shadow 0.2s, background-color 0.2s'
          }}
        >
            {/* Active Indicator Pulse */}
            {activeThumb === 'end' && !isDragging && (
                <div style={{
                    position: 'absolute',
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    border: '2px solid var(--accent-purple)',
                    animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
                    pointerEvents: 'none'
                }} />
            )}

            {/* Label for end thumb */}
            <div style={{
                position: 'absolute',
                top: '20px',
                fontSize: '10px',
                color: 'var(--accent-purple)',
                fontWeight: 600,
                whiteSpace: 'nowrap'
            }}>
                {formatSecondsLabel(rangeEnd)}
            </div>
        </div>
      </div>
    </div>
  );
};
