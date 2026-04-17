'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDraggableWidth } from '@/hooks/useDraggableWidth';
import { timeAgo } from '@/lib/format';
import {
  DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  isTypingContextTarget,
  resolvePlayerKeyboardAction,
} from '@/lib/player-keyboard-arbiter';
import type { PlayerKeyboardModeSettings } from '@/lib/player-keyboard-mode';
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
import { extractSummaryChapters } from '@/lib/summary-chapters';
import PlayerBottomBar from '@/components/player/PlayerBottomBar';

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

interface YouTubePlaybackResponse {
  proxyUrl?: string;
  expiresAt?: number;
  source?: 'mp4';
  limitations?: string[];
  error?: string;
  details?: string;
}

const DEFAULT_KEYBOARD_SETTINGS: PlayerKeyboardModeSettings = {
  enabled: true,
  bindings: DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  rateTogglePreset: 2,
  rateStep: 0.1,
  seekSeconds: 10,
  rateMin: 0.5,
  rateMax: 3,
};

const YOUTUBE_IFRAME_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const RATE_ONE_EPSILON = 0.01;

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
      disablekb: '1',
      playsinline: '1',
      start: String(Math.max(0, Math.floor(startSeconds))),
    });
    if (options?.enableYouTubeJsApi) {
      params.set('enablejsapi', '1');
      if (typeof window !== 'undefined' && window.location.origin) {
        params.set('origin', window.location.origin);
      }
    }
    return `https://www.youtube-nocookie.com/embed/${video.video_id}?${params.toString()}`;
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

function clampRate(rate: number, settings: PlayerKeyboardModeSettings): number {
  const clamped = Math.max(settings.rateMin, Math.min(settings.rateMax, rate));
  return Math.round(clamped * 100) / 100;
}

function nearestYouTubeIframeRate(
  rate: number,
  settings: PlayerKeyboardModeSettings,
): number {
  const bounded = clampRate(rate, {
    ...settings,
    rateMin: Math.max(settings.rateMin, YOUTUBE_IFRAME_RATES[0]),
    rateMax: Math.min(settings.rateMax, YOUTUBE_IFRAME_RATES.at(-1) ?? 2),
  });
  return YOUTUBE_IFRAME_RATES.reduce((best, candidate) => {
    return Math.abs(candidate - bounded) < Math.abs(best - bounded)
      ? candidate
      : best;
  }, 1);
}

