'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import MarkdownRenderer from '@/components/MarkdownRenderer';
import ChatPanel from '@/components/ChatPanel';
import { formatSecondsLabel, normalizeCommentUrl } from '@/lib/format';
import { findActiveSegmentIndex } from '@/lib/subtitle-segments';
import { Info, RefreshCw, Cpu, BrainCircuit, History, BarChart3, Languages, FileText, Download } from 'lucide-react';
import ResearchFavoriteModal from '@/components/ResearchFavoriteModal';
import type {
  SubtitleData,
  AiSummaryModelConfig,
  ChatArtifactData,
  ResearchFavoriteWithVideo,
  VideoCommentsData,
  VideoSummaryData,
  VideoWithMeta,
} from '@/types';

export interface VideoInfoPanelRef {
  scrollToChapterSeconds: (seconds: number) => void;
}

interface VideoInfoPanelProps {

  video: VideoWithMeta;
  onTimestampClick: (seconds: number) => void;
  currentPlayerSeconds?: number;
  playerDuration?: number;
  bilibiliAid?: number | null;
  bilibiliCid?: number | null;
  onSummaryChange?: (markdown: string) => void;
  onSubtitleChange?: (subtitle: SubtitleData | null) => void;
  onPlayModeClick?: () => void;
  currentPlayMode?: 'audio' | 'video' | 'official' | 'videolite' | 'reading' | 'none';
  followMode?: boolean;
  onFollowModeChange?: (follow: boolean) => void;
  subtitleOverlay?: boolean;
  onSubtitleOverlayChange?: (enabled: boolean) => void;
}

function formatToken(n: number | string | undefined | null): string {
  if (n === undefined || n === null) return '0';
  const num = typeof n === 'string' ? parseInt(n) : n;
  if (isNaN(num)) return '0';
  if (num > 999) {
    return (num / 1000).toFixed(1) + 'k';
  }
  return num.toString();
}

function parseMetricNumber(
  value: number | string | undefined | null,
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatMetricNumber(
  value: number | string | undefined | null,
  digits = 2,
): string {
  const parsed = parseMetricNumber(value);
  return parsed === null ? '0.00' : parsed.toFixed(digits);
}

const colors = {
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

function makeSafeFilename(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return normalized || 'video';
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatSubtitleText(subtitle: SubtitleData): string {
  if (Array.isArray(subtitle.segments) && subtitle.segments.length > 0) {
    return subtitle.segments
      .map((segment) => {
        const speaker = segment.speaker ? `${segment.speaker}: ` : '';
        return `[${formatSecondsLabel(segment.start)} - ${formatSecondsLabel(segment.end)}] ${speaker}${segment.text}`;
      })
      .join('\n');
  }
  return subtitle.text || '';
}

function formatSubtitlePlainText(subtitle: SubtitleData): string {
  if (Array.isArray(subtitle.segments) && subtitle.segments.length > 0) {
    return subtitle.segments
      .map((segment) => {
        const speaker = segment.speaker ? `${segment.speaker}: ` : '';
        return `${speaker}${segment.text}`;
      })
      .join('\n');
  }
  return (subtitle.text || '')
    .replace(/^\s*\[[^\]]+\]\s*/gm, '')
    .trim();
}

function formatResearchFavoriteMarkdown(favorite: ResearchFavoriteWithVideo) {
  return [
    '---',
    'artifact: research_favorite',
    `intent_type: ${favorite.intent_type_name}`,
    `created_at: ${favorite.created_at}`,
    `updated_at: ${favorite.updated_at}`,
    '---',
    '',
    `# ${favorite.title || favorite.platform_video_id}`,
    '',
    `- 平台：${favorite.platform}`,
    `- 频道：${favorite.channel_name || '未知频道'}`,
    `- 研究意图：${favorite.intent_type_name}`,
    '',
    favorite.note,
  ].join('\n');
}

function formatChatArtifactMarkdown(artifact: ChatArtifactData): string {
  const modeLabel = artifact.mode === 'roast' ? '吐槽模式' : '笔记模式';
  return [
    '---',
    'artifact: chat',
    `mode: ${artifact.mode}`,
    `created_at: ${artifact.createdAt}`,
    `range: ${formatSecondsLabel(artifact.rangeStart)}-${formatSecondsLabel(artifact.rangeEnd)}`,
    '---',
    '',
    `# 视频问答 - ${modeLabel}`,
    '',
    `- 时间范围：${formatSecondsLabel(artifact.rangeStart)} - ${formatSecondsLabel(artifact.rangeEnd)}`,
    `- 用户输入：${artifact.prompt || '无'}`,
    '',
    artifact.content,
  ].join('\n');
}

function formatAllChatArtifactsMarkdown(artifacts: ChatArtifactData[]): string {
  return artifacts
    .map((artifact) => formatChatArtifactMarkdown(artifact))
    .join('\n\n---\n\n');
}

function DownloadAction({
  title,
  detail,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px',
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: disabled ? 'var(--bg-hover)' : 'var(--bg-secondary)',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        textAlign: 'left',
      }}
    >
      <Download size={16} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {detail}
        </span>
      </span>
    </button>
  );
}

