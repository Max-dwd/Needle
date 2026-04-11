import { NextRequest, NextResponse } from 'next/server';
import { getDb, type ResearchFavorite } from '@/lib/db';
import type { ResearchFavoriteWithVideo } from '@/types';

type QueryArg = string | number;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const unorganized = searchParams.get('unorganized') === '1';
  const intentTypeId = searchParams.get('intent_type_id');
  const videoId = searchParams.get('video_id');
  const favoriteId = searchParams.get('favorite_id');
  const page = Number.parseInt(searchParams.get('page') || '1', 10);
  const limit = Number.parseInt(searchParams.get('limit') || '30', 10);
  const offset = (Math.max(page, 1) - 1) * Math.max(limit, 1);
  const db = getDb();

  const conditions = ['rf.archived_at IS NULL'];
  const params: QueryArg[] = [];

  if (unorganized) {
    conditions.push('rci.collection_id IS NULL');
  }
  if (intentTypeId) {
    conditions.push('rf.intent_type_id = ?');
    params.push(intentTypeId);
  }
  if (videoId) {
    conditions.push('rf.video_id = ?');
    params.push(videoId);
  }
  if (favoriteId) {
    conditions.push('rf.id = ?');
    params.push(favoriteId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const joinCollectionItems = `
    LEFT JOIN research_collection_items rci ON rci.favorite_id = rf.id
  `;

  const rows = db
    .prepare(
      `
        SELECT rf.*, v.title, v.platform, v.video_id AS platform_video_id,
               v.thumbnail_url, v.published_at, v.duration, v.subtitle_status,
               COALESCE(c.name, v.channel_name) AS channel_name, c.channel_id AS channel_channel_id,
               rit.name AS intent_type_name, rit.slug AS intent_type_slug
        FROM research_favorites rf
        JOIN videos v ON v.id = rf.video_id
        LEFT JOIN channels c ON c.id = v.channel_id
        JOIN research_intent_types rit ON rit.id = rf.intent_type_id
        ${joinCollectionItems}
        ${whereClause}
        GROUP BY rf.id
        ORDER BY rf.created_at DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(...params, limit, offset) as ResearchFavoriteWithVideo[];

  const total = db
    .prepare(
      `
        SELECT COUNT(DISTINCT rf.id) AS count
        FROM research_favorites rf
        JOIN videos v ON v.id = rf.video_id
        LEFT JOIN channels c ON c.id = v.channel_id
        JOIN research_intent_types rit ON rit.id = rf.intent_type_id
        ${joinCollectionItems}
        ${whereClause}
      `,
    )
    .get(...params) as { count: number };

  return NextResponse.json({
    items: rows,
    total: total.count,
    page,
    limit,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const videoId = Number.parseInt(String(body?.video_id ?? ''), 10);
  const intentTypeId = Number.parseInt(String(body?.intent_type_id ?? ''), 10);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';

  if (!Number.isFinite(videoId) || !Number.isFinite(intentTypeId) || !note) {
    return NextResponse.json(
      { error: 'video_id、intent_type_id 和 note 必填' },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const result = db
      .prepare(
        `
          INSERT INTO research_favorites (video_id, intent_type_id, note)
          VALUES (?, ?, ?)
        `,
      )
      .run(videoId, intentTypeId, note);
    const created = db
      .prepare('SELECT * FROM research_favorites WHERE id = ?')
      .get(result.lastInsertRowid) as ResearchFavorite;
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: research_favorites.video_id')) {
      return NextResponse.json(
        { error: '该视频已加入研究收藏' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = Number.parseInt(String(body?.id ?? ''), 10);
  const db = getDb();

  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'id 无效' }, { status: 400 });
  }

  const current = db
    .prepare('SELECT * FROM research_favorites WHERE id = ?')
    .get(id) as ResearchFavorite | undefined;
  if (!current) {
    return NextResponse.json({ error: '研究收藏不存在' }, { status: 404 });
  }

  const nextIntentTypeId =
    body?.intent_type_id === undefined
      ? current.intent_type_id
      : Number.parseInt(String(body.intent_type_id), 10);
  const nextNote =
    body?.note === undefined
      ? current.note
      : typeof body.note === 'string'
        ? body.note.trim()
        : '';

  if (!Number.isFinite(nextIntentTypeId) || !nextNote) {
    return NextResponse.json(
      { error: 'intent_type_id 或 note 无效' },
      { status: 400 },
    );
  }

  db.prepare(
    `
      UPDATE research_favorites
      SET intent_type_id = ?, note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(nextIntentTypeId, nextNote, id);

  const updated = db
    .prepare('SELECT * FROM research_favorites WHERE id = ?')
    .get(id) as ResearchFavorite;
  return NextResponse.json(updated);
}
