import { NextResponse } from 'next/server';
import { getLogStats } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;

export async function GET() {
  return NextResponse.json(getLogStats(), { headers: noCacheHeaders });
}
