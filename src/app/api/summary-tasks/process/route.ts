import { NextResponse } from 'next/server';
import {
  isQueueRunning,
  requestQueueStop,
  startQueueProcessing,
} from '@/lib/summary-queue';
import { log } from '@/lib/logger';

export async function POST() {
  if (!isQueueRunning()) {
    startQueueProcessing();
    log.info('summary', 'start', { source: 'api-control', mode: 'queue' });
    return NextResponse.json({ started: true }, { status: 202 });
  }

  log.warn(
    'summary',
    'skip',
    { source: 'api-control', mode: 'queue', reason: 'already-running' },
  );
  return NextResponse.json({ started: false, message: 'already running' });
}

export async function DELETE() {
  requestQueueStop();
  log.warn('summary', 'stop', { source: 'api-control', mode: 'queue' });
  return NextResponse.json({ stopped: true });
}
