'use client';

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import BilibiliSummaryPopup, {
  BilibiliSummaryData,
} from '@/components/BilibiliSummaryPopup';
import SummaryHoverPreview from '@/components/SummaryHoverPreview';
import { getSubtitleBadgeLabel, timeAgo } from '@/lib/format';
import type { VideoWithMeta } from '@/types';
import ResearchFavoriteModal from '@/components/ResearchFavoriteModal';

let cachedBilibiliSummaryEnabled: boolean | null = null;
let bilibiliSummaryEnabledPromise: Promise<boolean> | null = null;

async function loadBilibiliSummaryEnabled(): Promise<boolean> {
  if (cachedBilibiliSummaryEnabled !== null)
    return cachedBilibiliSummaryEnabled;
  if (!bilibiliSummaryEnabledPromise) {
    bilibiliSummaryEnabledPromise = fetch('/api/settings/bilibili-auth', {
      cache: 'no-store',
    })
      .then((res) => res.json())
      .then((data) => {
        cachedBilibiliSummaryEnabled = data.enabled !== false;
        return cachedBilibiliSummaryEnabled;
      })
      .catch(() => true)
      .finally(() => {
        bilibiliSummaryEnabledPromise = null;
      });
  }
  return bilibiliSummaryEnabledPromise;
}

function getExternalUrl(video: VideoWithMeta): string {
  if (video.platform === 'youtube')
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  return `https://www.bilibili.com/video/${video.video_id}`;
}

