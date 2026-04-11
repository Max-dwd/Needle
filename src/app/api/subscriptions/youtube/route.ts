import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  fetchBrowserYoutubeSubscriptionsViaBridge,
} from '@/lib/browser-youtube-source';
import { normalizeBrowserError } from '@/lib/browser-source-shared';
import {
  fetchYoutubeSubscriptionsViaYtDlp,
  hasYoutubeCookiesBrowserConfigured,
  parseYoutubeSubscriptionsOpml,
  type ImportedSubscriptionChannel,
} from '@/lib/import-subscriptions';

function markSubscribed(items: ImportedSubscriptionChannel[]) {
  const db = getDb();
  const rows = db
    .prepare('SELECT channel_id FROM channels WHERE platform = ?')
    .all('youtube') as Array<{ channel_id: string }>;
  const subscribedIds = new Set(rows.map((row) => row.channel_id));

  return items.map((item) => ({
    ...item,
    subscribed: subscribedIds.has(item.channel_id),
  }));
}

export async function GET(req: NextRequest) {
  const hasCookiesBrowser = hasYoutubeCookiesBrowserConfigured();
  if (req.nextUrl.searchParams.get('config') === '1') {
    return NextResponse.json({ hasCookiesBrowser });
  }

  const source = req.nextUrl.searchParams.get('source') === 'ytdlp'
    ? 'ytdlp'
    : 'bridge';

  try {
    const list = markSubscribed(
      source === 'ytdlp'
        ? await fetchYoutubeSubscriptionsViaYtDlp()
        : await fetchBrowserYoutubeSubscriptionsViaBridge(),
    );
    return NextResponse.json({
      hasCookiesBrowser,
      source,
      list,
      total: list.length,
    });
  } catch (error: unknown) {
    const message =
      source === 'bridge'
        ? normalizeBrowserError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    return NextResponse.json(
      {
        error:
          source === 'bridge'
            ? `${message}，你也可以改用 OPML 或配置 YOUTUBE_COOKIES_BROWSER 后走 yt-dlp 导入。`
            : `${message}，建议改用受控浏览器或 OPML 导入。`,
        hasCookiesBrowser,
        source,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { opml?: string } | null;
  const opml = typeof body?.opml === 'string' ? body.opml : '';

  if (!opml.trim()) {
    return NextResponse.json({ error: '请上传 OPML 文件' }, { status: 400 });
  }

  try {
    const list = markSubscribed(await parseYoutubeSubscriptionsOpml(opml));
    return NextResponse.json({
      hasCookiesBrowser: hasYoutubeCookiesBrowserConfigured(),
      list,
      total: list.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '文件格式错误';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
