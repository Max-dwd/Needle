import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

interface ImportChannelInput {
  platform?: 'youtube' | 'bilibili';
  channel_id?: string;
  name?: string;
  avatar_url?: string;
  description?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    channels?: ImportChannelInput[];
    targetIntent?: string;
  } | null;
  const channels = Array.isArray(body?.channels) ? body.channels : [];
  const targetIntent = body?.targetIntent;

  if (channels.length === 0) {
    return NextResponse.json({ error: '请选择要导入的频道' }, { status: 400 });
  }

  const db = getDb();
  const findExisting = db.prepare(
    'SELECT id FROM channels WHERE platform = ? AND channel_id = ?',
  );
  
  // Update query to include intent and description
  const insertChannel = db.prepare(`
    INSERT INTO channels (platform, channel_id, name, avatar_url, intent, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let created = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const item of channels) {
      const platform = item.platform;
      const channelId = (item.channel_id || '').trim();
      if ((platform !== 'youtube' && platform !== 'bilibili') || !channelId) {
        skipped += 1;
        continue;
      }

      const existing = findExisting.get(platform, channelId) as
        | { id: number }
        | undefined;
      if (existing) {
        skipped += 1;
        continue;
      }

      insertChannel.run(
        platform,
        channelId,
        (item.name || '').trim() || channelId,
        (item.avatar_url || '').trim(),
        targetIntent || '未分类',
        (item.description || '').trim()
      );
      created += 1;
    }
  });

  try {
    tx();
    return NextResponse.json({ created, skipped });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
