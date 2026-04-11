import { NextRequest, NextResponse } from 'next/server';
import { getDb, type ResearchCollection } from '@/lib/db';
import { buildUniqueSlug } from '@/lib/research';
import type { ResearchCollectionWithStats } from '@/types';

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT rc.*, COUNT(rci.favorite_id) AS item_count
        FROM research_collections rc
        LEFT JOIN research_collection_items rci ON rci.collection_id = rc.id
        WHERE rc.archived_at IS NULL
        GROUP BY rc.id
        ORDER BY rc.updated_at DESC, rc.id DESC
      `,
    )
    .all() as Array<ResearchCollectionWithStats & { item_count: number | string }>;

  return NextResponse.json(
    rows.map((row) => ({
      ...row,
      item_count: Number(row.item_count) || 0,
    })),
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : null;
  const description =
    typeof body?.description === 'string' ? body.description.trim() : null;

  if (!name) {
    return NextResponse.json({ error: '清单名称不能为空' }, { status: 400 });
  }

  const db = getDb();
  const slug = buildUniqueSlug(db, 'research_collections', name);
  const result = db
    .prepare(
      `
        INSERT INTO research_collections (name, slug, goal, description)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(name, slug, goal, description);

  const created = db
    .prepare('SELECT * FROM research_collections WHERE id = ?')
    .get(result.lastInsertRowid) as ResearchCollection;
  return NextResponse.json(created, { status: 201 });
}
