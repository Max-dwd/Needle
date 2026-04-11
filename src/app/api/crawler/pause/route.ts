import { NextRequest, NextResponse } from 'next/server';
import {
  getCrawlerRuntimeStatus,
  setCrawlerPaused,
} from '@/lib/crawler-status';
import { getSubtitlePool } from '@/lib/auto-pipeline';
import { getQueueState, requestQueueStop } from '@/lib/summary-queue';
import { ensureScheduler, getSchedulerStatus } from '@/lib/scheduler';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    paused?: boolean;
    stopSummaryQueue?: boolean;
  } | null;

  if (typeof body?.paused !== 'boolean') {
    return NextResponse.json(
      { error: 'Invalid paused state' },
      { status: 400 },
    );
  }

  setCrawlerPaused(body.paused);
  const subtitlePool = getSubtitlePool();
  if (body.paused) {
    subtitlePool.pause();
  } else {
    subtitlePool.resume();
  }
  if (body.paused && body.stopSummaryQueue) {
    requestQueueStop();
  }
  ensureScheduler();
  return NextResponse.json({
    ...getCrawlerRuntimeStatus(),
    scheduler: getSchedulerStatus(),
    queue: getQueueState(),
  });
}
