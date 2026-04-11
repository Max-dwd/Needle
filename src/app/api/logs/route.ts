import { NextRequest, NextResponse } from 'next/server';
import {
  formatBufferedEntry,
  getBufferedEntries,
} from '@/lib/logger';
import type { LogLevel, LogScope } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lines = Math.min(
    500,
    Math.max(1, parseInt(searchParams.get('lines') || '200', 10)),
  );
  const level = searchParams.get('level') as LogLevel | null;
  const scope = searchParams.get('scope') as LogScope | null;
  const platform = searchParams.get('platform');

  const entries = getBufferedEntries({
    lines,
    level: level || undefined,
    scope: scope || undefined,
    platform: platform || undefined,
  });

  const logs = entries.map((entry) => formatBufferedEntry(entry));

  return NextResponse.json(
    { entries, logs },
    { headers: noCacheHeaders },
  );
}