function InfoActionPopover({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => setIsOpen(false), 50);
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type="button"
        style={{
          background: 'transparent',
          border: 'none',
          color: isOpen ? 'var(--accent-purple)' : 'var(--text-muted)',
          padding: '6px',
          borderRadius: '8px',
          cursor: 'pointer',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isOpen ? 1 : 0.6,
        }}
        title="设置"
      >
        <Info size={18} strokeWidth={2.5} />
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 300,
            background: 'var(--bg-elevated, var(--bg-secondary))',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            boxShadow: 'var(--shadow-lg)',
            zIndex: 1000,
            padding: '16px',
            color: 'var(--text-primary)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default forwardRef<VideoInfoPanelRef, VideoInfoPanelProps>(
  function VideoInfoPanel(
    {
      video,
      onTimestampClick,
      currentPlayerSeconds = 0,
      playerDuration = 0,
      bilibiliAid,
      bilibiliCid,
      onSummaryChange,
      onSubtitleChange,
      onPlayModeClick,
      currentPlayMode = 'none',
      followMode = false,
      onFollowModeChange,
      subtitleOverlay = false,
      onSubtitleOverlayChange,
    }: VideoInfoPanelProps,
    ref,
  ) {

    const [subtitle, setSubtitle] = useState<SubtitleData | null>(null);

    const [subtitleLoading, setSubtitleLoading] = useState(true);
    const [subtitleRetrying, setSubtitleRetrying] = useState(false);
    const [subtitleApiExtracting, setSubtitleApiExtracting] = useState(false);
    const [summary, setSummary] = useState<VideoSummaryData | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [summaryGenerating, setSummaryGenerating] = useState(false);
    const [summaryError, setSummaryError] = useState<string | null>(null);
    const [summaryProgressMessage, setSummaryProgressMessage] = useState<
      string | null
    >(null);
    const [streamingMarkdown, setStreamingMarkdown] = useState<string | null>(
      null,
    );
    const abortRef = useRef<AbortController | null>(null);
    const [comments, setComments] = useState<VideoCommentsData | null>(null);
    const [commentsLoading, setCommentsLoading] = useState(true);
    const [chatArtifacts, setChatArtifacts] = useState<ChatArtifactData[]>([]);
    const [chatArtifactsLoading, setChatArtifactsLoading] = useState(false);
    const [researchFavorite, setResearchFavorite] =
      useState<ResearchFavoriteWithVideo | null>(null);
    const [researchFavoriteLoading, setResearchFavoriteLoading] =
      useState(false);
    const [models, setModels] = useState<
      Pick<AiSummaryModelConfig, 'id' | 'name' | 'isMultimodal'>[]
    >([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [selectedSubtitleModel, setSelectedSubtitleModel] =
      useState<string>('');
    const selectedSubtitleModelRef = useRef('');
    const [selectedSubtitleFallbackModel, setSelectedSubtitleFallbackModel] =
      useState<string>('');
    const selectedSubtitleFallbackModelRef = useRef('');
    const [viewingHistory, setViewingHistory] = useState(false);
    const [activePanel, setActivePanel] = useState<
      'subtitle' | 'summary' | 'comments' | 'chat' | 'download' | 'research'
    >('summary');
    const [isMobile, setIsMobile] = useState(false);
    const [isTabExpanded, setIsTabExpanded] = useState(false);
    const activeSegmentRef = useRef<HTMLButtonElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const checkMobile = () => {
        setIsMobile(window.innerWidth <= 900);
      };
      checkMobile();
      window.addEventListener('resize', checkMobile);
      return () => window.removeEventListener('resize', checkMobile);
    }, []);

    useEffect(() => {
      setIsTabExpanded(false);
    }, [video.id]);

    useEffect(() => {
      selectedSubtitleModelRef.current = selectedSubtitleModel;
    }, [selectedSubtitleModel]);

    useEffect(() => {
      selectedSubtitleFallbackModelRef.current = selectedSubtitleFallbackModel;
    }, [selectedSubtitleFallbackModel]);

    const effectiveMarkdown = viewingHistory && summary?.previous?.markdown
      ? summary.previous.markdown
      : summary?.markdown || '';

    useEffect(() => {
      onSummaryChange?.(effectiveMarkdown);
    }, [effectiveMarkdown, onSummaryChange]);

    useEffect(() => {
      onSubtitleChange?.(subtitle);
    }, [subtitle, onSubtitleChange]);

    useImperativeHandle(ref, () => ({
      scrollToChapterSeconds: (seconds: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const target = container.querySelector(
          `[data-chapter-seconds="${seconds}"], [data-summary-seconds="${seconds}"]`,
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
    }));


    // Keep refs to latest bilibili ids for use inside SSE handler
    const bilibiliAidRef = useRef<number | null | undefined>(bilibiliAid);
    const bilibiliCidRef = useRef<number | null | undefined>(bilibiliCid);
    useEffect(() => {
      bilibiliAidRef.current = bilibiliAid;
      bilibiliCidRef.current = bilibiliCid;
    });

    const isYt = video.platform === 'youtube';
    const defaultSubtitleMethod = isYt ? 'piped' : 'bilibili-api';
    type SubtitleRequestMethod =
      | 'api-fallback'
      | 'gemini'
      | 'piped'
      | 'bilibili-api';

    const buildSubtitleParams = useCallback(
      (
        preferredMethod: SubtitleRequestMethod,
        options?: { async?: boolean; force?: boolean },
      ) => {
        const params = new URLSearchParams({
          source: 'player',
          preferredMethod,
        });
        if (options?.async) {
          params.set('async', '1');
        }
        if (options?.force) {
          params.set('force', '1');
        }
        if (
          (preferredMethod === 'gemini' ||
            preferredMethod === 'api-fallback') &&
          selectedSubtitleModelRef.current
        ) {
          params.set('modelId', selectedSubtitleModelRef.current);
        }
        if (
          (preferredMethod === 'gemini' ||
            preferredMethod === 'api-fallback') &&
          selectedSubtitleFallbackModelRef.current &&
          selectedSubtitleFallbackModelRef.current !==
            selectedSubtitleModelRef.current
        ) {
          params.set(
            'fallbackModelId',
            selectedSubtitleFallbackModelRef.current,
          );
        }
        if (!isYt) {
          if (typeof bilibiliAid === 'number' && bilibiliAid > 0) {
            params.set('aid', String(bilibiliAid));
          }
          if (typeof bilibiliCid === 'number' && bilibiliCid > 0) {
            params.set('cid', String(bilibiliCid));
          }
        }
        return params;
      },
      [bilibiliAid, bilibiliCid, isYt],
    );

    const startSubtitleFetch = useCallback(
      async (
        preferredMethod: SubtitleRequestMethod,
        options?: { force?: boolean },
      ) => {
        const params = buildSubtitleParams(preferredMethod, {
          async: true,
          force: options?.force,
        });
        const res = await fetch(`/api/videos/${video.id}/subtitle?${params}`, {
          method: 'POST',
        });
        const data = (await res.json()) as SubtitleData;
        if (!res.ok && res.status !== 202) {
          throw new Error(data.error || '字幕抓取启动失败');
        }
        setSubtitle((prev) => ({
          ...(prev || {}),
          ...data,
          status: 'fetching',
          error: null,
          preferredMethod,
          activeMethod:
            preferredMethod === 'api-fallback'
              ? 'whisper-ai'
              : preferredMethod === 'gemini'
                ? 'gemini'
                : 'browser',
        }));
        return res;
      },
      [buildSubtitleParams, video.id],
    );

    // Subtitle fetch effect — depends directly on bilibiliAid/bilibiliCid props
    useEffect(() => {
      let active = true;
      const params = buildSubtitleParams(defaultSubtitleMethod);

      fetch(`/api/videos/${video.id}/subtitle?${params.toString()}`)
        .then(async (res) => {
          const data = (await res.json()) as SubtitleData;
          if (!active) return;
          setSubtitle(data);
          if (
            data.status !== 'fetched' &&
            data.status !== 'fetching' &&
            data.status !== 'pending'
          ) {
            void startSubtitleFetch(defaultSubtitleMethod).catch(() => {
              if (!active) return;
              setSubtitle((prev) => ({
                ...(prev || {}),
                status: 'error',
                error: '字幕抓取启动失败',
              }));
            });
          }
        })
        .catch(() => {
          if (!active) return;
          setSubtitle({ status: 'error', error: '字幕加载失败' });
        })
        .finally(() => {
          if (active) setSubtitleLoading(false);
        });

      return () => {
        active = false;
      };
    }, [buildSubtitleParams, defaultSubtitleMethod, startSubtitleFetch, video.id]);

    const loadSummary = useCallback(
      async (isRefresh = false) => {
        if (!isRefresh) setSummaryLoading(true);
        try {
          const res = await fetch(`/api/videos/${video.id}/summary?history=1`);
          const data = await res.json();
          setSummary(data);
        } catch {
          setSummary({ error: '总结加载失败' });
        } finally {
          setSummaryLoading(false);
        }
      },
      [video.id],
    );

    useEffect(() => {
      void loadSummary();
    }, [loadSummary]);

    useEffect(() => {
      const summaryIsProcessing = video.summary_status === 'processing';
      setSummaryGenerating(summaryIsProcessing);
      setSummaryError(null);
      setSummaryProgressMessage(
        summaryIsProcessing ? '总结正在后台生成中...' : null,
      );
      setStreamingMarkdown(null);
    }, [video.id, video.summary_status]);

    useEffect(() => {
      if (
        (activePanel === 'summary' || activePanel === 'subtitle') &&
        models.length === 0
      ) {
        fetch('/api/settings/ai-summary')
          .then((r) => r.json())
          .then((d) => setModels(d.models || []))
          .catch(() => { });
      }
    }, [activePanel, models.length]);

    useEffect(() => {
      let active = true;

      fetch(`/api/videos/${video.id}/comments`)
        .then(async (res) => {
          const data = await res.json();
          if (!active) return;
          setComments(data);
        })
        .catch(() => {
          if (!active) return;
          setComments({ error: '评论加载失败' });
        })
        .finally(() => {
          if (active) setCommentsLoading(false);
        });

      return () => {
        active = false;
      };
    }, [video.id]);

    const loadDownloadArtifacts = useCallback(async () => {
      setChatArtifactsLoading(true);
      setResearchFavoriteLoading(true);

      const chatRequest = fetch(`/api/videos/${video.id}/chat/artifacts`)
        .then((res) => res.json())
        .then((data) => {
          setChatArtifacts(Array.isArray(data.items) ? data.items : []);
        })
        .catch(() => {
          setChatArtifacts([]);
        })
        .finally(() => {
          setChatArtifactsLoading(false);
        });

      const researchRequest = fetch(`/api/research/favorites?video_id=${video.id}&limit=1`)
        .then((res) => res.json())
        .then((data) => {
          const favorite = Array.isArray(data.items) ? data.items[0] : null;
          setResearchFavorite(favorite || null);
        })
        .catch(() => {
          setResearchFavorite(null);
        })
        .finally(() => {
          setResearchFavoriteLoading(false);
        });

      await Promise.all([chatRequest, researchRequest]);
    }, [video.id]);

    useEffect(() => {
      setChatArtifacts([]);
      setResearchFavorite(null);
      if (activePanel === 'download') {
        void loadDownloadArtifacts();
      }
    }, [activePanel, loadDownloadArtifacts, video.id]);

    // Cleanup abortRef on unmount
    useEffect(
      () => () => {
        abortRef.current?.abort();
      },
      [],
    );

    // SSE event listener
    useEffect(() => {
      const es = new EventSource('/api/sse');

      const parseEvent = (event: MessageEvent) => {
        try {
          return JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return null;
        }
      };

      const isCurrentVideo = (data: Record<string, unknown> | null) =>
        data?.videoId === video.video_id;

      const onSummaryStart = (event: MessageEvent) => {
        const data = parseEvent(event);
        if (!isCurrentVideo(data)) return;
        setSummaryGenerating(true);
        setSummaryError(null);
        setSummaryProgressMessage('正在开始生成总结...');
      };

      const onSummaryProgress = (event: MessageEvent) => {
        const data = parseEvent(event);
        if (!isCurrentVideo(data)) return;
        setSummaryGenerating(true);
        setSummaryError(null);
        setSummaryProgressMessage(
          typeof data?.message === 'string' ? data.message : '正在生成总结...',
        );
      };

      const onSummaryComplete = (event: MessageEvent) => {
        const data = parseEvent(event);
        if (!isCurrentVideo(data)) return;
        setSummaryGenerating(false);
        setSummaryError(null);
        setSummaryProgressMessage(null);
        void loadSummary(true).then(() => {
          setStreamingMarkdown(null);
        });
      };

      const onSummaryError = (event: MessageEvent) => {
        const data = parseEvent(event);
        if (!isCurrentVideo(data)) return;
        setSummaryGenerating(false);
        setStreamingMarkdown(null);
        setSummaryProgressMessage(null);
        setSummaryError(
          typeof data?.error === 'string' ? data.error : '总结生成失败',
        );
      };

      const onSubtitleStatus = (event: MessageEvent) => {
        const data = parseEvent(event);
        if (!isCurrentVideo(data)) return;

        const status =
          typeof data?.status === 'string' ? data.status : 'fetching';
        const error =
          typeof data?.error === 'string' || data?.error === null
            ? (data.error as string | null)
            : null;
        const cooldownUntil =
          typeof data?.cooldownUntil === 'string' || data?.cooldownUntil === null
            ? (data.cooldownUntil as string | null)
            : null;
        const preferredMethod =
          typeof data?.preferredMethod === 'string'
            ? data.preferredMethod
            : undefined;
        const activeMethod =
          typeof data?.activeMethod === 'string' ? data.activeMethod : undefined;
        const message =
          typeof data?.message === 'string' ? data.message : undefined;

        setSubtitle((prev) => ({
          ...(prev || { status }),
          status,
          error,
          cooldownUntil,
          ...(preferredMethod ? { preferredMethod } : {}),
          ...(activeMethod ? { activeMethod } : {}),
          ...(message ? { message } : {}),
        }));

        const hasPartialSubtitle = data?.hasPartial === true;
        if (status === 'fetching') {
          setSubtitleLoading(false);
          if (!hasPartialSubtitle) return;
        }

        if (status === 'fetched' || hasPartialSubtitle) {
          const latestAid = bilibiliAidRef.current;
          const latestCid = bilibiliCidRef.current;
          const params = new URLSearchParams({
            source: 'player',
            preferredMethod: defaultSubtitleMethod,
          });
          if (!isYt && typeof latestAid === 'number' && latestAid > 0) {
            params.set('aid', String(latestAid));
          }
          if (!isYt && typeof latestCid === 'number' && latestCid > 0) {
            params.set('cid', String(latestCid));
          }
          void fetch(`/api/videos/${video.id}/subtitle?${params.toString()}`)
            .then((res) => res.json())
            .then((subtitleData: SubtitleData) => {
              setSubtitle(subtitleData);
            })
            .catch(() => { });
        }
      };

      es.addEventListener('summary-start', onSummaryStart);
      es.addEventListener('summary-progress', onSummaryProgress);
      es.addEventListener('summary-complete', onSummaryComplete);
      es.addEventListener('summary-error', onSummaryError);
      es.addEventListener('subtitle-status', onSubtitleStatus);

      return () => {
        es.removeEventListener('summary-start', onSummaryStart);
        es.removeEventListener('summary-progress', onSummaryProgress);
        es.removeEventListener('summary-complete', onSummaryComplete);
        es.removeEventListener('summary-error', onSummaryError);
        es.removeEventListener('subtitle-status', onSubtitleStatus);
        es.close();
      };
    }, [defaultSubtitleMethod, isYt, loadSummary, video.id, video.video_id]);

    const handleGenerateSummary = async (force = false) => {
      setSummaryGenerating(true);
      setSummaryError(null);
      setSummaryProgressMessage('正在发起生成请求...');
      setStreamingMarkdown('');
      setActivePanel('summary');

      const abort = new AbortController();
      abortRef.current = abort;
      let handedOffToExistingTask = false;

      try {
        const params = new URLSearchParams();
        if (force) params.set('force', '1');
        params.set('stream', '1');
        if (selectedModel) params.set('modelId', selectedModel);

        const res = await fetch(
          `/api/videos/${video.id}/summary/generate?${params}`,
          {
            method: 'POST',
            signal: abort.signal,
          },
        );

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 409) {
            handedOffToExistingTask = true;
            setSummaryGenerating(true);
            setSummaryError(null);
            setSummaryProgressMessage('总结已在后台生成中...');
            setStreamingMarkdown(null);
            return;
          }
          setSummaryError(data.details || data.error || '生成失败');
          setSummaryProgressMessage(null);
          setStreamingMarkdown(null);
          setSummaryGenerating(false);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            try {
              const json = JSON.parse(trimmed.slice(6));
              if (json.error) {
                setSummaryError(json.error);
                setSummaryProgressMessage(null);
                setStreamingMarkdown(null);
                setSummaryGenerating(false);
                return;
              }
              if (json.delta) {
                fullContent += json.delta;
                setSummaryProgressMessage('模型正在返回内容...');
                setStreamingMarkdown(fullContent);
              }
              if (json.done) {
                if (fullContent) {
                  const metadata =
                    json.metadata && typeof json.metadata === 'object'
                      ? (json.metadata as Record<string, string | number>)
                      : {};
                  setSummary({
                    markdown: fullContent,
                    format: 'markdown',
                    metadata,
                  });
                }
                setSummaryProgressMessage(null);
                setStreamingMarkdown(null);
                setSummaryGenerating(false);
                return;
              }
            } catch {
              /* skip malformed lines */
            }
          }
        }

        // Stream ended without done signal
        if (fullContent) {
          setSummary({ markdown: fullContent, format: 'markdown', metadata: {} });
        }
        setSummaryProgressMessage(null);
        setStreamingMarkdown(null);
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') {
          setSummaryError('生成请求失败，请检查网络');
        }
        setSummaryProgressMessage(null);
        setStreamingMarkdown(null);
      } finally {
        if (!handedOffToExistingTask) {
          setSummaryGenerating(false);
        }
        abortRef.current = null;
      }
    };

    const handleRetrySubtitle = async () => {
      setSubtitleRetrying(true);
      setSubtitleLoading(false);
      try {
        await startSubtitleFetch(defaultSubtitleMethod, { force: true });
      } catch {
        setSubtitle({ status: 'error', error: '字幕重试失败' });
      } finally {
        setSubtitleRetrying(false);
      }
    };

    const handleExtractSubtitleViaApi = async (force = false) => {
      setSubtitleApiExtracting(true);
      setSubtitleLoading(false);
      try {
        await startSubtitleFetch('api-fallback', { force });
      } catch {
        setSubtitle({ status: 'error', error: 'API 提取字幕失败' });
      } finally {
        setSubtitleApiExtracting(false);
      }
    };

    const subtitleSegments = Array.isArray(subtitle?.segments)
      ? subtitle.segments
      : [];
    const activeSegmentIndex = findActiveSegmentIndex(
      subtitleSegments,
      currentPlayerSeconds,
    );

    // 浮层字幕可用性：四态 —— 可用 / 加载中 / 不可用 / 粒度过粗
    type SubtitleOverlayAvailability =
      | 'available'
      | 'pending'
      | 'unavailable'
      | 'coarse';
    const subtitleOverlayAvailability: SubtitleOverlayAvailability = (() => {
      const status = subtitle?.status;
      if (
        !subtitle ||
        subtitleLoading ||
        status === 'pending' ||
        status === 'fetching'
      ) {
        return status === 'fetched' && subtitleSegments.length > 0
          ? 'available'
          : 'pending';
      }
      if (status !== 'fetched' || subtitleSegments.length === 0) {
        return 'unavailable';
      }
      if (subtitle?.segmentStyle === 'coarse') return 'coarse';
      return 'available';
    })();
    const subtitleOverlayTitle =
      subtitleOverlayAvailability === 'available'
        ? subtitleOverlay
          ? '关闭字幕浮层 (C)'
          : '开启字幕浮层 (C)'
        : subtitleOverlayAvailability === 'pending'
          ? '字幕加载中，稍后再试'
          : subtitleOverlayAvailability === 'coarse'
            ? '此视频字幕粒度过粗，无法悬浮显示'
            : '该视频暂无可用字幕';

    const isUserScrolledRef = useRef(false);
    const prevPlayerSecondsRef = useRef(currentPlayerSeconds);

    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const handleUserScroll = () => {
        isUserScrolledRef.current = true;
      };

      container.addEventListener('wheel', handleUserScroll, { passive: true });
      container.addEventListener('touchstart', handleUserScroll, { passive: true });
      container.addEventListener('mousedown', handleUserScroll, { passive: true });

      return () => {
        container.removeEventListener('wheel', handleUserScroll);
        container.removeEventListener('touchstart', handleUserScroll);
        container.removeEventListener('mousedown', handleUserScroll);
      };
    }, []);

    useEffect(() => {
      if (Math.abs(currentPlayerSeconds - prevPlayerSecondsRef.current) > 3) {
        isUserScrolledRef.current = false;
      }
      prevPlayerSecondsRef.current = currentPlayerSeconds;
    }, [currentPlayerSeconds]);

    useEffect(() => {
      if (followMode) {
        isUserScrolledRef.current = false;
      }
    }, [followMode, activePanel]);

    const lastScrolledSubtitleIndexRef = useRef<number | null>(null);
    // Auto-scroll active subtitle segment
    useEffect(() => {
      if (!followMode || activePanel !== 'subtitle') {
        lastScrolledSubtitleIndexRef.current = null;
        return;
      }
      if (activeSegmentRef.current && lastScrolledSubtitleIndexRef.current !== activeSegmentIndex) {
        if (!isUserScrolledRef.current) {
          activeSegmentRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        }
        lastScrolledSubtitleIndexRef.current = activeSegmentIndex;
      }
    }, [activeSegmentIndex, activePanel, followMode]);

    const lastScrolledSummarySecondsRef = useRef<number | null>(null);
    // Auto-scroll summary chapter
    useEffect(() => {
      if (!followMode || activePanel !== 'summary' || !scrollContainerRef.current) {
        lastScrolledSummarySecondsRef.current = null;
        return;
      }
      const container = scrollContainerRef.current;
      const sections = Array.from(container.querySelectorAll('[data-chapter-seconds], [data-summary-seconds]'))
        .map(el => ({
          el,
          seconds: parseInt(el.getAttribute('data-chapter-seconds') || el.getAttribute('data-summary-seconds') || '0')
        }))
        .sort((a, b) => b.seconds - a.seconds);

      const activeSection = sections.find(s => s.seconds <= currentPlayerSeconds);
      if (activeSection) {
        if (lastScrolledSummarySecondsRef.current !== activeSection.seconds) {
          isUserScrolledRef.current = false;
          activeSection.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          lastScrolledSummarySecondsRef.current = activeSection.seconds;
        }
      }
    }, [currentPlayerSeconds, activePanel, followMode]);

    const panelButtons = [
      { key: 'summary' as const, label: '总结', icon: '📝' },
      { key: 'subtitle' as const, label: '字幕', icon: '💬' },
      { key: 'chat' as const, label: '问答', icon: '✦' },
      { key: 'research' as const, label: video.research?.is_favorited ? '已收藏' : '收藏', icon: '🔬' },
      { key: 'download' as const, label: '下载', icon: '⬇' },
      { key: 'comments' as const, label: '其他', icon: '💭' },
    ];

    const summaryMetadata = summary?.metadata;
    const promptTokens = parseMetricNumber(summaryMetadata?.prompt_tokens);
    const completionTokens = parseMetricNumber(
      summaryMetadata?.completion_tokens,
    );
    const totalTime = parseMetricNumber(
      summaryMetadata?.total_time_seconds ?? summaryMetadata?.generation_time,
    );
    const ttft = parseMetricNumber(summaryMetadata?.ttft_seconds);
    const storedOutputTps = parseMetricNumber(summaryMetadata?.output_tps);
    const outputTps =
      storedOutputTps ??
      (completionTokens !== null && totalTime !== null && totalTime > 0
        ? completionTokens / totalTime
        : null);
    const hasSummaryStats =
      promptTokens !== null ||
      completionTokens !== null ||
      totalTime !== null ||
      ttft !== null ||
      outputTps !== null;

    const summaryGeneratedModelName =
      typeof summaryMetadata?.generated_model_name === 'string'
        ? summaryMetadata.generated_model_name
        : typeof summaryMetadata?.generated_model === 'string'
          ? summaryMetadata.generated_model
          : null;

    const subtitleMetadata = subtitle?.metadata;
    const subtitleTotalTokens = parseMetricNumber(subtitleMetadata?.total_tokens);
    const subtitleGeneratedAt =
      typeof subtitleMetadata?.generated_at === 'string'
        ? subtitleMetadata.generated_at
        : null;
    const subtitleGeneratedModelName =
      typeof subtitleMetadata?.generated_model_name === 'string'
        ? subtitleMetadata.generated_model_name
        : typeof subtitleMetadata?.generated_model === 'string'
          ? subtitleMetadata.generated_model
          : null;
    const multimodalModels = models.filter(
      (model) => model.isMultimodal !== false,
    );
    const subtitleTriggerSource =
      typeof subtitleMetadata?.trigger_source === 'string'
        ? subtitleMetadata.trigger_source
        : null;
    const subtitleActiveMethod =
      typeof subtitle?.activeMethod === 'string' ? subtitle.activeMethod : null;
    const subtitleRawFallbackRatio = parseMetricNumber(
      subtitleMetadata?.correction_raw_fallback_ratio,
    );
    const subtitleUsedRawWhisper =
      subtitleMetadata?.fallback === 'raw-whisper' ||
      subtitleRawFallbackRatio === 1;
    const subtitleHasRawWhisperFallback =
      subtitleRawFallbackRatio !== null && subtitleRawFallbackRatio > 0;
    const subtitleSourceLabel =
      subtitle?.sourceMethod === 'whisper-ai'
        ? subtitleUsedRawWhisper
          ? 'Whisper 原文（校对回退）'
          : subtitleHasRawWhisperFallback
            ? 'Whisper + AI 校对（部分回退）'
            : 'Whisper + AI 校对'
        : subtitle?.sourceMethod === 'gemini-url'
          ? 'Gemini API（视频直传）'
          : subtitle?.sourceMethod === 'gemini-audio'
            ? 'Gemini API（音频转录）'
            : subtitle?.sourceMethod === 'piped'
              ? 'Piped'
              : subtitle?.sourceMethod === 'bilibili-api'
                ? 'Bilibili API'
                : subtitle?.sourceMethod === 'opencli' ||
                  subtitle?.sourceMethod === 'browser'
                  ? 'Needle Browser'
                  : subtitle?.sourceMethod || null;
    const subtitleFetchingMessage =
      subtitle?.message ||
      (subtitleActiveMethod === 'whisper-ai'
        ? 'Whisper 时间戳锚定字幕提取已开始，关闭弹窗也会继续处理。'
        : subtitleActiveMethod === 'gemini'
          ? 'API 字幕提取已开始，关闭弹窗也会继续处理。'
          : subtitleActiveMethod === 'browser' || subtitleActiveMethod === 'opencli'
            ? 'CLI 字幕抓取已开始，关闭弹窗也会继续处理。'
            : '字幕抓取已开始，关闭弹窗也会继续处理。');
    const downloadBaseName = makeSafeFilename(video.title || video.video_id);
    const summaryDownloadMarkdown = summary?.markdown || '';
    const subtitleDownloadText = subtitle ? formatSubtitleText(subtitle) : '';
    const subtitlePlainDownloadText = subtitle ? formatSubtitlePlainText(subtitle) : '';

    return (
      <>
        <div style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          marginBottom: 12,
          minHeight: 44,
        }}>
          {isMobile ? (
            <div style={{ position: 'relative', zIndex: 10 }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsTabExpanded(!isTabExpanded);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 16px',
                  background: 'var(--bg-hover)',
                  borderRadius: 14,
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  fontWeight: 700,
                  height: 44,
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-sm)',
                  transition: 'all 0.2s ease',
                }}
              >
                <span>{panelButtons.find(b => b.key === activePanel)?.icon}</span>
                <span>{panelButtons.find(b => b.key === activePanel)?.label}</span>
                <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2, transform: isTabExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
              </button>

              {isTabExpanded && (
                <>
                  <div 
                    style={{ position: 'fixed', inset: 0, zIndex: -1 }} 
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsTabExpanded(false);
                    }} 
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 8px)',
                      left: 0,
                      minWidth: 160,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 18,
                      padding: '8px',
                      boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      zIndex: 20,
                      animation: 'dropdownIn 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    <style>{`
                      @keyframes dropdownIn {
                        from { opacity: 0; transform: translateY(-10px) scale(0.95); }
                        to { opacity: 1; transform: translateY(0) scale(1); }
                      }
                    `}</style>
                    {panelButtons.map((panel) => {
                      const active = activePanel === panel.key;
                      return (
                        <button
                          key={panel.key}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActivePanel(panel.key);
                            setIsTabExpanded(false);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            padding: '12px 16px',
                            borderRadius: 12,
                            background: active ? 'var(--bg-secondary)' : 'transparent',
                            border: 'none',
                            color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                            textAlign: 'left',
                            fontSize: 15,
                            fontWeight: active ? 700 : 500,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span style={{ fontSize: 18 }}>{panel.icon}</span>
                          <span>{panel.label}</span>
                          {active && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--accent-purple)' }}>●</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                gap: 2,
                padding: '4px',
                background: 'var(--bg-hover)',
                borderRadius: 12,
                height: 44,
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              {panelButtons.map((panel) => {
                const active = activePanel === panel.key;
                return (
                  <button
                    key={panel.key}
                    type="button"
                    onClick={() => setActivePanel(panel.key)}
                    style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: active ? 6 : 0,
                      padding: active ? '0 12px' : '0 10px',
                      borderRadius: 9,
                      background: active ? 'var(--bg-secondary)' : 'transparent',
                      border: 'none',
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      boxShadow: active ? 'var(--shadow-sm)' : 'none',
                      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      fontSize: 13,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                    title={panel.label}
                  >
                    <span style={{ fontSize: 16 }}>{panel.icon}</span>
                    {active && <span>{panel.label}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* Action Buttons Backplate */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            background: 'var(--bg-hover)',
            borderRadius: 14,
            padding: '2px',
            marginLeft: 'auto',
            marginRight: isMobile ? 52 : 0, // Space for Play Mode button on mobile
            zIndex: 5,
          }}>
            {isMobile && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFollowModeChange?.(!followMode);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: followMode ? 'var(--accent-purple)' : 'transparent',
                  border: 'none',
                  color: followMode ? '#fff' : 'var(--text-muted)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                title={followMode ? '关闭跟随模式' : '开启跟随模式'}
              >
                <span style={{ fontSize: 13, fontWeight: 700 }}>📍</span>
              </button>
            )}

            {isMobile && (() => {
              const canToggle = subtitleOverlayAvailability === 'available';
              const isOn = subtitleOverlay && canToggle;
              const isDisabled = !canToggle;
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canToggle) return;
                    onSubtitleOverlayChange?.(!subtitleOverlay);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: isOn ? 'var(--accent-purple)' : 'transparent',
                    border: 'none',
                    color: isOn ? '#fff' : 'var(--text-muted)',
                    opacity: isDisabled ? 0.5 : 1,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  title={subtitleOverlayTitle}
                >
                  <span style={{ fontSize: 13, fontWeight: 700 }}>📺</span>
                </button>
              );
            })()}
          </div>

          {isMobile && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPlayModeClick?.();
              }}
              style={{
                position: 'absolute',
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: 14,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                color: 'var(--accent-purple)',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                flexShrink: 0,
                transition: 'all 0.2s ease',
                zIndex: 1
              }}
              title="播放模式"
            >
              <span style={{ fontSize: 18 }}>
                {currentPlayMode === 'audio' ? '🎧' :
                  currentPlayMode === 'video' ? '📺' :
                    currentPlayMode === 'official' ? '🏛' :
                      currentPlayMode === 'videolite' ? '🎬' :
                        currentPlayMode === 'reading' ? '📖' : '🎬'}
              </span>
              <span style={{ fontSize: 8, fontWeight: 800, marginTop: -2, opacity: 0.8 }}>MODE</span>
            </button>
          )}
        </div>

        <div style={{
          position: 'relative',
          flex: isMobile && currentPlayMode === 'reading' ? 'none' : 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: isMobile && currentPlayMode === 'reading' ? 'auto' : 0
        }}>
          {/* Floating Info Icon Controls */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 4,
              zIndex: 100,
              display: (activePanel === 'summary' && !summaryLoading && (summary?.markdown || summary?.previous?.markdown)) ||
                (activePanel === 'subtitle' && !subtitleLoading && subtitle?.text) ? 'block' : 'none'
            }}
          >
            {activePanel === 'summary' && (
              <InfoActionPopover>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* Stats Section */}
                  <div>
                    <div style={{ color: colors.textSoft, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <BarChart3 size={12} />
                      统计信息
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: colors.textMuted }}>输入 Token</span>
                        <span style={{ fontWeight: 500 }}>{formatToken(summaryMetadata?.prompt_tokens)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: colors.textMuted }}>输出 Token</span>
                        <span style={{ fontWeight: 500 }}>{formatToken(summaryMetadata?.completion_tokens)}</span>
                      </div>
                      {ttft !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>首包耗时 (TTFT)</span>
                          <span style={{ fontWeight: 500 }}>{formatMetricNumber(ttft)}s</span>
                        </div>
                      )}
                      {outputTps !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>输出速度 (TPS)</span>
                          <span style={{ fontWeight: 500 }}>{formatMetricNumber(outputTps)} tok/s</span>
                        </div>
                      )}
                      {totalTime !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>总耗时</span>
                          <span style={{ fontWeight: 500 }}>{formatMetricNumber(totalTime)}s</span>
                        </div>
                      )}
                      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 11, color: colors.textSoft }}>
                        ✨ 生成于 {summaryMetadata?.generated_at ? new Date(summaryMetadata.generated_at).toLocaleString() : '未知时间'}
                        {summaryGeneratedModelName ? ` · ${summaryGeneratedModelName}` : ''}
                      </div>
                    </div>
                  </div>

                  {/* Model Selector Section */}
                  {models.length > 0 && (
                    <div>
                      <div style={{ color: colors.textSoft, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <BrainCircuit size={12} />
                        模型选择
                      </div>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        style={{
                          width: '100%',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: colors.textStrong,
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: 8,
                          fontSize: 12,
                          padding: '8px 10px',
                          outline: 'none',
                        }}
                      >
                        <option value="" style={{ background: 'var(--bg-secondary)' }}>使用默认模型</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id} style={{ background: 'var(--bg-secondary)' }}>
                            {m.name || m.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Actions Section */}
                  <div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {!summaryGenerating && (
                        <button
                          onClick={() => handleGenerateSummary(true)}
                          style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'var(--accent-purple)',
                            border: 'none',
                            borderRadius: 8,
                            color: 'white',
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                            padding: '8px 12px',
                            transition: 'all 0.2s',
                          }}
                        >
                          <RefreshCw size={14} />
                          重新生成
                        </button>
                      )}
                      {summary?.previous?.markdown && (
                        <button
                          onClick={() => setViewingHistory(!viewingHistory)}
                          style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 8,
                            color: colors.textMuted,
                            cursor: 'pointer',
                            fontSize: 12,
                            padding: '8px 12px',
                          }}
                        >
                          <History size={14} />
                          {viewingHistory ? '查看最新' : '查看过往'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </InfoActionPopover>
            )}

            {activePanel === 'subtitle' && (
              <InfoActionPopover>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* Stats Section */}
                  <div>
                    <div style={{ color: colors.textSoft, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Languages size={12} />
                      字幕信息
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: colors.textMuted }}>语言</span>
                        <span style={{ fontWeight: 500 }}>{subtitle?.language || '未知'}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: colors.textMuted }}>格式</span>
                        <span style={{ fontWeight: 500 }}>{subtitle?.format || 'txt'}</span>
                      </div>
                      {subtitleSegments.length > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>分段数量</span>
                          <span style={{ fontWeight: 500 }}>{subtitleSegments.length} 段</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: colors.textMuted }}>来源</span>
                        <span style={{ fontWeight: 500 }}>{subtitleSourceLabel || '未知'}</span>
                      </div>
                      {subtitleTotalTokens !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>总 Token</span>
                          <span style={{ fontWeight: 500 }}>{Math.round(subtitleTotalTokens)}</span>
                        </div>
                      )}
                      {parseMetricNumber(subtitleMetadata?.ttft_seconds) !== null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: colors.textMuted }}>首包耗时 (TTFT)</span>
                          <span style={{ fontWeight: 500 }}>{formatMetricNumber(subtitleMetadata?.ttft_seconds)}s</span>
                        </div>
                      )}
                      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 11, color: colors.textSoft }}>
                        {subtitleGeneratedAt ? `生成于 ${new Date(subtitleGeneratedAt).toLocaleString()}` : '已写入缓存'}
                        {subtitleGeneratedModelName ? ` · ${subtitleGeneratedModelName}` : ''}
                      </div>
                    </div>
                  </div>

                  {/* Configuration Section */}
                  {(subtitleTriggerSource || subtitle?.segmentStyle) && (
                    <div>
                      <div style={{ color: colors.textSoft, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <FileText size={12} />
                        配置详情
                      </div>
                      <div style={{ fontSize: 12, color: colors.textMuted }}>
                        {subtitleTriggerSource && (
                          <div>触发：{subtitleTriggerSource === 'manual-subtitle' ? '手动 API 提取' : subtitleTriggerSource}</div>
                        )}
                        {subtitle?.segmentStyle && (
                          <div>分段策略：{subtitle.segmentStyle === 'coarse' ? '粗粒度' : '细粒度'}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Actions Section */}
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ color: colors.textMuted, fontSize: 11 }}>主模型</span>
                        <select
                          value={selectedSubtitleModel}
                          onChange={(event) =>
                            setSelectedSubtitleModel(event.target.value)
                          }
                          disabled={subtitleApiExtracting || multimodalModels.length === 0}
                          style={{
                            width: '100%',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: colors.textStrong,
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: 8,
                            fontSize: 12,
                            padding: '8px 10px',
                            outline: 'none',
                          }}
                        >
                          {multimodalModels.length === 0 ? (
                            <option value="" style={{ background: 'var(--bg-secondary)' }}>
                              无多模态模型
                            </option>
                          ) : (
                            <option value="" style={{ background: 'var(--bg-secondary)' }}>
                              默认多模态模型
                            </option>
                          )}
                          {multimodalModels.map((model) => (
                            <option
                              key={model.id}
                              value={model.id}
                              style={{ background: 'var(--bg-secondary)' }}
                            >
                              {model.name || model.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ color: colors.textMuted, fontSize: 11 }}>备用模型</span>
                        <select
                          value={selectedSubtitleFallbackModel}
                          onChange={(event) =>
                            setSelectedSubtitleFallbackModel(event.target.value)
                          }
                          disabled={subtitleApiExtracting || multimodalModels.length === 0}
                          style={{
                            width: '100%',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: colors.textStrong,
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: 8,
                            fontSize: 12,
                            padding: '8px 10px',
                            outline: 'none',
                          }}
                        >
                          <option value="" style={{ background: 'var(--bg-secondary)' }}>
                            不使用备用模型
                          </option>
                          {multimodalModels.map((model) => (
                            <option
                              key={model.id}
                              value={model.id}
                              style={{ background: 'var(--bg-secondary)' }}
                              disabled={model.id === selectedSubtitleModel}
                            >
                              {model.name || model.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        onClick={() => void handleExtractSubtitleViaApi(true)}
                        disabled={
                          subtitleApiExtracting ||
                          subtitleRetrying ||
                          multimodalModels.length === 0
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          background: 'var(--accent-purple)',
                          border: 'none',
                          borderRadius: 8,
                          color: 'white',
                          cursor:
                            subtitleApiExtracting ||
                              subtitleRetrying ||
                              multimodalModels.length === 0
                              ? 'progress'
                              : 'pointer',
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '8px 12px',
                          transition: 'all 0.2s',
                        }}
                      >
                        <RefreshCw size={14} className={subtitleApiExtracting ? 'animate-spin' : ''} />
                        {subtitleApiExtracting ? '重新生成中...' : '重新生成'}
                      </button>
                    </div>
                  </div>
                </div>
              </InfoActionPopover>
            )}
          </div>

          <div
            ref={scrollContainerRef}
            className="mobile-sheet-scrollable"
            style={{
              minWidth: 0,
              flex: isMobile && currentPlayMode === 'reading' ? 'none' : 1,
              overflowY: isMobile && currentPlayMode === 'reading' ? 'visible' : 'auto',
              paddingRight: 4,
              paddingBottom: isMobile ? 'calc(50px + env(safe-area-inset-bottom, 0px))' : 0,
              position: 'relative',
            }}
          >
            {activePanel !== 'summary' && activePanel !== 'chat' && (
              <div
                style={{
                  color: colors.textStrong,
                  fontSize: 18,
                  fontWeight: 800,
                  marginBottom: 12,
                  letterSpacing: '-0.3px'
                }}
              >
                {activePanel === 'subtitle'
                  ? '字幕详情'
                  : '其他互动内容'}
              </div>
            )}

            {activePanel === 'summary' && summaryProgressMessage && (
              <div
                style={{
                  marginBottom: 12,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: colors.accentSoft,
                  border: `1px solid ${colors.accentBorder}`,
                  color: colors.accent,
                  fontSize: 12,
                }}
              >
                {summaryProgressMessage}
              </div>
            )}

            {activePanel === 'summary' && summaryLoading && (
              <div className="skeleton-group">
                <div
                  className="skeleton-line"
                  style={{ width: '45%', height: 18 }}
                />
                <div className="skeleton-line" style={{ width: '100%' }} />
                <div className="skeleton-line" style={{ width: '85%' }} />
                <div className="skeleton-line" style={{ width: '95%' }} />
              </div>
            )}
            {activePanel === 'summary' &&
              !summaryLoading &&
              streamingMarkdown !== null && (
                <MarkdownRenderer
                  markdown={streamingMarkdown}
                  video={video}
                  onTimestampClick={onTimestampClick}
                  streaming
                  tone="dark"
                />
              )}
            {activePanel === 'summary' &&
              !summaryLoading &&
              streamingMarkdown === null &&
              (summary?.markdown || summary?.previous?.markdown) && (
                <div style={{ position: 'relative' }}>
                  {summaryError && (
                    <div
                      style={{
                        color: colors.danger,
                        fontSize: 13,
                        marginBottom: 16,
                        padding: '10px 14px',
                        background: colors.dangerSoft,
                        border: `1px solid ${colors.dangerBorder}`,
                        borderRadius: 8,
                        textAlign: 'center',
                      }}
                    >
                      {summaryError}
                    </div>
                  )}
                  <MarkdownRenderer
                    markdown={
                      viewingHistory && summary.previous?.markdown
                        ? summary.previous?.markdown
                        : summary.markdown!
                    }
                    video={video}
                    onTimestampClick={onTimestampClick}
                    tone="dark"
                  />
                </div>
              )}
            {activePanel === 'summary' &&
              summaryGenerating &&
              streamingMarkdown === null && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    padding: '32px 0',
                  }}
                >
                  <div
                    className="status-pulse"
                    style={{ width: 10, height: 10 }}
                  />
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>
                    正在生成总结...
                  </div>
                </div>
              )}
            {activePanel === 'summary' &&
              !summaryLoading &&
              !summaryGenerating &&
              !summary?.markdown && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    padding: '32px 0',
                  }}
                >
                  {summaryError && (
                    <div
                      style={{
                        color: colors.danger,
                        fontSize: 13,
                        marginBottom: 8,
                        textAlign: 'center',
                      }}
                    >
                      {summaryError}
                    </div>
                  )}
                  {!summaryError && (
                    <div
                      style={{ color: colors.textMuted, fontSize: 13 }}
                    >
                      {summary?.details || summary?.error || '暂无总结'}
                    </div>
                  )}
                  <div
                    style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                  >
                    {models.length > 0 && (
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        style={{
                          background: colors.inputBg,
                          color: colors.textStrong,
                          border: `1px solid ${colors.borderStrong}`,
                          borderRadius: 4,
                          fontSize: 13,
                          padding: '8px 12px',
                        }}
                      >
                        <option value="">默认模型</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name || m.id}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() => handleGenerateSummary()}
                      disabled={summaryGenerating}
                      style={{
                        background: colors.accentSoft,
                        border: `1px solid ${colors.accentBorder}`,
                        borderRadius: 8,
                        color: colors.accent,
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: 600,
                        padding: '10px 24px',
                      }}
                    >
                      {summaryError || summary?.error
                        ? '立即重试'
                        : '生成 AI 总结'}
                    </button>
                  </div>
                  <div style={{ color: colors.textFaint, fontSize: 11 }}>
                    需要先有字幕数据，生成大约需要 10-30 秒
                  </div>
                </div>
              )}

            {activePanel === 'subtitle' && (subtitleLoading || !subtitle) && (
              <div className="skeleton-group">
                <div className="skeleton-line" style={{ width: '60%' }} />
                <div className="skeleton-line" style={{ width: '90%' }} />
                <div className="skeleton-line" style={{ width: '75%' }} />
                <div className="skeleton-line" style={{ width: '85%' }} />
                <div className="skeleton-line" style={{ width: '40%' }} />
              </div>
            )}
            {activePanel === 'subtitle' &&
              !subtitleLoading &&
              subtitle?.text && (
                <div style={{ position: 'relative' }}>
                  {/* Subtitle Content */}
                  {subtitleSegments.length > 0 ? (
                    <div className="subtitle-segment-list">
                      {subtitleSegments.map((segment, index) => {
                        const isActive = index === activeSegmentIndex;
                        return (
                          <button
                            key={`${segment.start}-${index}`}
                            ref={isActive ? activeSegmentRef : undefined}
                            type="button"
                            onClick={() => onTimestampClick(segment.start)}
                            className={`subtitle-segment ${isActive ? 'active' : ''}`}
                          >
                            <span className="subtitle-segment-time">
                              {formatSecondsLabel(segment.start)}
                            </span>
                            <span className="subtitle-segment-text">
                              {segment.speaker ? `[${segment.speaker}] ` : ''}
                              {segment.text}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div
                      style={{
                        color: colors.text,
                        fontSize: 14,
                        lineHeight: 1.7,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {subtitle.text}
                    </div>
                  )}
                </div>
              )}
            {activePanel === 'subtitle' &&
              !subtitleLoading &&
              !subtitle?.text && (
                <div className="subtitle-empty-card">
                  <div className="subtitle-empty-icon">
                    {subtitle?.status === 'fetching'
                      ? '⏳'
                      : subtitle?.status === 'error'
                        ? '⚠️'
                        : '📭'}
                  </div>
                  <div className="subtitle-empty-text">
                    {(subtitle?.status === 'fetching'
                      ? subtitleFetchingMessage
                      : null) ||
                      subtitle?.error ||
                      (subtitle?.status === 'missing'
                        ? '这个视频没有可抓取的字幕。'
                        : '暂无字幕。')}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {subtitle?.status === 'error' && (
                      <button
                        type="button"
                        onClick={() => void handleRetrySubtitle()}
                        disabled={subtitleRetrying || subtitleApiExtracting}
                        style={{
                          background: colors.dangerSoft,
                          border: `1px solid ${colors.dangerBorder}`,
                          borderRadius: 8,
                          color: colors.danger,
                          cursor:
                            subtitleRetrying || subtitleApiExtracting
                              ? 'progress'
                              : 'pointer',
                          fontSize: 13,
                          fontWeight: 600,
                          padding: '9px 18px',
                        }}
                      >
                        {subtitleRetrying ? '重试中...' : '立即重试'}
                      </button>
                    )}
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ color: colors.textMuted, fontSize: 11 }}>主模型</span>
                      <select
                        value={selectedSubtitleModel}
                        onChange={(event) =>
                          setSelectedSubtitleModel(event.target.value)
                        }
                        disabled={subtitleApiExtracting || multimodalModels.length === 0}
                        style={{
                          background: colors.inputBg,
                          border: `1px solid ${colors.borderStrong}`,
                          borderRadius: 8,
                          color: colors.textStrong,
                          fontSize: 13,
                          minWidth: 150,
                          padding: '9px 12px',
                        }}
                      >
                        {multimodalModels.length === 0 ? (
                          <option value="">无多模态模型</option>
                        ) : (
                          <option value="">默认多模态模型</option>
                        )}
                        {multimodalModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name || model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ color: colors.textMuted, fontSize: 11 }}>备用模型</span>
                      <select
                        value={selectedSubtitleFallbackModel}
                        onChange={(event) =>
                          setSelectedSubtitleFallbackModel(event.target.value)
                        }
                        disabled={subtitleApiExtracting || multimodalModels.length === 0}
                        style={{
                          background: colors.inputBg,
                          border: `1px solid ${colors.borderStrong}`,
                          borderRadius: 8,
                          color: colors.textStrong,
                          fontSize: 13,
                          minWidth: 150,
                          padding: '9px 12px',
                        }}
                      >
                        <option value="">不使用备用模型</option>
                        {multimodalModels.map((model) => (
                          <option
                            key={model.id}
                            value={model.id}
                            disabled={model.id === selectedSubtitleModel}
                          >
                            {model.name || model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleExtractSubtitleViaApi()}
                      disabled={
                        subtitleRetrying ||
                        subtitleApiExtracting ||
                        multimodalModels.length === 0
                      }
                      style={{
                        background: colors.accentSoft,
                        border: `1px solid ${colors.accentBorder}`,
                        borderRadius: 8,
                        color: colors.accent,
                        cursor:
                          subtitleRetrying ||
                            subtitleApiExtracting ||
                            multimodalModels.length === 0
                            ? 'progress'
                            : 'pointer',
                        fontSize: 13,
                        fontWeight: 600,
                        padding: '9px 18px',
                      }}
                    >
                      {subtitleApiExtracting ? '提取中...' : 'API 提取字幕'}
                    </button>
                  </div>
                  <div style={{ color: colors.textFaint, fontSize: 11 }}>
                    API 提取会调用多模态模型并使用设置页中的字幕提示词模板；主模型失败时会尝试备用模型。
                  </div>
                </div>
              )}

            {activePanel === 'comments' && commentsLoading && (
              <div className="skeleton-group">
                <div className="skeleton-line" style={{ width: '30%' }} />
                <div className="skeleton-line" style={{ width: '90%' }} />
                <div className="skeleton-line" style={{ width: '60%' }} />
              </div>
            )}
            {activePanel === 'comments' &&
              !commentsLoading &&
              Array.isArray(comments?.comments) &&
              comments.comments.length > 0 && (
                <div className="comment-list" style={{ gap: 16 }}>
                  {comments.comments.map((comment, index) => (
                    <div
                      key={comment.commentId || `${comment.author}-${index}`}
                      className="comment-item"
                    >
                      {comment.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className="comment-avatar"
                          src={comment.thumbnail}
                          alt={comment.author || 'avatar'}
                        />
                      ) : (
                        <div
                          className="comment-avatar placeholder"
                          style={{ color: colors.textMuted }}
                        >
                          {comment.author?.slice(0, 1) || '?'}
                        </div>
                      )}
                      <div className="comment-main">
                        <div
                          className="comment-head"
                          style={{ marginBottom: 6, flexWrap: 'wrap' }}
                        >
                          {normalizeCommentUrl(comment.commentorUrl) ? (
                            <a
                              href={
                                normalizeCommentUrl(comment.commentorUrl) ||
                                undefined
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className="comment-author"
                              style={{ textDecoration: 'none' }}
                            >
                              {comment.author || '匿名用户'}
                            </a>
                          ) : (
                            <span className="comment-author">
                              {comment.author || '匿名用户'}
                            </span>
                          )}
                          {comment.pinned && (
                            <span className="comment-time">置顶</span>
                          )}
                          {comment.channelOwner && (
                            <span className="comment-time">作者</span>
                          )}
                          {comment.verified && (
                            <span className="comment-time">认证</span>
                          )}
                          {comment.commentedTime && (
                            <span className="comment-time">
                              {comment.commentedTime}
                            </span>
                          )}
                          {typeof comment.likeCount === 'number' &&
                            comment.likeCount > 0 && (
                              <span className="comment-like">
                                赞 {comment.likeCount}
                              </span>
                            )}
                        </div>
                        <div className="comment-content">
                          {comment.commentText || '暂无正文'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            {activePanel === 'comments' &&
              !commentsLoading &&
              (!comments?.comments || comments.comments.length === 0) && (
                <div
                  style={{
                    color: colors.textMuted,
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  {comments?.details ||
                    comments?.error ||
                    '暂无其他文本内容。'}
                </div>
              )}

            {activePanel === 'download' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <DownloadAction
                    title="下载字幕 JSON"
                    detail={subtitleDownloadText ? '包含原始文本、分段、来源和元数据' : '当前视频暂无可下载字幕'}
                    disabled={!subtitleDownloadText}
                    onClick={() => {
                      if (!subtitle) return;
                      downloadTextFile(
                        `${downloadBaseName}_subtitle.json`,
                        JSON.stringify(subtitle, null, 2),
                        'application/json;charset=utf-8',
                      );
                    }}
                  />
                  <DownloadAction
                    title="下载字幕 TXT"
                    detail={subtitleDownloadText ? '按时间戳导出纯文本字幕' : '当前视频暂无可下载字幕'}
                    disabled={!subtitleDownloadText}
                    onClick={() => {
                      if (!subtitleDownloadText) return;
                      downloadTextFile(
                        `${downloadBaseName}_subtitle.txt`,
                        subtitleDownloadText,
                        'text/plain;charset=utf-8',
                      );
                    }}
                  />
                  <DownloadAction
                    title="下载字幕 TXT（无时间戳）"
                    detail={subtitlePlainDownloadText ? '只导出字幕正文，保留说话人标记' : '当前视频暂无可下载字幕'}
                    disabled={!subtitlePlainDownloadText}
                    onClick={() => {
                      if (!subtitlePlainDownloadText) return;
                      downloadTextFile(
                        `${downloadBaseName}_subtitle_plain.txt`,
                        subtitlePlainDownloadText,
                        'text/plain;charset=utf-8',
                      );
                    }}
                  />
                  <DownloadAction
                    title="下载总结 Markdown"
                    detail={summaryDownloadMarkdown ? '导出当前视频总结正文' : '当前视频暂无总结'}
                    disabled={!summaryDownloadMarkdown}
                    onClick={() => {
                      if (!summaryDownloadMarkdown) return;
                      downloadTextFile(
                        `${downloadBaseName}_summary.md`,
                        summaryDownloadMarkdown,
                        'text/markdown;charset=utf-8',
                      );
                    }}
                  />
                  <DownloadAction
                    title="下载研究意图 Markdown"
                    detail={
                      researchFavoriteLoading
                        ? '正在读取研究收藏'
                        : researchFavorite
                          ? `研究意图：${researchFavorite.intent_type_name}`
                          : '当前视频尚未加入研究收藏'
                    }
                    disabled={researchFavoriteLoading || !researchFavorite}
                    onClick={() => {
                      if (!researchFavorite) return;
                      downloadTextFile(
                        `${downloadBaseName}_research.md`,
                        formatResearchFavoriteMarkdown(researchFavorite),
                        'text/markdown;charset=utf-8',
                      );
                    }}
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    paddingTop: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: colors.textMuted,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>已保存问答</span>
                    <button
                      type="button"
                      onClick={() => void loadDownloadArtifacts()}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        background: 'var(--bg-hover)',
                        color: colors.textMuted,
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: '5px 8px',
                      }}
                    >
                      刷新
                    </button>
                  </div>
                  <DownloadAction
                    title="下载全部问答 Markdown"
                    detail={
                      chatArtifactsLoading
                        ? '正在读取问答记录'
                        : chatArtifacts.length > 0
                          ? `${chatArtifacts.length} 条已保存问答`
                          : '完整生成后的问答会自动保存到这里'
                    }
                    disabled={chatArtifactsLoading || chatArtifacts.length === 0}
                    onClick={() => {
                      if (chatArtifacts.length === 0) return;
                      downloadTextFile(
                        `${downloadBaseName}_chats.md`,
                        formatAllChatArtifactsMarkdown(chatArtifacts),
                        'text/markdown;charset=utf-8',
                      );
                    }}
                  />
                  {chatArtifacts.map((artifact) => (
                    <DownloadAction
                      key={artifact.id}
                      title={`${artifact.mode === 'roast' ? '吐槽' : '笔记'}问答 #${artifact.id}`}
                      detail={`${new Date(artifact.createdAt).toLocaleString()} · ${formatSecondsLabel(artifact.rangeStart)}-${formatSecondsLabel(artifact.rangeEnd)}`}
                      onClick={() => {
                        downloadTextFile(
                          `${downloadBaseName}_chat_${artifact.id}.md`,
                          formatChatArtifactMarkdown(artifact),
                          'text/markdown;charset=utf-8',
                        );
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {activePanel === 'chat' && (
              <ChatPanel
                video={video}
                subtitleSegments={subtitleSegments}
                onTimestampClick={onTimestampClick}
                currentPlayerSeconds={currentPlayerSeconds}
                playerDuration={playerDuration}
                onArtifactSaved={loadDownloadArtifacts}
              />
            )}

            {activePanel === 'research' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ color: colors.textStrong, fontSize: 18, fontWeight: 800, marginBottom: 4 }}>
                  研究收藏
                </div>
                <ResearchPanel 
                  video={video} 
                  colors={colors}
                  onSuccess={() => {
                    window.dispatchEvent(new CustomEvent('video-mutated', { detail: video.id }));
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </>
    );
  });

  function ResearchPanel({ 
    video, 
    colors,
    onSuccess 
  }: { 
    video: VideoWithMeta; 
    colors: any;
    onSuccess: () => void 
  }) {
    const [intentTypes, setIntentTypes] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [favorite, setFavorite] = useState<any>(null);
    
    const [selectedIntentTypeId, setSelectedIntentTypeId] = useState<number | null>(null);
    const [note, setNote] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      async function fetchData() {
        try {
          setLoading(true);
          const [intentRes, favRes] = await Promise.all([
            fetch('/api/research/intent-types'),
            fetch(`/api/research/favorites?video_id=${video.id}`)
          ]);
          
          if (intentRes.ok) {
            const intentData = await intentRes.json();
            setIntentTypes(intentData);
            
            const favData = await favRes.json();
            const fav = favData.items?.[0];
            if (fav) {
              setFavorite(fav);
              setSelectedIntentTypeId(fav.intent_type_id);
              setNote(fav.note || '');
            } else if (intentData.length > 0) {
              setSelectedIntentTypeId(intentData[0].id);
            }
          }
        } catch (err) {
          setError('加载数据失败');
        } finally {
          setLoading(false);
        }
      }
      fetchData();
    }, [video.id]);

    const handleSubmit = async () => {
      if (!selectedIntentTypeId) return setError('请选择研究意图');
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/research/favorites', {
          method: favorite ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: favorite?.id,
            video_id: video.id,
            intent_type_id: selectedIntentTypeId,
            note: note.trim(),
          }),
        });
        if (!res.ok) throw new Error();
        onSuccess();
        // Refresh local favorite state
        const favRes = await fetch(`/api/research/favorites?video_id=${video.id}`);
        const favData = await favRes.json();
        setFavorite(favData.items?.[0]);
      } catch (err) {
        setError('提交失败');
      } finally {
        setSubmitting(false);
      }
    };

    const handleRemove = async () => {
      if (!favorite) return;
      if (!confirm('确定移除收藏吗？')) return;
      setSubmitting(true);
      try {
        await fetch(`/api/research/favorites/${favorite.id}`, { method: 'DELETE' });
        setFavorite(null);
        setSelectedIntentTypeId(intentTypes[0]?.id || null);
        setNote('');
        onSuccess();
      } catch (err) {
        setError('移除失败');
      } finally {
        setSubmitting(false);
      }
    };

    if (loading) return <div style={{ padding: 20, textAlign: 'center', color: colors.textMuted }}>加载中...</div>;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: colors.textSoft }}>
            研究意图
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {intentTypes.map((intent) => (
              <button
                key={intent.id}
                type="button"
                onClick={() => setSelectedIntentTypeId(intent.id)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 10,
                  border: `1px solid ${selectedIntentTypeId === intent.id ? 'var(--accent-purple)' : colors.borderStrong}`,
                  background: selectedIntentTypeId === intent.id ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
                  color: selectedIntentTypeId === intent.id ? 'var(--accent-purple)' : colors.textMuted,
                  fontSize: 13,
                  fontWeight: selectedIntentTypeId === intent.id ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {intent.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: colors.textSoft }}>
            研究备注
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="记录此视频的研究价值..."
            style={{
              width: '100%',
              minHeight: 120,
              padding: 12,
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${colors.borderStrong}`,
              color: colors.textStrong,
              fontSize: 14,
              resize: 'vertical',
              fontFamily: 'inherit',
              lineHeight: 1.6,
            }}
          />
        </div>

        {error && <div style={{ color: colors.danger, fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          {favorite && (
            <button
              onClick={handleRemove}
              disabled={submitting}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: 10,
                border: '1px solid rgba(239, 68, 68, 0.3)',
                background: 'rgba(239, 68, 68, 0.1)',
                color: '#ef4444',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              移除收藏
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              flex: 2,
              padding: '10px',
              borderRadius: 10,
              border: 'none',
              background: 'var(--accent-purple)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: submitting ? 'progress' : 'pointer',
            }}
          >
            {submitting ? '提交中...' : favorite ? '更新收藏' : '加入收藏'}
          </button>
        </div>
      </div>
    );
  }
