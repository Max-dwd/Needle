import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawLimit = Number.parseInt(searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 200)
    : 100;

  const db = getDb();
  const videos = db
    .prepare(
      `
        SELECT
          v.id,
          v.video_id,
          v.platform,
          COALESCE(v.title, '') AS title,
          v.thumbnail_url,
          v.published_at,
          v.duration,
          COALESCE(c.name, '') AS channel_name,
          c.channel_id AS channel_channel_id,
          c.avatar_url,
          v.availability_status,
          v.availability_reason,
          v.availability_checked_at,
          v.created_at
        FROM videos v
        JOIN channels c ON c.id = v.channel_id
        WHERE v.availability_status IN ('unavailable', 'abandoned')
        ORDER BY
          CASE v.availability_status
            WHEN 'unavailable' THEN 0
            WHEN 'abandoned' THEN 1
            ELSE 2
          END,
          COALESCE(v.availability_checked_at, v.created_at) DESC,
          v.id DESC
        LIMIT ?
      `,
    )
    .all(limit);

  const totalTrackedRow = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM videos
        WHERE availability_status IN ('unavailable', 'abandoned')
      `,
    )
    .get() as { count?: number } | undefined;

  return NextResponse.json({
    videos,
    totalTracked: totalTrackedRow?.count ?? 0,
  });
}
