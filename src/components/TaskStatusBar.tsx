'use client';

import type {
  AutoPipelineStatus,
  CrawlerRuntimeStatus,
  SchedulerStatus,
  SummaryQueueState,
  VideoWithMeta,
} from '@/types';
import type { SummaryProgressEvent } from '@/lib/events';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildVideoUrl } from '@/lib/url-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return '从未';
  const diffMs = Date.now() - Date.parse(isoString);
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  return `${Math.floor(diffMs / 86_400_000)} 天前`;
}

function formatNextRun(nextRunAt: string | null | undefined): string | null {
  if (!nextRunAt) return null;
  const timestamp = Date.parse(nextRunAt);
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = timestamp - Date.now();
  if (diffMs > 0 && diffMs < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(diffMs / (60 * 1000)));
    return `${minutes} 分钟后`;
  }
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SUBTITLE_PLATFORM_META = [
  { id: 'youtube' as const, shortLabel: 'YT', label: 'YouTube' },
  { id: 'bilibili' as const, shortLabel: 'B', label: 'Bilibili' },
];

function formatSubtitlePlatformThrottle(
  platform: (typeof SUBTITLE_PLATFORM_META)[number],
  state:
    | AutoPipelineStatus['subtitle']['throttle']['platforms']['youtube']
    | AutoPipelineStatus['subtitle']['throttle']['platforms']['bilibili']
    | undefined,
  variant: 'short' | 'long',
): string {
  const name = variant === 'short' ? platform.shortLabel : platform.label;
  if (!state || state.state === 'clear') return `${name} 通畅`;
  if (state.state === 'exhausted') return `${name} 封顶`;
  return `${name} ×${state.multiplier}`;
}

function getSubtitleThrottleSummary(
  throttle: AutoPipelineStatus['subtitle']['throttle'] | null | undefined,
  variant: 'short' | 'long',
): string {
  if (!throttle?.platforms) {
    return variant === 'short' ? 'YT/B 通畅' : 'YouTube 通畅 · Bilibili 通畅';
  }

  return SUBTITLE_PLATFORM_META.map((platform) =>
    formatSubtitlePlatformThrottle(
      platform,
      throttle.platforms[platform.id],
      variant,
    ),
  ).join(' · ');
}

