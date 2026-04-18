'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import VideoInfoPanel from '@/components/VideoInfoPanel';
import { timeAgo, getSubtitleBadgeLabel } from '@/lib/format';
import type { VideoWithMeta } from '@/types';
import EmbeddedPlayer from '@/components/player/EmbeddedPlayer';
import type { EmbeddedPlayerSeekRequest } from '@/components/player/EmbeddedPlayer';
import AudioModeOverlay from '@/components/AudioModeOverlay';

interface MobileVideoSheetProps {
  video: VideoWithMeta;
  onClose: () => void;
  onPlay: (video: VideoWithMeta, startSeconds?: number) => void;
  onPlayAudio?: (video: VideoWithMeta) => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  initialAudioMode?: boolean;
}

export default function MobileVideoSheet({
  video,
  onClose,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  initialAudioMode = false,
}: MobileVideoSheetProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [dragDirection, setDragDirection] = useState<'none' | 'vertical' | 'horizontal'>('none');
  const [isFirstOpen, setIsFirstOpen] = useState(true);
  const [isFullHeight, setIsFullHeight] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('needle-mobile-play-mode');
      if (saved) return saved === 'audio';
    }
    return initialAudioMode;
  });
  const [isVideoPlaying, setIsVideoPlaying] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('needle-mobile-play-mode');
      if (saved) return saved === 'video';
    }
    return false;
  });
  const [preferredMode, setPreferredMode] = useState<'audio' | 'video' | 'official' | 'videolite' | 'reading' | 'none'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('needle-mobile-play-mode');
      if (saved === 'audio' || saved === 'video' || saved === 'official' || saved === 'videolite' || saved === 'reading') {
        return saved as any;
      }
    }
    return 'none';
  });

  // Keep internal playing states in sync with preferredMode changes from picker
  useEffect(() => {
    if (preferredMode === 'audio') {
      setIsAudioPlaying(true);
      setIsVideoPlaying(false);
    } else if (preferredMode === 'video') {
      setIsVideoPlaying(true);
      setIsAudioPlaying(false);
    } else {
      setIsAudioPlaying(false);
      setIsVideoPlaying(false);
    }
  }, [preferredMode]);
  const [isPickerActive, setIsPickerActive] = useState(false);
  const [playerState, setPlayerState] = useState({
    videoId: video.id,
    seconds: 0,
    duration: 0,
  });
  const [seekRequest, setSeekRequest] = useState<
    (EmbeddedPlayerSeekRequest & { videoId: number }) | null
  >(null);

  const touchStartTime = useRef(0);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const lastDragY = useRef(0);
  const lastDragX = useRef(0);

  const lastVideoId = useRef(video.id);
  const seekNonceRef = useRef(0);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    // After first mount animation, disable the slide-up-from-bottom trigger
    const timer = setTimeout(() => setIsFirstOpen(false), 20);
    return () => {
      document.body.style.overflow = '';
      clearTimeout(timer);
    };
  }, []);

  // Handle Video Transition Animation
  useEffect(() => {
    if (lastVideoId.current !== video.id) {
      const direction = lastDragX.current > 0 ? 'prev' : 'next';
      let settleFrame = 0;
      const startFrame = requestAnimationFrame(() => {
        setIsTransitioning(true);
        // Start from the edge (snap to side instantly)
        setDragX(direction === 'prev' ? -window.innerWidth : window.innerWidth);

        // Immediate animation back to center
        settleFrame = requestAnimationFrame(() => {
          setIsTransitioning(false);
          setDragX(0);
          if (contentRef.current) contentRef.current.scrollTop = 0;
          lastDragX.current = 0; // Reset for next transition
        });

        lastVideoId.current = video.id;
      });

      return () => {
        cancelAnimationFrame(startFrame);
        if (settleFrame) cancelAnimationFrame(settleFrame);
      };
    }
  }, [video.id]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (isTransitioning) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
    touchStartTime.current = Date.now();
    setIsDragging(true);
    setDragDirection('none');
    lastDragY.current = 0;
    lastDragX.current = 0;
  }, [isTransitioning]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (!isDragging) return;

    const currentY = e.touches[0].clientY;
    const currentX = e.touches[0].clientX;
    const diffY = currentY - touchStartY.current;
    const diffX = currentX - touchStartX.current;

    let direction = dragDirection;
    if (direction === 'none') {
      if (Math.abs(diffX) > 15) direction = 'horizontal';
      else if (Math.abs(diffY) > 10) {
        const target = e.target as HTMLElement;
        const isScrollable = target.closest('.mobile-sheet-scrollable');
        const scrollTop = isScrollable ? (isScrollable as HTMLElement).scrollTop : 0;

        if (diffY > 0) {
          // Drag down
          if (!isScrollable || scrollTop <= 0) {
            direction = 'vertical';
          }
        } else {
          // Drag up
          if (!isFullHeight) {
            direction = 'vertical';
          }
        }
      }
      if (direction !== 'none') setDragDirection(direction);
    }

    if (direction === 'vertical') {
      // Resistance when pulling up past top or down past limit
      let effectiveY = diffY;
      if (isFullHeight && diffY < 0) effectiveY = diffY * 0.3; // Resistance at top

      setDragY(effectiveY);
      lastDragY.current = effectiveY;
    } else if (direction === 'horizontal') {
      const baseResistance = 0.3; // Increased friction
      const boundaryResistance = (diffX > 0 && !hasPrev) || (diffX < 0 && !hasNext) ? 0.3 : 1;
      const dampedX = diffX * baseResistance * boundaryResistance;
      setDragX(dampedX);
      lastDragX.current = diffX; // Track original finger movement
    }
  }, [dragDirection, hasNext, hasPrev, isDragging, isFullHeight]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (!isDragging) return;
    setIsDragging(false);

    if (dragDirection === 'vertical') {
      const timeDiff = Date.now() - touchStartTime.current;
      const velocity = lastDragY.current / (timeDiff || 1);
      const expandThreshold = -60; // Easier to expand
      const collapseThreshold = 100; // Standard for collapse
      const flickThreshold = 0.5;

      if (!isFullHeight) {
        if (lastDragY.current > collapseThreshold || velocity > flickThreshold) {
          onClose();
        } else if (lastDragY.current < expandThreshold || velocity < -flickThreshold) {
          setIsFullHeight(true);
        }
      } else {
        if (lastDragY.current > collapseThreshold || velocity > flickThreshold) {
          setIsFullHeight(false);
        }
      }
      setDragY(0);
    } else if (dragDirection === 'horizontal') {
      const threshold = 80; // Finger movement threshold (80px)
      if (lastDragX.current > threshold && onPrev && hasPrev) {
        setIsTransitioning(true);
        setDragX(window.innerWidth);
        setTimeout(() => {
          onPrev();
        }, 300);
      } else if (lastDragX.current < -threshold && onNext && hasNext) {
        setIsTransitioning(true);
        setDragX(-window.innerWidth);
        setTimeout(() => {
          onNext();
        }, 300);
      } else {
        setDragX(0);
      }
    }

    setDragDirection('none');
  }, [dragDirection, hasNext, hasPrev, isDragging, isFullHeight, onClose, onNext, onPrev]);

  const executePickerAction = useCallback((index: number) => {
    switch (index) {
      case 0: // 音频
        setPreferredMode('audio');
        localStorage.setItem('needle-mobile-play-mode', 'audio');
        break;
      case 1: // 视频
        setPreferredMode('video');
        localStorage.setItem('needle-mobile-play-mode', 'video');
        break;
      case 2: // 官方
        setPreferredMode('official');
        localStorage.setItem('needle-mobile-play-mode', 'official');
        const officialUrl = video.platform === 'youtube'
          ? `https://www.youtube.com/watch?v=${video.video_id}`
          : `bilibili://video/${video.video_id}`;
        window.location.href = officialUrl;
        break;
      case 3: // Video Lite
        setPreferredMode('videolite');
        localStorage.setItem('needle-mobile-play-mode', 'videolite');
        const videoUrl = video.platform === 'youtube'
          ? `www.youtube.com/watch?v=${video.video_id}`
          : `www.bilibili.com/video/${video.video_id}`;
        const videoLiteUrl = `videolite://${videoUrl}`;
        window.location.href = videoLiteUrl;
        break;
      case 4: // 阅读
        setPreferredMode('reading');
        localStorage.setItem('needle-mobile-play-mode', 'reading');
        break;
      case 5: // 取消
      default:
        break;
    }
  }, [video]);

  const [followMode, setFollowMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('needle-player-follow-mode') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('needle-player-follow-mode', String(followMode));
  }, [followMode]);

  const isYt = video.platform === 'youtube';
  const isMediaActive = isAudioPlaying || isVideoPlaying;
  const activeSeekRequest =
    seekRequest?.videoId === video.id ? seekRequest : null;
  const activePlayerSeconds =
    playerState.videoId === video.id ? playerState.seconds : 0;
  const activePlayerDuration =
    playerState.videoId === video.id ? playerState.duration : 0;
  const channelName = (video as { channel_name?: string }).channel_name ?? '';
  const subtitleBadge = getSubtitleBadgeLabel(video);
  const accessBadge =
    video.access_status === 'limited_free'
      ? { label: '🎟 限免', title: '限时免费视频' }
      : video.access_status === 'members_only' || video.is_members_only === 1
        ? { label: '👑 会员', title: '会员专属视频' }
        : null;

  const handlePlayerTimeUpdate = useCallback(
    (seconds: number) => {
      setPlayerState((prev) => ({
        videoId: video.id,
        seconds,
        duration: prev.videoId === video.id ? prev.duration : 0,
      }));
    },
    [video.id],
  );

  const handlePlayerDurationChange = useCallback(
    (duration: number) => {
      setPlayerState((prev) => ({
        videoId: video.id,
        seconds: prev.videoId === video.id ? prev.seconds : 0,
        duration,
      }));
    },
    [video.id],
  );

  const handleThumbnailClick = useCallback(() => {
    if (isMediaActive) return;
    if (preferredMode === 'official') {
      const officialUrl = video.platform === 'youtube'
        ? `https://www.youtube.com/watch?v=${video.video_id}`
        : `bilibili://video/${video.video_id}`;
      window.location.href = officialUrl;
    } else if (preferredMode === 'videolite') {
      const videoUrl = video.platform === 'youtube'
        ? `www.youtube.com/watch?v=${video.video_id}`
        : `www.bilibili.com/video/${video.video_id}`;
      const videoLiteUrl = `videolite://${videoUrl}`;
      window.location.href = videoLiteUrl;
    }
  }, [isMediaActive, preferredMode, video]);

  const sheetStyle = useMemo(() => {
    const windowH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const collapsedTop = windowH * 0.12;

    // Initial entrance from bottom, then stay at collapsedTop or expandedTop
    const baseY = isFirstOpen ? windowH : (isFullHeight ? 0 : collapsedTop);
    const translateY = baseY + dragY;

    return {
      position: 'fixed' as const,
      left: 0,
      right: 0,
      bottom: -200,
      paddingBottom: 200,
      top: 0,
      zIndex: 10000,
      background: 'var(--bg-primary)',
      display: 'flex',
      flexDirection: 'column' as const,
      borderTopLeftRadius: isFullHeight ? 0 : 24,
      borderTopRightRadius: isFullHeight ? 0 : 24,
      boxShadow: '0 -12px 40px rgba(0,0,0,0.25)',
      transform: `translate3d(0, ${translateY}px, 0)`,
      transition: isDragging ? 'none' : 'transform 0.5s cubic-bezier(0.32, 0.72, 0, 1), border-radius 0.5s cubic-bezier(0.32, 0.72, 0, 1)',
      overflow: 'hidden',
      animationOrigin: 'bottom',
      willChange: 'transform',
    };
  }, [dragY, isDragging, isFirstOpen, isFullHeight]);

  return (
    <>
      <div
        className="mobile-sheet-backdrop"
        onClick={onClose}
        style={{
          opacity: Math.max(0, 1 - Math.max(dragY / 400, Math.abs(dragX) / 800)),
          pointerEvents: isDragging ? 'none' : 'auto'
        }}
      />

      {/* Navigation Indicators */}
      {isDragging && dragDirection === 'horizontal' && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: dragX > 0 ? 0 : 'auto',
          right: dragX < 0 ? 0 : 'auto',
          transform: `translateX(${dragX}px)`,
          display: 'flex',
          padding: '0 20px',
          zIndex: 301,
          pointerEvents: 'none',
          opacity: Math.min(Math.abs(dragX) / 40, 1)
        }}>
          {dragX > 0 && hasPrev && (
            <div style={{ background: 'var(--accent-purple)', color: '#fff', padding: '12px 20px', borderRadius: 24, boxShadow: '0 8px 24px rgba(139, 92, 246, 0.4)', fontWeight: 700 }}>
              ← 上一个视频
            </div>
          )}
          {dragX < 0 && hasNext && (
            <div style={{ background: 'var(--accent-purple)', color: '#fff', padding: '12px 20px', borderRadius: 24, boxShadow: '0 8px 24px rgba(139, 92, 246, 0.4)', fontWeight: 700 }}>
              下一个视频 →
            </div>
          )}
        </div>
      )}

      <div
        style={sheetStyle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="mobile-drag-indicator" />

        {/* Header and Fixed Content (rendered if NOT reading) */}
        {preferredMode !== 'reading' && (
          <div style={{ flexShrink: 0 }}>
            <div style={{ padding: '14px 16px 6px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{
                    fontSize: 16,
                    fontWeight: 800,
                    lineHeight: 1.4,
                    color: 'var(--text-primary)',
                    margin: 0,
                    wordBreak: 'break-word'
                  }}>
                    {video.title}
                  </h1>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, color: 'var(--text-muted)', fontSize: 10 }}>
                    <span style={{
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: isYt ? 'rgba(255,0,0,0.1)' : 'rgba(0,161,214,0.1)',
                      color: isYt ? 'var(--accent-yt)' : 'var(--accent-bili)',
                      fontSize: 10,
                      fontWeight: 800,
                      textTransform: 'uppercase'
                    }}>
                      {isYt ? 'YouTube' : 'Bilibili'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
                      {channelName}
                    </span>
                    {video.published_at && (
                      <>
                        <span style={{ opacity: 0.5 }}>•</span>
                        <span>{timeAgo(video.published_at)}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'var(--bg-hover)',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                    flexShrink: 0,
                    marginTop: 2
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            <div style={{ padding: '12px 16px 8px' }}>
              <div
                onClick={handleThumbnailClick}
                onContextMenu={(e) => e.preventDefault()}
                className="video-thumb-wrapper"
                style={{
                  borderRadius: 20,
                  cursor: (!isMediaActive && (preferredMode === 'official' || preferredMode === 'videolite')) ? 'pointer' : 'default',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  overflow: 'hidden',
                  position: 'relative',
                  aspectRatio: '16/9',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  WebkitTouchCallout: 'none'
                }}
              >
                {(isAudioPlaying || isVideoPlaying) ? (
                  <EmbeddedPlayer
                    video={video}
                    isAudioMode={isAudioPlaying}
                    isVisible={isVideoPlaying}
                    seekRequest={activeSeekRequest}
                    onTimeUpdate={handlePlayerTimeUpdate}
                    onDurationChange={handlePlayerDurationChange}
                  >
                    {({ isPlaying, currentTime, duration, togglePlay, seek }) => (
                      isAudioPlaying ? (
                        <AudioModeOverlay
                          video={video}
                          isPlaying={isPlaying}
                          currentTime={currentTime}
                          duration={duration}
                          onTogglePlay={togglePlay}
                          onSeek={seek}
                          onClose={() => setIsAudioPlaying(false)}
                        />
                      ) : null
                    )}
                  </EmbeddedPlayer>
                ) : (
                  <>
                    <div className="video-badges-top">
                      {subtitleBadge && (
                        <span className={`subtitle-badge state-${video.subtitle_status || 'unknown'}`}>
                          {subtitleBadge}
                        </span>
                      )}
                      {video.summary_status === 'completed' && (
                        <span className="summary-indicator completed" title="已有 AI 总结">✦</span>
                      )}
                      {video.summary_status === 'processing' && (
                        <span className="summary-indicator processing" title="AI 总结生成中">
                          <span className="status-pulse" style={{ width: 6, height: 6, margin: 0 }} />
                        </span>
                      )}
                      {video.summary_status === 'failed' && (
                        <span className="summary-indicator failed" title="AI 总结失败">!</span>
                      )}
                    </div>

                    {video.thumbnail_url ? (
                      <img
                        src={video.thumbnail_url}
                        alt=""
                        className="video-thumb"
                        draggable={false}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          WebkitTouchCallout: 'none',
                          WebkitUserSelect: 'none'
                        }}
                      />
                    ) : (
                      <div
                        className="video-thumb"
                        style={{
                          background: isYt
                            ? 'linear-gradient(135deg, #ff0000 0%, #ff4444 50%, #ff0000 100%)'
                            : 'linear-gradient(135deg, #00a1e4 0%, #23c3f2 50%, #00a1e4 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 32,
                          width: '100%',
                          height: '100%'
                        }}
                      >
                        {isYt ? '▶' : '📺'}
                      </div>
                    )}

                    <span className="video-duration">{video.duration || '--:--'}</span>
                    {accessBadge && (
                      <span className="members-badge" title={accessBadge.title}>
                        {accessBadge.label}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        <div
          ref={contentRef}
          className={preferredMode === 'reading' ? "mobile-sheet-scrollable" : ""}
          style={{
            flex: 1,
            overflowY: preferredMode === 'reading' ? 'auto' : 'hidden',
            overscrollBehavior: 'contain',
            padding: preferredMode === 'reading' ? '0' : '4px 0 0 0',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {preferredMode === 'reading' && (
            <>
              {/* Header inside scrollable area for reading mode */}
              <div style={{ padding: '14px 16px 6px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{
                      fontSize: 16,
                      fontWeight: 800,
                      lineHeight: 1.4,
                      color: 'var(--text-primary)',
                      margin: 0,
                      wordBreak: 'break-word'
                    }}>
                      {video.title}
                    </h1>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, color: 'var(--text-muted)', fontSize: 10 }}>
                      <span style={{
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: isYt ? 'rgba(255,0,0,0.1)' : 'rgba(0,161,214,0.1)',
                        color: isYt ? 'var(--accent-yt)' : 'var(--accent-bili)',
                        fontSize: 10,
                        fontWeight: 800,
                        textTransform: 'uppercase'
                      }}>
                        {isYt ? 'YouTube' : 'Bilibili'}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
                        {channelName}
                      </span>
                      {video.published_at && (
                        <>
                          <span style={{ opacity: 0.5 }}>•</span>
                          <span>{timeAgo(video.published_at)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={onClose}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: 'var(--bg-hover)',
                      border: 'none',
                      color: 'var(--text-secondary)',
                      fontSize: 20,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                      flexShrink: 0,
                      marginTop: 2
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>

              <div style={{ padding: '12px 16px 12px' }}>
                <div
                  onClick={handleThumbnailClick}
                  onContextMenu={(e) => e.preventDefault()}
                  className="video-thumb-wrapper"
                  style={{
                    borderRadius: 20,
                    cursor: (!isMediaActive && (preferredMode === 'official' || preferredMode === 'videolite')) ? 'pointer' : 'default',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    overflow: 'hidden',
                    position: 'relative',
                    aspectRatio: '16/9',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    WebkitTouchCallout: 'none'
                  }}
                >
                  {(isAudioPlaying || isVideoPlaying) ? (
                    <EmbeddedPlayer
                      video={video}
                      isAudioMode={isAudioPlaying}
                      isVisible={isVideoPlaying}
                      seekRequest={activeSeekRequest}
                      onTimeUpdate={handlePlayerTimeUpdate}
                      onDurationChange={handlePlayerDurationChange}
                    >
                      {({ isPlaying, currentTime, duration, togglePlay, seek }) => (
                        isAudioPlaying ? (
                          <AudioModeOverlay
                            video={video}
                            isPlaying={isPlaying}
                            currentTime={currentTime}
                            duration={duration}
                            onTogglePlay={togglePlay}
                            onSeek={seek}
                            onClose={() => setIsAudioPlaying(false)}
                          />
                        ) : null
                      )}
                    </EmbeddedPlayer>
                  ) : (
                    <>
                      <div className="video-badges-top">
                        {subtitleBadge && (
                          <span className={`subtitle-badge state-${video.subtitle_status || 'unknown'}`}>
                            {subtitleBadge}
                          </span>
                        )}
                        {video.summary_status === 'completed' && (
                          <span className="summary-indicator completed" title="已有 AI 总结">✦</span>
                        )}
                        {video.summary_status === 'processing' && (
                          <span className="summary-indicator processing" title="AI 总结生成中">
                            <span className="status-pulse" style={{ width: 6, height: 6, margin: 0 }} />
                          </span>
                        )}
                        {video.summary_status === 'failed' && (
                          <span className="summary-indicator failed" title="AI 总结失败">!</span>
                        )}
                      </div>

                      {video.thumbnail_url ? (
                        <img
                          src={video.thumbnail_url}
                          alt=""
                          className="video-thumb"
                          draggable={false}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            WebkitTouchCallout: 'none',
                            WebkitUserSelect: 'none'
                          }}
                        />
                      ) : (
                        <div
                          className="video-thumb"
                          style={{
                            background: isYt
                              ? 'linear-gradient(135deg, #ff0000 0%, #ff4444 50%, #ff0000 100%)'
                              : 'linear-gradient(135deg, #00a1e4 0%, #23c3f2 50%, #00a1e4 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 32,
                            width: '100%',
                            height: '100%'
                          }}
                        >
                          {isYt ? '▶' : '📺'}
                        </div>
                      )}

                      <span className="video-duration">{video.duration || '--:--'}</span>
                      {accessBadge && (
                        <span className="members-badge" title={accessBadge.title}>
                          {accessBadge.label}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          <div style={{ padding: '0 16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <VideoInfoPanel
              video={video}
              onPlayModeClick={() => setIsPickerActive(true)}
              currentPlayMode={preferredMode}
              onTimestampClick={(seconds) => {
                if (isMediaActive) {
                  seekNonceRef.current += 1;
                  setSeekRequest({
                    seconds,
                    nonce: seekNonceRef.current,
                    videoId: video.id,
                  });
                  return;
                }

                const isYt = video.platform === 'youtube';
                // Use standard web URLs with 1:1 location.href mapping
                // to trigger Universal Links in iOS/Android Safari for a direct app jump.
                const webUrl = isYt
                  ? `https://www.youtube.com/watch?v=${video.video_id}&t=${seconds}s`
                  : `https://www.bilibili.com/video/${video.video_id}/?t=${seconds}`;

                window.location.href = webUrl;
              }}
              currentPlayerSeconds={isMediaActive ? activePlayerSeconds : 0}
              playerDuration={isMediaActive ? activePlayerDuration : 0}
              followMode={followMode}
              onFollowModeChange={setFollowMode}
            />
          </div>
        </div>
      </div>

      {/* Click Menu Picker UI */}
      {isPickerActive && (
        <div
          onClick={() => setIsPickerActive(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 20000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(12px)',
            animation: 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
          }}>
          <div style={{
            color: '#fff',
            fontSize: 16,
            fontWeight: 900,
            marginBottom: 24,
            textShadow: '0 2px 10px rgba(0,0,0,0.5)',
            background: 'rgba(255,255,255,0.1)',
            padding: '8px 20px',
            borderRadius: 30,
            transform: 'translateY(-10px)',
            letterSpacing: '0.05em'
          }}>
            选择播放模式
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex',
              background: 'rgba(30,30,30,0.9)',
              backdropFilter: 'blur(40px)',
              padding: '16px',
              borderRadius: 40,
              gap: 12,
              boxShadow: '0 30px 80px rgba(0,0,0,0.8)',
              border: '1px solid rgba(255,255,255,0.15)',
              width: '94%',
              maxWidth: 440,
              justifyContent: 'space-around'
            }}>
            {['音频', '视频', '官方', 'Lite', '阅读', '取消'].map((label, i) => (
              <button
                key={label}
                onClick={() => {
                  executePickerAction(i);
                  setIsPickerActive(false);
                }}
                style={{
                  flex: 1,
                  padding: '20px 0',
                  borderRadius: 24,
                  background: 'transparent',
                  border: 'none',
                  color: '#fff',
                  fontWeight: 900,
                  fontSize: 10,
                  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  outline: 'none'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ fontSize: 22, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))' }}>
                  {i === 0 ? '🎧' : i === 1 ? '📺' : i === 2 ? '🏛' : i === 3 ? '🎬' : i === 4 ? '📖' : '✕'}
                </span>
                <span style={{ opacity: 0.9 }}>{label}</span>
              </button>
            ))}
          </div>

          <style dangerouslySetInnerHTML={{
            __html: `
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
              `}} />
        </div>
      )}
    </>
  );
}
