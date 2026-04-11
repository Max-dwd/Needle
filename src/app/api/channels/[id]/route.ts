import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!channel)
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });

  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!channel)
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });

  if (body.intent !== undefined) {
    const intent =
      typeof body.intent === 'string' && body.intent.trim() !== ''
        ? body.intent.trim()
        : '未分类';
    const existingIntent = db
      .prepare('SELECT id FROM intents WHERE name = ?')
      .get(intent);
    if (!existingIntent) {
      return NextResponse.json(
        { error: `意图"${intent}"不存在` },
        { status: 400 },
      );
    }
    db.prepare('UPDATE channels SET intent = ? WHERE id = ?').run(intent, id);
  }
  if (body.topics !== undefined) {
    const topics = Array.isArray(body.topics) ? body.topics : [];
    db.prepare('UPDATE channels SET topics = ? WHERE id = ?').run(
      JSON.stringify(topics),
      id,
    );
  }

  return NextResponse.json({ success: true });
}
