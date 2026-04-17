'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { VideoWithMeta } from '@/types';
import { useMediaSession } from '@/hooks/useMediaSession';
import {
  parseYouTubePlayerMessage,
  createYouTubeListeningMessage,
  resolveYouTubeEmbedOrigin,
  isTrustedYouTubeOrigin,
} from '@/lib/youtube-player';

interface BilibiliPlaybackResponse {
  url?: string;
  proxyUrl?: string;
  aid?: number;
  cid?: number;
  qualityLabel?: string;
  format?: string;
  authUsed?: boolean;
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

export interface EmbeddedPlayerSeekRequest {
  seconds: number;
  nonce: number;
}

interface EmbeddedPlayerProps {
  video: VideoWithMeta;
  initialStartSeconds?: number;
  isAudioMode?: boolean;
  isVisible?: boolean;
  seekRequest?: EmbeddedPlayerSeekRequest | null;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
  onStateChange?: (isPlaying: boolean) => void;
  children?: (props: {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    togglePlay: () => void;
    seek: (time: number) => void;
  }) => ReactNode;
}

function getEmbedUrl(
  video: VideoWithMeta,
  start: number,
  options: { enableYouTubeJsApi?: boolean } = {},
) {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${video.video_id}`);
  url.searchParams.set('autoplay', '1');
  url.searchParams.set('disablekb', '1');
  url.searchParams.set('playsinline', '1');
  if (start > 0) url.searchParams.set('start', Math.floor(start).toString());
  if (options.enableYouTubeJsApi) {
    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set(
      'origin',
      typeof window !== 'undefined' ? window.location.origin : '',
    );
  }
  return url.toString();
}

function clampSeconds(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  if (Number.isFinite(duration) && duration > 0) {
    return Math.max(0, Math.min(time, Math.max(0, duration - 0.25)));
  }
  return Math.max(0, time);
}

export default function EmbeddedPlayer({
  video,
  initialStartSeconds = 0,
  isAudioMode = false,
  isVisible = false,
  seekRequest,
  onTimeUpdate,
  onDurationChange,
  onStateChange,
  children,
}: EmbeddedPlayerProps) {
  const isYt = video.platform === 'youtube';
  const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
  const nativeVideoRef = useRef<HTMLVideoElement>(null);
  const hiddenAudioRef = useRef<HTMLAudioElement>(null);
  const pendingNativeSeekRef = useRef<number | null>(
    Math.max(0, Math.floor(initialStartSeconds)),
  );
  const youtubeNativeErrorCountRef = useRef(0);
  const lastSeekRequestNonceRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialStartSeconds);
  const [duration, setDuration] = useState(0);
  const [youtubePlayback, setYoutubePlayback] =
    useState<YouTubePlaybackResponse | null>(null);
  const [youtubePlaybackLoading, setYoutubePlaybackLoading] = useState(false);
  const [youtubePlaybackError, setYoutubePlaybackError] = useState<string | null>(
    null,
  );
  const [youtubeNativeReloadToken, setYoutubeNativeReloadToken] = useState(0);
  const [bilibiliPlayback, setBilibiliPlayback] =
    useState<BilibiliPlaybackResponse | null>(null);
  const [bilibiliPlaybackLoading, setBilibiliPlaybackLoading] = useState(false);
  const [bilibiliPlaybackError, setBilibiliPlaybackError] = useState<string | null>(
    null,
  );
  const [hiddenAudioSrc, setHiddenAudioSrc] = useState<string>('');

  const useNativeYouTube =
    isYt && Boolean(youtubePlayback?.proxyUrl) && !youtubePlaybackError;
  const shouldUseYouTubeNativeShell = isYt && !youtubePlaybackError;
  const usesNativeVideo =
    !isYt || useNativeYouTube || shouldUseYouTubeNativeShell;
  const nativeProxyUrl = isYt
    ? youtubePlayback?.proxyUrl
    : bilibiliPlayback?.proxyUrl || bilibiliPlayback?.url;
  const needsIframeHeartbeat = isYt && !usesNativeVideo;

  useEffect(() => {
    setHiddenAudioSrc(
      'data:audio/mpeg;base64,SUQzBAAAAAABAFRYWFgAAAASAAADbWFqb3JfYnJhbmQAZGFzaABUWFhYAAAAEQAAA21pbm9yX3ZlcnNpb24AMABUWFhYAAAAHAAAA2NvbXBhdGlibGVfYnJhbmRzAGlzbzZtcDQyAFRTU0UAAAAPAAADTGF2ZjYwLjMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zw0QEAAAADSAAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/88NEBAAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/88NEBAAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
    );
  }, []);

  useEffect(() => {
    const nextStart = Math.max(0, Math.floor(initialStartSeconds));
    pendingNativeSeekRef.current = nextStart;
    youtubeNativeErrorCountRef.current = 0;
    lastSeekRequestNonceRef.current = null;
    setIsPlaying(false);
    setCurrentTime(nextStart);
    setDuration(0);
    setYoutubePlayback(null);
    setYoutubePlaybackError(null);
    setYoutubePlaybackLoading(false);
    setYoutubeNativeReloadToken(0);
    setBilibiliPlayback(null);
    setBilibiliPlaybackError(null);
    setBilibiliPlaybackLoading(false);
    onTimeUpdate?.(nextStart);
    onDurationChange?.(0);
    onStateChange?.(false);
  }, [
    initialStartSeconds,
    onDurationChange,
    onStateChange,
    onTimeUpdate,
    video.id,
  ]);

  useEffect(() => {
    if (!isYt) return;
    const controller = new AbortController();

    async function loadYouTubePlayback() {
      setYoutubePlaybackLoading(true);
      setYoutubePlaybackError(null);
      try {
        const res = await fetch(
          `/api/youtube/playback?videoId=${encodeURIComponent(video.video_id)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const data = (await res.json()) as YouTubePlaybackResponse;
        if (!res.ok || data.error || !data.proxyUrl) {
          throw new Error(
            data.details || data.error || 'YouTube 播放地址加载失败',
          );
        }
        if (!controller.signal.aborted) {
          setYoutubePlayback(data);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setYoutubePlayback(null);
        setYoutubePlaybackError(
          error instanceof Error ? error.message : 'YouTube 播放地址加载失败',
        );
      } finally {
        if (!controller.signal.aborted) {
          setYoutubePlaybackLoading(false);
        }
      }
    }

    void loadYouTubePlayback();
    return () => controller.abort();
  }, [isYt, video.video_id]);

  useEffect(() => {
    if (isYt) return;
    const controller = new AbortController();

    async function loadBilibiliPlayback() {
      setBilibiliPlaybackLoading(true);
      setBilibiliPlaybackError(null);
      try {
        const res = await fetch(
          `/api/bilibili/playback?bvid=${encodeURIComponent(video.video_id)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const data = (await res.json()) as BilibiliPlaybackResponse;
        if (!res.ok || data.error || !(data.proxyUrl || data.url)) {
          throw new Error(data.details || data.error || 'B站播放地址加载失败');
        }
        if (!controller.signal.aborted) {
          setBilibiliPlayback(data);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setBilibiliPlaybackError(
          error instanceof Error ? error.message : 'B站播放地址加载失败',
        );
      } finally {
        if (!controller.signal.aborted) {
          setBilibiliPlaybackLoading(false);
        }
      }
    }

    void loadBilibiliPlayback();
    return () => controller.abort();
  }, [isYt, video.video_id]);

  const postYouTubeCommand = useCallback((func: string, args: unknown[] = []) => {
    const iframe = youtubeIframeRef.current;
    if (!iframe || !iframe.contentWindow) return false;
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 1 }),
      resolveYouTubeEmbedOrigin(iframe.src),
    );
    return true;
  }, []);

  const syncIframeHeartbeat = useCallback(
    (playing: boolean) => {
      if (!needsIframeHeartbeat || !hiddenAudioRef.current) return;
      if (playing) {
        hiddenAudioRef.current.play().catch(() => {});
      } else {
        hiddenAudioRef.current.pause();
      }
    },
    [needsIframeHeartbeat],
  );

  const playMedia = useCallback(() => {
    if (usesNativeVideo) {
      nativeVideoRef.current?.play().catch(() => {});
      return;
    }
    postYouTubeCommand('playVideo');
    syncIframeHeartbeat(true);
  }, [postYouTubeCommand, syncIframeHeartbeat, usesNativeVideo]);

  const pauseMedia = useCallback(() => {
    if (usesNativeVideo) {
      nativeVideoRef.current?.pause();
      return;
    }
    postYouTubeCommand('pauseVideo');
    syncIframeHeartbeat(false);
  }, [postYouTubeCommand, syncIframeHeartbeat, usesNativeVideo]);

  const togglePlay = useCallback(() => {
    if (usesNativeVideo) {
      const media = nativeVideoRef.current;
      if (!media) return;
      if (media.paused) {
        media.play().catch(() => {});
      } else {
        media.pause();
      }
      return;
    }

    const nextPlaying = !isPlaying;
    postYouTubeCommand(nextPlaying ? 'playVideo' : 'pauseVideo');
    syncIframeHeartbeat(nextPlaying);
  }, [isPlaying, postYouTubeCommand, syncIframeHeartbeat, usesNativeVideo]);

  const seek = useCallback(
    (time: number) => {
      const target = clampSeconds(time, duration);
      setCurrentTime(target);
      onTimeUpdate?.(target);

      if (usesNativeVideo) {
        pendingNativeSeekRef.current = target;
        const media = nativeVideoRef.current;
        if (media && (media.readyState >= 1 || Number.isFinite(media.duration))) {
          try {
            media.currentTime = clampSeconds(target, media.duration);
            pendingNativeSeekRef.current = null;
          } catch {
            pendingNativeSeekRef.current = target;
          }
        }
        return;
      }

      postYouTubeCommand('seekTo', [target, true]);
    },
    [duration, onTimeUpdate, postYouTubeCommand, usesNativeVideo],
  );

  useMediaSession(
    {
      title: video.title,
      artist: video.channel_name,
      artwork: video.thumbnail_url || '',
      album: 'Needle Audio',
    },
    {
      onPlay: playMedia,
      onPause: pauseMedia,
      onSeekBackward: () => seek(currentTime - 10),
      onSeekForward: () => seek(currentTime + 10),
      onSeekTo: (details) => {
        if (details.seekTime !== undefined) seek(details.seekTime);
      },
    },
    isPlaying ? 'playing' : 'paused',
    currentTime,
    duration,
  );

  useEffect(() => {
    if (!seekRequest) return;
    if (lastSeekRequestNonceRef.current === seekRequest.nonce) return;
    lastSeekRequestNonceRef.current = seekRequest.nonce;
    seek(seekRequest.seconds);
  }, [seek, seekRequest]);

  useEffect(() => {
    if (!isYt || usesNativeVideo) return;

    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedYouTubeOrigin(event.origin)) return;
      const telemetry = parseYouTubePlayerMessage(event.data);
      if (!telemetry) return;

      if (telemetry.playerState !== undefined) {
        const playing = telemetry.playerState === 1;
        setIsPlaying(playing);
        onStateChange?.(playing);
        syncIframeHeartbeat(playing);
      }
      if (telemetry.currentTime !== undefined) {
        setCurrentTime(telemetry.currentTime);
        onTimeUpdate?.(telemetry.currentTime);
      }
      if (telemetry.duration !== undefined) {
        setDuration(telemetry.duration);
        onDurationChange?.(telemetry.duration);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    isYt,
    onDurationChange,
    onStateChange,
    onTimeUpdate,
    syncIframeHeartbeat,
    usesNativeVideo,
  ]);

  const handleNativeLoadedMetadata = useCallback(() => {
    const media = nativeVideoRef.current;
    if (!media) return;

    youtubeNativeErrorCountRef.current = 0;
    const nextDuration = Number.isFinite(media.duration) ? media.duration : 0;
    setDuration(nextDuration);
    onDurationChange?.(nextDuration);

    const pending = pendingNativeSeekRef.current;
    if (pending !== null) {
      try {
        media.currentTime = clampSeconds(pending, media.duration);
        pendingNativeSeekRef.current = null;
      } catch {
        pendingNativeSeekRef.current = pending;
      }
    }

    media.play().catch(() => {});
  }, [onDurationChange]);

  const handleNativePlayState = useCallback(
    (playing: boolean) => {
      setIsPlaying(playing);
      onStateChange?.(playing);
    },
    [onStateChange],
  );

  const handleYouTubeNativeError = useCallback(() => {
    const media = nativeVideoRef.current;
    const resumeSeconds = media?.currentTime ?? currentTime;
    pendingNativeSeekRef.current = resumeSeconds;
    youtubeNativeErrorCountRef.current += 1;

    if (youtubeNativeErrorCountRef.current <= 2) {
      setYoutubeNativeReloadToken((token) => token + 1);
      return;
    }

    setYoutubePlayback(null);
    setYoutubePlaybackError('YouTube 原生播放流暂时不可用，已回退 iframe');
  }, [currentTime]);

  const renderNativeVideo = () => {
    if (!nativeProxyUrl) {
      const loading = isYt ? youtubePlaybackLoading : bilibiliPlaybackLoading;
      const error = isYt ? youtubePlaybackError : bilibiliPlaybackError;
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#000',
            color: '#fff',
            padding: 16,
            textAlign: 'center',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {loading ? '正在解析播放流…' : error || '播放流暂时不可用'}
        </div>
      );
    }

    return (
      <video
        key={`${video.platform}-${video.id}-${nativeProxyUrl}-${youtubeNativeReloadToken}`}
        ref={nativeVideoRef}
        src={nativeProxyUrl}
        poster={video.thumbnail_url || undefined}
        autoPlay
        playsInline
        preload="auto"
        controls={isVisible && !isAudioMode}
        style={{ width: '100%', height: '100%', background: '#000' }}
        onLoadedMetadata={handleNativeLoadedMetadata}
        onPlay={() => handleNativePlayState(true)}
        onPause={() => handleNativePlayState(false)}
        onTimeUpdate={(event) => {
          const nextTime = event.currentTarget.currentTime;
          setCurrentTime(nextTime);
          onTimeUpdate?.(nextTime);
        }}
        onDurationChange={(event) => {
          const nextDuration = event.currentTarget.duration;
          setDuration(nextDuration);
          onDurationChange?.(nextDuration);
        }}
        onError={isYt ? handleYouTubeNativeError : undefined}
      />
    );
  };

  return (
    <>
      <div
        style={
          isVisible
            ? {
                position: 'relative',
                width: '100%',
                height: '100%',
                zIndex: 1,
                background: '#000',
              }
            : {
                position: 'absolute',
                opacity: 0.01,
                pointerEvents: 'none',
                width: 200,
                height: 200,
                overflow: 'hidden',
                left: -500,
                top: -500,
                zIndex: -1,
              }
        }
      >
        <audio ref={hiddenAudioRef} src={hiddenAudioSrc} loop playsInline />
        {usesNativeVideo ? (
          renderNativeVideo()
        ) : (
          <iframe
            ref={youtubeIframeRef}
            src={getEmbedUrl(video, initialStartSeconds, {
              enableYouTubeJsApi: true,
            })}
            allow="autoplay; encrypted-media"
            title={video.title}
            style={{ width: '100%', height: '100%', border: 'none' }}
            onLoad={() => {
              const iframe = youtubeIframeRef.current;
              if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage(
                  createYouTubeListeningMessage(),
                  resolveYouTubeEmbedOrigin(iframe.src),
                );
              }
            }}
          />
        )}
      </div>
      {children?.({ isPlaying, currentTime, duration, togglePlay, seek })}
    </>
  );
}
