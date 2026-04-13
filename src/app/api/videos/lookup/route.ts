import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get('video_id')?.trim();
  const platform = searchParams.get('platform')?.trim();

  if (!videoId) {
    return NextResponse.json({ error: 'video_id is required' }, { status: 400 });
  }

  const db = getDb();
  const conditions = ['v.video_id = ?'];
  const params: Array<string> = [videoId];

  if (platform === 'youtube' || platform === 'bilibili') {
    conditions.push('v.platform = ?');
    params.push(platform);
  }

  const video = db
    .prepare(
      `
      SELECT v.id, v.channel_id, v.platform, v.video_id, v.title, v.thumbnail_url,
             v.published_at, v.duration, v.is_read, v.is_members_only, v.access_status,
             v.availability_status, v.availability_reason, v.availability_checked_at,
             v.subtitle_status, v.subtitle_path, v.subtitle_language, v.subtitle_format,
             v.subtitle_error, v.subtitle_last_attempt_at, v.subtitle_cooldown_until, v.created_at,
             COALESCE(c.name, v.channel_name) as channel_name, c.avatar_url,
             c.channel_id as channel_channel_id, COALESCE(c.intent, '未分类') as intent, c.topics,
             st.status as summary_status
      FROM videos v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN summary_tasks st ON v.video_id = st.video_id AND v.platform = st.platform
      WHERE ${conditions.join(' AND ')}
      LIMIT 1
    `,
    )
    .get(...params);

  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  return NextResponse.json(
    { video },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    },
  );
}
