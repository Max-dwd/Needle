import { NextRequest, NextResponse } from 'next/server';
import { getDb, type ResearchCollection } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const collection = db
    .prepare(
      `
        SELECT *
        FROM research_collections
        WHERE id = ? AND archived_at IS NULL
      `,
    )
    .get(id) as ResearchCollection | undefined;

  if (!collection) {
    return NextResponse.json({ error: '清单不存在' }, { status: 404 });
  }

  const items = db
    .prepare(
      `
        SELECT rci.collection_id, rci.favorite_id, rci.sort_order, rci.override_intent_type_id,
               rci.override_note, rci.created_at,
               rf.id, rf.video_id, rf.note, rf.intent_type_id, rf.created_at AS favorite_created_at,
               v.title, v.platform, v.video_id AS platform_video_id, v.thumbnail_url,
               v.published_at, v.duration, v.subtitle_status,
               COALESCE(c.name, v.channel_name) AS channel_name, c.channel_id AS channel_channel_id,
               COALESCE(orit.name, rit.name) AS intent_type_name,
               orit.name AS override_intent_type_name
        FROM research_collection_items rci
        JOIN research_favorites rf ON rf.id = rci.favorite_id
        JOIN videos v ON v.id = rf.video_id
        LEFT JOIN channels c ON c.id = v.channel_id
        JOIN research_intent_types rit ON rit.id = rf.intent_type_id
        LEFT JOIN research_intent_types orit ON orit.id = rci.override_intent_type_id
        WHERE rci.collection_id = ?
        ORDER BY rci.sort_order ASC, rci.created_at ASC
      `,
    )
    .all(id);
  return NextResponse.json({
    collection,
    items,
    ...collection,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const db = getDb();
  const current = db
    .prepare('SELECT * FROM research_collections WHERE id = ?')
    .get(id) as ResearchCollection | undefined;

  if (!current) {
    return NextResponse.json({ error: '清单不存在' }, { status: 404 });
  }

  const name =
    body?.name === undefined
      ? current.name
      : typeof body.name === 'string'
        ? body.name.trim()
        : '';
  const goal =
    body?.goal === undefined
      ? current.goal
      : typeof body.goal === 'string'
        ? body.goal.trim()
        : null;
  const description =
    body?.description === undefined
      ? current.description
      : typeof body.description === 'string'
        ? body.description.trim()
        : null;

  if (!name) {
    return NextResponse.json({ error: '清单名称不能为空' }, { status: 400 });
  }

  db.prepare(
    `
      UPDATE research_collections
      SET name = ?, goal = ?, description = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(name, goal, description, id);

  const updated = db
    .prepare('SELECT * FROM research_collections WHERE id = ?')
    .get(id) as ResearchCollection;
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  db.prepare('DELETE FROM research_collections WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
