import { NextRequest, NextResponse } from 'next/server';
import {
  fetchBilibiliViewInfo,
  resolveBilibiliPlayback,
} from '@/lib/bilibili-playback';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const bvid = request.nextUrl.searchParams.get('bvid')?.trim();

  if (!bvid) {
    return NextResponse.json(
      { error: 'Missing bvid parameter' },
      { status: 400 },
    );
  }

  try {
    const view = await fetchBilibiliViewInfo(bvid);
    const playback = await resolveBilibiliPlayback(bvid, view.cid);
    const params = new URLSearchParams({
      bvid,
      cid: String(view.cid),
    });
    if (playback.quality) {
      params.set('qn', String(playback.quality));
    }

    return NextResponse.json({
      bvid,
      aid: view.aid,
      cid: view.cid,
      proxyUrl: `/api/bilibili/media?${params.toString()}`,
      durationMs: playback.durationMs,
      quality: playback.quality,
      qualityLabel: playback.qualityLabel,
      format: playback.format,
      authUsed: playback.authUsed,
      source: 'mp4',
      segmented: playback.segmentCount > 1,
      limitations:
        playback.segmentCount > 1
          ? ['当前阶段仅实现单路 MP4 播放，多分段资源未做无缝串联']
          : [],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'B站播放地址加载失败';
    return NextResponse.json(
      {
        error: 'Failed to resolve Bilibili playback',
        details: message,
      },
      { status: 502 },
    );
  }
}
