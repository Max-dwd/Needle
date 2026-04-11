import { NextRequest, NextResponse } from 'next/server';
import {
  clearBilibiliSessdata,
  getBilibiliAuthStatus,
  setBilibiliAiSummaryEnabled,
  setBilibiliSessdata,
  validateBilibiliSessdata,
} from '@/lib/bilibili-auth';

export async function GET() {
  const status = await getBilibiliAuthStatus();
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    sessdata?: string;
    enabled?: boolean;
  } | null;
  const sessdata = body?.sessdata?.trim() || '';
  const hasSessdata = Boolean(sessdata);

  if (typeof body?.enabled === 'boolean') {
    setBilibiliAiSummaryEnabled(body.enabled);
  }

  if (!hasSessdata) {
    const status = await getBilibiliAuthStatus();
    return NextResponse.json(status);
  }

  const status = await validateBilibiliSessdata(sessdata);
  if (status.state === 'invalid' || status.state === 'error') {
    return NextResponse.json(status, { status: 400 });
  }

  setBilibiliSessdata(sessdata);
  const updatedStatus = await getBilibiliAuthStatus();
  return NextResponse.json(updatedStatus);
}

export async function DELETE() {
  clearBilibiliSessdata();
  const status = await getBilibiliAuthStatus();
  return NextResponse.json(status);
}
