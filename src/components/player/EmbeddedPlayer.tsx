'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { VideoWithMeta } from '@/types';
import { useMediaSession } from '@/hooks/useMediaSession';
import { 
  parseYouTubePlayerMessage, 
  createYouTubeListeningMessage, 
  resolveYouTubeEmbedOrigin,
  isTrustedYouTubeOrigin
} from '@/lib/youtube-player';

interface BilibiliPlaybackResponse {
  url: string;
  proxyUrl?: string;
  aid: number;
  cid: number;
  qualityLabel?: string;
  format?: string;
  authUsed?: boolean;
  limitations?: string[];
}

interface EmbeddedPlayerProps {
  video: VideoWithMeta;
  initialStartSeconds?: number;
  isAudioMode?: boolean;
  isVisible?: boolean;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
  onStateChange?: (isPlaying: boolean) => void;
  children?: (props: { 
    isPlaying: boolean; 
    currentTime: number; 
    duration: number;
    togglePlay: () => void;
    seek: (time: number) => void;
  }) => React.ReactNode;
}

function getEmbedUrl(video: VideoWithMeta, start: number, options: { enableYouTubeJsApi?: boolean } = {}) {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${video.video_id}`);
  url.searchParams.set('autoplay', '1');
  url.searchParams.set('playsinline', '1'); // Critical for mobile backgrounding
  if (start > 0) url.searchParams.set('start', Math.floor(start).toString());
  if (options.enableYouTubeJsApi) {
    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set('origin', typeof window !== 'undefined' ? window.location.origin : '');
  }
  return url.toString();
}

export default function EmbeddedPlayer({
  video,
  initialStartSeconds = 0,
  isAudioMode = false,
  isVisible = false,
  onTimeUpdate,
  onDurationChange,
  onStateChange,
  children
}: EmbeddedPlayerProps) {
  const isYt = video.platform === 'youtube';
  const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
  const bilibiliVideoRef = useRef<HTMLVideoElement>(null);
  const hiddenAudioRef = useRef<HTMLAudioElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialStartSeconds);
  const [duration, setDuration] = useState(0);
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [bilibiliPlayback, setBilibiliPlayback] = useState<BilibiliPlaybackResponse | null>(null);
  const [hiddenAudioSrc, setHiddenAudioSrc] = useState<string>('');

  // Prepare a tiny silent audio to keep iOS alive
  useEffect(() => {
    // 1-second silent base64 MP3 (CBR)
    setHiddenAudioSrc('data:audio/mpeg;base64,SUQzBAAAAAABAFRYWFgAAAASAAADbWFqb3JfYnJhbmQAZGFzaABUWFhYAAAAEQAAA21pbm9yX3ZlcnNpb24AMABUWFhYAAAAHAAAA2NvbXBhdGlibGVfYnJhbmRzAGlzbzZtcDQyAFRTU0UAAAAPAAADTGF2ZjYwLjMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zw0QEAAAADSAAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/88NEBAAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/88NEBAAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
  }, []);

  // YouTube Command helper
  const postYouTubeCommand = useCallback((func: string, args: any[] = []) => {
    const iframe = youtubeIframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      resolveYouTubeEmbedOrigin(iframe.src)
    );
  }, []);

  // Bilibili Loader
  useEffect(() => {
    if (isYt) return;
    const load = async () => {
      try {
        const res = await fetch(`/api/bilibili/playback?bvid=${video.video_id}`);
        const data = await res.json();
        if (data.url || data.proxyUrl) setBilibiliPlayback(data);
      } catch (e) {
        console.error('Bilibili playback error', e);
      }
    };
    load();
  }, [isYt, video.video_id]);

  // Message Handler for YouTube
  useEffect(() => {
    if (!isYt) return;
    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedYouTubeOrigin(event.origin)) return;
      const telemetry = parseYouTubePlayerMessage(event.data);
      if (!telemetry) return;

      if (telemetry.playerReady) setYoutubeReady(true);
      if (telemetry.playerState !== undefined) {
        const playing = telemetry.playerState === 1;
        setIsPlaying(playing);
        onStateChange?.(playing);

        // Sync silent audio for iOS heartbeat
        if (hiddenAudioRef.current) {
          if (playing) hiddenAudioRef.current.play().catch(() => {});
          else hiddenAudioRef.current.pause();
        }
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
  }, [isYt, onStateChange, onTimeUpdate, onDurationChange]);

  // Media Session Integration
  useMediaSession(
    {
      title: video.title,
      artist: video.channel_name,
      artwork: video.thumbnail_url || '',
      album: 'Needle Audio'
    },
    {
      onPlay: () => togglePlay(),
      onPause: () => togglePlay(),
      onSeekBackward: () => seek(currentTime - 10),
      onSeekForward: () => seek(currentTime + 10),
      onSeekTo: (details) => {
        if (details.seekTime !== undefined) seek(details.seekTime);
      },
    },
    isPlaying ? 'playing' : 'paused',
    currentTime,
    duration
  );

  const togglePlay = useCallback(() => {
    const nextPlaying = !isPlaying;
    if (isYt) {
      postYouTubeCommand(nextPlaying ? 'playVideo' : 'pauseVideo');
    } else if (bilibiliVideoRef.current) {
      if (nextPlaying) bilibiliVideoRef.current.play();
      else bilibiliVideoRef.current.pause();
    }
    
    // Silent heartbeat for iOS lock screen
    if (hiddenAudioRef.current) {
      if (nextPlaying) hiddenAudioRef.current.play().catch(() => {});
      else hiddenAudioRef.current.pause();
    }
  }, [isYt, isPlaying, postYouTubeCommand]);

  const seek = useCallback((time: number) => {
    const target = Math.max(0, Math.min(time, duration || 99999));
    if (isYt) {
      postYouTubeCommand('seekTo', [target, true]);
    } else if (bilibiliVideoRef.current) {
      bilibiliVideoRef.current.currentTime = target;
    }
  }, [isYt, duration, postYouTubeCommand]);

  return (
    <>
      {/* iOS Heartbeat + Actual Player container */}
      <div style={isVisible ? { 
        position: 'relative', 
        width: '100%', 
        height: '100%', 
        zIndex: 1,
        background: '#000'
      } : { 
        position: 'absolute', 
        opacity: 0.01, 
        pointerEvents: 'none', 
        width: 200, 
        height: 200, 
        overflow: 'hidden', 
        left: -500, 
        top: -500, 
        zIndex: -1 
      }}>
        <audio 
          ref={hiddenAudioRef} 
          src={hiddenAudioSrc} 
          loop 
          playsInline 
        />
        {isYt ? (
          <iframe
            ref={youtubeIframeRef}
            src={getEmbedUrl(video, initialStartSeconds, { enableYouTubeJsApi: true })}
            allow="autoplay; encrypted-media"
            style={{ width: '100%', height: '100%' }}
            onLoad={() => {
              // Start listening
              const iframe = youtubeIframeRef.current;
              if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage(createYouTubeListeningMessage(), resolveYouTubeEmbedOrigin(iframe.src));
              }
            }}
          />
        ) : (
          bilibiliPlayback && (
            <video
              ref={bilibiliVideoRef}
              src={bilibiliPlayback.proxyUrl || bilibiliPlayback.url}
              autoPlay
              playsInline
              style={{ width: '100%', height: '100%' }}
              onPlay={() => { setIsPlaying(true); onStateChange?.(true); }}
              onPause={() => { setIsPlaying(false); onStateChange?.(false); }}
              onTimeUpdate={(e) => {
                const t = e.currentTarget.currentTime;
                setCurrentTime(t);
                onTimeUpdate?.(t);
              }}
              onDurationChange={(e) => {
                const d = e.currentTarget.duration;
                setDuration(d);
                onDurationChange?.(d);
              }}
            />
          )
        )}
      </div>
      {children?.({ isPlaying, currentTime, duration, togglePlay, seek })}
    </>
  );
}
