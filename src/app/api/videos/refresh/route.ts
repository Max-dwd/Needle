import { NextRequest, NextResponse } from 'next/server';
import { log, cleanupOldLogs } from '@/lib/logger';
import { getDb } from '@/lib/db';
import {
  releaseCrawlerScope,
  resetCrawlerScopeStatus,
  tryAcquireCrawlerScope,
  updateCrawlerScopeStatus,
  getCrawlerScopeOwner,
} from '@/lib/crawler-status';
import {
  getCrawlerPerformanceSummary,
  throttleCrawlerStage,
} from '@/lib/crawler-performance';
import { fetchYouTubeFeed, fetchBilibiliFeed } from '@/lib/fetcher';
import { BROWSER_METHOD_ID } from '@/lib/browser-method';
import { getPreferredCrawlMethod } from '@/lib/pipeline-config';
import {
  getSchedulerConfig,
  insertOrUpdateVideos,
  startScheduler,
  stopScheduler,
} from '@/lib/scheduler';
import type { Channel } from '@/lib/db';
import {
  recordChannelRefresh,
  recordIntentRefresh,
} from '@/lib/refresh-history';
import {
  finishManualRefreshRun,
  getActiveManualRefreshRun,
  isManualRefreshCancelled,
  requestManualRefreshCancel,
  startManualRefreshRun,
} from '@/lib/manual-refresh';

type RefreshScope = {
  platform?: Channel['platform'];
  intent?: string;
  channelId?: number;
};

function normalizeRefreshScope(body: unknown): RefreshScope {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const raw = body as {
    platform?: string;
    intent?: string;
    channel_id?: string | number;
  };

  const platform =
    raw.platform === 'youtube' || raw.platform === 'bilibili'
      ? raw.platform
      : undefined;
  const intent = typeof raw.intent === 'string' ? raw.intent.trim() : '';
  const parsedChannelId =
    typeof raw.channel_id === 'number'
      ? raw.channel_id
      : typeof raw.channel_id === 'string'
        ? Number.parseInt(raw.channel_id, 10)
        : Number.NaN;
  const channelId =
    Number.isInteger(parsedChannelId) && parsedChannelId > 0
      ? parsedChannelId
      : undefined;

  return {
    platform,
    intent: intent || undefined,
    channelId,
  };
}

function buildChannelScopeQuery(scope: RefreshScope): {
  sql: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (scope.platform) {
    conditions.push('platform = ?');
    params.push(scope.platform);
  }

  if (scope.intent) {
    if (scope.intent === '未分类') {
      // Include channels with NULL, empty, literal '未分类', or orphaned intent
      // (intent name that doesn't exist in the intents table)
      conditions.push(
        "(intent = '未分类' OR intent IS NULL OR intent = '' OR NOT EXISTS (SELECT 1 FROM intents WHERE name = intent))",
      );
    } else {
      conditions.push('intent = ?');
      params.push(scope.intent);
    }
  }

  if (scope.channelId) {
    conditions.push('id = ?');
    params.push(scope.channelId);
  }

  const whereClause =
    conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  return {
    sql: `SELECT * FROM channels${whereClause} ORDER BY id ASC`,
    params,
  };
}

