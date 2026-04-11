import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { fetchBilibiliFollowingList } from '@/lib/bilibili-following';
import { normalizeBrowserError } from '@/lib/browser-source-shared';

interface ImportFollowingInput {
  mid?: number;
  uname?: string;
  face?: string;
}

function toSubscribedMidSet(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare('SELECT channel_id FROM channels WHERE platform = ?')
    .all('bilibili') as Array<{ channel_id: string }>;
  return new Set(rows.map((row) => row.channel_id));
}

export async function GET() {
  try {
    const list = await fetchBilibiliFollowingList();
    const subscribedIds = toSubscribedMidSet();

    return NextResponse.json({
      list: list.map((item) => ({
        ...item,
        subscribed:
          subscribedIds.has(String(item.mid)) ||
          subscribedIds.has(`UID_${item.mid}`),
      })),
      total: list.length,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: normalizeBrowserError(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    channels?: ImportFollowingInput[];
  } | null;
  const channels = Array.isArray(body?.channels) ? body.channels : [];

  if (channels.length === 0) {
    return NextResponse.json({ error: '请选择要导入的频道' }, { status: 400 });
  }

  const db = getDb();
  const findExisting = db.prepare(
    'SELECT id FROM channels WHERE platform = ? AND (channel_id = ? OR channel_id = ?)',
  );
  const insertChannel = db.prepare(`
    INSERT INTO channels (platform, channel_id, name, avatar_url)
    VALUES (?, ?, ?, ?)
  `);

  let created = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const item of channels) {
      const mid = typeof item.mid === 'number' ? item.mid : Number(item.mid);
      if (!Number.isFinite(mid) || mid <= 0) {
        skipped += 1;
        continue;
      }

      const channelId = String(mid);
      const existing = findExisting.get('bilibili', channelId, `UID_${mid}`) as
        | { id: number }
        | undefined;
      if (existing) {
        skipped += 1;
        continue;
      }

      insertChannel.run(
        'bilibili',
        channelId,
        (item.uname || '').trim() || `UP主 ${mid}`,
        (item.face || '').trim(),
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
