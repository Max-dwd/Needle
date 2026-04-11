import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueSubtitleJobForVideoDbId } from '@/lib/auto-pipeline';
import { 
  parseYoutubeVideoIdFromUrl, 
  parseBilibiliVideoIdFromUrl 
} from '@/lib/browser-source-shared';
import { 
  fetchYouTubeVideoDetail, 
  fetchBilibiliVideoDetail 
} from '@/lib/fetcher';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { url, intent_type_id, note } = body || {};

  if (!url || !intent_type_id || !note) {
    return NextResponse.json({ error: 'url, intent_type_id and note are required' }, { status: 400 });
  }

  let platform: 'youtube' | 'bilibili' | null = null;
  let videoId = '';

  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    platform = 'youtube';
    videoId = parseYoutubeVideoIdFromUrl(url);
  } else if (url.includes('bilibili.com')) {
    platform = 'bilibili';
    videoId = parseBilibiliVideoIdFromUrl(url);
  }

  if (!platform || !videoId) {
    return NextResponse.json({ error: 'Invalid or unsupported URL' }, { status: 400 });
  }

  const db = getDb();
  let videoRecord = db
    .prepare('SELECT id FROM videos WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as { id: number } | undefined;

  if (!videoRecord) {
    // Fetch and insert video
    const detail = platform === 'youtube' 
      ? await fetchYouTubeVideoDetail(videoId)
      : await fetchBilibiliVideoDetail(videoId);

    if (!detail) {
      return NextResponse.json({ error: 'Could not fetch video metadata' }, { status: 404 });
    }

    const result = db.prepare(`
      INSERT INTO videos (platform, video_id, title, thumbnail_url, published_at, duration, source, channel_name)
      VALUES (?, ?, ?, ?, ?, ?, 'research', ?)
    `).run(
      platform,
      videoId,
      detail.title,
      detail.thumbnail_url,
      detail.published_at,
      detail.duration,
      detail.channel_name
    );
    videoRecord = { id: Number(result.lastInsertRowid) };
  }

  // Create research favorite
  try {
    db.prepare(`
      INSERT INTO research_favorites (video_id, intent_type_id, note)
      VALUES (?, ?, ?)
    `).run(videoRecord.id, intent_type_id, note);

    void Promise.resolve().then(() => {
      enqueueSubtitleJobForVideoDbId(videoRecord.id, 0);
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: research_favorites.video_id')) {
      return NextResponse.json({ error: '该视频已在研究收藏中' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
