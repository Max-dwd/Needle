'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import ChatPanel from '@/components/ChatPanel';
import { formatSecondsLabel, normalizeCommentUrl } from '@/lib/format';
import ResearchFavoriteModal from '@/components/ResearchFavoriteModal';
import type {
  SubtitleData,
  VideoCommentsData,
  VideoSummaryData,
  VideoWithMeta,
} from '@/types';

interface VideoInfoPanelProps {
  video: VideoWithMeta;
  onTimestampClick: (seconds: number) => void;
  currentPlayerSeconds?: number;
  playerDuration?: number;
  bilibiliAid?: number | null;
  bilibiliCid?: number | null;
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

export default function VideoInfoPanel({
  video,
  onTimestampClick,
  currentPlayerSeconds = 0,
  playerDuration = 0,
  bilibiliAid,
  bilibiliCid,
}: VideoInfoPanelProps) {
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
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [viewingHistory, setViewingHistory] = useState(false);
  const [researchModalState, setResearchModalState] = useState<{
    mode: 'add' | 'edit';
    existingFavorite?: { id: number; intent_type_id: number; note: string };
  } | null>(null);
  const [activePanel, setActivePanel] = useState<
    'subtitle' | 'summary' | 'comments' | 'chat'
  >('summary');
  const activeSegmentRef = useRef<HTMLButtonElement>(null);

  // Keep refs to latest bilibili ids for use inside SSE handler
  const bilibiliAidRef = useRef<number | null | undefined>(bilibiliAid);
  const bilibiliCidRef = useRef<number | null | undefined>(bilibiliCid);
  useEffect(() => {
    bilibiliAidRef.current = bilibiliAid;
    bilibiliCidRef.current = bilibiliCid;
  });

  const isYt = video.platform === 'youtube';
  const defaultSubtitleMethod = isYt ? 'piped' : 'bilibili-api';

  const buildSubtitleParams = useCallback(
    (
      preferredMethod: 'gemini' | 'piped' | 'bilibili-api',
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
      preferredMethod: 'gemini' | 'piped' | 'bilibili-api',
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
        activeMethod: preferredMethod === 'gemini' ? 'gemini' : 'browser',
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

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/summary?history=1`);
      const data = await res.json();
      setSummary(data);
    } catch {
      setSummary({ error: '总结加载失败' });
    } finally {
      setSummaryLoading(false);
    }
  }, [video.id]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (activePanel === 'summary' && models.length === 0) {
      fetch('/api/settings/ai-summary')
        .then((r) => r.json())
        .then((d) => setModels(d.models || []))
        .catch(() => {});
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
      setActivePanel('summary');
    };

    const onSummaryProgress = (event: MessageEvent) => {
      const data = parseEvent(event);
      if (!isCurrentVideo(data)) return;
      setSummaryGenerating(true);
      setSummaryError(null);
      setSummaryProgressMessage(
        typeof data?.message === 'string' ? data.message : '正在生成总结...',
      );
      setActivePanel('summary');
    };

    const onSummaryComplete = (event: MessageEvent) => {
      const data = parseEvent(event);
      if (!isCurrentVideo(data)) return;
      setSummaryGenerating(false);
      setSummaryError(null);
      setSummaryProgressMessage(null);
      setStreamingMarkdown(null);
      setActivePanel('summary');
      void loadSummary();
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
      setActivePanel('summary');
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
      setActivePanel('subtitle');

      if (status === 'fetching') {
        setSubtitleLoading(false);
        return;
      }

      if (status === 'fetched') {
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
          .catch(() => {});
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
      setSummaryGenerating(false);
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
      await startSubtitleFetch('gemini', { force });
    } catch {
      setSubtitle({ status: 'error', error: 'API 提取字幕失败' });
    } finally {
      setSubtitleApiExtracting(false);
    }
  };

  // Auto-scroll active subtitle segment
  useEffect(() => {
    if (activePanel === 'subtitle' && activeSegmentRef.current) {
      activeSegmentRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentPlayerSeconds, activePanel]);

  const panelButtons = [
    { key: 'summary' as const, label: '总结', icon: '📝' },
    { key: 'subtitle' as const, label: '字幕', icon: '💬' },
    { key: 'chat' as const, label: '问答', icon: '✦' },
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
  const subtitleTriggerSource =
    typeof subtitleMetadata?.trigger_source === 'string'
      ? subtitleMetadata.trigger_source
      : null;
  const subtitleActiveMethod =
    typeof subtitle?.activeMethod === 'string' ? subtitle.activeMethod : null;
  const subtitleSourceLabel =
    subtitle?.sourceMethod === 'gemini-url'
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
    (subtitleActiveMethod === 'gemini'
      ? 'API 字幕提取已开始，关闭弹窗也会继续处理。'
      : subtitleActiveMethod === 'browser' || subtitleActiveMethod === 'opencli'
        ? 'CLI 字幕抓取已开始，关闭弹窗也会继续处理。'
        : '字幕抓取已开始，关闭弹窗也会继续处理。');

  const subtitleSegments = Array.isArray(subtitle?.segments)
    ? subtitle.segments
    : [];
  const activeSegmentIndex =
    subtitleSegments.length > 0
      ? subtitleSegments.reduce(
          (bestIdx, seg, idx) =>
            seg.start <= currentPlayerSeconds ? idx : bestIdx,
          0,
        )
      : -1;

  return (
    <>
      <div 
        className="modal-tab-bar"
        style={{
          display: 'flex',
          gap: 4,
          padding: '4px',
          background: 'var(--bg-hover)',
          borderRadius: 12,
          marginBottom: 12
        }}
      >
        {panelButtons.map((panel) => {
          const active = activePanel === panel.key;
          return (
            <button
              key={panel.key}
              type="button"
              className={`modal-tab-btn ${active ? 'active' : ''}`}
              onClick={() => setActivePanel(panel.key)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 0',
                borderRadius: 9,
                background: active ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                boxShadow: active ? 'var(--shadow-sm)' : 'none',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                cursor: 'pointer'
              }}
            >
              <span className="modal-tab-icon" style={{ fontSize: 18 }}>{panel.icon}</span>
              <span style={{ fontSize: 11, fontWeight: active ? 700 : 500 }}>{panel.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={async () => {
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
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '8px 12px',
            borderRadius: 9,
            background: video.research?.is_favorited ? 'var(--accent-purple)' : 'transparent',
            border: `1px solid ${video.research?.is_favorited ? 'var(--accent-purple)' : 'transparent'}`,
            color: video.research?.is_favorited ? '#fff' : 'var(--text-muted)',
            cursor: 'pointer'
          }}
          title="研究收藏"
        >
          <span style={{ fontSize: 14 }}>🔬</span>
        </button>
      </div>

      <div
        style={{
          minWidth: 0,
          flex: 1,
          overflowY: 'auto',
          paddingRight: 4,
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
            <div>
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

              {summary?.metadata &&
                Object.keys(summary.metadata).length > 0 &&
                !viewingHistory && (
                  <div
                    style={{
                      fontSize: 11,
                      color: colors.textMuted,
                      marginTop: 16,
                      textAlign: 'right',
                      opacity: 0.95,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    {hasSummaryStats && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <div>
                          In:{' '}
                          {formatToken(summaryMetadata?.prompt_tokens)}{' '}
                          tokens &nbsp;Out:{' '}
                          {formatToken(
                            summaryMetadata?.completion_tokens,
                          )}{' '}
                          tokens
                        </div>
                        <div>
                          {ttft !== null && (
                            <>
                              <span>
                                TTFT: {formatMetricNumber(ttft)} s
                              </span>
                            </>
                          )}
                          {outputTps !== null && (
                            <>
                              <span>
                                &nbsp;TPS: {formatMetricNumber(outputTps)}{' '}
                                tok/s
                              </span>
                            </>
                          )}
                          {totalTime !== null && (
                            <>
                              <span>
                                &nbsp;Total Time:{' '}
                                {formatMetricNumber(totalTime)} s
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    <div>
                      ✨ 生成于{' '}
                      {summaryMetadata?.generated_at
                        ? new Date(
                            summaryMetadata.generated_at,
                          ).toLocaleString()
                        : '未知时间'}
                      {summaryMetadata?.generated_model_name ||
                      summaryMetadata?.model_name
                        ? `，使用 ${summaryMetadata.generated_model_name || summaryMetadata.model_name}`
                        : ''}
                    </div>
                  </div>
                )}

              {!summaryGenerating && (
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: `1px solid ${colors.border}`,
                  }}
                >
                  <button
                    onClick={() => handleGenerateSummary(true)}
                    style={{
                      background: 'var(--bg-hover)',
                      border: `1px solid ${colors.border}`,
                      borderRadius: 6,
                      color: colors.textStrong,
                      cursor: 'pointer',
                      fontSize: 12,
                      padding: '6px 12px',
                    }}
                  >
                    重新生成
                  </button>

                  {models.length > 0 && (
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      style={{
                        background: colors.inputBg,
                        color: colors.textStrong,
                        border: `1px solid ${colors.borderStrong}`,
                        borderRadius: 4,
                        fontSize: 12,
                        padding: '4px 8px',
                      }}
                    >
                      <option value="">使用默认模型</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>
                  )}

                  {summary.previous?.markdown && (
                    <button
                      onClick={() => setViewingHistory(!viewingHistory)}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${colors.border}`,
                        borderRadius: 6,
                        color: colors.textMuted,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '6px 12px',
                        marginLeft: 'auto',
                      }}
                    >
                      {viewingHistory
                        ? '查看最新版本'
                        : '查看上一版 (.prev)'}
                    </button>
                  )}
                </div>
              )}
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
            <>
              <div
                style={{
                  color: colors.textMuted,
                  fontSize: 12,
                  marginBottom: 12,
                }}
              >
                {subtitle.language || 'unknown'} ·{' '}
                {subtitle.format || 'txt'}
                {subtitleSegments.length > 0
                  ? ` · ${subtitleSegments.length} 段`
                  : ''}
                {subtitleSourceLabel ? ` · ${subtitleSourceLabel}` : ''}
              </div>
              {(subtitleMetadata &&
                Object.keys(subtitleMetadata).length > 0) ||
              subtitle?.sourceMethod ? (
                <div
                  style={{
                    color: colors.textFaint,
                    fontSize: 11,
                    marginBottom: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div>
                    {subtitleGeneratedAt
                      ? `生成于 ${new Date(subtitleGeneratedAt).toLocaleString()}`
                      : '已写入字幕缓存'}
                    {subtitleGeneratedModelName
                      ? `，使用 ${subtitleGeneratedModelName}`
                      : ''}
                  </div>
                  <div>
                    {subtitleTriggerSource
                      ? `触发方式：${subtitleTriggerSource === 'manual-subtitle' ? '手动 API 提取' : subtitleTriggerSource}`
                      : '触发方式：常规抓取'}
                    {subtitle?.segmentStyle
                      ? `，分段：${subtitle.segmentStyle === 'coarse' ? '粗粒度' : '细粒度'}`
                      : ''}
                    {subtitleTotalTokens !== null
                      ? `，总 Token：${Math.round(subtitleTotalTokens)}`
                      : ''}
                  </div>
                </div>
              ) : null}
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
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: `1px solid ${colors.border}`,
                }}
              >
                <button
                  onClick={() => void handleExtractSubtitleViaApi(true)}
                  disabled={subtitleApiExtracting || subtitleRetrying}
                  style={{
                    background: 'var(--bg-hover)',
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    color: colors.textStrong,
                    cursor:
                      subtitleApiExtracting || subtitleRetrying
                        ? 'progress'
                        : 'pointer',
                    fontSize: 12,
                    padding: '6px 12px',
                  }}
                >
                  {subtitleApiExtracting ? '重新生成中...' : '重新生成'}
                </button>
                <div
                  style={{ color: colors.textFaint, fontSize: 11 }}
                >
                  重新生成会覆盖当前字幕缓存，并继续通过 SSE 更新状态。
                </div>
              </div>
            </>
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
                <button
                  type="button"
                  onClick={() => void handleExtractSubtitleViaApi()}
                  disabled={subtitleRetrying || subtitleApiExtracting}
                  style={{
                    background: colors.accentSoft,
                    border: `1px solid ${colors.accentBorder}`,
                    borderRadius: 8,
                    color: colors.accent,
                    cursor:
                      subtitleRetrying || subtitleApiExtracting
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
                API 提取会调用当前 AI 模型并使用设置页中的字幕提示词模板。
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

        {activePanel === 'chat' && (
          <ChatPanel
            video={video}
            subtitleSegments={subtitleSegments}
            onTimestampClick={onTimestampClick}
            currentPlayerSeconds={currentPlayerSeconds}
            playerDuration={playerDuration}
          />
        )}
      </div>

      {researchModalState && (
        <ResearchFavoriteModal
          video={video}
          mode={researchModalState.mode}
          existingFavorite={researchModalState.existingFavorite}
          onClose={() => setResearchModalState(null)}
          onSuccess={() => {
            setResearchModalState(null);
            window.dispatchEvent(new CustomEvent('video-mutated', { detail: video.id })); 
          }}
        />
      )}
    </>
  );
}
