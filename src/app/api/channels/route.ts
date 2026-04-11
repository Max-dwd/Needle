import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveChannelFromUrl } from '@/lib/fetcher';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channel_id')?.trim() || null;
  const platform = searchParams.get('platform')?.trim() || null;
  const db = getDb();
  const conditions: string[] = [];
  const params: Array<string> = [];

  if (channelId) {
    conditions.push('c.channel_id = ?');
    params.push(channelId);
  }
  if (platform === 'youtube' || platform === 'bilibili') {
    conditions.push('c.platform = ?');
    params.push(platform);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
    SELECT c.*, COUNT(v.id) as video_count
    FROM channels c
    LEFT JOIN videos v ON v.channel_id = c.id
    ${whereClause}
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const channels = rows.map((row) => ({
    ...row,
    topics: (() => {
      try {
        const parsed = JSON.parse((row.topics as string) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    intent: row.intent ?? '未分类',
  }));

  return NextResponse.json(channels);
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();
  if (!url)
    return NextResponse.json({ error: 'URL required' }, { status: 400 });

  try {
    const info = await resolveChannelFromUrl(url);
    const db = getDb();

    const existing = db
      .prepare('SELECT * FROM channels WHERE channel_id = ?')
      .get(info.channel_id);
    if (existing) {
      return NextResponse.json(
        { error: 'Channel already subscribed' },
        { status: 409 },
      );
    }

    const result = db
      .prepare(
        `
      INSERT INTO channels (platform, channel_id, name, avatar_url)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(info.platform, info.channel_id, info.name, info.avatar_url);

    const channel = db
      .prepare('SELECT * FROM channels WHERE id = ?')
      .get(result.lastInsertRowid);
    return NextResponse.json(channel, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
