import { NextRequest, NextResponse } from 'next/server';
import { getDb, type ResearchIntentType } from '@/lib/db';
import { buildUniqueSlug } from '@/lib/research';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const body = await req.json().catch(() => null);
  const current = db
    .prepare('SELECT * FROM research_intent_types WHERE id = ?')
    .get(id) as ResearchIntentType | undefined;

  if (!current) {
    return NextResponse.json({ error: '研究意图不存在' }, { status: 404 });
  }

  const nextName =
    body?.name === undefined
      ? current.name
      : typeof body.name === 'string'
        ? body.name.trim()
        : '';
  if (!nextName) {
    return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
  }

  const nextTemplate =
    body?.export_template === undefined
      ? current.export_template
      : typeof body.export_template === 'string'
        ? body.export_template
        : null;
  const nextSortOrder =
    body?.sort_order === undefined
      ? current.sort_order
      : Number.parseInt(String(body.sort_order), 10);

  if (!Number.isFinite(nextSortOrder)) {
    return NextResponse.json({ error: 'sort_order 无效' }, { status: 400 });
  }

  const nextSlug =
    nextName === current.name
      ? current.slug
      : buildUniqueSlug(db, 'research_intent_types', nextName, current.id);

  db.prepare(
    `
      UPDATE research_intent_types
      SET name = ?, slug = ?, export_template = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(nextName, nextSlug, nextTemplate, nextSortOrder, id);

  const updated = db
    .prepare('SELECT * FROM research_intent_types WHERE id = ?')
    .get(id) as ResearchIntentType;
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const current = db
    .prepare('SELECT * FROM research_intent_types WHERE id = ?')
    .get(id) as ResearchIntentType | undefined;

  if (!current) {
    return NextResponse.json({ error: '研究意图不存在' }, { status: 404 });
  }
  if (current.is_preset) {
    return NextResponse.json({ error: '预设研究意图不能删除' }, { status: 400 });
  }

  const favoriteCount = db
    .prepare(
      'SELECT COUNT(*) AS count FROM research_favorites WHERE intent_type_id = ?',
    )
    .get(id) as { count: number };
  if (favoriteCount.count > 0) {
    return NextResponse.json(
      { error: '已有研究收藏使用该意图，无法删除' },
      { status: 409 },
    );
  }

  db.prepare('DELETE FROM research_intent_types WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
