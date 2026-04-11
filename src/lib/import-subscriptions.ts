import { parseStringPromise } from 'xml2js';
import { runYtDlp } from '@/lib/fetcher';

export interface ImportedSubscriptionChannel {
  channel_id: string;
  name: string;
  avatar_url: string;
  description?: string;
}

interface YtDlpThumbnail {
  url?: string;
  width?: number;
}

interface YtDlpSubscriptionEntry {
  id?: string;
  channel_id?: string;
  uploader_id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  url?: string;
  webpage_url?: string;
  channel_url?: string;
  thumbnails?: YtDlpThumbnail[];
  thumbnail?: string;
}

function normalizeAvatarUrl(url: string | undefined): string {
  const value = (url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value.replace(/^http:\/\//, 'https://');
}

function pickBestThumbnail(entry: YtDlpSubscriptionEntry): string {
  const candidates = Array.isArray(entry.thumbnails)
    ? [...entry.thumbnails]
    : [];
  candidates.sort((a, b) => (b.width || 0) - (a.width || 0));
  return normalizeAvatarUrl(entry.thumbnail || candidates[0]?.url);
}

function extractYoutubeChannelId(raw: string | undefined): string {
  const value = (raw || '').trim();
  if (!value) return '';
  if (/^(UC|HC)[A-Za-z0-9_-]+$/.test(value)) return value;

  try {
    const parsed = value.startsWith('http')
      ? new URL(value)
      : new URL(value, 'https://www.youtube.com');
    const direct = parsed.searchParams.get('channel_id');
    if (direct) return direct;

    const pathname = parsed.pathname.replace(/\/+$/, '');
    const channelMatch = pathname.match(/\/channel\/((?:UC|HC)[A-Za-z0-9_-]+)/);
    if (channelMatch?.[1]) return channelMatch[1];

    const handleMatch = pathname.match(/\/(@[A-Za-z0-9._-]+)/);
    if (handleMatch?.[1]) return handleMatch[1];

    const userMatch = pathname.match(/\/(?:user|c)\/([A-Za-z0-9._-]+)/);
    if (userMatch?.[1]) return userMatch[1];
  } catch {
    // ignore malformed URL
  }

  return value;
}

function dedupeSubscriptions(
  items: ImportedSubscriptionChannel[],
): ImportedSubscriptionChannel[] {
  const map = new Map<string, ImportedSubscriptionChannel>();
  for (const item of items) {
    const channelId = item.channel_id.trim();
    if (!channelId) continue;
    if (!map.has(channelId)) {
      map.set(channelId, {
        channel_id: channelId,
        name: item.name.trim() || channelId,
        avatar_url: normalizeAvatarUrl(item.avatar_url),
        description: normalizeDescription(item.description),
      });
    }
  }
  return Array.from(map.values());
}

function normalizeDescription(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

export function hasYoutubeCookiesBrowserConfigured(): boolean {
  return Boolean(process.env.YOUTUBE_COOKIES_BROWSER?.trim());
}

export async function fetchYoutubeSubscriptionsViaYtDlp(): Promise<
  ImportedSubscriptionChannel[]
> {
  const browser = process.env.YOUTUBE_COOKIES_BROWSER?.trim();
  if (!browser) {
    throw new Error('未配置 YOUTUBE_COOKIES_BROWSER，请改用 OPML 导入');
  }

  const raw = await runYtDlp(
    [
      '--flat-playlist',
      '--dump-single-json',
      'https://www.youtube.com/feed/channels',
      '--cookies-from-browser',
      browser,
    ],
    120000,
  );

  const data = JSON.parse(raw) as { entries?: YtDlpSubscriptionEntry[] };
  const entries = Array.isArray(data.entries) ? data.entries : [];

  return dedupeSubscriptions(
    entries.map((entry) => {
      const channelId =
        extractYoutubeChannelId(entry.channel_id) ||
        extractYoutubeChannelId(entry.id) ||
        extractYoutubeChannelId(entry.url) ||
        extractYoutubeChannelId(entry.webpage_url) ||
        extractYoutubeChannelId(entry.channel_url) ||
        extractYoutubeChannelId(entry.uploader_id);

      return {
        channel_id: channelId,
        name: (
          entry.title ||
          entry.channel ||
          entry.uploader ||
          channelId ||
          ''
        ).trim(),
        avatar_url: pickBestThumbnail(entry),
      };
    }),
  );
}

type XmlNode = {
  $?: Record<string, string>;
  outline?: XmlNode | XmlNode[];
};

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectOpmlOutlines(nodes: XmlNode[]): ImportedSubscriptionChannel[] {
  const items: ImportedSubscriptionChannel[] = [];

  for (const node of nodes) {
    const attrs = node.$ || {};
    const xmlUrl = attrs.xmlUrl || attrs.xmlurl || '';
    const channelId = extractYoutubeChannelId(xmlUrl);

    if (channelId) {
      items.push({
        channel_id: channelId,
        name: (attrs.title || attrs.text || channelId).trim(),
        avatar_url: '',
      });
    }

    items.push(...collectOpmlOutlines(toArray(node.outline)));
  }

  return items;
}

export async function parseYoutubeSubscriptionsOpml(
  opml: string,
): Promise<ImportedSubscriptionChannel[]> {
  const parsed = await parseStringPromise(opml);
  const body = parsed?.opml?.body?.[0];
  const outlineNodes = toArray<XmlNode>(body?.outline);
  const items = dedupeSubscriptions(collectOpmlOutlines(outlineNodes));

  if (items.length === 0) {
    throw new Error('文件格式错误，未解析到任何 YouTube 订阅');
  }

  return items;
}
