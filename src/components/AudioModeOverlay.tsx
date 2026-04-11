'use client';

import React, { useMemo } from 'react';
import type { VideoWithMeta } from '@/types';

interface AudioModeOverlayProps {
  video: VideoWithMeta;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onClose: () => void;
}

export default function AudioModeOverlay({
  video,
  isPlaying,
  currentTime,
  duration,
  onTogglePlay,
  onSeek,
  onClose,
}: AudioModeOverlayProps) {
  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newProgress = x / rect.width;
    onSeek(newProgress * duration);
  };

  return (
    <div
      className="audio-mode-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
        overflow: 'hidden',
        zIndex: 10,
      }}
    >
      {/* Close Button at Top */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          border: 'none',
          color: '#fff',
          fontSize: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 100,
          backdropFilter: 'blur(10px)',
        }}
      >
        ×
      </button>

      {/* Dynamic Background Blur */}
      <div
        style={{
          position: 'absolute',
          inset: '-20px',
          backgroundImage: `url(${video.thumbnail_url})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'blur(60px) brightness(0.4)',
          opacity: 0.6,
          zIndex: 0,
        }}
      />

      {/* Content Container */}
      <div
        className="audio-overlay-content"
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {/* Left: Album Art */}
        <div
          style={{
            flexShrink: 0,
            width: '28%',
            aspectRatio: '1',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            transform: isPlaying ? 'scale(1)' : 'scale(0.95)',
            transition: 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)',
            background: 'var(--bg-secondary)',
          }}
        >
          {video.thumbnail_url ? (
            <img
              src={video.thumbnail_url}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              🎵
            </div>
          )}
        </div>

        {/* Right: Info + Progress + Controls */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {/* Metadata */}
          <div style={{ textAlign: 'left', width: '100%' }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: '#fff',
                margin: '0 0 2px 0',
                textShadow: '0 2px 10px rgba(0,0,0,0.3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {video.title}
            </h2>
            <p
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.6)',
                margin: 0,
                fontWeight: 500,
              }}
            >
              {video.channel_name}
            </p>
          </div>

          {/* Controls + Progress Group */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Controls */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 20,
              }}
            >
              <button
                onClick={onTogglePlay}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: '#fff',
                  border: 'none',
                  color: '#000',
                  fontSize: 18,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                  transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
                  flexShrink: 0
                }}
                onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.9)')}
                onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? 'Ⅱ' : '▶'}
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <button
                  onClick={() => onSeek(currentTime - 10)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#fff',
                    fontSize: 16,
                    cursor: 'pointer',
                    opacity: 0.6,
                  }}
                  aria-label="Back 10s"
                >
                  ↺
                </button>
                <button
                  onClick={() => onSeek(currentTime + 10)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#fff',
                    fontSize: 16,
                    cursor: 'pointer',
                    opacity: 0.6,
                  }}
                  aria-label="Forward 10s"
                >
                  ↻
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            <div style={{ width: '100%' }}>
              <div
                onClick={handleProgressClick}
                style={{
                  width: '100%',
                  height: 3,
                  background: 'rgba(255,255,255,0.15)',
                  borderRadius: 1.5,
                  cursor: 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${progress}%`,
                    background: 'var(--accent-purple)',
                    borderRadius: 1.5,
                    transition: 'width 0.1s linear',
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 4,
                  fontSize: 9,
                  color: 'rgba(255,255,255,0.4)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