export async function POST(req: NextRequest) {
  let restartScheduler = false;
  let feedLockAcquired = tryAcquireCrawlerScope('feed', 'manual');

  if (!feedLockAcquired) {
    const owner = getCrawlerScopeOwner('feed');
    if (owner !== 'scheduler') {
      return NextResponse.json(
        { error: '后台抓取任务正在运行，请稍后再试' },
        { status: 409 },
      );
    }

    restartScheduler = getSchedulerConfig().enabled;
    stopScheduler({ persist: false });
    releaseCrawlerScope('feed', 'scheduler');
    feedLockAcquired = tryAcquireCrawlerScope('feed', 'manual');

    if (!feedLockAcquired) {
      if (restartScheduler) {
        startScheduler();
      }
      return NextResponse.json(
        { error: '后台抓取任务正在运行，请稍后再试' },
        { status: 409 },
      );
    }
  }

  const requestBody = await req.json().catch(() => null);
  const scope = normalizeRefreshScope(requestBody);
  const run = startManualRefreshRun();
  const db = getDb();
  const channelQuery = buildChannelScopeQuery(scope);
  const countChannelVideos = db.prepare(
    'SELECT COUNT(*) AS c FROM videos WHERE channel_id = ?',
  );
  const channels = db
    .prepare(channelQuery.sql)
    .all(...channelQuery.params) as Channel[];

  let added = 0;
  let refreshed = 0;
  let cancelled = false;
  const errors: string[] = [];

  log.info(
    'api',
    'refresh_start',
    {
      channels: channels.length,
      channel: scope.channelId,
      intent: scope.intent,
      platform: scope.platform,
    },
  );
  cleanupOldLogs();

  updateCrawlerScopeStatus('feed', {
    state: 'running',
    isFallback: false,
    message: `Refreshing ${channels.length} channels`,
  });

  try {
    for (let i = 0; i < channels.length; i++) {
      if (isManualRefreshCancelled(run.id)) {
        cancelled = true;
        updateCrawlerScopeStatus('feed', {
          state: 'idle',
          isFallback: false,
          message: '手动刷新已取消',
          progress: i,
          total: channels.length,
        });
        break;
      }

      const channel = channels[i];
      const existingVideoCount = countChannelVideos.get(channel.id) as
        | { c?: number }
        | undefined;
      const suppressAutomationForInitialImport =
        Number(existingVideoCount?.c ?? 0) === 0;
      const preferredMethod =
        getPreferredCrawlMethod(channel.platform) || BROWSER_METHOD_ID;
      try {
        const throttle = i === 0 ? null : await throttleCrawlerStage('feed');
        updateCrawlerScopeStatus('feed', {
          state: 'running',
          platform: channel.platform,
          preferredMethod,
          activeMethod: preferredMethod,
          isFallback: false,
          targetId: channel.channel_id,
          targetLabel: channel.name || channel.channel_id,
          message: throttle
            ? `Refreshing ${channel.name || channel.channel_id} · ${getCrawlerPerformanceSummary(throttle)}`
            : `Refreshing ${channel.name || channel.channel_id}`,
          progress: i + 1,
          total: channels.length,
        });

        let videos;
        if (channel.platform === 'youtube') {
          videos = await fetchYouTubeFeed(
            channel.channel_id,
            channel.name ?? undefined,
          );
        } else {
          videos = await fetchBilibiliFeed(
            channel.channel_id,
            channel.name ?? undefined,
          );
        }

        // Use the shared insertOrUpdateVideos from scheduler to keep
        // payload and events in sync with the scheduler crawl path
        const channelAdded = insertOrUpdateVideos(channel, videos, {
          emitEvents: true,
          emitDiscoveredEvent: !suppressAutomationForInitialImport,
          eventPriority: 0,
        });
        added += channelAdded;
        refreshed += 1;
        const refreshedAt = new Date().toISOString();
        recordChannelRefresh(channel.id, refreshedAt);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(
          'api',
          'refresh_channel_error',
          {
            channel: channel.name || channel.channel_id,
            platform: channel.platform,
            error: msg,
          },
        );
        errors.push(`${channel.name || channel.channel_id}: ${msg}`);
        updateCrawlerScopeStatus('feed', {
          state: 'error',
          platform: channel.platform,
          preferredMethod,
          activeMethod: preferredMethod,
          isFallback: false,
          targetId: channel.channel_id,
          targetLabel: channel.name || channel.channel_id,
          message: msg,
        });
      }
    }

    log.info(
      'api',
      cancelled ? 'refresh_cancelled' : 'refresh_complete',
      {
        added,
        errors: errors.length,
        channels: channels.length,
        refreshed,
      },
    );
    if (refreshed > 0 && scope.intent && !scope.channelId) {
      recordIntentRefresh(scope.intent);
    }
    return NextResponse.json({
      added,
      errors,
      total_channels: channels.length,
      scope: {
        platform: scope.platform ?? null,
        intent: scope.intent ?? null,
        channel_id: scope.channelId ?? null,
      },
      cancelled,
    });
  } finally {
    finishManualRefreshRun(run.id);
    resetCrawlerScopeStatus('feed');
    releaseCrawlerScope('feed', 'manual');
    if (restartScheduler) {
      startScheduler();
    }
  }
}

export async function DELETE() {
  const activeRun = getActiveManualRefreshRun();
  if (!activeRun) {
    return NextResponse.json(
      { cancelled: false, error: '当前没有进行中的手动刷新' },
      { status: 409 },
    );
  }

  const run = requestManualRefreshCancel();
  return NextResponse.json({
    cancelled: Boolean(run),
    requested: true,
  });
}
