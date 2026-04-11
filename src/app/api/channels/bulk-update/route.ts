import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { ids, intent, addTopics, removeTopics } = body as {
    ids?: unknown;
    intent?: string;
    addTopics?: unknown;
    removeTopics?: unknown;
  };

  // Validate ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: 'ids must be a non-empty array' },
      { status: 400 },
    );
  }
  if (!ids.every((id) => typeof id === 'number' && Number.isInteger(id))) {
    return NextResponse.json(
      { error: 'ids must contain only integers' },
      { status: 400 },
    );
  }

  // Validate intent if provided
  if (intent !== undefined) {
    if (typeof intent !== 'string' || intent.trim() === '') {
      return NextResponse.json(
        { error: 'intent must be a non-empty string' },
        { status: 400 },
      );
    }
    const db = getDb();
    const existingIntent = db
      .prepare('SELECT id FROM intents WHERE name = ?')
      .get(intent.trim());
    if (!existingIntent) {
      return NextResponse.json(
        { error: `意图"${intent}"不存在` },
        { status: 400 },
      );
    }
  }

  // Validate topics arrays if provided
  if (addTopics !== undefined) {
    if (!Array.isArray(addTopics) || !addTopics.every((t) => typeof t === 'string')) {
      return NextResponse.json(
        { error: 'addTopics must be an array of strings' },
        { status: 400 },
      );
    }
  }
  if (removeTopics !== undefined) {
    if (!Array.isArray(removeTopics) || !removeTopics.every((t) => typeof t === 'string')) {
      return NextResponse.json(
        { error: 'removeTopics must be an array of strings' },
        { status: 400 },
      );
    }
  }

  const db = getDb();

  // Build update expression
  const updates: string[] = [];
  const params: unknown[] = [];

  if (intent !== undefined) {
    updates.push('intent = ?');
    params.push(intent.trim());
  }

  // For topics, we need to handle per-channel because each channel may have different existing topics
  const hasTopicOps = addTopics !== undefined || removeTopics !== undefined;

  // Use a transaction to ensure all updates are atomic — either all succeed or none do
  const doUpdates = db.transaction(() => {
    if (!hasTopicOps) {
      // Simple case: just intent update
      if (updates.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        const sql = `UPDATE channels SET ${updates.join(', ')} WHERE id IN (${placeholders})`;
        db.prepare(sql).run(...params, ...ids);
      }
    } else {
      // Per-channel topic merge
      const updateTopics = db.prepare('UPDATE channels SET topics = ? WHERE id = ?');
      const selectChannel = db.prepare('SELECT id, topics FROM channels WHERE id = ?');

      for (const channelId of ids) {
        const channel = selectChannel.get(channelId) as { id: number; topics: string | null } | undefined;
        if (!channel) continue;

        let existingTopics: string[] = [];
        try {
          const parsed = JSON.parse(channel.topics || '[]');
          existingTopics = Array.isArray(parsed) ? parsed : [];
        } catch {
          existingTopics = [];
        }

        let nextTopics = existingTopics;

        if (addTopics !== undefined) {
          const toAdd = (addTopics as string[]).filter((t) => !nextTopics.includes(t));
          nextTopics = [...nextTopics, ...toAdd];
        }

        if (removeTopics !== undefined) {
          nextTopics = nextTopics.filter((t) => !(removeTopics as string[]).includes(t));
        }

        updateTopics.run(JSON.stringify(nextTopics), channelId);
      }

      if (updates.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        const sql = `UPDATE channels SET ${updates.join(', ')} WHERE id IN (${placeholders})`;
        db.prepare(sql).run(...params, ...ids);
      }
    }
  });

  doUpdates();

  // Return updated channel objects
  const selectPlaceholders = ids.map(() => '?').join(', ');
  const updatedChannels = db
    .prepare(
      `
      SELECT c.*, COUNT(v.id) as video_count
      FROM channels c
      LEFT JOIN videos v ON v.channel_id = c.id
      WHERE c.id IN (${selectPlaceholders})
      GROUP BY c.id
    `,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const channels = updatedChannels.map((row) => ({
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
