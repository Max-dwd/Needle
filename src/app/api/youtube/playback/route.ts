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
      source: 'mp4',
      limitations: ['最高使用 720p progressive MP4，解析失败时回退 iframe'],
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