const VideoCard = memo(function VideoCard({
  video,
  externalOpen,
  onPlay,
}: {
  video: VideoWithMeta;
  externalOpen: boolean;
  onPlay: (video: VideoWithMeta, startSeconds?: number) => void;
}) {
  const isYt = video.platform === 'youtube';
  const accessBadge =
    video.access_status === 'limited_free'
      ? { label: '🎟 限免', title: '限时免费视频' }
      : video.access_status === 'members_only' || video.is_members_only === 1
        ? { label: '👑 会员', title: '会员专属视频' }
        : null;
  const availabilityBadge =
    video.availability_status === 'abandoned'
      ? { label: '⛔ 放弃', title: video.availability_reason || '已确认不可用并完全放弃' }
      : video.availability_status === 'unavailable'
        ? { label: '⚠ 不可用', title: video.availability_reason || '已确认不可用' }
        : null;
  const subtitleBadge = getSubtitleBadgeLabel(video);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryData, setSummaryData] = useState<BilibiliSummaryData | null>(
    null,
  );
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [localSummaryMarkdown, setLocalSummaryMarkdown] = useState<
    string | null
  >(null);
  const [localSummaryLoading, setLocalSummaryLoading] = useState(false);
  const [localSummaryChecked, setLocalSummaryChecked] = useState(false);
  const [bilibiliSummaryEnabled, setBilibiliSummaryEnabled] = useState<
    boolean | null
  >(isYt ? null : cachedBilibiliSummaryEnabled);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({
    display: 'none',
  });
  const [subtitleRetrying, setSubtitleRetrying] = useState(false);
  const [summaryRetrying, setSummaryRetrying] = useState(false);
  const [metadataRepairing, setMetadataRepairing] = useState(false);
  const [researchModalState, setResearchModalState] = useState<{
    mode: 'add' | 'edit';
    existingFavorite?: { id: number; intent_type_id: number; note: string };
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<
    'subtitle' | 'summary' | null
  >(null);
  const [summaryModels, setSummaryModels] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [summaryModelsLoading, setSummaryModelsLoading] = useState(false);

  const openSummaryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hideSummaryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hoverRegionRef = useRef({ card: false, popup: false });
  const cardRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const videoStateRef = useRef({
    id: video.id,
    summaryStatus: video.summary_status,
    subtitleStatus: video.subtitle_status,
  });

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setActiveSubmenu(null);
  }, []);

  const calculatePosition = useCallback(() => {
    if (!cardRef.current || !popupRef.current || !showSummary) return;
    const cardRect = cardRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const viewportPadding = 12;

    const popupWidth =
      popupRect.width > 0
        ? popupRect.width
        : Math.min(320, window.innerWidth - viewportPadding * 2);
    const popupHeight =
      popupRect.height > 0
        ? popupRect.height
        : Math.min(window.innerHeight * 0.9, 800);
    const cardCenter = cardRect.left + cardRect.width / 2;
    const screenCenter = window.innerWidth / 2;
    const rightSideLeft = cardRect.right;
    const leftSideLeft = cardRect.left - popupWidth;
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - popupWidth - viewportPadding,
    );

    let left: number;
    if (cardCenter < screenCenter) {
      left =
        rightSideLeft + popupWidth <= window.innerWidth - viewportPadding
          ? rightSideLeft
          : leftSideLeft;
    } else {
      left = leftSideLeft >= viewportPadding ? leftSideLeft : rightSideLeft;
    }
    left = Math.min(Math.max(left, viewportPadding), maxLeft);

    let calculatedTop = cardRect.top;
    const maxTop = Math.max(
      viewportPadding,
      window.innerHeight - popupHeight - viewportPadding,
    );
    calculatedTop = Math.min(Math.max(calculatedTop, viewportPadding), maxTop);

    setPopupStyle({
      position: 'fixed',
      top: `${calculatedTop}px`,
      left: `${left}px`,
      opacity: 1,
      transition: 'opacity 0.2s ease-in',
      zIndex: 9999,
    });
  }, [showSummary]);

  useEffect(() => {
    if (!showSummary || !popupRef.current) return;

    calculatePosition();

    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => calculatePosition());
    });
    observer.observe(popupRef.current);

    const handleViewportChange = () => {
      window.requestAnimationFrame(() => calculatePosition());
    };
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [showSummary, calculatePosition]);

  useEffect(
    () => () => {
      if (openSummaryTimeoutRef.current) clearTimeout(openSummaryTimeoutRef.current);
      if (hideSummaryTimeoutRef.current) clearTimeout(hideSummaryTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    const previous = videoStateRef.current;
    const videoChanged = previous.id !== video.id;
    const summaryChanged = previous.summaryStatus !== video.summary_status;
    const subtitleChanged = previous.subtitleStatus !== video.subtitle_status;

    if (videoChanged) {
      hoverRegionRef.current = { card: false, popup: false };
      if (openSummaryTimeoutRef.current) {
        clearTimeout(openSummaryTimeoutRef.current);
        openSummaryTimeoutRef.current = null;
      }
      clearHideSummaryTimer();
      setShowSummary(false);
      setSummaryData(null);
      setSummaryLoading(false);
      setLocalSummaryMarkdown(null);
      setLocalSummaryLoading(false);
      setLocalSummaryChecked(false);
      setBilibiliSummaryEnabled(isYt ? null : cachedBilibiliSummaryEnabled);
      setSubtitleRetrying(false);
      setSummaryRetrying(false);
      setMetadataRepairing(false);
      closeContextMenu();
    } else if (summaryChanged || subtitleChanged) {
      setLocalSummaryChecked(false);
      setLocalSummaryLoading(false);
      if (summaryChanged) setSummaryRetrying(false);
      if (subtitleChanged) setSubtitleRetrying(false);
      if (summaryChanged) {
        setLocalSummaryMarkdown(null);
        setSummaryData(null);
        setSummaryLoading(false);
      }
    }

    videoStateRef.current = {
      id: video.id,
      summaryStatus: video.summary_status,
      subtitleStatus: video.subtitle_status,
    };
  }, [closeContextMenu, isYt, video.id, video.summary_status, video.subtitle_status]);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = () => {
      closeContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };
    const handleScroll = () => {
      closeContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [closeContextMenu, contextMenu]);

  const fetchLocalSummary = useCallback(async () => {
    if (localSummaryMarkdown || localSummaryLoading || localSummaryChecked)
      return;

    setLocalSummaryLoading(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/summary`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.markdown) {
        setLocalSummaryMarkdown(data.markdown);
      }
    } catch {
      // Ignore local summary errors and allow Bilibili fallback below.
    } finally {
      setLocalSummaryChecked(true);
      setLocalSummaryLoading(false);
    }
  }, [
    localSummaryChecked,
    localSummaryLoading,
    localSummaryMarkdown,
    video.id,
  ]);

  useEffect(() => {
    if (
      !showSummary ||
      localSummaryMarkdown ||
      localSummaryLoading ||
      localSummaryChecked
    )
      return;
    void fetchLocalSummary();
  }, [
    fetchLocalSummary,
    localSummaryChecked,
    localSummaryLoading,
    localSummaryMarkdown,
    showSummary,
  ]);

  const fetchBilibiliSummary = useCallback(async () => {
    if (isYt || summaryData || summaryLoading) return;

    setSummaryLoading(true);
    try {
      const res = await fetch(`/api/bilibili/summary?bvid=${video.video_id}`);
      const data = await res.json();
      if (data.model_result) {
        setSummaryData(data);
      } else if (data.error) {
        setSummaryData({
          model_result: { summary: '', outline: [] },
          error: data.error,
          details: data.authExpired
            ? 'B站登录态失效，请前往“设置”页更新 SESSDATA'
            : data.details || '此视频不存在AI总结',
          authExpired: Boolean(data.authExpired),
        });
      } else {
        setSummaryData({ model_result: { summary: '', outline: [] } });
      }
    } catch {
      setSummaryData({ model_result: { summary: '', outline: [] } });
    } finally {
      setSummaryLoading(false);
    }
  }, [isYt, summaryData, summaryLoading, video.video_id]);

  useEffect(() => {
    if (isYt || !showSummary) return;
    if (localSummaryLoading || !localSummaryChecked || localSummaryMarkdown)
      return;
    if (bilibiliSummaryEnabled === false) return;
    if (bilibiliSummaryEnabled === true) {
      void fetchBilibiliSummary();
      return;
    }

    let cancelled = false;
    void loadBilibiliSummaryEnabled().then((enabled) => {
      if (cancelled) return;
      setBilibiliSummaryEnabled(enabled);
      if (enabled) {
        void fetchBilibiliSummary();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    bilibiliSummaryEnabled,
    fetchBilibiliSummary,
    isYt,
    localSummaryChecked,
    localSummaryLoading,
    localSummaryMarkdown,
    showSummary,
  ]);

  const clearHideSummaryTimer = () => {
    if (hideSummaryTimeoutRef.current) {
      clearTimeout(hideSummaryTimeoutRef.current);
      hideSummaryTimeoutRef.current = null;
    }
  };

  const scheduleHideSummary = () => {
    clearHideSummaryTimer();
    hideSummaryTimeoutRef.current = setTimeout(() => {
      if (!hoverRegionRef.current.card && !hoverRegionRef.current.popup) {
        setShowSummary(false);
      }
    }, 200);
  };

  const handleCardMouseEnter = () => {
    // No hover preview on touch/mobile devices
    if (window.innerWidth <= 900) return;

    hoverRegionRef.current.card = true;
    clearHideSummaryTimer();

    if (openSummaryTimeoutRef.current) {
      clearTimeout(openSummaryTimeoutRef.current);
    }

    if (showSummary) return;

    openSummaryTimeoutRef.current = setTimeout(() => {
      if (!hoverRegionRef.current.card && !hoverRegionRef.current.popup) {
        return;
      }
      setShowSummary(true);
      setPopupStyle({ opacity: 0 });
      void fetchLocalSummary();
    }, 400);
  };

  const handleCardMouseLeave = () => {
    hoverRegionRef.current.card = false;
    if (openSummaryTimeoutRef.current) {
      clearTimeout(openSummaryTimeoutRef.current);
      openSummaryTimeoutRef.current = null;
    }

    if (!hoverRegionRef.current.popup) {
      scheduleHideSummary();
    }
  };

  const handlePopupMouseEnter = () => {
    hoverRegionRef.current.popup = true;
    clearHideSummaryTimer();

    if (openSummaryTimeoutRef.current) {
      clearTimeout(openSummaryTimeoutRef.current);
      openSummaryTimeoutRef.current = null;
    }

    if (!showSummary) {
      setShowSummary(true);
      setPopupStyle({ opacity: 0 });
    }
  };

  const handlePopupMouseLeave = () => {
    hoverRegionRef.current.popup = false;
    if (!hoverRegionRef.current.card) {
      scheduleHideSummary();
    }
  };

  const playInApp = () => {
    onPlay(video);
    fetch('/api/videos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: video.id, is_read: true }),
    }).catch(() => {});
  };

  const handleClick = (e: React.MouseEvent) => {
    const isMobileViewport = window.innerWidth <= 900;
    if (externalOpen && !isMobileViewport) return;
    e.preventDefault();
    playInApp();
  };

  const loadSummaryModels = useCallback(async () => {
    if (summaryModelsLoading || summaryModels.length > 0) return;
    setSummaryModelsLoading(true);
    try {
      const res = await fetch('/api/settings/ai-summary', {
        cache: 'no-store',
      });
      const data = await res.json();
      setSummaryModels(Array.isArray(data.models) ? data.models : []);
    } catch {
      setSummaryModels([]);
    } finally {
      setSummaryModelsLoading(false);
    }
  }, [summaryModels.length, summaryModelsLoading]);

  const triggerMetadataRepair = useCallback(() => {
    if (metadataRepairing || video.availability_status === 'abandoned') return;
    setMetadataRepairing(true);
    fetch(`/api/videos/${video.id}/repair`, {
      method: 'POST',
    })
      .catch(() => {})
      .finally(() => {
        setMetadataRepairing(false);
      });
  }, [metadataRepairing, video.availability_status, video.id]);

  const triggerSubtitleRetry = useCallback(
    (preferredMethod: 'gemini' | 'piped' | 'bilibili-api') => {
      if (subtitleRetrying) return;
      setSubtitleRetrying(true);
      const params = new URLSearchParams({
        source: 'player',
        preferredMethod,
        async: '1',
      });
      void fetch(`/api/videos/${video.id}/subtitle?${params.toString()}`, {
        method: 'POST',
      })
        .catch(() => {})
        .finally(() => {
          setSubtitleRetrying(false);
        });
    },
    [subtitleRetrying, video.id],
  );

  const triggerSummaryGenerate = useCallback(
    (modelId?: string) => {
      if (summaryRetrying) return;
      setSummaryRetrying(true);
      const params = new URLSearchParams();
      if (modelId) params.set('modelId', modelId);
      const qs = params.toString();
      fetch(
        `/api/videos/${video.id}/summary/generate${qs ? `?${qs}` : ''}`,
        {
          method: 'POST',
        },
      )
        .catch(() => {})
        .finally(() => {
          setSummaryRetrying(false);
        });
    },
    [summaryRetrying, video.id],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const width = 208;
      const height = 180;
      const maxX = window.innerWidth - width - 12;
      const maxY = window.innerHeight - height - 12;
      setContextMenu({
        x: Math.max(12, Math.min(event.clientX, maxX)),
        y: Math.max(12, Math.min(event.clientY, maxY)),
      });
      setActiveSubmenu(null);
    },
    [],
  );

  const shouldRenderSummaryPopup =
    localSummaryMarkdown ||
    (isYt
      ? localSummaryLoading
      : !localSummaryChecked ||
        localSummaryLoading ||
        bilibiliSummaryEnabled === null ||
        summaryLoading ||
        bilibiliSummaryEnabled !== false);

  return (
    <div
      ref={cardRef}
      className={`video-card ${video.is_read === 0 ? 'unread' : ''}${video._isNew ? ' is-new' : ''}`}
      onMouseEnter={handleCardMouseEnter}
      onMouseLeave={handleCardMouseLeave}
      onContextMenu={handleContextMenu}
      style={{ position: 'relative', zIndex: showSummary ? 50 : 1 }}
    >
      <a
        href={getExternalUrl(video)}
        target={externalOpen ? '_blank' : undefined}
        rel={externalOpen ? 'noopener noreferrer' : undefined}
        onClick={handleClick}
        style={{ textDecoration: 'none', color: 'inherit' }}
      >
        <div className="video-thumb-wrapper">
          <div className="video-badges-top">
            {video.research?.is_favorited && (
              <span className="subtitle-badge" title="已加入研究收藏" style={{ background: 'var(--accent-purple)' }}>
                🔖
              </span>
            )}
            {subtitleBadge && (
              <span
                className={`subtitle-badge state-${video.subtitle_status || 'unknown'}`}
                title={
                  video.subtitle_status === 'error'
                    ? `${video.subtitle_error || '字幕抓取失败'}，点击尝试 API 提取字幕`
                    : video.subtitle_error || undefined
                }
                style={
                  video.subtitle_status === 'error'
                    ? {
                        cursor: subtitleRetrying ? 'progress' : 'pointer',
                        pointerEvents: 'auto',
                      }
                    : undefined
                }
                onClick={
                  video.subtitle_status === 'error'
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (subtitleRetrying) return;
                        setSubtitleRetrying(true);
                        const params = new URLSearchParams({
                          source: 'player',
                          preferredMethod: 'gemini',
                          async: '1',
                        });
                        void fetch(
                          `/api/videos/${video.id}/subtitle?${params.toString()}`,
                          {
                            method: 'POST',
                          },
                        )
                          .catch(() => {})
                          .finally(() => {
                            setSubtitleRetrying(false);
                          });
                      }
                    : undefined
                }
              >
                {subtitleRetrying ? '…' : subtitleBadge}
              </span>
            )}
            {video.summary_status === 'completed' && (
              <span
                className="summary-indicator completed"
                title="已有 AI 总结"
              >
                ✦
              </span>
            )}
            {video.summary_status === 'processing' && (
              <span
                className="summary-indicator processing"
                title="AI 总结生成中"
              >
                <span
                  className="status-pulse"
                  style={{ width: 6, height: 6, margin: 0 }}
                />
              </span>
            )}
            {video.summary_status === 'failed' && (
              <span
                className={`summary-indicator failed ${video.summary_status}`}
                title="AI 总结生成失败，点击重试"
                style={{
                  cursor: summaryRetrying ? 'progress' : 'pointer',
                  pointerEvents: 'auto',
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (summaryRetrying) return;
                  setSummaryRetrying(true);
                  fetch(`/api/videos/${video.id}/summary/generate`, {
                    method: 'POST',
                  })
                    .catch(() => {})
                    .finally(() => {
                      setSummaryRetrying(false);
                    });
                }}
              >
                {summaryRetrying ? '…' : '!'}
              </span>
            )}
            {video.summary_status === 'skipped' && (
              <span
                className="summary-indicator"
                title="已被规则跳过"
                style={{ background: 'rgba(15, 15, 15, 0.72)' }}
              >
                ⊘
              </span>
            )}
          </div>
          {video.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnail_url}
              alt={video.title}
              className="video-thumb"
              referrerPolicy="no-referrer"
              loading="lazy"
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
          {availabilityBadge && (
            <span className="members-badge" title={availabilityBadge.title}>
              {availabilityBadge.label}
            </span>
          )}

          {/* Removed play-overlay on hover */}
        </div>
      </a>
      <div className="video-meta">
        <div className="video-meta-content">
          <div
            className={`video-title ${video.is_read === 0 ? 'unread' : ''}`}
            title={video.title}
          >
            {video.title}
          </div>
          <div className="video-sub-meta">
            {video.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={video.avatar_url}
                alt={video.channel_name}
                className="video-meta-avatar-small"
                referrerPolicy="no-referrer"
                loading="lazy"
              />
            ) : (
              <div
                className="video-meta-avatar-small"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                }}
              >
                {isYt ? '▶' : '🅱'}
              </div>
            )}
            <span className="video-channel-name">{video.channel_name}</span>
            <span
              style={{
                color: isYt ? 'var(--accent-yt)' : 'var(--accent-bili)',
                fontWeight: 700,
                fontSize: 11,
                marginLeft: 4,
                userSelect: 'none',
              }}
              title={isYt ? 'YouTube' : 'B站'}
            >
              {isYt ? '▶' : '🅱'}
            </span>
            <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>•</span>
            <span className="video-date">
              {video.published_at ? timeAgo(video.published_at) : ''}
            </span>

          </div>
        </div>
      </div>

      {showSummary &&
        shouldRenderSummaryPopup &&
        typeof window !== 'undefined' &&
        createPortal(
          <div
            ref={popupRef}
            className="biliscope-video-card-inner"
            style={popupStyle}
            onMouseEnter={handlePopupMouseEnter}
            onMouseLeave={handlePopupMouseLeave}
          >
            {localSummaryMarkdown ? (
              <SummaryHoverPreview
                markdown={localSummaryMarkdown}
                video={video}
                onTimestampClick={(seconds) => onPlay(video, seconds)}
              />
            ) : isYt ? (
              localSummaryLoading ? (
                <div id="biliscope-ai-summary-none">加载中...</div>
              ) : null
            ) : !localSummaryChecked ||
              localSummaryLoading ||
              bilibiliSummaryEnabled === null ||
              summaryLoading ? (
              <div id="biliscope-ai-summary-none">加载中...</div>
            ) : summaryData?.model_result?.summary ||
              (summaryData?.model_result?.outline &&
                summaryData.model_result.outline.length > 0) ? (
              <BilibiliSummaryPopup
                data={summaryData}
                videoId={video.video_id}
                onTimestampClick={(timestamp) => {
                  onPlay(video, timestamp);
                  setShowSummary(false);
                }}
              />
            ) : (
              <div
                id="biliscope-ai-summary-none"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                  padding: 20,
                }}
              >
                {summaryData?.authExpired ? (
                  <div>
                    B站登录态失效，请前往{' '}
                    <a
                      href="/settings?tab=bilibili-summary"
                      style={{ color: 'inherit', textDecoration: 'underline' }}
                    >
                      设置页
                    </a>{' '}
                    更新 SESSDATA
                  </div>
                ) : (
                  <div>
                    {summaryData?.details || summaryData?.error || '暂无总结'}
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}

      {contextMenu &&
        typeof window !== 'undefined' &&
        createPortal(
          <div
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              minWidth: 196,
              background: 'rgba(18, 18, 22, 0.96)',
              color: '#f3f4f6',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 10,
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
              padding: 6,
              zIndex: 10000,
            }}
          >
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                triggerMetadataRepair();
              }}
              disabled={metadataRepairing || video.availability_status === 'abandoned'}
              style={contextMenuItemStyle}
            >
              修
              <span style={contextMenuHintStyle}>
                {video.availability_status === 'abandoned'
                  ? '已放弃'
                  : metadataRepairing
                    ? '处理中…'
                    : '元数据'}
              </span>
            </button>

            <button
              type="button"
              onClick={async () => {
                closeContextMenu();
                if (video.research?.is_favorited) {
                  try {
                    const res = await fetch('/api/research/favorites?video_id=' + video.id);
                    const data = await res.json();
                    const fav = data.items?.[0];
                    if (fav) {
                      setResearchModalState({
                        mode: 'edit',
                        existingFavorite: { id: fav.id, intent_type_id: fav.intent_type_id, note: fav.note }
                      });
                      return;
                    }
                  } catch (e) {
                    console.error('Failed to fetch favorite', e);
                  }
                }
                setResearchModalState({ mode: 'add' });
              }}
              style={contextMenuItemStyle}
            >
              <span>{video.research?.is_favorited ? '编辑研究收藏' : '加入研究收藏'}</span>
              <span style={contextMenuHintStyle}>›</span>
            </button>

            <div
              onMouseEnter={() => setActiveSubmenu('subtitle')}
              style={contextMenuItemStyle}
            >
              <span>重试字幕</span>
              <span style={contextMenuHintStyle}>›</span>
            </div>

            <div
              onMouseEnter={() => {
                setActiveSubmenu('summary');
                void loadSummaryModels();
              }}
              style={contextMenuItemStyle}
            >
              <span>总结</span>
              <span style={contextMenuHintStyle}>›</span>
            </div>

            {activeSubmenu === 'subtitle' && (
              <div
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  ...contextSubmenuStyle,
                  left:
                    contextMenu.x > window.innerWidth - 420 ? -198 : 198,
                  top: 42,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    triggerSubtitleRetry(isYt ? 'piped' : 'bilibili-api');
                  }}
                  style={contextMenuItemStyle}
                >
                  CLI
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    triggerSubtitleRetry('gemini');
                  }}
                  style={contextMenuItemStyle}
                >
                  API
                </button>
              </div>
            )}

            {activeSubmenu === 'summary' && (
              <div
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  ...contextSubmenuStyle,
                  left:
                    contextMenu.x > window.innerWidth - 420 ? -198 : 198,
                  top: 78,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    triggerSummaryGenerate();
                  }}
                  style={contextMenuItemStyle}
                >
                  默认模型
                </button>
                {summaryModelsLoading && (
                  <div style={contextMenuLoadingStyle}>加载模型中…</div>
                )}
                {!summaryModelsLoading &&
                  summaryModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        triggerSummaryGenerate(model.id);
                      }}
                      style={contextMenuItemStyle}
                    >
                      {model.name || model.id}
                    </button>
                  ))}
              </div>
            )}
          </div>,
          document.body,
        )}

      {researchModalState && (
        <ResearchFavoriteModal
          video={video}
          mode={researchModalState.mode}
          existingFavorite={researchModalState.existingFavorite}
          onClose={() => setResearchModalState(null)}
          onSuccess={() => {
            setResearchModalState(null);
            // Optionally, parent can trigger a refresh, but the user requested local state updating 
            // inside VideoFeed/App, or handled up via a global callback, but we will let `onSuccess` run.
            // Ideally should refresh data or optimistically mutate, but re-fetching works.
            window.dispatchEvent(new CustomEvent('video-mutated', { detail: video.id })); 
          }}
        />
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.externalOpen === next.externalOpen &&
    prev.video.id === next.video.id &&
    prev.video.summary_status === next.video.summary_status &&
    prev.video.subtitle_status === next.video.subtitle_status &&
    prev.video.subtitle_error === next.video.subtitle_error &&
    prev.video.is_read === next.video.is_read &&
    prev.video._isNew === next.video._isNew &&
    prev.video.thumbnail_url === next.video.thumbnail_url &&
    prev.video.duration === next.video.duration &&
    prev.video.published_at === next.video.published_at &&
    prev.video.is_members_only === next.video.is_members_only &&
    prev.video.access_status === next.video.access_status &&
    prev.video.research?.is_favorited === next.video.research?.is_favorited
  );
});

export default VideoCard;

const contextMenuItemStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  background: 'transparent',
  border: 0,
  borderRadius: 8,
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1.2,
  padding: '10px 12px',
  textAlign: 'left',
};

const contextMenuHintStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.56)',
  fontSize: 12,
};

const contextSubmenuStyle: React.CSSProperties = {
  position: 'absolute',
  minWidth: 196,
  background: 'rgba(18, 18, 22, 0.98)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  borderRadius: 10,
  boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
  padding: 6,
};

const contextMenuLoadingStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.56)',
  fontSize: 12,
  padding: '10px 12px',
};
