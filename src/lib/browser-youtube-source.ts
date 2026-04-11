import {
  openBrowserWorkspaceLoginPage,
  withBrowserWorkspacePage,
} from './browser-session-manager';
import {
  asFieldValueRows,
  asOptionalString,
  asRecord,
  asString,
  buildYoutubeWatchUrl,
  extractYoutubeChannelId,
  normalizeChannelInfoRecord,
  normalizeVideoMetaRecord,
  normalizeVideoSummaryRecord,
  parseFieldValueMap,
  parseYoutubeVideoIdFromUrl,
  runBrowserJson,
  type BrowserChannelInfo,
  type BrowserExecOptions,
  type BrowserSubtitleRow,
  type BrowserVideoMeta,
  type BrowserVideoSummary,
  type BrowserYoutubeSubscriptionRow,
} from './browser-source-shared';

export const BROWSER_YOUTUBE_SUBSCRIPTIONS_WORKSPACE =
  'folo-youtube-subscriptions';

function normalizeYoutubeChannelVideosPayload(
  payload: unknown,
): BrowserVideoSummary[] {
  if (Array.isArray(payload)) {
    const directRows = payload
      .map((item) =>
        normalizeVideoSummaryRecord(asRecord(item) || {}, 'youtube'),
      )
      .filter((item): item is BrowserVideoSummary => Boolean(item));
    if (directRows.length > 0) return directRows;
  }

  const fieldRows = asFieldValueRows(payload);
  if (!fieldRows) {
    throw new Error(
      'browser youtube channel-videos returned unexpected payload',
    );
  }

  const videos: BrowserVideoSummary[] = [];
  let inRecentVideos = false;

  for (const row of fieldRows) {
    const field = asString(row.field);
    const value = asString(row.value);
    if (!field && !value) continue;
    if (field === '---' && /recent videos/i.test(value)) {
      inRecentVideos = true;
      continue;
    }
    if (!inRecentVideos) continue;

    const urlMatch = value.match(/https?:\/\/\S+$/);
    const url = urlMatch?.[0] || '';
    const videoId = parseYoutubeVideoIdFromUrl(url);
    if (!videoId || !field) continue;
    const parts = value
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    videos.push({
      video_id: videoId,
      title: field,
      url: url || undefined,
      duration: parts[0] && !parts[0].startsWith('http') ? parts[0] : undefined,
    });
  }

  return videos;
}

function normalizeYoutubeVideoMetaPayload(
  payload: unknown,
  videoIdOrUrl: string,
): BrowserVideoMeta {
  const fallbackId = parseYoutubeVideoIdFromUrl(videoIdOrUrl);
  const record = asRecord(payload);
  if (record) {
    return normalizeVideoMetaRecord(record, 'youtube', fallbackId);
  }

  const rows = asFieldValueRows(payload);
  if (!rows) {
    throw new Error('browser youtube video-meta returned unexpected payload');
  }

  return normalizeVideoMetaRecord(
    parseFieldValueMap(rows),
    'youtube',
    fallbackId,
  );
}

function normalizeYoutubeChannelInfoPayload(
  payload: unknown,
  channelIdOrUrl: string,
): BrowserChannelInfo {
  const record = asRecord(payload);
  if (record) {
    if (Array.isArray(record.recentVideos)) delete record.recentVideos;
    return normalizeChannelInfoRecord(record, channelIdOrUrl);
  }

  const rows = asFieldValueRows(payload);
  if (!rows) {
    throw new Error('browser youtube channel-info returned unexpected payload');
  }

  return normalizeChannelInfoRecord(parseFieldValueMap(rows), channelIdOrUrl);
}

export async function fetchBrowserYoutubeChannelVideos(
  channelIdOrUrl: string,
  limit = 20,
  options?: BrowserExecOptions,
): Promise<BrowserVideoSummary[]> {
  const payload = await runBrowserJson(
    ['youtube', 'channel-videos', channelIdOrUrl, '--limit', String(limit)],
    {
      ...options,
      strategy: 'metadata',
    },
  );

  return normalizeYoutubeChannelVideosPayload(payload);
}

export async function fetchBrowserYoutubeVideoMeta(
  videoIdOrUrl: string,
  options?: BrowserExecOptions,
): Promise<BrowserVideoMeta> {
  const commandInput = buildYoutubeWatchUrl(videoIdOrUrl);
  const payload = await runBrowserJson(
    ['youtube', 'video-meta', commandInput],
    {
      ...options,
      strategy: 'metadata',
    },
  );

  return normalizeYoutubeVideoMetaPayload(payload, videoIdOrUrl);
}

