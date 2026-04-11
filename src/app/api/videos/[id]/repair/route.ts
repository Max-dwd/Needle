import { NextResponse } from 'next/server';
import { getDb, type Video } from '@/lib/db';
import { ensureEnrichmentQueue, enrichVideo } from '@/lib/enrichment-queue';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoDbId = Number(id);
  if (!Number.isFinite(videoDbId) || videoDbId <= 0) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }

  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoDbId) as
    | Video
    | undefined;

  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  ensureEnrichmentQueue();
  void enrichVideo(videoDbId);

  return NextResponse.json(
    {
      accepted: true,
      videoId: video.video_id,
      platform: video.platform,
    },
    { status: 202 },
  );
}
