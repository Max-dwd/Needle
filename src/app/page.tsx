'use client';

import { Suspense, memo, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import TaskStatusBar from '@/components/TaskStatusBar';
import { buildChannelUrl } from '@/lib/url-utils';
import PlayerModal from '@/components/PlayerModal';
import VideoCard from '@/components/VideoCard';
import MobileIntentBar from '@/components/MobileIntentBar';
import MobileVideoSheet from '@/components/MobileVideoSheet';
import type {
  AutoPipelineStatus,
  CrawlerRuntimeStatus,
  SummaryQueueState,
  VideoWithMeta,
} from '@/types';

interface IntentOption {
  id: number;
  name: string;
  sort_order: number;
}

interface HomeIntentShortcutSettings {
  enabled: boolean;
}

// Memoized wrapper: prevents all sibling cards from re-rendering when
// mobileActiveVideo changes (only the card that gains/loses isActive re-renders)
const VideoCardWrapper = memo(function VideoCardWrapper({
  video,
  isActive,
  isDimmed,
  externalOpen,
  onPlay,
  onRef,
}: {
  video: VideoWithMeta;
  isActive: boolean;
  isDimmed: boolean;
  externalOpen: boolean;
  onPlay: (video: VideoWithMeta, startSeconds?: number) => void;
  onRef: (id: number, el: HTMLDivElement | null) => void;
}) {
  const refCallback = useCallback(
    (el: HTMLDivElement | null) => onRef(video.id, el),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [video.id],
  );
  return (
    <div
      ref={refCallback}
      className={`video-card-wrapper${isDimmed ? ' mobile-dimmed' : ''}`}
      style={isActive ? { opacity: 0, pointerEvents: 'none' } : undefined}
    >
      <VideoCard video={video} externalOpen={externalOpen} onPlay={onPlay} />
    </div>
  );
});

function FeedPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const intent = searchParams.get('intent');
  const topic = searchParams.get('topic');
  const platform = searchParams.get('platform');
  const channel_id = searchParams.get('channel_id');

  const [videos, setVideos] = useState<VideoWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    type: 'success' | 'error';
  } | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<{
    video: VideoWithMeta;
    startSeconds: number;
    initialAudioMode?: boolean;
  } | null>(null);
  const [mobileActiveVideo, setMobileActiveVideo] = useState<{
    video: VideoWithMeta;
    cardRect: DOMRect;
    initialAudioMode?: boolean;
  } | null>(null);
  const cardElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const [crawlerStatus, setCrawlerStatus] =
    useState<CrawlerRuntimeStatus | null>(null);
  const [pausePending, setPausePending] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [summaryQueueState, setSummaryQueueState] =
    useState<SummaryQueueState | null>(null);
  const [pipelineStatus, setPipelineStatus] =
    useState<AutoPipelineStatus | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<{
    videoId: string;
    stage: 'preparing_prompt' | 'calling_api' | 'streaming' | 'writing_file';
    message: string;
    receivedChars?: number;
    modelId?: string;
    modelName?: string;
  } | null>(null);
  const [intents, setIntents] = useState<IntentOption[]>([]);
  const [homeIntentShortcutsEnabled, setHomeIntentShortcutsEnabled] =
    useState(true);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadedVideoCountRef = useRef(0);
  const lastVideoRefreshAtRef = useRef(0);
  const refreshRequestRef = useRef<AbortController | null>(null);

  const mobileActiveVideoRef = useRef(mobileActiveVideo);
  useEffect(() => {
    mobileActiveVideoRef.current = mobileActiveVideo;
  }, [mobileActiveVideo]);

  const handlePlay = useCallback((videoToPlay: VideoWithMeta, startSeconds = 0) => {
    const isMobile = window.innerWidth <= 900;
    if (isMobile) {

      
      if (mobileActiveVideoRef.current?.video.id === videoToPlay.id) {
        // Second tap: play the video
        setPlayingVideo({ video: videoToPlay, startSeconds });
        setMobileActiveVideo(null);
      } else {
        // First tap: show info overlay
        const el = cardElementsRef.current.get(videoToPlay.id);
        const cardRect = el ? el.getBoundingClientRect() : new DOMRect(0, 120, window.innerWidth * 0.5, 90);
        setMobileActiveVideo({ video: videoToPlay, cardRect });
      }
    } else {
      setPlayingVideo({ video: videoToPlay, startSeconds });
    }
  }, []);

  const handleCardRef = useCallback((id: number, el: HTMLDivElement | null) => {
    if (el) cardElementsRef.current.set(id, el);
    else cardElementsRef.current.delete(id);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('folo_external_open');
    if (saved === '1') setExternalOpen(true);
  }, []);

  useEffect(() => {
    loadedVideoCountRef.current = videos.length;
  }, [videos.length]);

  useEffect(() => {
    const loadIntentData = async () => {
      try {
        const [intentRes, shortcutRes] = await Promise.all([
          fetch('/api/settings/intents', { cache: 'no-store' }),
          fetch('/api/settings/home-intent-shortcuts', { cache: 'no-store' }),
        ]);

        if (intentRes.ok) {
          const intentData = (await intentRes.json()) as IntentOption[];
          setIntents(intentData);
        }

        if (shortcutRes.ok) {
          const shortcutData = (await shortcutRes.json()) as HomeIntentShortcutSettings;
          setHomeIntentShortcutsEnabled(shortcutData.enabled !== false);
        }
      } catch {
        // Keep defaults when settings cannot be loaded.
      }
    };

    void loadIntentData();
  }, []);

  const toggleExternalOpen = () => {
    setExternalOpen((value) => {
      localStorage.setItem('folo_external_open', value ? '0' : '1');
      return !value;
    });
  };

  const showToast = useCallback(
    (msg: string, type: 'success' | 'error' = 'success') => {
      setToast({ msg, type });
      setTimeout(() => setToast(null), 3000);
    },
    [],
  );

  const getIntentNavigationTarget = useCallback(
    (direction: 1 | -1): string | null => {
      if (intents.length === 0) return null;

      const currentIndex = intent ? intents.findIndex((item) => item.name === intent) : -1;
      if (direction === 1) {
        if (currentIndex < 0) return intents[0].name;
        const nextIndex = currentIndex + 1;
        return nextIndex >= intents.length ? null : intents[nextIndex].name;
      }

      if (currentIndex < 0) return intents[intents.length - 1].name;
      if (currentIndex === 0) return null;
      return intents[currentIndex - 1].name;
    },
    [intent, intents],
  );

  const navigateToIntent = useCallback(
    (nextIntent: string | null) => {
      const nextUrl = nextIntent
        ? `/?intent=${encodeURIComponent(nextIntent)}`
        : '/';
      router.replace(nextUrl, { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    if (!homeIntentShortcutsEnabled || intents.length === 0) return;

    const isTypingContext = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (playingVideo !== null) {
        return;
      }

      if (isTypingContext()) {
        return;
      }

      const nextIntent =
        event.key === 'Tab'
          ? getIntentNavigationTarget(1)
          : event.key === '`' || event.key === '·' || event.code === 'Backquote'
            ? getIntentNavigationTarget(-1)
            : null;

      if (nextIntent === null && event.key !== 'Tab' && event.key !== '`' && event.key !== '·' && event.code !== 'Backquote') {
        return;
      }

      if (event.key === 'Tab' || event.key === '`' || event.key === '·' || event.code === 'Backquote') {
        event.preventDefault();
        navigateToIntent(nextIntent);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [getIntentNavigationTarget, homeIntentShortcutsEnabled, intents.length, navigateToIntent, playingVideo]);

  const loadVideos = useCallback(
    async (pageNum = 1, append = false) => {
      if (pageNum === 1) setLoading(true);
      else setLoadingMore(true);

      try {
        const params = new URLSearchParams();
        if (platform) params.set('platform', platform);
        if (intent) params.set('intent', intent);
        if (topic) params.set('topic', topic);
        if (channel_id) params.set('channel_id', channel_id);
        params.set('page', pageNum.toString());
        params.set('limit', '30');
        params.set('include_research', '1');

        const res = await fetch(`/api/videos?${params.toString()}`, {
          cache: 'no-store',
        });
        const data = await res.json();
        const newVideos = data.videos || [];
        setVideos((current) => {
          const nextVideos = append ? [...current, ...newVideos] : newVideos;
          loadedVideoCountRef.current = nextVideos.length;
          return nextVideos;
        });
        setTotal(data.total || 0);
        setHasMore(newVideos.length === 30);
        if (!append) {
          setLastRefreshAt(
            typeof data.last_refresh_at === 'string' ? data.last_refresh_at : null,
          );
        }
      } catch {
        showToast('加载视频失败', 'error');
      } finally {
        if (pageNum === 1) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [platform, intent, topic, channel_id, showToast],
  );

  const refreshLoadedVideos = useCallback(async () => {
    const now = Date.now();
    if (now - lastVideoRefreshAtRef.current < 5000) {
      return;
    }
    lastVideoRefreshAtRef.current = now;

    const params = new URLSearchParams();
    if (platform) params.set('platform', platform);
    if (intent) params.set('intent', intent);
    if (topic) params.set('topic', topic);
    if (channel_id) params.set('channel_id', channel_id);
    params.set('page', '1');
    const requestedLimit = Math.max(loadedVideoCountRef.current, 30);
    params.set('limit', String(requestedLimit));
    params.set('include_research', '1');

    try {
      const res = await fetch(`/api/videos?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      const nextVideos = data.videos || [];
      setVideos(nextVideos);
      loadedVideoCountRef.current = nextVideos.length;
      setTotal(data.total || 0);
      setHasMore(nextVideos.length >= requestedLimit);
      setLastRefreshAt(
        typeof data.last_refresh_at === 'string' ? data.last_refresh_at : null,
      );
    } catch {
      // keep stale list on polling failures
    }
  }, [platform, intent, topic, channel_id]);

  useEffect(() => {
    setPage(1);
    loadedVideoCountRef.current = 0;
    loadVideos(1, false);
  }, [loadVideos]);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource('/api/sse');

      es.addEventListener('crawler-status', (event) => {
        try {
          const data = JSON.parse(event.data);
          setCrawlerStatus(data);
        } catch {}
      });

      es.addEventListener('videos-updated', () => {
        void refreshLoadedVideos();
      });

      // Summary stats (includes queue state)
      es.addEventListener('summary-stats', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.queue) setSummaryQueueState(data.queue);
        } catch {}
      });

      // Pipeline status (subtitle/summary queue state)
      es.addEventListener('pipeline-status', (event) => {
        try {
          const data = JSON.parse(event.data);
          setPipelineStatus(data);
        } catch {}
      });

      // Summary progress (current video title, model, chars)
      es.addEventListener('summary-progress', (event) => {
        try {
          const data = JSON.parse(event.data);
          setSummaryProgress(data);
        } catch {}
      });

      // Summary events: update video cards in-place + refresh stats
      es.addEventListener('summary-start', (event) => {
        try {
          const { videoId } = JSON.parse(event.data);
          setVideos((prev) =>
            prev.map((v) =>
              v.video_id === videoId
                ? { ...v, summary_status: 'processing' as const }
                : v,
            ),
          );
        } catch {}
      });

      es.addEventListener('summary-complete', (event) => {
        try {
          const { videoId } = JSON.parse(event.data);
          setVideos((prev) =>
            prev.map((v) =>
              v.video_id === videoId
                ? { ...v, summary_status: 'completed' as const }
                : v,
            ),
          );
          void refreshLoadedVideos();
        } catch {}
      });

      es.addEventListener('summary-error', (event) => {
        try {
          const { videoId } = JSON.parse(event.data);
          setVideos((prev) =>
            prev.map((v) =>
              v.video_id === videoId
                ? { ...v, summary_status: 'failed' as const }
                : v,
            ),
          );
          void refreshLoadedVideos();
        } catch {}
      });

      // Realtime video-new SSE event: insert new video at top of list
      es.addEventListener('video-new', (event) => {
        try {
          const newVideo = JSON.parse(event.data) as VideoWithMeta;

          // Check if video matches current filters
          if (platform && newVideo.platform !== platform) return;
          if (intent && newVideo.intent !== intent) return;
          // channel_id filter: skip SSE insertion, rely on fallback
          // SSE payload's channel_id is the platform channel_id (e.g. 'UC...')
          // URL param channel_id is the numeric DB row ID — these don't match
          if (channel_id) return;
          // Topic filter: skip insertion, rely on fallback (topic info not in payload)
          if (topic) return;

          // Insert at top, avoid duplicates
          setVideos((prev) => {
            if (prev.some((v) => v.video_id === newVideo.video_id)) return prev;
            return [{ ...newVideo, _isNew: true }, ...prev];
          });

          // Clear _isNew flag after 3 seconds
          setTimeout(() => {
            setVideos((prev) =>
              prev.map((v) =>
                v.video_id === newVideo.video_id ? { ...v, _isNew: false } : v,
              ),
            );
          }, 3000);
        } catch {}
      });

      // Subtitle status SSE event: update video card badge in-place
      es.addEventListener('subtitle-status', (event) => {
        try {
          const { videoId, status, error, cooldownUntil } = JSON.parse(
            event.data,
          );
          setVideos((prev) =>
            prev.map((v) =>
              v.video_id === videoId
                ? {
                    ...v,
                    subtitle_status: status,
                    subtitle_error:
                      error === undefined ? v.subtitle_error : error,
                    subtitle_cooldown_until:
                      cooldownUntil === undefined
                        ? v.subtitle_cooldown_until
                        : cooldownUntil,
                  }
                : v,
            ),
          );
        } catch {}
      });

      // video:enriched SSE event: update video card thumbnail/duration/published_at in-place
      es.addEventListener('video-enriched', (event) => {
        try {
          const { videoId, fields } = JSON.parse(event.data);
          setVideos((prev) =>
            prev.map((v) =>
              v.video_id === videoId
                ? {
                    ...v,
                    thumbnail_url: fields.thumbnail_url ?? v.thumbnail_url,
                    published_at: fields.published_at ?? v.published_at,
                    duration: fields.duration ?? v.duration,
                    is_members_only:
                      fields.is_members_only === undefined
                        ? v.is_members_only
                        : fields.is_members_only,
                    access_status:
                      fields.access_status === undefined
                        ? v.access_status
                        : fields.access_status,
                  }
                : v,
            ),
          );
        } catch {}
      });

      es.onerror = () => {
        es?.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [channel_id, intent, platform, refreshLoadedVideos, topic]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    void loadVideos(nextPage, true);
  }, [loadingMore, hasMore, page, loadVideos]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || loading || loadingMore || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: '400px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, loadingMore, hasMore, loadMore]);

  const updateGlobalPauseState = useCallback(
    async (nextPaused: boolean, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const res = await fetch('/api/crawler/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paused: nextPaused,
          stopSummaryQueue: nextPaused,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (!silent) {
          showToast('切换抓取暂停状态失败', 'error');
        }
        return null;
      }
      setCrawlerStatus(data);
      if (data.queue) {
        setSummaryQueueState(data.queue);
      }
      if (!silent) {
        showToast(data.paused ? '已暂停抓取任务' : '已继续后台抓取');
      }
      return data;
    },
    [showToast],
  );

  const handleRefresh = useCallback(async () => {
    if (refreshing) {
      try {
        const res = await fetch('/api/videos/refresh', {
          method: 'DELETE',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          showToast(
            typeof data?.error === 'string' ? data.error : '取消刷新失败',
            'error',
          );
          return;
        }
        refreshRequestRef.current?.abort();
        refreshRequestRef.current = null;
        setRefreshing(false);
        showToast('已请求取消手动刷新');
      } catch {
        showToast('取消刷新失败', 'error');
      }
      return;
    }

    const controller = new AbortController();
    refreshRequestRef.current = controller;
    setRefreshing(true);
    try {
      const res = await fetch('/api/videos/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          platform: platform || undefined,
          intent: intent || undefined,
          channel_id: channel_id || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(
          typeof data?.error === 'string' ? data.error : '刷新失败',
          'error',
        );
        return;
      }
      const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
      const firstError = errorCount > 0 ? `；${String(data.errors[0])}` : '';
      if (data.cancelled) {
        showToast(
          `已取消刷新，新增 ${data.added} 个视频` +
            `${errorCount ? `（${errorCount} 个错误）` : ''}${firstError}`,
        );
      } else {
        showToast(
          `新增 ${data.added} 个视频，刷新完成` +
            `${errorCount ? `（${errorCount} 个错误）` : ''}${firstError}`,
        );
      }
      setPage(1);
      await refreshLoadedVideos();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      showToast('刷新失败', 'error');
    } finally {
      if (refreshRequestRef.current === controller) {
        refreshRequestRef.current = null;
      }
      setRefreshing(false);
    }
  }, [
    refreshing,
    intent,
    channel_id,
    platform,
    refreshLoadedVideos,
    showToast,
  ]);

  const isPulling = useRef(false);
  const pullY = useRef(0);
  const dragX = useRef(0);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  const pullTextRef = useRef<HTMLSpanElement>(null);
  const prevIntentIndicatorRef = useRef<HTMLDivElement>(null);
  const nextIntentIndicatorRef = useRef<HTMLDivElement>(null);
  const isHeaderTouch = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    isHeaderTouch.current = Boolean(target.closest('.feed-header-wrapper'));

    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    dragX.current = 0;
    
    if (containerRef.current) {
      containerRef.current.style.transition = 'none';
      containerRef.current.style.transform = 'none';
    }
    if (prevIntentIndicatorRef.current) prevIntentIndicatorRef.current.style.transition = 'none';
    if (nextIntentIndicatorRef.current) nextIntentIndicatorRef.current.style.transition = 'none';

    // Only pull if at the very top and not header touch
    if (mobileActiveVideoRef.current || isHeaderTouch.current) {
       isPulling.current = false;
       return;
    }

    const mainContent = document.querySelector('.main-content');
    if (mainContent && mainContent.scrollTop === 0) {
      isPulling.current = true;
    } else {
      isPulling.current = false;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    if (mobileActiveVideoRef.current || isHeaderTouch.current) return;

    // Determine if horizontal or vertical
    if (Math.abs(diffX) > Math.abs(diffY)) {
      // Horizontal swipe
      if (Math.abs(diffX) > 10) {
        dragX.current = diffX * 0.3; // Increased friction
        pullY.current = 0;
      }
    } else {
      // Vertical swipe
      if (isPulling.current && diffY > 0) {
        // Add friction
        pullY.current = Math.min(diffY * 0.4, 80);
      } else {
        pullY.current = 0;
      }
      dragX.current = 0;
    }

    if (containerRef.current) {
      if (pullY.current > 0) {
        containerRef.current.style.transform = `translateY(${pullY.current}px)`;
      } else {
        containerRef.current.style.transform = 'none';
      }
    }

    if (pullIndicatorRef.current) {
      pullIndicatorRef.current.style.opacity = pullY.current > 10 ? String(pullY.current / 50) : '0';
    }

    if (prevIntentIndicatorRef.current) {
      const x = dragX.current > 0 ? dragX.current : 0;
      prevIntentIndicatorRef.current.style.transform = `translate(${x}px, -50%)`;
      prevIntentIndicatorRef.current.style.opacity = String(Math.min(x / 40, 1));
    }

    if (nextIntentIndicatorRef.current) {
      const x = dragX.current < 0 ? dragX.current : 0;
      nextIntentIndicatorRef.current.style.transform = `translate(${x}px, -50%)`;
      nextIntentIndicatorRef.current.style.opacity = String(Math.min(Math.abs(x) / 40, 1));
    }

    if (pullTextRef.current) {
      if (pullY.current > 50) {
        pullTextRef.current.innerText = '松开刷新';
      } else {
        pullTextRef.current.innerText = '下拉刷新';
      }
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (isHeaderTouch.current) {
      isHeaderTouch.current = false;
      return;
    }

    // Check for pull-to-refresh
    if (isPulling.current && pullY.current > 50) {
      if (!refreshing) {
        void handleRefresh();
      }
    }

    // Check for intent swipe
    if (Math.abs(dragX.current) > 25) {
      const direction = dragX.current > 0 ? -1 : 1;
      const nextIntent = getIntentNavigationTarget(direction);
      if (nextIntent !== undefined) {
         navigateToIntent(nextIntent);
      }
    }

    isPulling.current = false;
    isHeaderTouch.current = false;
    pullY.current = 0;
    dragX.current = 0;

    if (containerRef.current) {
      containerRef.current.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      containerRef.current.style.transform = 'none';
    }

    if (pullIndicatorRef.current) {
      pullIndicatorRef.current.style.opacity = '0';
    }

    if (prevIntentIndicatorRef.current) {
      prevIntentIndicatorRef.current.style.transition = 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      prevIntentIndicatorRef.current.style.transform = 'translate(-100%, -50%)';
      prevIntentIndicatorRef.current.style.opacity = '0';
    }

    if (nextIntentIndicatorRef.current) {
      nextIntentIndicatorRef.current.style.transition = 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      nextIntentIndicatorRef.current.style.transform = 'translate(100%, -50%)';
      nextIntentIndicatorRef.current.style.opacity = '0';
    }
  }, [refreshing, handleRefresh, getIntentNavigationTarget, navigateToIntent]);

  const handleTogglePause = useCallback(async () => {
    if (!crawlerStatus) return;
    setPausePending(true);
    try {
      const shouldPause = !crawlerStatus.paused;
      await updateGlobalPauseState(shouldPause);
    } catch {
      showToast('切换抓取暂停状态失败', 'error');
    } finally {
      setPausePending(false);
    }
  }, [crawlerStatus, showToast, updateGlobalPauseState]);

  const unreadCount = videos.filter((video) => video.is_read === 0).length;
  const hasBackgroundActivity = Boolean(
    crawlerStatus?.feed.state === 'running' ||
    summaryQueueState?.running,
  );

  useEffect(() => {
    const refreshIfVisible = () => {
      if (
        document.visibilityState !== 'visible' ||
        loading ||
        loadingMore ||
        refreshing
      )
        return;
      void refreshLoadedVideos();
    };

    const timer = window.setInterval(
      refreshIfVisible,
      hasBackgroundActivity ? 2500 : 8000,
    );
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [
    hasBackgroundActivity,
    loading,
    loadingMore,
    refreshing,
    refreshLoadedVideos,
  ]);

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    // Only scroll if clicking empty space or the title area, not controls
    const target = e.target as HTMLElement;
    if (target.closest('button, a, select, .mobile-intent-tabs')) return;
    
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  return (
    <>
      <div
      ref={containerRef}
      style={{
        minHeight: '100%',
        position: 'relative',
        transition: 'none',
        transform: 'none'
      }}
    >
      {/* Pull indicator */}
      <div 
        ref={pullIndicatorRef}
        style={{
        position: 'absolute',
        top: -40,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: 40,
        opacity: 0,
        pointerEvents: 'none'
      }}>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: 20,
          padding: '4px 12px',
          boxShadow: 'var(--shadow-sm)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}>
          {refreshing ? (
            <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> 刷新中</>
          ) : (
            <><span ref={pullTextRef}>下拉刷新</span></>
          )}
        </div>
      </div>

      <div 
        className={`feed-header-wrapper${mobileActiveVideo ? ' mobile-dimmed' : ''}`} 
        style={{ pointerEvents: mobileActiveVideo ? 'none' : undefined, cursor: 'pointer' }}
        onClick={handleHeaderClick}
      >
        <div className="feed-header-top">
          <div className="feed-header-title-container">
            <h1
              className="section-title"
              style={{
                fontSize: 20,
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              {channel_id
                ? videos.length > 0
                  ? videos[0].channel_channel_id
                    ? (
                        <a
                          href={buildChannelUrl(
                            videos[0].platform,
                            videos[0].channel_channel_id,
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="feed-channel-link"
                          title={
                            videos[0].platform === 'youtube'
                              ? '在 YouTube 打开频道'
                              : '在 B站 打开空间'
                          }
                        >
                          {videos[0].channel_name}
                        </a>
                      )
                    : videos[0].channel_name
                  : '频道视频'
                : (() => {
                    const parts: string[] = [];
                    if (topic) parts.push(`主题：${topic}`);
                    if (intent) parts.push(intent);
                    if (platform) {
                      parts.push(platform === 'youtube' ? 'YouTube' : 'B站');
                    }
                    if (parts.length === 0) return '全部视频';
                    if (parts.length === 1) return parts[0];
                    return parts.join(' · ');
                  })()}
            </h1>

            <div className="feed-header-meta">
              <span className="feed-header-meta-text">
                <span className="feed-header-meta-group">{total} 视频</span>
                <span className="feed-header-meta-divider"> / </span>
                <span className="feed-header-meta-group">{unreadCount} 未读</span>
              </span>
            </div>

            <div className="feed-header-status-capsule">
              <TaskStatusBar
                crawlerStatus={crawlerStatus}
                pipelineStatus={pipelineStatus}
                schedulerStatus={crawlerStatus?.scheduler ?? null}
                lastRefreshAt={lastRefreshAt}
                refreshing={refreshing}
                onRefresh={handleRefresh}
                summaryQueueState={summaryQueueState}
                summaryProgress={summaryProgress}
                onTogglePause={handleTogglePause}
                pausePending={pausePending}
                externalOpen={externalOpen}
                onPipelineStatusChange={setPipelineStatus}
                onSummaryQueueStateChange={setSummaryQueueState}
                onToast={showToast}
                onOpenVideo={(video) =>
                  setPlayingVideo({ video, startSeconds: 0 })
                }
              />
            </div>
          </div>
          <div className="feed-header-actions">
            <button
              id="external-open-toggle"
              className="toolbar-icon-btn"
              onClick={toggleExternalOpen}
              title={`外部打开: ${externalOpen ? '开' : '关'}`}
            >
              {externalOpen ? '🔗' : '⛓️'}
            </button>
          </div>
        </div>

        <div className="feed-header-middle">
          <MobileIntentBar
            intents={intents}
            currentIntent={intent}
            currentPlatform={platform}
          />
        </div>
      </div>

      <div 
        className="feed-content-area"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner" />
            加载中…
          </div>
        ) : videos.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <div className="empty-state-title">暂无视频</div>
            <div className="empty-state-desc">
              先去
              <Link href="/channels" style={{ color: 'var(--accent-purple)' }}>
                添加频道
              </Link>
              ，再点击刷新获取最新视频
            </div>
          </div>
        ) : (
          <div className="video-grid-container" style={{ paddingBottom: 40 }}>
            <div className={`video-grid${mobileActiveVideo ? ' has-mobile-active' : ''}`}>
              {videos.map((video) => {
                const isActive = mobileActiveVideo?.video.id === video.id;
                const isDimmed = Boolean(mobileActiveVideo && !isActive);
                return (
                  <VideoCardWrapper
                    key={video.id}
                    video={video}
                    isActive={isActive}
                    isDimmed={isDimmed}
                    externalOpen={externalOpen}
                    onPlay={handlePlay}
                    onRef={handleCardRef}
                  />
                );
              })}
            </div>

            {hasMore && (
              <div
                ref={loadMoreRef}
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  marginTop: 32,
                  height: 40,
                  alignItems: 'center',
                }}
              >
                {loadingMore && (
                  <span
                    className="spinner"
                    style={{ width: 16, height: 16, borderWidth: 2 }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}

      {playingVideo && (
        <PlayerModal
          video={playingVideo.video}
          initialStartSeconds={playingVideo.startSeconds}
          initialAudioMode={playingVideo.initialAudioMode}
          onClose={() => setPlayingVideo(null)}
        />
      )}

      {mobileActiveVideo && (
        <MobileVideoSheet
          video={mobileActiveVideo.video}
          onClose={() => setMobileActiveVideo(null)}
          onPlay={(v, s) => {

            setPlayingVideo({ video: v, startSeconds: s || 0 });
            setMobileActiveVideo(null);
          }}
          onNext={() => {
            const idx = videos.findIndex(v => v.id === mobileActiveVideo.video.id);
            if (idx >= 0 && idx < videos.length - 1) {
              setMobileActiveVideo({ video: videos[idx + 1], cardRect: mobileActiveVideo.cardRect });
            }
          }}
          onPrev={() => {
            const idx = videos.findIndex(v => v.id === mobileActiveVideo.video.id);
            if (idx > 0) {
              setMobileActiveVideo({ video: videos[idx - 1], cardRect: mobileActiveVideo.cardRect });
            }
          }}
          hasNext={videos.findIndex(v => v.id === mobileActiveVideo.video.id) < videos.length - 1}
          hasPrev={videos.findIndex(v => v.id === mobileActiveVideo.video.id) > 0}
          initialAudioMode={mobileActiveVideo.initialAudioMode}
        />
      )}
      </div>

      {/* FIXED Left Swipe Indicator (Prev Intent) */}
      <div 
        ref={prevIntentIndicatorRef}
        style={{
         position: 'fixed',
         top: '50%',
         left: 0,
         transform: 'translate(-100%, -50%)',
         opacity: 0,
         pointerEvents: 'none',
         zIndex: 1000,
         display: 'flex',
         padding: '0 20px',
      }}>
         <div style={{
           background: 'var(--accent-purple)',
           color: '#fff',
           borderRadius: 24,
           padding: '12px 20px',
           boxShadow: '0 8px 24px rgba(139, 92, 246, 0.4)',
           fontSize: 15,
           fontWeight: 'bold',
           whiteSpace: 'nowrap'
         }}>
           ← {getIntentNavigationTarget(-1) || '全部'}
         </div>
      </div>

      {/* FIXED Right Swipe Indicator (Next Intent) */}
      <div 
        ref={nextIntentIndicatorRef}
        style={{
         position: 'fixed',
         top: '50%',
         right: 0,
         transform: 'translate(100%, -50%)',
         opacity: 0,
         pointerEvents: 'none',
         zIndex: 1000,
         display: 'flex',
         padding: '0 20px',
      }}>
         <div style={{
           background: 'var(--accent-purple)',
           color: '#fff',
           borderRadius: 24,
           padding: '12px 20px',
           boxShadow: '0 8px 24px rgba(139, 92, 246, 0.4)',
           fontSize: 15,
           fontWeight: 'bold',
           whiteSpace: 'nowrap'
         }}>
           {getIntentNavigationTarget(1) || '全部'} →
         </div>
      </div>
    </>
  );
}

export default function FeedPage() {
  return (
    <Suspense
      fallback={
        <div className="loading-spinner">
          <div className="spinner" />
          加载中…
        </div>
      }
    >
      <FeedPageContent />
    </Suspense>
  );
}
