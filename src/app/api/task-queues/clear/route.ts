import { NextRequest, NextResponse } from 'next/server';
import { clearSubtitleQueue, getAutoPipelineStatus } from '@/lib/auto-pipeline';
import { clearSummaryQueue, getQueueState } from '@/lib/summary-queue';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    queue?: 'subtitle' | 'summary';
  } | null;

  if (body?.queue !== 'subtitle' && body?.queue !== 'summary') {
    return NextResponse.json({ error: 'Invalid queue type' }, { status: 400 });
  }

  if (body.queue === 'subtitle') {
    const result = clearSubtitleQueue();
    return NextResponse.json({
      ok: true,
      queue: 'subtitle',
      cleared: result.cleared,
      pipeline: getAutoPipelineStatus(),
    });
  }

  const result = clearSummaryQueue();
  return NextResponse.json({
    ok: true,
    queue: 'summary',
    cleared: result.clearedPending + result.clearedQueued,
    details: result,
    queueState: getQueueState(),
    pipeline: getAutoPipelineStatus(),
  });
}