function isOneRate(rate: number): boolean {
  return Math.abs(rate - 1) < RATE_ONE_EPSILON;
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
  const [playerDuration, setPlayerDuration] = useState<number>(0);
  const [isAudioMode, setIsAudioMode] = useState(initialAudioMode ?? false);
  const [isMobile, setIsMobile] = useState(false);
  const [summaryMarkdown, setSummaryMarkdown] = useState<string>('');
  const [keyboardSettings, setKeyboardSettings] =
    useState<PlayerKeyboardModeSettings>(DEFAULT_KEYBOARD_SETTINGS);
  const [keyboardSettingsLoaded, setKeyboardSettingsLoaded] = useState(false);

  const [youtubeEmbedSrc, setYoutubeEmbedSrc] = useState(() =>
    isYt
      ? getEmbedUrl(video, initialStartSeconds, { enableYouTubeJsApi: true })
      : '',
  );
  const [youtubePlayback, setYoutubePlayback] =
    useState<YouTubePlaybackResponse | null>(null);
  const [youtubePlaybackLoading, setYoutubePlaybackLoading] = useState(false);
  const [youtubePlaybackError, setYoutubePlaybackError] = useState<
    string | null
  >(null);
  const [youtubePlayerLoaded, setYoutubePlayerLoaded] = useState(false);
  const [youtubeTelemetryReady, setYoutubeTelemetryReady] = useState(false);
  const [youtubePlayerState, setYoutubePlayerState] = useState<number>(-1);
  const [youtubeIframePlaybackRate, setYoutubeIframePlaybackRate] = useState(1);

  const [bilibiliPlayback, setBilibiliPlayback] =
    useState<BilibiliPlaybackResponse | null>(null);
  const [bilibiliPlaybackLoading, setBilibiliPlaybackLoading] = useState(!isYt);
  const [bilibiliPlaybackError, setBilibiliPlaybackError] = useState<
    string | null
  >(null);

  const [nativePlaybackRate, setNativePlaybackRate] = useState(1);
  const [nativeIsPlaying, setNativeIsPlaying] = useState(false);

  const modalContentRef = useRef<HTMLDivElement>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
  const youtubeNativeVideoRef = useRef<HTMLVideoElement>(null);
  const bilibiliVideoRef = useRef<HTMLVideoElement>(null);
  const pendingYouTubeSeekRef = useRef<number | null>(null);
  const pendingNativeSeekRef = useRef<number | null>(
    isYt ? null : Math.max(0, Math.floor(initialStartSeconds)),
  );
  const lastManualRateRef = useRef<number | null>(null);
  const keyboardSettingsRef = useRef(keyboardSettings);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/videos/${video.id}/summary`, {
      cache: 'no-store',
      signal: controller.signal
    })
      .then(res => res.json())
      .then(data => {
         if (!controller.signal.aborted && data.markdown) {
           setSummaryMarkdown(data.markdown);
         }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [video.id]);

  const chapters = useMemo(
    () => extractSummaryChapters(summaryMarkdown, {
      platform: video.platform,
      video_id: video.video_id,
    }),
    [summaryMarkdown, video.platform, video.video_id],
  );

  const { width: leftPanelWidth, handleRef: panelHandleRef } =
    useDraggableWidth('player-panel-width', 380, { min: 260, max: 520 });

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

  const desktopKeyboardEnabled = keyboardSettings.enabled && !isMobile;
  const shouldAttemptNativeYouTube =
    isYt && keyboardSettingsLoaded && desktopKeyboardEnabled;
  const useNativeYouTube =
    shouldAttemptNativeYouTube &&
    Boolean(youtubePlayback?.proxyUrl) &&
    !youtubePlaybackError;
  const usesNativeVideo = !isYt || useNativeYouTube;
  const isPlayerPlaying = isYt
    ? useNativeYouTube
      ? nativeIsPlaying
      : youtubePlayerState === 1
    : nativeIsPlaying;

  const rateOptions = useMemo(() => {
    const values = [
      keyboardSettings.rateMin,
      0.75,
      1,
      1.25,
      1.5,
      2,
      keyboardSettings.rateMax,
      nativePlaybackRate,
    ].filter(
      (rate) =>
        Number.isFinite(rate) &&
        rate >= keyboardSettings.rateMin &&
        rate <= keyboardSettings.rateMax,
    );
    return Array.from(
      new Set(values.map((rate) => Math.round(rate * 100) / 100)),
    )
      .sort((a, b) => a - b)
      .map((rate) => Number(rate.toFixed(2)));
  }, [keyboardSettings.rateMax, keyboardSettings.rateMin, nativePlaybackRate]);

  useEffect(() => {
    keyboardSettingsRef.current = keyboardSettings;
  }, [keyboardSettings]);

  useEffect(() => {
    setIsMobile(window.innerWidth <= 900);
    if (window.innerWidth <= 900) {
      setIsAudioMode(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadKeyboardSettings() {
      try {
        const res = await fetch('/api/settings/player-keyboard-mode', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as PlayerKeyboardModeSettings;
        if (!controller.signal.aborted) {
          setKeyboardSettings({ ...DEFAULT_KEYBOARD_SETTINGS, ...data });
        }
      } catch {
        // Keep the default shortcut table when settings are temporarily unreadable.
      } finally {
        if (!controller.signal.aborted) {
          setKeyboardSettingsLoaded(true);
        }
      }
    }

    void loadKeyboardSettings();
    return () => controller.abort();
  }, []);

  const focusPlayer = useCallback(() => {
    const focusElement = (element: HTMLElement | null) => {
      if (!element) return;
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
    };

    if (desktopKeyboardEnabled) {
      window.requestAnimationFrame(() => focusElement(modalContentRef.current));
      return;
    }

    if (isYt && !useNativeYouTube) {
      const iframe = youtubeIframeRef.current;
      if (!iframe) return;

      const attemptFocus = () => {
        focusElement(iframe);
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

    const videoElement = isYt
      ? youtubeNativeVideoRef.current
      : bilibiliVideoRef.current;
    window.requestAnimationFrame(() => focusElement(videoElement));
  }, [desktopKeyboardEnabled, isYt, useNativeYouTube]);

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

  const loadYouTubePlayback = useCallback(
    async (signal?: AbortSignal, restoreSeconds?: number) => {
      if (!isYt) return;

      setYoutubePlaybackLoading(true);
      setYoutubePlaybackError(null);

      try {
        const res = await fetch(
          `/api/youtube/playback?videoId=${encodeURIComponent(video.video_id)}`,
          {
            cache: 'no-store',
            signal,
          },
        );
        const data = (await res.json()) as YouTubePlaybackResponse;
        if (!res.ok || data.error || !data.proxyUrl) {
          throw new Error(
            data.details || data.error || 'YouTube 播放地址加载失败',
          );
        }
        if (signal?.aborted) return;
        setYoutubePlayback(data);
        if (typeof restoreSeconds === 'number' && restoreSeconds >= 0) {
          pendingNativeSeekRef.current = restoreSeconds;
        }
      } catch (error) {
        if (signal?.aborted) return;
        const message =
          error instanceof Error ? error.message : 'YouTube 播放地址加载失败';
        setYoutubePlayback(null);
        setYoutubePlaybackError(message);
      } finally {
        if (!signal?.aborted) {
          setYoutubePlaybackLoading(false);
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

  useEffect(() => {
    if (!shouldAttemptNativeYouTube) return;

    const controller = new AbortController();
    void loadYouTubePlayback(
      controller.signal,
      pendingNativeSeekRef.current ??
        Math.max(0, Math.floor(initialStartSeconds)),
    );

    return () => controller.abort();
  }, [initialStartSeconds, loadYouTubePlayback, shouldAttemptNativeYouTube]);

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
          id: 1,
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

  const getNativeVideoElement = useCallback(() => {
    return isYt ? youtubeNativeVideoRef.current : bilibiliVideoRef.current;
  }, [isYt]);

  const setNativeRate = useCallback(
    (nextRate: number) => {
      const videoElement = getNativeVideoElement();
      const clamped = clampRate(nextRate, keyboardSettingsRef.current);
      setNativePlaybackRate(clamped);
      if (videoElement) {
        videoElement.playbackRate = clamped;
      }
      return clamped;
    },
    [getNativeVideoElement],
  );

  const applyYouTubeIframeRate = useCallback(
    (nextRate: number) => {
      const rate = nearestYouTubeIframeRate(
        nextRate,
        keyboardSettingsRef.current,
      );
      setYoutubeIframePlaybackRate(rate);
      postYouTubeCommand('setPlaybackRate', [rate]);
      return rate;
    },
    [postYouTubeCommand],
  );

  const flushPendingNativeSeek = useCallback(
    (seconds: number) => {
      const videoElement = getNativeVideoElement();
      const hasSource = isYt
        ? Boolean(youtubePlayback?.proxyUrl)
        : Boolean(bilibiliPlayback?.proxyUrl);
      if (!videoElement || !hasSource) return false;

      pendingNativeSeekRef.current = seconds;

      const canSeek =
        videoElement.readyState >= 1 || Number.isFinite(videoElement.duration);
      if (!canSeek) return false;

      try {
        const boundedSeconds =
          Number.isFinite(videoElement.duration) && videoElement.duration > 0
            ? Math.min(seconds, Math.max(0, videoElement.duration - 0.25))
            : seconds;
        videoElement.currentTime = Math.max(0, boundedSeconds);
        videoElement.playbackRate = nativePlaybackRate;
        const playPromise = videoElement.play();
        if (playPromise) {
          playPromise.catch(() => {});
        }
        pendingNativeSeekRef.current = null;
        return true;
      } catch {
        return false;
      }
    },
    [
      bilibiliPlayback?.proxyUrl,
      getNativeVideoElement,
      isYt,
      nativePlaybackRate,
      youtubePlayback?.proxyUrl,
    ],
  );

  const toggleNativePlayback = useCallback(() => {
    const videoElement = getNativeVideoElement();
    if (!videoElement) return;

    if (videoElement.paused) {
      const playPromise = videoElement.play();
      if (playPromise) {
        playPromise.catch(() => {});
      }
      return;
    }

    videoElement.pause();
  }, [getNativeVideoElement]);

  const togglePlay = useCallback(() => {
    if (usesNativeVideo) {
      toggleNativePlayback();
      return;
    }
    if (youtubePlayerState === 1) {
      postYouTubeCommand('pauseVideo');
    } else {
      postYouTubeCommand('playVideo');
    }
  }, [usesNativeVideo, toggleNativePlayback, youtubePlayerState, postYouTubeCommand]);

  const applyPlaybackRate = useCallback(
    (nextRate: number, options?: { rememberManual?: boolean }) => {
      const appliedRate = usesNativeVideo
        ? setNativeRate(nextRate)
        : applyYouTubeIframeRate(nextRate);

      if (options?.rememberManual) {
        lastManualRateRef.current = isOneRate(appliedRate) ? null : appliedRate;
      }

      return appliedRate;
    },
    [applyYouTubeIframeRate, setNativeRate, usesNativeVideo],
  );

  const getCurrentPlaybackRate = useCallback(() => {
    if (usesNativeVideo) {
      return getNativeVideoElement()?.playbackRate ?? nativePlaybackRate;
    }
    return youtubeIframePlaybackRate;
  }, [
    getNativeVideoElement,
    nativePlaybackRate,
    usesNativeVideo,
    youtubeIframePlaybackRate,
  ]);

  const handleRateToggle = useCallback(() => {
    const currentRate = getCurrentPlaybackRate();
    if (!isOneRate(currentRate)) {
      applyPlaybackRate(1);
      return;
    }

    applyPlaybackRate(
      lastManualRateRef.current ?? keyboardSettingsRef.current.rateTogglePreset,
    );
  }, [applyPlaybackRate, getCurrentPlaybackRate]);

  const handleRateStep = useCallback(
    (delta: number) => {
      const nextRate = getCurrentPlaybackRate() + delta;
      applyPlaybackRate(nextRate, { rememberManual: true });
    },
    [applyPlaybackRate, getCurrentPlaybackRate],
  );

  const handleSeekStep = useCallback(
    (secondsDelta: number) => {
      const videoElement = usesNativeVideo ? getNativeVideoElement() : null;
      const currentSeconds =
        videoElement && Number.isFinite(videoElement.currentTime)
          ? videoElement.currentTime
          : playerStartSeconds;
      const nextSeconds = currentSeconds + secondsDelta;
      if (nextSeconds < 0) return;

      const duration =
        videoElement &&
        Number.isFinite(videoElement.duration) &&
        videoElement.duration > 0
          ? videoElement.duration
          : playerDuration;
      if (
        Number.isFinite(duration) &&
        duration > 0 &&
        nextSeconds > duration - 0.25
      ) {
        return;
      }

      setPlayerStartSeconds(nextSeconds);
      if (usesNativeVideo) {
        pendingNativeSeekRef.current = nextSeconds;
        flushPendingNativeSeek(nextSeconds);
        return;
      }

      pendingYouTubeSeekRef.current = nextSeconds;
      flushPendingYouTubeSeek(nextSeconds);
    },
    [
      flushPendingNativeSeek,
      flushPendingYouTubeSeek,
      getNativeVideoElement,
      playerDuration,
      playerStartSeconds,
      usesNativeVideo,
    ],
  );

  // ── Keyboard interaction ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = resolvePlayerKeyboardAction(e, {
        isTypingContext:
          isTypingContextTarget(e.target) ||
          isTypingContextTarget(document.activeElement),
        settings: keyboardSettings,
      });

      if (action.type === 'none') return;

      e.preventDefault();
      e.stopPropagation();

      if (action.type === 'close-modal') {
        onClose();
        return;
      }
      if (action.type === 'play-pause') {
        if (usesNativeVideo) {
          toggleNativePlayback();
        } else if (youtubePlayerState === 1) {
          postYouTubeCommand('pauseVideo');
        } else {
          postYouTubeCommand('playVideo');
        }
        return;
      }
      if (action.type === 'rate-toggle') {
        handleRateToggle();
        return;
      }
      if (action.type === 'rate-step') {
        handleRateStep(action.delta);
        return;
      }
      if (action.type === 'seek-step') {
        handleSeekStep(action.seconds);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = '';
    };
  }, [
    handleRateStep,
    handleRateToggle,
    handleSeekStep,
    keyboardSettings,
    onClose,
    postYouTubeCommand,
    toggleNativePlayback,
    usesNativeVideo,
    youtubePlayerState,
  ]);

  useEffect(() => {
    const nextStartSeconds = Math.max(0, Math.floor(initialStartSeconds));
    setPlayerStartSeconds(nextStartSeconds);
    setPlayerDuration(0);
    setNativePlaybackRate(1);
    setNativeIsPlaying(false);
    setYoutubeIframePlaybackRate(1);
    lastManualRateRef.current = null;

    if (video.platform === 'youtube') {
      pendingYouTubeSeekRef.current = null;
      pendingNativeSeekRef.current = nextStartSeconds;
      setYoutubePlayerLoaded(false);
      setYoutubeTelemetryReady(false);
      setYoutubePlayerState(-1);
      setYoutubePlayback(null);
      setYoutubePlaybackLoading(false);
      setYoutubePlaybackError(null);
      setYoutubeEmbedSrc(
        getEmbedUrl(video, nextStartSeconds, { enableYouTubeJsApi: true }),
      );
    } else {
      pendingNativeSeekRef.current = nextStartSeconds;
      setBilibiliPlayback(null);
      setBilibiliPlaybackError(null);
    }
  }, [initialStartSeconds, video]);

  useEffect(() => {
    if (isYt) {
      focusPlayer();
    }
  }, [focusPlayer, isYt, useNativeYouTube, youtubeEmbedSrc]);

  useEffect(() => {
    if (!desktopKeyboardEnabled || !isYt || useNativeYouTube) return;

    const reclaimFocusFromYouTubeIframe = () => {
      window.setTimeout(() => {
        if (document.activeElement !== youtubeIframeRef.current) return;
        try {
          modalContentRef.current?.focus({ preventScroll: true });
        } catch {
          modalContentRef.current?.focus();
        }
      }, 0);
    };

    window.addEventListener('blur', reclaimFocusFromYouTubeIframe);
    return () => {
      window.removeEventListener('blur', reclaimFocusFromYouTubeIframe);
    };
  }, [desktopKeyboardEnabled, isYt, useNativeYouTube]);

  useEffect(() => {
    if (!isYt && bilibiliPlayback?.proxyUrl) {
      focusPlayer();
    }
  }, [bilibiliPlayback?.proxyUrl, focusPlayer, isYt]);

  useMediaSession(
    {
      title: video.title,
      artist: video.channel_name,
      artwork: video.thumbnail_url || '',
    },
    {
      onPlay: () => {
        if (usesNativeVideo) {
          getNativeVideoElement()?.play();
        } else {
          postYouTubeCommand('playVideo');
        }
      },
      onPause: () => {
        if (usesNativeVideo) {
          getNativeVideoElement()?.pause();
        } else {
          postYouTubeCommand('pauseVideo');
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
    isPlayerPlaying ? 'playing' : 'paused',
  );

  const handleTimestampClick = (seconds: number) => {
    const nextSeconds = Math.max(0, Math.floor(seconds));
    setPlayerStartSeconds(nextSeconds);

    if (usesNativeVideo) {
      pendingNativeSeekRef.current = nextSeconds;
      flushPendingNativeSeek(nextSeconds);
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
    if (!isYt || useNativeYouTube) return;

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
  }, [isYt, useNativeYouTube]);

  useEffect(() => {
    if (!isYt || useNativeYouTube || !youtubePlayerLoaded) return;

    requestYouTubeTelemetry();
    const warmupTimers = [80, 220, 500].map((delay) =>
      window.setTimeout(requestYouTubeTelemetry, delay),
    );
    const interval = window.setInterval(requestYouTubeTelemetry, 500);

    return () => {
      warmupTimers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(interval);
    };
  }, [isYt, requestYouTubeTelemetry, useNativeYouTube, youtubePlayerLoaded]);

  useEffect(() => {
    if (
      !isYt ||
      useNativeYouTube ||
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
  }, [flushPendingYouTubeSeek, isYt, useNativeYouTube, youtubeTelemetryReady]);

  const handleNativeLoadedMetadata = useCallback(() => {
    const pendingSeconds = pendingNativeSeekRef.current;
    const videoElement = getNativeVideoElement();
    if (!videoElement) return;

    focusPlayer();
    videoElement.playbackRate = nativePlaybackRate;
    setPlayerDuration(videoElement.duration);

    if (pendingSeconds !== null) {
      flushPendingNativeSeek(pendingSeconds);
      return;
    }

    const playPromise = videoElement.play();
    if (playPromise) {
      playPromise.catch(() => {});
    }
  }, [
    flushPendingNativeSeek,
    focusPlayer,
    getNativeVideoElement,
    nativePlaybackRate,
  ]);

  const handleYouTubeNativeError = useCallback(() => {
    const resumeSeconds =
      youtubeNativeVideoRef.current?.currentTime ?? playerStartSeconds;
    setPlayerStartSeconds(resumeSeconds);
    void loadYouTubePlayback(undefined, resumeSeconds);
  }, [loadYouTubePlayback, playerStartSeconds]);

  const renderNativeVideo = (
    platform: 'youtube' | 'bilibili',
    proxyUrl: string,
  ) => (
    <video
      key={`${platform}-${video.id}-${proxyUrl}-${
        platform === 'youtube' ? (youtubePlayback?.expiresAt ?? '') : ''
      }`}
      ref={platform === 'youtube' ? youtubeNativeVideoRef : bilibiliVideoRef}
      tabIndex={0}
      src={proxyUrl}
      poster={video.thumbnail_url || undefined}
      controls
      autoPlay
      preload="auto"
      playsInline
      onLoadedMetadata={handleNativeLoadedMetadata}
      onPlay={() => setNativeIsPlaying(true)}
      onPause={() => setNativeIsPlaying(false)}
      onError={platform === 'youtube' ? handleYouTubeNativeError : undefined}
      onRateChange={(event) => {
        const nextRate = event.currentTarget.playbackRate;
        if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
          setNativePlaybackRate(nextRate);
        }
      }}
      onTimeUpdate={(event) => {
        setPlayerStartSeconds(event.currentTarget.currentTime);
      }}
      style={{
        width: '100%',
        height: '100%',
        background: '#000',
      }}
    />
  );

  const renderPlaybackStatus = (
    title: string,
    detail: string | null | undefined,
  ) => (
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
          {title}
        </div>
        <div
          style={{
            fontSize: 13,
            color: modalColors.textMuted,
          }}
        >
          {detail}
        </div>
      </div>
    </div>
  );

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
        ref={modalContentRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
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

        <div
          id="player-main-container"
          style={{ display: 'flex', flex: 1, minHeight: 0 }}
        >
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
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
            {isAudioMode && (
              <AudioModeOverlay
                video={video}
                isPlaying={isPlayerPlaying}
                currentTime={playerStartSeconds}
                duration={playerDuration}
                onTogglePlay={togglePlay}
                onSeek={handleTimestampClick}
                onClose={onClose}
              />
            )}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: isAudioMode || isMobile ? 0 : 1,
                pointerEvents: isAudioMode || isMobile ? 'none' : 'auto',
                transition: 'opacity 0.3s',
              }}
            >
              {isYt ? (
                <>
                  {shouldAttemptNativeYouTube && youtubePlaybackLoading ? (
                    renderPlaybackStatus(
                      '正在解析 YouTube 原生播放流…',
                      '解析成功后可以使用精确倍速快捷键。',
                    )
                  ) : useNativeYouTube && youtubePlayback?.proxyUrl ? (
                    renderNativeVideo('youtube', youtubePlayback.proxyUrl)
                  ) : (
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
                  )}

                  {desktopKeyboardEnabled && youtubePlaybackError && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 16,
                        bottom: 16,
                        maxWidth: 420,
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: `1px solid ${modalColors.dangerBorder}`,
                        background: modalColors.dangerSoft,
                        color: modalColors.textStrong,
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      精准倍速不可用，已回退到 YouTube iframe：
                      {youtubePlaybackError}
                    </div>
                  )}
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
                    {bilibiliPlayback?.proxyUrl
                      ? renderNativeVideo('bilibili', bilibiliPlayback.proxyUrl)
                      : renderPlaybackStatus(
                          bilibiliPlaybackLoading
                            ? '正在解析 B 站可播放流…'
                            : '当前无法直接播放这个 B 站视频',
                          bilibiliPlaybackError ||
                            '这个阶段只支持可直接播放的 MP4 单路流。',
                        )}
                  </div>

                </div>
              )}
            </div>
            </div>
            <PlayerBottomBar
              isPlaying={isPlayerPlaying}
              onTogglePlay={togglePlay}
              currentSeconds={playerStartSeconds}
              duration={playerDuration}
              playbackRate={usesNativeVideo ? nativePlaybackRate : youtubeIframePlaybackRate}
              chapters={chapters}
              onSeek={handleTimestampClick}
              disabled={isYt ? (shouldAttemptNativeYouTube && youtubePlaybackLoading && !youtubePlayerLoaded) : (!bilibiliPlayback?.proxyUrl)}
              trailing={!isYt ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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

                  {!bilibiliPlaybackLoading &&
                    !bilibiliPlayback?.proxyUrl && (
                      <button
                        type="button"
                        onClick={() => void loadBilibiliPlayback()}
                        style={{
                          border: `1px solid ${modalColors.borderStrong}`,
                          borderRadius: 8,
                          background: 'var(--bg-hover)',
                          color: modalColors.textStrong,
                          cursor: 'pointer',
                          padding: '4px 10px',
                          fontSize: 12,
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
                          fontSize: 12,
                          color: modalColors.textSoft,
                        }}
                      >
                        限制：{bilibiliPlayback.limitations.join('；')}
                      </div>
                    )}
                </div>
              ) : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
