import { NextResponse } from 'next/server';
import { getCrawlerRuntimeStatus } from '@/lib/crawler-status';
import { getAutoPipelineStatus } from '@/lib/auto-pipeline';
import { appEvents } from '@/lib/events';
import type {
  SummaryStartEvent,
  SummaryProgressEvent,
  SummaryCompleteEvent,
  SummaryErrorEvent,
  CrawlerStatusChangedEvent,
  LogEntryEvent,
} from '@/lib/events';
import {
  getSummaryTaskStats,
  syncExternalCompletions,
} from '@/lib/summary-tasks';
import { getQueueState } from '@/lib/summary-queue';
import { ensureScheduler, getSchedulerStatus } from '@/lib/scheduler';
import type { VideoWithMeta } from '@/types';
import type { PoolStatus } from '@/lib/async-pool';

export const dynamic = 'force-dynamic';

// video:enriched event payload
interface VideoEnrichedEvent {
  videoDbId: number;
  videoId: string;
  platform: string;
  channelId: string;
  channelName: string;
  fields: {
    thumbnail_url: string | null;
    published_at: string | null;
    duration: string | null;
    is_members_only?: number;
    access_status?: 'members_only' | 'limited_free' | null;
    availability_status?: 'unavailable' | 'abandoned' | null;
    availability_reason?: string | null;
    availability_checked_at?: string | null;
  };
}

interface VideoAvailabilityChangedEvent {
  videoDbId: number;
  videoId: string;
  platform: string;
  status: 'unavailable' | 'abandoned' | null;
  reason?: string | null;
}

