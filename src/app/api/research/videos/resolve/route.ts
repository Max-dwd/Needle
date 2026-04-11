import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { 
  parseYoutubeVideoIdFromUrl, 
  parseBilibiliVideoIdFromUrl 
} from '@/lib/browser-source-shared';
import { 
  fetchYouTubeVideoDetail, 
  fetchBilibiliVideoDetail 
} from '@/lib/fetcher';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
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
  const existing = db
    .prepare('SELECT * FROM videos WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as any;

  if (existing) {
    // If it's an existing video from a subscribed channel, we need to get the channel name via JOIN
    const videoWithChannel = db
      .prepare(`
        SELECT v.*, COALESCE(c.name, v.channel_name) as channel_name
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        WHERE v.id = ?
      `)
      .get(existing.id) as any;

    return NextResponse.json({
      exists: true,
      video: {
        id: videoWithChannel.id,
        platform: videoWithChannel.platform,
        video_id: videoWithChannel.video_id,
        title: videoWithChannel.title,
        thumbnail_url: videoWithChannel.thumbnail_url,
        channel_name: videoWithChannel.channel_name,
      }
    });
  }

  // Not in DB, fetch metadata
  const detail = platform === 'youtube' 
    ? await fetchYouTubeVideoDetail(videoId)
    : await fetchBilibiliVideoDetail(videoId);

  if (!detail) {
    return NextResponse.json({ error: 'Could not fetch video metadata' }, { status: 404 });
  }

  return NextResponse.json({
    exists: false,
    video: {
      platform,
      video_id: videoId,
      title: detail.title,
      thumbnail_url: detail.thumbnail_url,
      channel_name: detail.channel_name,
      published_at: detail.published_at,
      duration: detail.duration,
    }
  });
}
