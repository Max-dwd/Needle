import { NextResponse } from 'next/server';
import { getCrawlerRuntimeStatus } from '@/lib/crawler-status';
import { ensureScheduler, getSchedulerStatus } from '@/lib/scheduler';

export async function GET() {
  ensureScheduler();
  return NextResponse.json({
    ...getCrawlerRuntimeStatus(),
    scheduler: getSchedulerStatus(),
  });
}