export async function GET() {
  ensureScheduler();
  const encoder = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let previousStatus = '';
  let previousPipelineStatus = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const send = (event: string, data: unknown) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      cleanup();
    }
  };

  const onSummaryStart = (data: SummaryStartEvent) =>
    send('summary-start', data);
  const onSummaryProgress = (data: SummaryProgressEvent) =>
    send('summary-progress', data);
  const onSummaryComplete = (data: SummaryCompleteEvent) =>
    send('summary-complete', data);
  const onSummaryError = (data: SummaryErrorEvent) =>
    send('summary-error', data);
  const onVideoNewSkeleton = (data: VideoWithMeta) => send('video-new', data);
  const onSubtitleStatusChanged = (data: {
    videoId: string;
    platform: string;
    status: string;
    error?: string | null;
    cooldownUntil?: string | null;
  }) => send('subtitle-status', data);
  const onVideoEnriched = (data: VideoEnrichedEvent) =>
    send('video-enriched', data);
  const onVideoAvailabilityChanged = (data: VideoAvailabilityChangedEvent) => {
    send('video-availability', data);
    send('videos-updated', {
      reason: 'video-availability-changed',
      videoId: data.videoId,
      platform: data.platform,
      timestamp: new Date().toISOString(),
    });
  };
  const onPoolStatusChanged = (data: PoolStatus) => send('pool-status', data);
  const onCrawlerStatusChanged = (data: CrawlerStatusChangedEvent) => {
    const current = {
      ...data,
      scheduler: getSchedulerStatus(),
    };
    const serialized = JSON.stringify(current);
    if (serialized === previousStatus) return;
    send('crawler-status', current);
    previousStatus = serialized;
  };
  const onLogEntry = (data: LogEntryEvent) => send('log-entry', data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAgentStart = (data: any) => send('agent-start', data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAgentComplete = (data: any) => send('agent-complete', data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onAgentError = (data: any) => send('agent-error', data);

  const cleanup = () => {
    closed = true;
    controller = null;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    // Remove summary event listeners
    appEvents.removeListener('summary:start', onSummaryStart);
    appEvents.removeListener('summary:progress', onSummaryProgress);
    appEvents.removeListener('summary:complete', onSummaryComplete);
    appEvents.removeListener('summary:error', onSummaryError);
    // Remove realtime video push event listeners
    appEvents.removeListener('video:new-skeleton', onVideoNewSkeleton);
    appEvents.removeListener('subtitle:status-changed', onSubtitleStatusChanged);
    appEvents.removeListener('video:enriched', onVideoEnriched);
    appEvents.removeListener(
      'video:availability-changed',
      onVideoAvailabilityChanged,
    );
    // Remove pool event listeners
    appEvents.removeListener('pool:status-changed', onPoolStatusChanged);
    appEvents.removeListener('crawler:status-changed', onCrawlerStatusChanged);
    appEvents.removeListener('log:entry', onLogEntry);
    appEvents.removeListener('agent:start', onAgentStart);
    appEvents.removeListener('agent:complete', onAgentComplete);
    appEvents.removeListener('agent:error', onAgentError);
  };

  appEvents.on('summary:start', onSummaryStart);
  appEvents.on('summary:progress', onSummaryProgress);
  appEvents.on('summary:complete', onSummaryComplete);
  appEvents.on('summary:error', onSummaryError);
  appEvents.on('video:new-skeleton', onVideoNewSkeleton);
  appEvents.on('subtitle:status-changed', onSubtitleStatusChanged);
  appEvents.on('video:enriched', onVideoEnriched);
  appEvents.on('video:availability-changed', onVideoAvailabilityChanged);
  appEvents.on('pool:status-changed', onPoolStatusChanged);
  appEvents.on('crawler:status-changed', onCrawlerStatusChanged);
  appEvents.on('log:entry', onLogEntry);
  appEvents.on('agent:start', onAgentStart);
  appEvents.on('agent:complete', onAgentComplete);
  appEvents.on('agent:error', onAgentError);

  const stream = new ReadableStream({
    async start(streamController) {
      controller = streamController;

      // Send initial status immediately
      const initial = {
        ...getCrawlerRuntimeStatus(),
        scheduler: getSchedulerStatus(),
      };
      previousStatus = JSON.stringify(initial);
      send('crawler-status', initial);

      // Send initial summary stats
      let previousSummaryStats = '';
      const sendSummaryStats = () => {
        const stats = getSummaryTaskStats();
        const queue = getQueueState();
        const payload = { stats, queue };
        const serialized = JSON.stringify(payload);
        if (serialized !== previousSummaryStats) {
          send('summary-stats', payload);
          previousSummaryStats = serialized;
        }
      };
      sendSummaryStats();

      // Send initial pipeline status
      const initialPipeline = getAutoPipelineStatus();
      previousPipelineStatus = JSON.stringify(initialPipeline);
      send('pipeline-status', initialPipeline);

      const tick = () => {
        if (closed) return;
        try {
          const synced = syncExternalCompletions();
          if (synced > 0) {
            previousSummaryStats = '';
            send('videos-updated', {
              reason: 'external-summary-sync',
              count: synced,
              timestamp: new Date().toISOString(),
            });
          }

          const current = {
            ...getCrawlerRuntimeStatus(),
            scheduler: getSchedulerStatus(),
          };
          const serialized = JSON.stringify(current);
          const oldPreviousStatus = previousStatus;

          if (serialized !== oldPreviousStatus) {
            const prev = oldPreviousStatus
              ? JSON.parse(oldPreviousStatus)
              : null;
            send('crawler-status', current);
            const prevFeedState = prev?.feed?.state;
            const curFeedState = current.feed.state;

            if (prevFeedState === 'running' && curFeedState !== 'running') {
              send('videos-updated', { timestamp: new Date().toISOString() });
            }

            previousStatus = serialized;
          }

          // Pipeline status update
          const pipelineStatus = getAutoPipelineStatus();
          const pipelineSerialized = JSON.stringify(pipelineStatus);
          if (pipelineSerialized !== previousPipelineStatus) {
            send('pipeline-status', pipelineStatus);
            previousPipelineStatus = pipelineSerialized;
          }

          sendSummaryStats();
        } catch {
          // ignore
        }
      };

      // Poll at different rates based on activity
      interval = setInterval(() => {
        if (closed) {
          if (interval) clearInterval(interval);
          return;
        }
        tick();
      }, 2000);

      // Heartbeat to keep connection alive
      heartbeat = setInterval(() => {
        if (closed) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try {
          streamController.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          cleanup();
        }
      }, 15000);
    },
    cancel() {
      cleanup();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
