import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { Intent } from '@/lib/db';

export async function GET() {
  const db = getDb();
  const intents = db
    .prepare(
      `
    SELECT * FROM intents ORDER BY sort_order ASC, id ASC
  `,
    )
    .all() as Intent[];
  return NextResponse.json(intents);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';

  if (!name) {
    return NextResponse.json(
      { error: '意图名称不能为空' },
      { status: 400 },
    );
  }

  if (name.length > 100) {
    return NextResponse.json(
      { error: '意图名称过长（最多 100 字符）' },
      { status: 400 },
    );
  }

  const db = getDb();

  const existing = db
    .prepare('SELECT id FROM intents WHERE name = ?')
    .get(name);
  if (existing) {
    return NextResponse.json(
      { error: `意图 "${name}" 已存在` },
      { status: 409 },
    );
  }

  // Auto-assign sort_order: max of existing non-未分类 intents + 1, before 未分类 (sort_order=99)
  const maxResult = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) as max_order FROM intents WHERE name != '未分类'`,
    )
    .get() as { max_order: number };

  const sortOrder = Math.min(maxResult.max_order + 1, 98);

  const result = db
    .prepare(
      `INSERT INTO intents (name, auto_subtitle, auto_summary, sort_order)
       VALUES (?, ?, ?, ?)`,
    )
    .run(name, body?.auto_subtitle ? 1 : 0, body?.auto_summary ? 1 : 0, sortOrder);

  const intent = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(result.lastInsertRowid) as Intent;

  return NextResponse.json(intent, { status: 201 });
}
