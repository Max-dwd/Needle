import { NextRequest, NextResponse } from 'next/server';
import { getDb, type ResearchIntentType } from '@/lib/db';
import { buildUniqueSlug } from '@/lib/research';

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM research_intent_types
        WHERE archived_at IS NULL
        ORDER BY sort_order ASC, id ASC
      `,
    )
    .all() as ResearchIntentType[];

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const exportTemplate =
    typeof body?.export_template === 'string' ? body.export_template.trim() : null;

  if (!name) {
    return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
  }

  const db = getDb();
  const slug = buildUniqueSlug(db, 'research_intent_types', name);
  const sortResult = db
    .prepare(
      `
        SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
        FROM research_intent_types
        WHERE archived_at IS NULL
      `,
    )
    .get() as { max_sort_order: number };

  const result = db
    .prepare(
      `
        INSERT INTO research_intent_types (name, slug, export_template, sort_order)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(name, slug, exportTemplate, sortResult.max_sort_order + 1);

  const created = db
    .prepare('SELECT * FROM research_intent_types WHERE id = ?')
    .get(result.lastInsertRowid) as ResearchIntentType;

  return NextResponse.json(created, { status: 201 });
}