export async function fetchBrowserYoutubeChannelInfo(
  channelIdOrUrl: string,
  options?: BrowserExecOptions,
): Promise<BrowserChannelInfo> {
  const payload = await runBrowserJson(
    ['youtube', 'channel-info', channelIdOrUrl],
    {
      ...options,
      strategy: 'metadata',
    },
  );

  return normalizeYoutubeChannelInfoPayload(payload, channelIdOrUrl);
}

export async function fetchBrowserYoutubeTranscriptRows(
  videoUrlOrId: string,
  options?: BrowserExecOptions,
): Promise<BrowserSubtitleRow[]> {
  const result = await runBrowserJson(
    ['youtube', 'transcript', videoUrlOrId, '--mode', 'raw'],
    options,
  );
  if (!Array.isArray(result)) {
    throw new Error('browser youtube transcript returned unexpected payload');
  }
  return result as BrowserSubtitleRow[];
}

export async function fetchBrowserYoutubeSubscriptionsViaBridge(): Promise<
  BrowserYoutubeSubscriptionRow[]
> {
  return withBrowserWorkspacePage(
    {
      workspace: BROWSER_YOUTUBE_SUBSCRIPTIONS_WORKSPACE,
      timeoutSeconds: 30,
    },
    async (page) => {
      await page.goto('https://www.youtube.com/feed/channels', {
        waitUntil: 'domcontentloaded',
        settleMs: 1500,
      });

      const result = await page.evaluate(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeId = (raw) => {
          const value = String(raw || '').trim();
          if (!value) return '';
          if (/^(UC|HC)[A-Za-z0-9_-]+$/.test(value)) return value;
          try {
            const parsed = value.startsWith('http')
              ? new URL(value)
              : new URL(value, 'https://www.youtube.com');
            const direct = parsed.searchParams.get('channel_id');
            if (direct) return direct;
            const pathname = parsed.pathname.replace(/\\/+$/, '');
            const channelMatch = pathname.match(/\\/channel\\/((?:UC|HC)[A-Za-z0-9_-]+)/);
            if (channelMatch && channelMatch[1]) return channelMatch[1];
            const handleMatch = pathname.match(/\\/(@[A-Za-z0-9._-]+)/);
            if (handleMatch && handleMatch[1]) return handleMatch[1];
            const userMatch = pathname.match(/\\/(?:user|c)\\/([A-Za-z0-9._-]+)/);
            if (userMatch && userMatch[1]) return userMatch[1];
          } catch {}
          return value;
        };

        const normalizeAvatar = (raw) => {
          const value = String(raw || '').trim();
          if (!value) return '';
          if (value.startsWith('//')) return 'https:' + value;
          return value.replace(/^http:\\/\\//, 'https://');
        };

        const collapseRepeatedText = (value) => {
          const text = String(value || '').trim();
          if (!text) return '';
          const repeatedPhrase = text.match(/^(.{1,120}?)\\s+\\1$/u);
          if (repeatedPhrase && repeatedPhrase[1]) {
            return repeatedPhrase[1].trim();
          }
          const tokens = text.split(/\\s+/).filter(Boolean);
          if (tokens.length % 2 === 0 && tokens.length > 1) {
            const half = tokens.length / 2;
            const left = tokens.slice(0, half).join(' ');
            const right = tokens.slice(half).join(' ');
            if (left === right) return left;
          }
          return text;
        };

        const pickAvatar = (root) => {
          if (!root || !root.querySelector) return '';
          const img =
            root.querySelector('yt-img-shadow img') ||
            root.querySelector('#avatar img') ||
            root.querySelector('#content img') ||
            root.querySelector('img');
          if (!img) return '';

          const srcset = String(img.getAttribute('srcset') || '').trim();
          if (srcset) {
            const candidates = srcset
              .split(',')
              .map((entry) => entry.trim().split(/\\s+/)[0])
              .filter(Boolean);
            const best = candidates[candidates.length - 1];
            if (best) return normalizeAvatar(best);
          }

          const direct =
            img.getAttribute('src') ||
            img.getAttribute('data-thumb') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-image-src') ||
            img.currentSrc ||
            '';
          return normalizeAvatar(direct);
        };

        const collect = () => {
          const map = new Map();
          const cardSelectors = [
            'ytd-channel-renderer',
            'ytd-grid-channel-renderer',
            'ytd-rich-item-renderer',
            'yt-lockup-view-model',
          ];
          const cards = Array.from(document.querySelectorAll(cardSelectors.join(',')));

          const cleanText = (value) =>
            String(value || '')
              .replace(/\\s+/g, ' ')
              .trim();

          const pickText = (root, selectors) => {
            if (!root || !root.querySelector) return '';
            for (const selector of selectors) {
              const node = root.querySelector(selector);
              const text = cleanText(node && (node.textContent || node.innerText));
              if (text) return text;
            }
            return '';
          };

          const pickDescription = (root) => {
            const text = pickText(root, [
              '#description-text',
              '#description',
              '#metadata-line',
              '#subtitle',
              '#text',
              'yt-content-metadata-view-model',
              'yt-formatted-string#metadata-line',
            ]);
            if (!text) return '';
            const parts = text
              .split(/[·•]/)
              .map((part) => cleanText(part))
              .filter(Boolean);
            const filtered = parts.filter(
              (part) =>
                !/^@/.test(part) &&
                !/^(UC|HC)[A-Za-z0-9_-]+$/.test(part) &&
                !/^[0-9.,]+\s*(subscriber|subscribers|位订阅者|訂閱者|位追踪者)$/i.test(part),
            );
            return cleanText(filtered.join(' · ') || text);
          };

          const addRow = (root, anchor) => {
            if (!anchor) return;
            const href = anchor.getAttribute('href') || '';
            const channelId = normalizeId(href);
            if (!channelId || map.has(channelId)) return;
            const name = collapseRepeatedText(cleanText(
              pickText(root, [
                '#channel-title',
                '#channel-name',
                '#title',
                'a#main-link yt-formatted-string',
                'span.yt-core-attributed-string',
              ]) ||
                anchor.getAttribute('title') ||
                anchor.getAttribute('aria-label') ||
                anchor.textContent ||
                '',
            )) || channelId;
            const avatarUrl = pickAvatar(root);
            const description = pickDescription(root);
            map.set(channelId, {
              channel_id: channelId,
              name,
              avatar_url: avatarUrl,
              description,
            });
          };

          for (const card of cards) {
            const anchor =
              card.querySelector('a#main-link[href]') ||
              card.querySelector('a[href^="/channel/"]') ||
              card.querySelector('a[href^="/@"]') ||
              card.querySelector('a[href*="/user/"]') ||
              card.querySelector('a[href*="/c/"]');
            addRow(card, anchor);
          }

          if (map.size === 0) {
            const anchors = Array.from(
              document.querySelectorAll(
                'a[href^="/channel/"], a[href^="/@"], a[href*="/user/"], a[href*="/c/"]',
              ),
            );
            for (const anchor of anchors) {
              const text = (anchor.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!text || text.length > 120) continue;
              addRow(anchor.closest('a, ytd-channel-renderer, ytd-grid-channel-renderer, ytd-rich-item-renderer, yt-lockup-view-model, div'), anchor);
            }
          }

          return Array.from(map.values());
        };

        const revealVisibleCards = async () => {
          const cards = Array.from(
            document.querySelectorAll(
              [
                'ytd-channel-renderer',
                'ytd-grid-channel-renderer',
                'ytd-rich-item-renderer',
                'yt-lockup-view-model',
              ].join(','),
            ),
          );

          for (let index = 0; index < cards.length; index += 1) {
            const card = cards[index];
            if (!card || typeof card.scrollIntoView !== 'function') continue;
            card.scrollIntoView({ block: 'center' });
            if (index % 6 === 0) {
              await sleep(250);
            }
          }
          await sleep(500);
        };

        let lastCount = -1;
        let stableRounds = 0;
        for (let round = 0; round < 18; round += 1) {
          await revealVisibleCards();
          const rows = collect();
          if (rows.length === lastCount) stableRounds += 1;
          else stableRounds = 0;
          lastCount = rows.length;
          if (rows.length > 0 && stableRounds >= 2) break;
          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(1200);
        }

        const rows = collect();
        if (rows.length > 0) return rows;

        const pageText = (document.body && document.body.innerText
          ? document.body.innerText
          : '')
          .replace(/\\s+/g, ' ')
          .trim();

        if (/sign in|登录|signin/i.test(pageText)) {
          throw new Error('Not logged in to YouTube');
        }

        throw new Error('无法从 YouTube 订阅页解析频道列表');
      })()`);

      if (!Array.isArray(result)) {
        throw new Error(
          'browser YouTube subscriptions returned unexpected payload',
        );
      }

      return (result as Array<Record<string, unknown>>)
        .map((item) => ({
          channel_id: extractYoutubeChannelId(asString(item.channel_id)),
          name:
            asString(item.name) ||
            extractYoutubeChannelId(asString(item.channel_id)),
          avatar_url: asOptionalString(item.avatar_url) || '',
          description: asOptionalString(item.description),
        }))
        .filter((item) => Boolean(item.channel_id));
    },
  );
}

export async function openBrowserYoutubeLoginPage(): Promise<void> {
  return openBrowserWorkspaceLoginPage({
    workspace: BROWSER_YOUTUBE_SUBSCRIPTIONS_WORKSPACE,
    url: 'https://www.youtube.com/feed/channels',
    timeoutSeconds: 30,
    settleMs: 1500,
  });
}
