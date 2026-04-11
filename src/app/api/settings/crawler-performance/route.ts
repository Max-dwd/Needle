import { NextRequest, NextResponse } from 'next/server';
import {
  getCrawlerPerformanceProfile,
  getCrawlerPerformanceStatus,
  setCrawlerPerformanceProfile,
  type CrawlerPerformanceProfile,
} from '@/lib/crawler-performance';

function createResponse() {
  const status = getCrawlerPerformanceStatus();
  return {
    profile: status.profile,
    profileLabel: status.profileLabel,
    loadState: status.loadState,
    loadStateLabel: status.loadStateLabel,
    eventLoopLagMs: status.eventLoopLagMs,
    peakLagMs: status.peakLagMs,
    throttleMultiplier: status.throttleMultiplier,
    updatedAt: status.updatedAt,
    options: [
      {
        value: 'high',
        label: '高',
        description: '抓取更积极，只有检测到卡顿时才明显降频。',
      },
      {
        value: 'medium',
        label: '中',
        description: '默认推荐，兼顾抓取速度和主机占用。',
      },
      {
        value: 'low',
        label: '低',
        description: '优先减少后台干扰，抓取间隔更长。',
      },
    ] satisfies Array<{
      value: CrawlerPerformanceProfile;
      label: string;
      description: string;
    }>,
  };
}

export async function GET() {
  return NextResponse.json(createResponse());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    profile?: string;
  } | null;
  const profile = body?.profile;

  if (profile !== 'high' && profile !== 'medium' && profile !== 'low') {
    return NextResponse.json({ error: 'Invalid profile' }, { status: 400 });
  }

  if (profile !== getCrawlerPerformanceProfile()) {
    setCrawlerPerformanceProfile(profile);
  }

  return NextResponse.json(createResponse());
}
