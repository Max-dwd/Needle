import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getPipedComments } from '@/lib/piped';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }

  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as
    | { id: number; platform: 'youtube' | 'bilibili'; video_id: string }
    | undefined;
  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  if (video.platform !== 'youtube') {
    return NextResponse.json({
      error: 'Comments unavailable',
      details: '当前仅支持 YouTube 评论聚合，B站评论暂未接入。',
    });
  }

  try {
    const comments = await getPipedComments(video.video_id, 40);
    return NextResponse.json({
      source: comments.instance,
      comments: comments.data,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      error: 'Comments unavailable',
      details,
    });
  }
}
