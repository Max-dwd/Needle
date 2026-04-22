import { NextResponse } from 'next/server';
import { rescrapeVideo } from '@/lib/video-rescrape';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoDbId = Number(id);
  if (!Number.isFinite(videoDbId) || videoDbId <= 0) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }

  const result = await rescrapeVideo(videoDbId);

  if (!result.ok && result.reason === 'not_found') {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  if (!result.ok && result.reason === 'in_progress') {
    return NextResponse.json(
      { error: 'rescrape_in_progress' },
      { status: 409 },
    );
  }

  if (!result.ok) {
    return NextResponse.json({ error: 'Rescrape failed' }, { status: 500 });
  }

  return NextResponse.json(
    {
      accepted: true,
      videoId: result.videoId,
      platform: result.platform,
    },
    { status: 202 },
  );
}
