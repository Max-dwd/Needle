import { NextRequest, NextResponse } from 'next/server';
import { resolveYouTubeStream } from '@/lib/youtube-playback';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get('videoId')?.trim();

  if (!videoId) {
    return NextResponse.json(
      { error: 'Missing videoId parameter' },
      { status: 400 },
    );
  }

  try {
    const stream = await resolveYouTubeStream(videoId);
    const params = new URLSearchParams({ videoId });
    return NextResponse.json({
      proxyUrl: `/api/youtube/media?${params.toString()}`,
      expiresAt: stream.expiresAt,
      source: 'native',
      limitations: [
        '优先使用最高 720p 原生可播放 MP4/HLS；保留原生 media element 以支持锁屏播放',
      ],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'YouTube 播放地址加载失败';
    return NextResponse.json(
      {
        error: 'Failed to resolve YouTube playback',
        details: message,
      },
      { status: 502 },
    );
  }
}
