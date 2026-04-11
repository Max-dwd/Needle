import { NextRequest, NextResponse } from 'next/server';
import {
  ensureScheduler,
  getSchedulerSnapshot,
  startScheduler,
  stopScheduler,
  updateSchedulerConfig,
} from '@/lib/scheduler';
import { getAutoPipelineStatus } from '@/lib/auto-pipeline';

function parseInterval(value: unknown): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export async function GET() {
  ensureScheduler();
  const snapshot = getSchedulerSnapshot();
  return NextResponse.json({
    ...snapshot,
    pipeline: getAutoPipelineStatus(),
  });
}

export async function POST(request: NextRequest) {
  ensureScheduler();

  const body = (await request.json().catch(() => null)) as {
    action?: string;
    crawlInterval?: number;
    subtitleInterval?: number;
  } | null;

  const crawlInterval = parseInterval(body?.crawlInterval);
  const subtitleInterval = parseInterval(body?.subtitleInterval);

  const intervalPatch = {
    ...(crawlInterval ? { crawlInterval } : {}),
    ...(subtitleInterval !== null ? { subtitleInterval } : {}),
  };

  if (body?.action === 'stop') {
    stopScheduler();
    return NextResponse.json(getSchedulerSnapshot());
  }

  if (body?.action === 'start') {
    return NextResponse.json(startScheduler(intervalPatch));
  }

  if (body?.action === 'update') {
    return NextResponse.json(updateSchedulerConfig(intervalPatch));
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
