'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDraggableWidth } from '@/hooks/useDraggableWidth';
import { timeAgo } from '@/lib/format';
import {
  isTypingContextTarget,
  resolvePlayerKeyboardAction,
} from '@/lib/player-keyboard-arbiter';
import {
  createYouTubeListeningMessage,
  isTrustedYouTubeOrigin,
  parseYouTubePlayerMessage,
  resolveYouTubeEmbedOrigin,
} from '@/lib/youtube-player';
import type { VideoWithMeta } from '@/types';
import VideoInfoPanel from '@/components/VideoInfoPanel';
import AudioModeOverlay from '@/components/AudioModeOverlay';
import { useMediaSession } from '@/hooks/useMediaSession';

interface BilibiliPlaybackResponse {
  bvid?: string;
  aid?: number | null;
  cid?: number;
  proxyUrl?: string;
  durationMs?: number | null;
  quality?: number | null;
  qualityLabel?: string | null;
  format?: string | null;
  authUsed?: boolean;
  source?: 'mp4';
  segmented?: boolean;
  limitations?: string[];
  error?: string;
  details?: string;
}

function getExternalUrl(video: VideoWithMeta): string {
  if (video.platform === 'youtube')
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  return `https://www.bilibili.com/video/${video.video_id}`;
}

function getEmbedUrl(
  video: VideoWithMeta,
  startSeconds = 0,
  options?: { enableYouTubeJsApi?: boolean },
): string {
  if (video.platform === 'youtube') {
    const params = new URLSearchParams({
      autoplay: '1',
      start: String(Math.max(0, Math.floor(startSeconds))),
    });
    if (options?.enableYouTubeJsApi) {
      params.set('enablejsapi', '1');
      if (typeof window !== 'undefined' && window.location.origin) {
        params.set('origin', window.location.origin);
      }
    }
    return `https://www.youtube.com/embed/${video.video_id}?${params.toString()}`;
  }

  const params = new URLSearchParams({
    bvid: video.video_id,
    autoplay: '1',
  });
  if (startSeconds > 0) {
    params.set('t', String(Math.max(0, Math.floor(startSeconds))));
  }
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

export default function PlayerModal({
  video,
  initialStartSeconds = 0,
  initialAudioMode = false,
  onClose,
}: {
  video: VideoWithMeta;
  initialStartSeconds?: number;
  initialAudioMode?: boolean;
  onClose: () => void;
}) {
  const isYt = video.platform === 'youtube';
  const [playerStartSeconds, setPlayerStartSeconds] = useState(() =>
    Math.max(0, Math.floor(initialStartSeconds)),
  );
  const [isAudioMode, setIsAudioMode] = useState(initialAudioMode ?? false);
  const [youtubeEmbedSrc, setYoutubeEmbedSrc] = useState(() =>
    isYt
      ? getEmbedUrl(video, initialStartSeconds, { enableYouTubeJsApi: true })
      : '',
  );
  const [bilibiliPlayback, setBilibiliPlayback] =
    useState<BilibiliPlaybackResponse | null>(null);
  const [bilibiliPlaybackLoading, setBilibiliPlaybackLoading] = useState(!isYt);
  const [bilibiliPlaybackError, setBilibiliPlaybackError] = useState<
    string | null
  >(null);
  const [bilibiliPlaybackRate, setBilibiliPlaybackRate] = useState(1);
  const [bilibiliIsPlaying, setBilibiliIsPlaying] = useState(false);
  const [youtubePlayerLoaded, setYoutubePlayerLoaded] = useState(false);
  const [youtubeTelemetryReady, setYoutubeTelemetryReady] = useState(false);
  const [youtubePlayerState, setYoutubePlayerState] = useState<number>(-1);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    setIsMobile(window.innerWidth <= 900);
    if (window.innerWidth <= 900) {
      setIsAudioMode(true);
    }
  }, []);
  const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
  const bilibiliVideoRef = useRef<HTMLVideoElement>(null);
  const pendingYouTubeSeekRef = useRef<number | null>(null);
  const pendingBilibiliSeekRef = useRef<number | null>(null);

  const [playerDuration, setPlayerDuration] = useState<number>(0);

  const { width: leftPanelWidth, handleRef: panelHandleRef } = useDraggableWidth(
    'player-panel-width',
    380,
    { min: 260, max: 520 },
  );

  const modalColors = {
    background: 'var(--bg-primary)',
    surface: 'var(--bg-secondary)',
    border: 'var(--border)',
    borderStrong: 'var(--border)',
    text: 'var(--text-primary)',
    textStrong: 'var(--text-primary)',
    textMuted: 'var(--text-secondary)',
    textSoft: 'var(--text-muted)',
    textFaint: 'var(--text-muted)',
    inputBg: 'var(--bg-input)',
    accent: 'var(--accent-purple)',
    accentSoft: 'rgba(139, 92, 246, 0.12)',
    accentBorder: 'rgba(139, 92, 246, 0.22)',
    danger: 'var(--destructive)',
    dangerSoft: 'rgba(220, 38, 38, 0.08)',
    dangerBorder: 'rgba(220, 38, 38, 0.2)',
  } as const;

  const focusPlayer = useCallback(() => {
    if (isYt) {
      const iframe = youtubeIframeRef.current;
      if (!iframe) return;

      const attemptFocus = () => {
        try {
          iframe.focus({ preventScroll: true });
        } catch {
          iframe.focus();
        }

        try {
          iframe.contentWindow?.focus();
        } catch {
          // Cross-origin iframe may reject direct window focus.
        }
      };

      window.requestAnimationFrame(attemptFocus);
      window.setTimeout(attemptFocus, 50);
      window.setTimeout(attemptFocus, 180);
      return;
    }

    const videoElement = bilibiliVideoRef.current;
    if (!videoElement) return;

    window.requestAnimationFrame(() => {
      try {
        videoElement.focus({ preventScroll: true });
      } catch {
        videoElement.focus();
      }
    });
  }, [isYt]);

  // ── Keyboard interaction ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = resolvePlayerKeyboardAction(e, {
        isTypingContext: isTypingContextTarget(document.activeElement),
      });

      if (action === 'none') return;

      if (action === 'close-modal') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  useEffect(() => {
    const nextStartSeconds = Math.max(0, Math.floor(initialStartSeconds));
    setPlayerStartSeconds(nextStartSeconds);
    setPlayerDuration(0);
    if (video.platform === 'youtube') {
      pendingYouTubeSeekRef.current = null;
      setYoutubePlayerLoaded(false);
      setYoutubeTelemetryReady(false);
      setYoutubeEmbedSrc(
        getEmbedUrl(video, nextStartSeconds, { enableYouTubeJsApi: true }),
      );
    } else {
      pendingBilibiliSeekRef.current = nextStartSeconds;
      setBilibiliIsPlaying(false);
      setBilibiliPlaybackRate(1);
    }
  }, [initialStartSeconds, video]);

  useEffect(() => {
    if (isYt) {
      focusPlayer();
    }
  }, [focusPlayer, isYt, youtubeEmbedSrc]);

  useEffect(() => {
    if (!isYt && bilibiliPlayback?.proxyUrl) {
      focusPlayer();
    }
  }, [bilibiliPlayback?.proxyUrl, focusPlayer, isYt]);

  const loadBilibiliPlayback = useCallback(
    async (signal?: AbortSignal) => {
      if (isYt) return;

      setBilibiliPlaybackLoading(true);
      setBilibiliPlaybackError(null);
      setBilibiliPlayback(null);

      try {
        const res = await fetch(
          `/api/bilibili/playback?bvid=${encodeURIComponent(video.video_id)}`,
          {
            cache: 'no-store',
            signal,
          },
        );
        const data = (await res.json()) as BilibiliPlaybackResponse;
        if (!res.ok || data.error || !data.proxyUrl) {
          throw new Error(data.details || data.error || 'B站播放地址加载失败');
        }
        if (signal?.aborted) return;
        setBilibiliPlayback(data);
      } catch (error) {
        if (signal?.aborted) return;
        const message =
          error instanceof Error ? error.message : 'B站播放地址加载失败';
        setBilibiliPlaybackError(message);
      } finally {
        if (!signal?.aborted) {
          setBilibiliPlaybackLoading(false);
        }
      }
    },
    [isYt, video.video_id],
  );

  useEffect(() => {
    if (isYt) return;

    const controller = new AbortController();
    void loadBilibiliPlayback(controller.signal);

    return () => controller.abort();
  }, [isYt, loadBilibiliPlayback]);

  const postYouTubeCommand = useCallback(
    (func: string, args: unknown[] = []) => {
      const iframe = youtubeIframeRef.current;
      const playerWindow = iframe?.contentWindow;
      if (!playerWindow || !iframe.src) return false;

      playerWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func,
          args,
          id: 1, // Optional ID for some versions of the API
        }),
        resolveYouTubeEmbedOrigin(iframe.src),
      );
      return true;
    },
    [],
  );

  const requestYouTubeTelemetry = useCallback(() => {
    const iframe = youtubeIframeRef.current;
    const playerWindow = iframe?.contentWindow;
    if (playerWindow && iframe?.src) {
      playerWindow.postMessage(
        createYouTubeListeningMessage(),
        resolveYouTubeEmbedOrigin(iframe.src),
      );
    }
    postYouTubeCommand('getCurrentTime');
    postYouTubeCommand('getDuration');
  }, [postYouTubeCommand]);

  const flushPendingYouTubeSeek = useCallback(
    (seconds: number) => {
      if (!postYouTubeCommand('seekTo', [seconds, true])) return false;
      postYouTubeCommand('playVideo');
      return true;
    },
    [postYouTubeCommand],
  );

  const setBilibiliRate = useCallback((nextRate: number) => {
    const videoElement = bilibiliVideoRef.current;
    const clamped = Math.min(2, Math.max(0.5, nextRate));
    setBilibiliPlaybackRate(clamped);
    if (videoElement) {
      videoElement.playbackRate = clamped;
    }
  }, []);

  const flushPendingBilibiliSeek = useCallback(
    (seconds: number) => {
      const videoElement = bilibiliVideoRef.current;
      if (!videoElement || !bilibiliPlayback?.proxyUrl) return false;

      pendingBilibiliSeekRef.current = seconds;

      const canSeek =
        videoElement.readyState >= 1 || Number.isFinite(videoElement.duration);
      if (!canSeek) return false;

      try {
        const boundedSeconds =
          Number.isFinite(videoElement.duration) && videoElement.duration > 0
            ? Math.min(seconds, Math.max(0, videoElement.duration - 0.25))
            : seconds;
        videoElement.currentTime = Math.max(0, boundedSeconds);
        videoElement.playbackRate = bilibiliPlaybackRate;
        const playPromise = videoElement.play();
        if (playPromise) {
          playPromise.catch(() => {});
        }
        pendingBilibiliSeekRef.current = null;
        return true;
      } catch {
        return false;
      }
    },
    [bilibiliPlayback?.proxyUrl, bilibiliPlaybackRate],
  );

  const toggleBilibiliPlayback = useCallback(() => {
    const videoElement = bilibiliVideoRef.current;
    if (!videoElement) return;

    if (videoElement.paused) {
      const playPromise = videoElement.play();
      if (playPromise) {
        playPromise.catch(() => {});
      }
      return;
    }

    videoElement.pause();
  }, []);

  // Media Session Integration
  useMediaSession(
    {
      title: video.title,
      artist: video.channel_name,
      artwork: video.thumbnail_url || '',
    },
    {
      onPlay: () => {
        if (isYt) {
          postYouTubeCommand('playVideo');
        } else {
          bilibiliVideoRef.current?.play();
        }
      },
      onPause: () => {
        if (isYt) {
          postYouTubeCommand('pauseVideo');
        } else {
          bilibiliVideoRef.current?.pause();
        }
      },
      onSeekBackward: () => {
        const nextTime = Math.max(0, playerStartSeconds - 10);
        handleTimestampClick(nextTime);
      },
      onSeekForward: () => {
        const nextTime = Math.min(playerDuration, playerStartSeconds + 10);
        handleTimestampClick(nextTime);
      },
      onSeekTo: (details) => {
        if (typeof details.seekTime === 'number') {
          handleTimestampClick(details.seekTime);
        }
      },
    },
    (isYt && youtubeTelemetryReady) || (!isYt && bilibiliIsPlaying) ? 'playing' : 'paused'
  );

  const handleTimestampClick = (seconds: number) => {
    const nextSeconds = Math.max(0, Math.floor(seconds));
    setPlayerStartSeconds(nextSeconds);

    if (!isYt) {
      pendingBilibiliSeekRef.current = nextSeconds;
      flushPendingBilibiliSeek(nextSeconds);
      return;
    }

    pendingYouTubeSeekRef.current = nextSeconds;

    if (!youtubePlayerLoaded) {
      setYoutubeEmbedSrc(
        getEmbedUrl(video, nextSeconds, { enableYouTubeJsApi: true }),
      );
      return;
    }

    if (!youtubeTelemetryReady) {
      return;
    }

    if (flushPendingYouTubeSeek(nextSeconds)) {
      window.setTimeout(() => {
        if (pendingYouTubeSeekRef.current !== nextSeconds) return;
        if (flushPendingYouTubeSeek(nextSeconds)) {
          pendingYouTubeSeekRef.current = null;
        }
      }, 120);
    }
  };

  useEffect(() => {
    if (!isYt) return;

    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedYouTubeOrigin(event.origin)) return;

      const telemetry = parseYouTubePlayerMessage(event.data);
      if (!telemetry) return;

      if (
        telemetry.playerReady ||
        telemetry.currentTime !== undefined ||
        telemetry.duration !== undefined
      ) {
        setYoutubeTelemetryReady(true);
      }

      if (telemetry.playerState !== undefined) {
        setYoutubePlayerState(telemetry.playerState);
      }
      if (telemetry.currentTime !== undefined) {
        setPlayerStartSeconds(telemetry.currentTime);
      }
      if (telemetry.duration !== undefined && telemetry.duration > 0) {
        setPlayerDuration(telemetry.duration);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [isYt]);

  useEffect(() => {
    if (!isYt || !youtubePlayerLoaded) return;

    requestYouTubeTelemetry();
    const warmupTimers = [80, 220, 500].map((delay) =>
      window.setTimeout(requestYouTubeTelemetry, delay),
    );
    const interval = window.setInterval(requestYouTubeTelemetry, 500);

    return () => {
      warmupTimers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(interval);
    };
  }, [isYt, requestYouTubeTelemetry, youtubePlayerLoaded]);

  useEffect(() => {
    if (
      !isYt ||
      !youtubeTelemetryReady ||
      pendingYouTubeSeekRef.current === null
    )
      return;

    const pendingSeconds = pendingYouTubeSeekRef.current;
    const timer = window.setTimeout(() => {
      if (flushPendingYouTubeSeek(pendingSeconds)) {
        pendingYouTubeSeekRef.current = null;
      }
    }, 80);

    return () => window.clearTimeout(timer);
  }, [flushPendingYouTubeSeek, isYt, youtubeTelemetryReady]);

  const handleBilibiliLoadedMetadata = useCallback(() => {
    const pendingSeconds = pendingBilibiliSeekRef.current;
    const videoElement = bilibiliVideoRef.current;
    if (!videoElement) return;

    focusPlayer();
    videoElement.playbackRate = bilibiliPlaybackRate;

    if (pendingSeconds !== null) {
      flushPendingBilibiliSeek(pendingSeconds);
      return;
    }

    const playPromise = videoElement.play();
    if (playPromise) {
      playPromise.catch(() => {});
    }
  }, [bilibiliPlaybackRate, flushPendingBilibiliSeek, focusPlayer]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: modalColors.background,
        display: 'flex',
        flexDirection: 'column',
        animation: 'fadeIn 0.18s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          className="player-header"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '16px 24px',
            flexShrink: 0,
            borderBottom: `1px solid ${modalColors.border}`,
            background: modalColors.surface,
          }}
        >
          <div>
            <div
              style={{
                fontWeight: 700,
                fontSize: 18,
                color: modalColors.textStrong,
                lineHeight: 1.4,
                marginBottom: 6,
              }}
            >
              {video.title}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                fontSize: 13,
                color: modalColors.textMuted,
              }}
            >
              <span
                className={`platform-tag ${video.platform}`}
                style={{ fontSize: 11 }}
              >
                {isYt ? '▶ YouTube' : '🅱 B站'}
              </span>
              <span>{video.channel_name}</span>
              {video.published_at && <span>{timeAgo(video.published_at)}</span>}

              <a
                href={getExternalUrl(video)}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: modalColors.accent,
                  textDecoration: 'none',
                  fontSize: 12,
                  marginLeft: 8,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                ↗ 原始页面
              </a>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-hover)',
              border: 'none',
              borderRadius: 8,
              color: modalColors.textStrong,
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: '8px 12px',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div id="player-main-container" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div
            className="player-sidebar"
            style={{
              width: leftPanelWidth,
              minWidth: leftPanelWidth,
              maxWidth: leftPanelWidth,
              flexShrink: 0,
              borderRight: `1px solid ${modalColors.border}`,
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              background: modalColors.surface,
              position: 'relative',
            }}
          >
            {/* Drag handle */}
            <div
              ref={panelHandleRef}
              style={{
                position: 'absolute',
                top: 0,
                right: -3,
                width: 6,
                height: '100%',
                cursor: 'col-resize',
                zIndex: 10,
              }}
            />
            <VideoInfoPanel
              video={video}
              onTimestampClick={handleTimestampClick}
              currentPlayerSeconds={playerStartSeconds}
              playerDuration={playerDuration}
              bilibiliAid={isYt ? null : (bilibiliPlayback?.aid ?? null)}
              bilibiliCid={isYt ? null : (bilibiliPlayback?.cid ?? null)}
            />
          </div>

          <div
            style={{
              flex: 1,
              background: modalColors.background,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {isAudioMode && (
              <AudioModeOverlay
                video={video}
                isPlaying={isYt ? youtubePlayerState === 1 : bilibiliIsPlaying}
                currentTime={playerStartSeconds}
                duration={playerDuration}
                onTogglePlay={() => {
                  if (isYt) {
                    if (youtubePlayerState === 1) {
                        postYouTubeCommand('pauseVideo');
                    } else {
                        postYouTubeCommand('playVideo');
                    }
                  } else {
                    toggleBilibiliPlayback();
                  }
                }}
                onSeek={handleTimestampClick}
                onClose={onClose}
              />
            )}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: (isAudioMode || isMobile) ? 0 : 1,
                pointerEvents: (isAudioMode || isMobile) ? 'none' : 'auto',
                transition: 'opacity 0.3s',
              }}
            >
              {isYt ? (
                <>
                  <iframe
                    key={video.id}
                    ref={youtubeIframeRef}
                    src={youtubeEmbedSrc}
                    onLoad={() => {
                      setYoutubePlayerLoaded(true);
                      focusPlayer();
                      requestYouTubeTelemetry();
                    }}
                    title={video.title}
                    tabIndex={0}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      border: 'none',
                    }}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                  />
                </>
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#000',
                  }}
                >
                  <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    {bilibiliPlayback?.proxyUrl ? (
                      <video
                        key={`bilibili-${video.id}`}
                        ref={bilibiliVideoRef}
                        tabIndex={0}
                        src={bilibiliPlayback.proxyUrl}
                        poster={video.thumbnail_url || undefined}
                      controls
                      autoPlay
                      preload="auto"
                      playsInline
                      onLoadedMetadata={(e) => {
                        handleBilibiliLoadedMetadata();
                        setPlayerDuration(e.currentTarget.duration);
                      }}
                      onPlay={() => setBilibiliIsPlaying(true)}
                      onPause={() => setBilibiliIsPlaying(false)}
                      onRateChange={() => {
                        const nextRate = bilibiliVideoRef.current?.playbackRate;
                        if (
                          typeof nextRate === 'number' &&
                          Number.isFinite(nextRate)
                        ) {
                          setBilibiliPlaybackRate(nextRate);
                        }
                      }}
                      onTimeUpdate={(e) => {
                        setPlayerStartSeconds(e.currentTarget.currentTime);
                      }}
                      style={{
                        width: '100%',
                        height: '100%',
                        background: '#000',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 24,
                        textAlign: 'center',
                        color: modalColors.textStrong,
                        lineHeight: 1.6,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: modalColors.textStrong,
                            marginBottom: 10,
                          }}
                        >
                          {bilibiliPlaybackLoading
                            ? '正在解析 B 站可播放流…'
                            : '当前无法直接播放这个 B 站视频'}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            color: modalColors.textMuted,
                          }}
                        >
                          {bilibiliPlaybackError ||
                            '这个阶段只支持可直接播放的 MP4 单路流。'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    borderTop: `1px solid ${modalColors.border}`,
                    background: modalColors.surface,
                    color: modalColors.textMuted,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    onClick={toggleBilibiliPlayback}
                    disabled={!bilibiliPlayback?.proxyUrl}
                    style={{
                      border: `1px solid ${modalColors.borderStrong}`,
                      borderRadius: 8,
                      background: bilibiliPlayback?.proxyUrl
                        ? 'var(--bg-hover)'
                        : 'var(--bg-primary)',
                      color: bilibiliPlayback?.proxyUrl
                        ? modalColors.textStrong
                        : modalColors.textFaint,
                      cursor: bilibiliPlayback?.proxyUrl
                        ? 'pointer'
                        : 'not-allowed',
                      padding: '8px 14px',
                      fontSize: 13,
                      lineHeight: 1,
                    }}
                  >
                    {bilibiliIsPlaying ? '暂停' : '播放'}
                  </button>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <span>倍速</span>
                    <select
                      value={bilibiliPlaybackRate}
                      onChange={(e) => setBilibiliRate(Number(e.target.value))}
                      disabled={!bilibiliPlayback?.proxyUrl}
                      style={{
                        background: modalColors.inputBg,
                        color: modalColors.textStrong,
                        border: `1px solid ${modalColors.borderStrong}`,
                        borderRadius: 6,
                        padding: '6px 10px',
                        fontSize: 13,
                      }}
                    >
                      {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate}x
                        </option>
                      ))}
                    </select>
                  </label>

                  <div style={{ fontSize: 12, color: modalColors.textMuted }}>
                    {bilibiliPlaybackLoading
                      ? '解析中'
                      : bilibiliPlayback?.qualityLabel ||
                        bilibiliPlayback?.format ||
                        'MP4 单路流'}
                    {bilibiliPlayback?.authUsed ? ' · 已使用 SESSDATA' : ''}
                  </div>

                  {bilibiliPlaybackError && (
                    <div style={{ fontSize: 12, color: modalColors.danger }}>
                      {bilibiliPlaybackError}
                    </div>
                  )}

                  {!bilibiliPlaybackLoading && !bilibiliPlayback?.proxyUrl && (
                    <button
                      type="button"
                      onClick={() => void loadBilibiliPlayback()}
                      style={{
                        border: `1px solid ${modalColors.borderStrong}`,
                        borderRadius: 8,
                        background: 'var(--bg-hover)',
                        color: modalColors.textStrong,
                        cursor: 'pointer',
                        padding: '8px 14px',
                        fontSize: 13,
                        lineHeight: 1,
                      }}
                    >
                      重试解析
                    </button>
                  )}

                  {Array.isArray(bilibiliPlayback?.limitations) &&
                    bilibiliPlayback.limitations.length > 0 && (
                      <div
                        style={{
                          width: '100%',
                          fontSize: 12,
                          color: modalColors.textSoft,
                        }}
                      >
                        限制：{bilibiliPlayback.limitations.join('；')}
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
