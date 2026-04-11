import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const favoriteIds = Array.isArray(body?.favorite_ids)
    ? body.favorite_ids
        .map((value: unknown) => Number.parseInt(String(value), 10))
        .filter((value: number) => Number.isFinite(value))
    : [];
  const overrideNote =
    typeof body?.override_note === 'string' ? body.override_note.trim() : null;
  const overrideIntentTypeId =
    body?.override_intent_type_id === undefined || body?.override_intent_type_id === null
      ? null
      : Number.parseInt(String(body.override_intent_type_id), 10);

  if (favoriteIds.length === 0) {
    return NextResponse.json({ error: 'favorite_ids 不能为空' }, { status: 400 });
  }
  if (
    overrideIntentTypeId !== null &&
    !Number.isFinite(overrideIntentTypeId)
  ) {
    return NextResponse.json(
      { error: 'override_intent_type_id 无效' },
      { status: 400 },
    );
  }

  const db = getDb();
  const maxSort = db
    .prepare(
      `
        SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
        FROM research_collection_items
        WHERE collection_id = ?
      `,
    )
    .get(id) as { max_sort_order: number };

  const insert = db.prepare(
    `
      INSERT INTO research_collection_items (
        collection_id, favorite_id, sort_order, override_intent_type_id, override_note
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_id, favorite_id) DO UPDATE SET
        override_intent_type_id = COALESCE(excluded.override_intent_type_id, research_collection_items.override_intent_type_id),
        override_note = COALESCE(excluded.override_note, research_collection_items.override_note)
    `,
  );

  const run = db.transaction(() => {
    favoriteIds.forEach((favoriteId: number, index: number) => {
      insert.run(
        id,
        favoriteId,
        maxSort.max_sort_order + index + 1,
        overrideIntentTypeId,
        overrideNote,
      );
    });
  });
  run();

  return NextResponse.json({ success: true, added: favoriteIds.length });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const favoriteId = Number.parseInt(String(body?.favorite_id ?? ''), 10);

  if (!Number.isFinite(favoriteId)) {
    return NextResponse.json({ error: 'favorite_id 无效' }, { status: 400 });
  }

  const db = getDb();

  // Check the item exists
  const existing = db
    .prepare(
      'SELECT 1 FROM research_collection_items WHERE collection_id = ? AND favorite_id = ?',
    )
    .get(id, favoriteId);

  if (!existing) {
    return NextResponse.json({ error: 'item 不存在' }, { status: 400 });
  }

  // Build update clauses only for fields that were provided
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (body?.override_note !== undefined) {
    const note =
      body.override_note === null
        ? null
        : typeof body.override_note === 'string'
          ? body.override_note
          : null;
    setClauses.push('override_note = ?');
    values.push(note);
  }

  if (body?.override_intent_type_id !== undefined) {
    const intentTypeId =
      body.override_intent_type_id === null
        ? null
        : Number.parseInt(String(body.override_intent_type_id), 10);
    if (intentTypeId !== null && !Number.isFinite(intentTypeId)) {
      return NextResponse.json(
        { error: 'override_intent_type_id 无效' },
        { status: 400 },
      );
    }
    setClauses.push('override_intent_type_id = ?');
    values.push(intentTypeId);
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ success: true });
  }

  values.push(id, favoriteId);
  db.prepare(
    `UPDATE research_collection_items SET ${setClauses.join(', ')} WHERE collection_id = ? AND favorite_id = ?`,
  ).run(...values);

  return NextResponse.json({ success: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const favoriteId = Number.parseInt(String(body?.favorite_id ?? ''), 10);

  if (!Number.isFinite(favoriteId)) {
    return NextResponse.json({ error: 'favorite_id 无效' }, { status: 400 });
  }

  const db = getDb();
  db.prepare(
    `
      DELETE FROM research_collection_items
      WHERE collection_id = ? AND favorite_id = ?
    `,
  ).run(id, favoriteId);

  return NextResponse.json({ success: true });
}
