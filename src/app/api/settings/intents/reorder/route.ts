import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const ids: unknown = body?.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: '请提供有效的意图 id 列表' },
      { status: 400 },
    );
  }

  // Validate all entries are numbers
  if (!ids.every((id) => typeof id === 'number' && Number.isInteger(id))) {
    return NextResponse.json(
      { error: 'id 列表中包含无效值' },
      { status: 400 },
    );
  }

  const db = getDb();

  const updateOrder = db.prepare(
    `UPDATE intents SET sort_order = ? WHERE id = ? AND name != '未分类'`,
  );

  const reorder = db.transaction(() => {
    ids.forEach((id, index) => {
      updateOrder.run(index, id);
    });
    // 未分类 always stays at sort_order=99
    db.prepare(
      `UPDATE intents SET sort_order = 99 WHERE name = '未分类'`,
    ).run();
  });

  reorder();

  return NextResponse.json({ success: true });
}