function getSubtitleThrottleDisplay(
  throttle: AutoPipelineStatus['subtitle']['throttle'] | null | undefined,
): {
  compactText: string;
  panelText: string;
  platformText: string;
  color: string;
} {
  const compactSummary = getSubtitleThrottleSummary(throttle, 'short');
  const platformSummary = getSubtitleThrottleSummary(throttle, 'long');

  if (!throttle || throttle.state === 'clear') {
    return {
      compactText: compactSummary,
      panelText: '空闲',
      platformText: platformSummary,
      color: 'var(--status-ok)',
    };
  }

  if (throttle.state === 'exhausted') {
    const exhaustedText =
      throttle.exhaustedCount > 0 ? ` · ${throttle.exhaustedCount} 条失败` : '';
    const platformLabel =
      throttle.platform === 'youtube'
        ? 'YouTube · '
        : throttle.platform === 'bilibili'
          ? 'Bilibili · '
          : '';
    return {
      compactText: compactSummary,
      panelText: `${platformLabel}已达最大重试${exhaustedText}`,
      platformText: platformSummary,
      color: 'var(--accent-yt)',
    };
  }

  const platformLabel =
    throttle.platform === 'youtube'
      ? 'YouTube · '
      : throttle.platform === 'bilibili'
        ? 'Bilibili · '
        : '';
  return {
    compactText: compactSummary,
    panelText: `${platformLabel}退避状态 · ×${throttle.multiplier} · ${throttle.consecutiveErrors} 次限流`,
    platformText: platformSummary,
    color: 'var(--status-warn)',
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CompactRow({
  crawlerStatus,
  pipelineStatus,
  schedulerStatus,
  summaryQueueState,
  lastRefreshAt,
  refreshing,
  onRefresh,
  onTogglePause,
  pausePending,
  onExpandToggle,
}: {
  crawlerStatus: CrawlerRuntimeStatus | null;
  pipelineStatus: AutoPipelineStatus | null;
  schedulerStatus: SchedulerStatus | null;
  summaryQueueState: SummaryQueueState | null;
  lastRefreshAt: string | null | undefined;
  refreshing: boolean;
  onRefresh: () => void;
  onTogglePause: () => void;
  pausePending: boolean;
  onExpandToggle: () => void;
}) {
  // Crawl section
  const crawlState = crawlerStatus?.feed?.state || 'idle';
  const crawlProgress = crawlerStatus?.feed?.progress;
  const crawlTotal = crawlerStatus?.feed?.total;
  const crawlTargetLabel = crawlerStatus?.feed?.targetLabel?.trim() || null;
  const relativeTime = lastRefreshAt ? formatRelativeTime(lastRefreshAt) : null;
  const crawlColor =
    crawlState === 'running'
      ? 'var(--accent-bili)'
      : crawlState === 'error'
        ? 'var(--accent-yt)'
        : 'var(--text-muted)';
  const crawlText =
    crawlState === 'idle'
      ? relativeTime
        ? relativeTime
        : '未刷新'
      : crawlState === 'running' && crawlProgress !== undefined && crawlTotal
        ? `爬取中 ${crawlProgress}/${crawlTotal}`
        : crawlState === 'error'
          ? '错误'
          : crawlState === 'cooldown'
            ? '冷却中'
            : '未刷新';

  // Subtitle section
  const subQueue = pipelineStatus?.subtitle?.queueLength ?? 0;
  const subProcessing = pipelineStatus?.subtitle?.processing ?? false;
  const subWaitingCount = Math.max(0, subQueue - (subProcessing ? 1 : 0));
  const subCooling =
    subProcessing && Boolean(pipelineStatus?.subtitle?.nextRunAt);
  const subCurrentTitle =
    pipelineStatus?.subtitle?.currentVideoTitle?.trim() || null;
  const subtitleThrottle = getSubtitleThrottleDisplay(
    pipelineStatus?.subtitle?.throttle,
  );
  const subText = subCooling
    ? `${subWaitingCount > 0 ? `${subWaitingCount} 等待 · ` : ''}冷却中`
    : subProcessing
      ? `${subWaitingCount > 0 ? `${subWaitingCount} 等待 · ` : ''}处理中`
    : subQueue > 0
      ? `${subQueue}待处理`
      : subtitleThrottle.compactText;
  const subColor = subProcessing
    ? 'var(--accent-bili)'
    : subQueue > 0
      ? 'var(--status-warn)'
      : subtitleThrottle.color;

  // YT & Bili Throttle status overrides for mobile
  const ytThrottle = pipelineStatus?.subtitle?.throttle?.platforms?.youtube;
  const ytColor = !ytThrottle || ytThrottle.state === 'clear' ? 'var(--status-ok)' : ytThrottle.state === 'exhausted' ? 'var(--accent-yt)' : 'var(--status-warn)';

  const biliThrottle = pipelineStatus?.subtitle?.throttle?.platforms?.bilibili;
  const biliColor = !biliThrottle || biliThrottle.state === 'clear' ? 'var(--status-ok)' : biliThrottle.state === 'exhausted' ? 'var(--accent-yt)' : 'var(--status-warn)';

  // Summary section
  const sumQueue = pipelineStatus?.summary?.queueLength ?? 0;
  const sumProcessing = pipelineStatus?.summary?.processing ?? false;
  const sumCurrentTitle = summaryQueueState?.currentTitle?.trim() || null;
  const sumText = sumProcessing
    ? '处理中'
    : sumQueue > 0
      ? `${sumQueue} 待处理`
      : '空闲';
  const sumColor = sumProcessing
    ? 'var(--accent-bili)'
    : sumQueue > 0
      ? 'var(--status-warn)'
      : 'var(--text-muted)';

  const pauseButtonLabel = pausePending
    ? '处理中...'
    : crawlerStatus?.paused
      ? '继续'
      : '暂停';
  const pauseButtonTitle = crawlerStatus?.paused
    ? '继续后台任务'
    : '暂停后台任务';

  const isDisconnected = !crawlerStatus;
  const isGlobalPaused = crawlerStatus?.paused;
  const isCrawlerEnabled = schedulerStatus?.running ?? true; // Default to true if not provided

  const crawlDot = isDisconnected || !isCrawlerEnabled
    ? { color: 'var(--accent-yt)', pulse: false }
    : crawlState === 'running'
      ? { color: 'var(--status-ok)', pulse: true }
      : (crawlState === 'cooldown' || crawlState === 'error')
        ? { color: 'var(--status-warn)', pulse: false }
        : { color: 'var(--text-muted)', pulse: false };

  const subDot = isDisconnected || isGlobalPaused
    ? { color: 'var(--accent-yt)', pulse: false }
    : (subProcessing && !subCooling)
      ? { color: 'var(--status-ok)', pulse: true }
      : (subQueue > 0 || subCooling || (pipelineStatus?.subtitle?.throttle?.state && pipelineStatus.subtitle.throttle.state !== 'clear'))
        ? { color: 'var(--status-warn)', pulse: false }
        : { color: 'var(--text-muted)', pulse: false };

  const sumDot = isDisconnected || isGlobalPaused
    ? { color: 'var(--accent-yt)', pulse: false }
    : sumProcessing
      ? { color: 'var(--status-ok)', pulse: true }
      : sumQueue > 0
        ? { color: 'var(--status-warn)', pulse: false }
        : { color: 'var(--text-muted)', pulse: false };

  return (
    <div className="task-status-bar-compact-row">
      <div className="pc-compact-view">
        <button
          type="button"
          className="compact-row-expand-btn"
          onClick={onExpandToggle}
          title="展开详情"
          aria-label="展开任务面板"
        >
          {/* Crawl */}
          <div className="compact-section">
            <span className="compact-icon">🔄</span>
            <span
              className="compact-label"
              style={{ color: crawlDot.color, fontWeight: 600 }}
            >
              <span
                className={`status-pulse ${crawlDot.pulse ? '' : 'paused'}`}
                style={{
                  background: crawlDot.color,
                  width: 6,
                  height: 6,
                  margin: 0,
                  display: 'inline-block',
                  marginRight: 4,
                }}
              />
              {crawlText}
            </span>
            {crawlState === 'running' && crawlTargetLabel && (
              <span
                className="compact-label"
                title={crawlTargetLabel}
                style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  opacity: 0.75,
                }}
              >
                {crawlTargetLabel}
              </span>
            )}
            <button
              type="button"
              className="crawler-pause-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
              title={refreshing ? '取消刷新' : '刷新当前'}
              style={{ marginLeft: 4, minWidth: 40, paddingInline: 10 }}
            >
              {refreshing ? '停' : '↻'}
            </button>
          </div>

          <div className="compact-divider" />

          {/* Subtitle */}
          <div className="compact-section">
            <span className="compact-icon">💬</span>
            <span
              className="compact-label"
              style={{ color: subDot.color, fontWeight: 600 }}
            >
              <span
                className={`status-pulse ${subDot.pulse ? '' : 'paused'}`}
                style={{
                  background: subDot.color,
                  width: 6,
                  height: 6,
                  margin: 0,
                  display: 'inline-block',
                  marginRight: 4,
                }}
              />
              {subText}
            </span>
            {subProcessing && subCurrentTitle && (
              <span
                className="compact-label"
                title={subCurrentTitle}
                style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  opacity: 0.75,
                }}
              >
                {subCurrentTitle}
              </span>
            )}
          </div>

          <div className="compact-divider" />

          {/* Summary */}
          <div className="compact-section">
            <span className="compact-icon">📝</span>
            <span
              className="compact-label"
              style={{ color: sumDot.color, fontWeight: 600 }}
            >
              <span
                className={`status-pulse ${sumDot.pulse ? '' : 'paused'}`}
                style={{
                  background: sumDot.color,
                  width: 6,
                  height: 6,
                  margin: 0,
                  display: 'inline-block',
                  marginRight: 4,
                }}
              />
              {sumText}
            </span>
            {sumProcessing && sumCurrentTitle && (
              <span
                className="compact-label"
                title={sumCurrentTitle}
                style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  opacity: 0.75,
                }}
              >
                {sumCurrentTitle}
              </span>
            )}
          </div>
        </button>

        <div className="compact-actions">
          <button
            type="button"
            className={`crawler-pause-btn ${crawlerStatus?.paused ? 'paused' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePause();
            }}
            disabled={pausePending}
            title={pauseButtonTitle}
          >
            {pauseButtonLabel}
          </button>
          <button
            type="button"
            className="expand-btn"
            onClick={onExpandToggle}
            title="展开详情"
            aria-label="展开"
          >
            ▾
          </button>
        </div>
      </div>

      <div className="mobile-compact-view">
        <button
          type="button"
          className="compact-row-expand-btn"
          onClick={onExpandToggle}
          title="展开详情"
          aria-label="展开任务"
        >
          {/* Crawl */}
          <div className="compact-section mobile-sec">
            <span className="compact-icon">🔄</span>
            <span className={`status-pulse ${crawlDot.pulse ? '' : 'paused'}`} style={{ background: crawlDot.color, width: 6, height: 6, display: 'inline-block', marginBottom: 1 }} />
            {crawlState === 'running' && crawlProgress !== undefined && crawlTotal ? (
               <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                 {crawlProgress}/{crawlTotal}
               </span>
            ) : null}
          </div>

          <div className="compact-divider" />

          {/* Subtitle */}
          <div className="compact-section mobile-sec">
            <span className="compact-icon">💬</span>
            <span 
              className={`status-pulse ${subDot.pulse ? '' : 'paused'}`} 
              style={{ background: subDot.color, width: 6, height: 6, display: 'inline-block', marginBottom: 1 }} 
            />
            <span style={{ color: ytColor, fontWeight: 700, fontSize: 12, marginLeft: 1 }}>▶</span>
            <span style={{ color: biliColor, fontWeight: 700, fontSize: 12 }}>🅱</span>
          </div>

          <div className="compact-divider" />

          {/* Summary */}
          <div className="compact-section mobile-sec">
            <span className="compact-icon">📝</span>
            <span className={`status-pulse ${sumDot.pulse ? '' : 'paused'}`} style={{ background: sumDot.color, width: 6, height: 6, display: 'inline-block', marginBottom: 1 }} />
          </div>
        </button>

      </div>
    </div>
  );
}

function CrawlSection({
  crawlerStatus,
  schedulerStatus,
  lastRefreshAt,
  channelPreview,
  onOpenChannelList,
}: {
  crawlerStatus: CrawlerRuntimeStatus | null;
  schedulerStatus: SchedulerStatus | null;
  lastRefreshAt: string | null | undefined;
  channelPreview: {
    id: number;
    name: string;
    avatar_url: string | null;
    channel_id: string;
    platform: 'youtube' | 'bilibili';
  } | null;
  onOpenChannelList: () => void;
}) {
  const nextCrawl = schedulerStatus?.nextCrawl;
  const todayVideos = schedulerStatus?.todayStats?.videos ?? 0;
  const crawlProgress = crawlerStatus?.feed?.progress;
  const crawlTotal = crawlerStatus?.feed?.total;
  const showProgress =
    crawlerStatus?.feed?.state === 'running' &&
    crawlProgress !== undefined &&
    Boolean(crawlTotal);

  return (
    <div className="task-panel-section">
      <div className="section-header">
        <span>📡</span>
        <span>爬取</span>
        {lastRefreshAt && (
          <span className="section-meta">
            {formatRelativeTime(lastRefreshAt)}
          </span>
        )}
      </div>
      <div className="section-body">
        <div className="section-row">
          <span className="section-row-label">下次爬取：</span>
          <span className="section-row-value">
            {nextCrawl ? (formatNextRun(nextCrawl) ?? nextCrawl) : '—'}
          </span>
        </div>
        <div className="section-row">
          <span className="section-row-label">今日新增：</span>
          <span className="section-row-value">{todayVideos} 个视频</span>
        </div>
        {showProgress && (
          <div className="section-row">
            <span className="section-row-label">抓取进度：</span>
            <span className="section-row-value">
              {crawlProgress}/{crawlTotal}
            </span>
          </div>
        )}
        {crawlerStatus?.feed?.targetLabel && (
          <div className="section-row">
            <span className="section-row-label">当前频道：</span>
            {channelPreview ? (
              <button
                type="button"
                className="section-row-value section-video-preview"
                onClick={onOpenChannelList}
                title="点击进入频道视频列表"
              >
                <span className="section-avatar">
                  {channelPreview.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={channelPreview.avatar_url}
                      alt={channelPreview.name}
                      className="section-avatar-image"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="section-avatar-fallback">
                      {channelPreview.platform === 'youtube' ? '▶' : '🅱'}
                    </span>
                  )}
                </span>
                <span className="section-preview-text">
                  {channelPreview.name}
                </span>
              </button>
            ) : (
              <span className="section-row-value">
                {crawlerStatus.feed.targetLabel}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SubtitleSection({
  pipelineStatus,
  preview,
  onOpenPreview,
  onClearQueue,
  clearPending,
}: {
  pipelineStatus: AutoPipelineStatus | null;
  preview: VideoWithMeta | null;
  onOpenPreview: () => void;
  onClearQueue: () => void;
  clearPending: boolean;
}) {
  const queueLength = pipelineStatus?.subtitle?.queueLength ?? 0;
  const videoCount = pipelineStatus?.subtitle?.videoCount ?? 0;
  const processing = pipelineStatus?.subtitle?.processing ?? false;
  const waitingCount = Math.max(0, queueLength - (processing ? 1 : 0));
  const currentVideoId = pipelineStatus?.subtitle?.currentVideoId ?? null;
  const currentVideoTitle = pipelineStatus?.subtitle?.currentVideoTitle ?? null;
  const currentBatchLabel =
    pipelineStatus?.subtitle?.currentBatchLabel?.trim() || null;
  const currentBatchVideoCount =
    pipelineStatus?.subtitle?.currentBatchVideoCount ?? 0;
  const nextRunAt = pipelineStatus?.subtitle?.nextRunAt ?? null;
  const stats = pipelineStatus?.subtitle?.stats;
  const subtitleThrottle = getSubtitleThrottleDisplay(
    pipelineStatus?.subtitle?.throttle,
  );
  const cooling = processing && Boolean(nextRunAt);
  const statusColor =
    processing || queueLength > 0 ? undefined : subtitleThrottle.color;
  const nextRunText = cooling
    ? (formatNextRun(nextRunAt) ?? '—')
    : processing
      ? '进行中'
    : nextRunAt
      ? (formatNextRun(nextRunAt) ?? '—')
      : '可立即开始';
  const statusText = cooling
    ? `冷却中${waitingCount > 0 ? ` · ${waitingCount} 个作业等待中` : ''}`
    : processing
      ? `处理中${waitingCount > 0 ? ` · ${waitingCount} 个作业等待中` : ''}`
    : queueLength > 0
      ? `${queueLength} 个作业待处理`
      : '空闲';
  const statusTextColor =
    processing || queueLength > 0 ? statusColor : 'var(--text-muted)';

  return (
    <div className="task-panel-section">
      <div className="section-header">
        <span>💬</span>
        <span>字幕队列</span>
        {stats && (
          <span className="section-meta">
            {stats.completed} 完成 / {stats.failed} 失败
          </span>
        )}
      </div>
      <div className="section-body">
        <div className="section-row">
          <span className="section-row-label">状态：</span>
          <span
            className="section-row-value"
            style={statusTextColor ? { color: statusTextColor } : undefined}
          >
            {statusText}
          </span>
        </div>
        <div className="section-row">
          <span className="section-row-label">平台退避：</span>
          <span
            className="section-row-value"
            style={statusColor ? { color: statusColor } : undefined}
          >
            {subtitleThrottle.platformText}
          </span>
        </div>
        <div className="section-row">
          <span className="section-row-label">下次爬取：</span>
          <span className="section-row-value">{nextRunText}</span>
        </div>
        {videoCount > 0 && (
          <div className="section-row">
            <span className="section-row-label">待抓视频：</span>
            <span className="section-row-value">{videoCount} 个</span>
          </div>
        )}
        {currentBatchLabel && currentBatchVideoCount > 1 ? (
          <div className="section-row">
            <span className="section-row-label">当前作业：</span>
            <span className="section-row-value">
              {currentBatchLabel} · {currentBatchVideoCount} 个视频
            </span>
          </div>
        ) : null}
        {currentVideoTitle || currentVideoId ? (
          <div className="section-row">
            <span className="section-row-label">正在处理：</span>
            <button
              type="button"
              className="section-row-value section-video-preview"
              onClick={onOpenPreview}
              title="点击打开视频"
            >
              <span className="section-preview-thumb">
                {preview?.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview.thumbnail_url}
                    alt={preview.title}
                    className="section-preview-thumb-image"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="section-preview-thumb-fallback">💬</span>
                )}
              </span>
              <span
                className="section-preview-text"
                title={currentVideoTitle || currentVideoId || undefined}
              >
                {currentVideoTitle || preview?.title || currentVideoId}
              </span>
            </button>
          </div>
        ) : null}
        {stats && (
          <div className="section-row">
            <span className="section-row-label">今日完成：</span>
            <span className="section-row-value">{stats.completed} 条</span>
          </div>
        )}
        <div className="section-actions">
          <button
            type="button"
            className="crawler-pause-btn"
            onClick={onClearQueue}
            disabled={clearPending || queueLength === 0}
            title="清除尚未开始处理的字幕任务"
          >
            {clearPending ? '清除中...' : '清除队列'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummarySection({
  pipelineStatus,
  summaryQueueState,
  summaryProgress,
  preview,
  onOpenPreview,
  onClearQueue,
  clearPending,
}: {
  pipelineStatus: AutoPipelineStatus | null;
  summaryQueueState: SummaryQueueState | null;
  summaryProgress: SummaryProgressEvent | null;
  preview: VideoWithMeta | null;
  onOpenPreview: () => void;
  onClearQueue: () => void;
  clearPending: boolean;
}) {
  const queueLength = pipelineStatus?.summary?.queueLength ?? 0;
  const processing = pipelineStatus?.summary?.processing ?? false;
  const currentTitle = summaryQueueState?.currentTitle;
  const receivedChars = summaryProgress?.receivedChars;
  const modelName = summaryProgress?.modelName;

  return (
    <div className="task-panel-section">
      <div className="section-header">
        <span>📝</span>
        <span>总结队列</span>
        <span className="section-meta">
          {processing
            ? '处理中'
            : queueLength > 0
              ? `${queueLength} 待处理`
              : '空闲'}
        </span>
      </div>
      <div className="section-body">
        {currentTitle ? (
          <div className="section-row">
            <span className="section-row-label">正在处理：</span>
            <button
              type="button"
              className="section-row-value section-video-preview"
              onClick={onOpenPreview}
              title="点击打开视频"
            >
              <span className="section-preview-thumb">
                {preview?.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview.thumbnail_url}
                    alt={preview.title}
                    className="section-preview-thumb-image"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="section-preview-thumb-fallback">📝</span>
                )}
              </span>
              <span
                className="section-preview-text"
                title={currentTitle || undefined}
              >
                {preview?.title || currentTitle}
              </span>
            </button>
          </div>
        ) : processing ? (
          <div className="section-row">
            <span className="section-row-label">正在处理：</span>
            <span className="section-row-value">—</span>
          </div>
        ) : null}
        {modelName && (
          <div className="section-row">
            <span className="section-row-label">模型：</span>
            <span className="section-row-value">
              {modelName}
              {receivedChars !== undefined && (
                <span className="section-row-muted">
                  {' '}
                  · 已接收 {formatNumber(receivedChars)} 字
                </span>
              )}
            </span>
          </div>
        )}
        {queueLength > 0 && (
          <div className="section-row">
            <span className="section-row-label">待处理：</span>
            <span className="section-row-value">{queueLength} 个</span>
          </div>
        )}
        <div className="section-actions">
          <button
            type="button"
            className="crawler-pause-btn"
            onClick={onClearQueue}
            disabled={clearPending || (!queueLength && !processing)}
            title="清除尚未开始处理的总结任务"
          >
            {clearPending ? '清除中...' : '清除队列'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface TaskStatusBarProps {
  crawlerStatus: CrawlerRuntimeStatus | null;
  pipelineStatus: AutoPipelineStatus | null;
  schedulerStatus: SchedulerStatus | null;
  lastRefreshAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  summaryQueueState: SummaryQueueState | null;
  summaryProgress: SummaryProgressEvent | null;
  onTogglePause: () => void;
  pausePending: boolean;
  externalOpen: boolean;
  onOpenVideo: (video: VideoWithMeta) => void;
  onPipelineStatusChange?: (status: AutoPipelineStatus) => void;
  onSummaryQueueStateChange?: (state: SummaryQueueState) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export default function TaskStatusBar({
  crawlerStatus,
  pipelineStatus,
  schedulerStatus,
  lastRefreshAt,
  refreshing,
  onRefresh,
  summaryQueueState,
  summaryProgress,
  onTogglePause,
  pausePending,
  externalOpen,
  onOpenVideo,
  onPipelineStatusChange,
  onSummaryQueueStateChange,
  onToast,
}: TaskStatusBarProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [channelPreview, setChannelPreview] = useState<{
    id: number;
    name: string;
    avatar_url: string | null;
    channel_id: string;
    platform: 'youtube' | 'bilibili';
  } | null>(null);
  const [subtitlePreview, setSubtitlePreview] = useState<VideoWithMeta | null>(
    null,
  );
  const [summaryPreview, setSummaryPreview] = useState<VideoWithMeta | null>(
    null,
  );
  const [clearingQueue, setClearingQueue] = useState<
    'subtitle' | 'summary' | null
  >(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  // Close on click outside
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    // Delay to avoid closing immediately when clicking the compact bar itself
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [expanded]);

  const handleExpandToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const openVideo = useCallback(
    async (video: VideoWithMeta) => {
      if (externalOpen) {
        window.open(
          buildVideoUrl(video.platform, video.video_id),
          '_blank',
          'noopener,noreferrer',
        );
      } else {
        onOpenVideo(video);
      }

      fetch('/api/videos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: video.id, is_read: true }),
      }).catch(() => {});
    },
    [externalOpen, onOpenVideo],
  );

  const openVideoById = useCallback(
    async (videoId: string) => {
      if (!videoId) return;
      if (subtitlePreview?.video_id === videoId) {
        await openVideo(subtitlePreview);
        return;
      }
      if (summaryPreview?.video_id === videoId) {
        await openVideo(summaryPreview);
        return;
      }

      const res = await fetch(
        `/api/videos/lookup?video_id=${encodeURIComponent(videoId)}`,
        {
          cache: 'no-store',
        },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { video?: VideoWithMeta };
      if (data.video) {
        await openVideo(data.video);
      }
    },
    [openVideo, subtitlePreview, summaryPreview],
  );

  const openChannelList = useCallback(() => {
    if (!channelPreview) return;
    router.push(`/?channel_id=${channelPreview.id}`);
  }, [channelPreview, router]);

  const clearQueue = useCallback(
    async (queue: 'subtitle' | 'summary') => {
      setClearingQueue(queue);
      try {
        const res = await fetch('/api/task-queues/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queue }),
        });
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          cleared?: number;
          pipeline?: AutoPipelineStatus;
          queueState?: SummaryQueueState;
        } | null;

        if (!res.ok) {
          onToast?.(data?.error || '清除队列失败', 'error');
          return;
        }

        if (data?.pipeline) {
          onPipelineStatusChange?.(data.pipeline);
        }
        if (data?.queueState) {
          onSummaryQueueStateChange?.(data.queueState);
        }

        const cleared = data?.cleared ?? 0;
        onToast?.(
          cleared > 0
            ? `已清除 ${cleared} 个${queue === 'subtitle' ? '字幕' : '总结'}任务`
            : `没有可清除的${queue === 'subtitle' ? '字幕' : '总结'}任务`,
        );
      } finally {
        setClearingQueue((current) => (current === queue ? null : current));
      }
    },
    [onPipelineStatusChange, onSummaryQueueStateChange, onToast],
  );

  const activeChannelPreview =
    crawlerStatus?.feed?.targetId?.trim() === channelPreview?.channel_id
      ? channelPreview
      : null;
  const activeSubtitlePreview =
    pipelineStatus?.subtitle?.currentVideoId?.trim() ===
    subtitlePreview?.video_id
      ? subtitlePreview
      : null;
  const activeSummaryPreview =
    summaryQueueState?.currentVideoId?.trim() === summaryPreview?.video_id
      ? summaryPreview
      : null;

  useEffect(() => {
    const targetId = crawlerStatus?.feed?.targetId?.trim();
    const platform = crawlerStatus?.feed?.platform;
    if (!targetId || !platform) return;

    let cancelled = false;
    void fetch(
      `/api/channels?channel_id=${encodeURIComponent(targetId)}&platform=${platform}`,
      {
        cache: 'no-store',
      },
    )
      .then((res) => res.json())
      .then(
        (
          data: Array<{
            id: number;
            name: string;
            avatar_url: string | null;
            channel_id: string;
            platform: 'youtube' | 'bilibili';
          }>,
        ) => {
          if (cancelled) return;
          setChannelPreview(data[0] || null);
        },
      )
      .catch(() => {
        if (!cancelled) setChannelPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [crawlerStatus?.feed?.platform, crawlerStatus?.feed?.targetId]);

  useEffect(() => {
    const videoId = pipelineStatus?.subtitle?.currentVideoId?.trim();
    if (!videoId) return;

    let cancelled = false;
    void fetch(`/api/videos/lookup?video_id=${encodeURIComponent(videoId)}`, {
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { video?: VideoWithMeta } | null) => {
        if (cancelled) return;
        setSubtitlePreview(data?.video ?? null);
      })
      .catch(() => {
        if (!cancelled) setSubtitlePreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [pipelineStatus?.subtitle?.currentVideoId]);

  useEffect(() => {
    const videoId = summaryQueueState?.currentVideoId?.trim();
    if (!videoId) return;

    let cancelled = false;
    void fetch(`/api/videos/lookup?video_id=${encodeURIComponent(videoId)}`, {
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { video?: VideoWithMeta } | null) => {
        if (cancelled) return;
        setSummaryPreview(data?.video ?? null);
      })
      .catch(() => {
        if (!cancelled) setSummaryPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [summaryQueueState?.currentVideoId]);

  // Remove the strict null return so the bar can render a "disconnected" state gracefully for the red bubbles
  // if (!crawlerStatus) return null;

  return (
    <div ref={panelRef} className="task-status-bar">
      <CompactRow
        crawlerStatus={crawlerStatus}
        pipelineStatus={pipelineStatus}
        schedulerStatus={schedulerStatus}
        summaryQueueState={summaryQueueState}
        lastRefreshAt={lastRefreshAt}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onTogglePause={onTogglePause}
        pausePending={pausePending}
        onExpandToggle={handleExpandToggle}
      />

      <div className={`task-panel ${expanded ? 'task-panel-open' : ''}`}>
        <div className="task-panel-inner">
          <div className="mobile-only-panel-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={onRefresh}
            >
              {refreshing ? '🔄 停止刷新' : '🔄 抓取刷新'}
            </button>
            <button
              className={`btn btn-sm ${crawlerStatus?.paused ? 'btn-primary' : 'btn-danger'}`}
              onClick={onTogglePause}
              disabled={pausePending}
            >
              {pausePending ? '处理中...' : crawlerStatus?.paused ? '▶ 继续所有任务' : '⏸ 暂停后台任务'}
            </button>
          </div>
          <div className="task-panel-divider mobile-only-panel-divider" />
          <CrawlSection
            crawlerStatus={crawlerStatus}
            schedulerStatus={schedulerStatus}
            lastRefreshAt={lastRefreshAt}
            channelPreview={activeChannelPreview}
            onOpenChannelList={openChannelList}
          />
          <div className="task-panel-divider" />
          <SubtitleSection
            pipelineStatus={pipelineStatus}
            preview={activeSubtitlePreview}
            clearPending={clearingQueue === 'subtitle'}
            onClearQueue={() => {
              void clearQueue('subtitle');
            }}
            onOpenPreview={() => {
              const videoId = pipelineStatus?.subtitle?.currentVideoId;
              if (videoId) void openVideoById(videoId);
            }}
          />
          <div className="task-panel-divider" />
          <SummarySection
            pipelineStatus={pipelineStatus}
            summaryQueueState={summaryQueueState}
            summaryProgress={summaryProgress}
            preview={activeSummaryPreview}
            clearPending={clearingQueue === 'summary'}
            onClearQueue={() => {
              void clearQueue('summary');
            }}
            onOpenPreview={() => {
              const videoId = summaryQueueState?.currentVideoId;
              if (videoId) void openVideoById(videoId);
            }}
          />
        </div>
      </div>
    </div>
  );
}
