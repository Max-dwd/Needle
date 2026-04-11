import { NextRequest, NextResponse } from 'next/server';
import { getDb, type Channel, type Intent } from '@/lib/db';
import { resolveChannelFromUrl } from '@/lib/fetcher';
import {
  exportChannelsToMarkdown,
  importChannelsFromMarkdown,
} from '@/lib/channel-markdown';

export async function GET() {
  const db = getDb();

  const channels = db
    .prepare('SELECT * FROM channels ORDER BY name, channel_id')
    .all() as Channel[];

  // Parse topics JSON string to array for each channel
  const channelsWithTopics = channels.map((c) => ({
    ...c,
    topics: typeof c.topics === 'string' ? JSON.parse(c.topics) : c.topics,
  }));

  const intents = db
    .prepare('SELECT * FROM intents ORDER BY sort_order, id')
    .all() as Intent[];

  const markdown = exportChannelsToMarkdown(channelsWithTopics, intents);

  return new NextResponse(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="needle-subscriptions-${new Date().toISOString().slice(0, 10)}.md"`,
    },
  });
}

export async function POST(req: NextRequest) {
  const { markdown } = await req.json();
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return NextResponse.json({ error: 'Markdown required' }, { status: 400 });
  }

  try {
    const parsed = await importChannelsFromMarkdown(markdown, getDb);
    if (parsed.length === 0) {
      return NextResponse.json(
        { error: '未解析到任何订阅条目，请检查 Markdown 列表格式' },
        { status: 400 },
      );
    }

    const db = getDb();
    const parsedWithMetadata = await Promise.all(
      parsed.map(async (item) => {
        try {
          const resolved = await resolveChannelFromUrl(item.url);
          return {
            ...item,
            avatar_url: resolved.avatar_url || '',
          };
        } catch {
          return {
            ...item,
            avatar_url: '',
          };
        }
      }),
    );

    // Get existing channel ids for upsert
    const findExisting = db.prepare(
      'SELECT id FROM channels WHERE channel_id = ?',
    );
    // Upsert channel: insert or update
    const upsertChannel = db.prepare(`
      INSERT INTO channels (platform, channel_id, name, avatar_url, intent, topics, category, category2)
      VALUES (?, ?, ?, ?, ?, ?, '', '')
      ON CONFLICT(channel_id) DO UPDATE SET
        platform = excluded.platform,
        name = excluded.name,
        avatar_url = CASE
          WHEN excluded.avatar_url <> '' THEN excluded.avatar_url
          ELSE channels.avatar_url
        END,
        intent = excluded.intent,
        topics = excluded.topics
    `);

    let created = 0;
    let updated = 0;

    const tx = db.transaction(() => {
      for (const item of parsedWithMetadata) {
        const existing = findExisting.get(item.channel_id) as
          | { id: number }
          | undefined;
        if (existing) {
          // Update existing channel
          upsertChannel.run(
            item.platform,
            item.channel_id,
            item.name,
            item.avatar_url,
            item.intent,
            JSON.stringify(item.topics),
          );
          updated += 1;
        } else {
          // Insert new channel
          upsertChannel.run(
            item.platform,
            item.channel_id,
            item.name,
            item.avatar_url,
            item.intent,
            JSON.stringify(item.topics),
          );
          created += 1;
        }
      }
    });

    tx();

    return NextResponse.json({
      ok: true,
      created,
      updated,
      total: parsed.length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
