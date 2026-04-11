import { getBilibiliSessdata } from './bilibili-auth';
import { signAndFetchBilibili } from './wbi';

const BILIBILI_REFERER = 'https://www.bilibili.com/';
const BILIBILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const PLAYBACK_CACHE_TTL_MS = 100 * 60 * 1000;
const DEFAULT_QUALITY_ORDER = [64, 32, 16];

interface BilibiliApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

interface BilibiliViewData {
  cid?: number;
  aid?: number;
  title?: string;
}

interface BilibiliSupportFormat {
  quality?: number;
  new_description?: string;
  display_desc?: string;
  format?: string;
}

interface BilibiliDurlItem {
  url?: string;
  backup_url?: string[] | null;
}

interface BilibiliPlayurlData {
  quality?: number;
  format?: string;
  timelength?: number;
  durl?: BilibiliDurlItem[];
  support_formats?: BilibiliSupportFormat[];
}

interface BilibiliPlaybackCacheEntry {
  expiresAt: number;
  value: ResolvedBilibiliPlayback;
}

export interface BilibiliViewInfo {
  bvid: string;
  cid: number;
  aid: number | null;
  title: string | null;
}

export interface ResolvedBilibiliPlayback {
  directUrl: string;
  backupUrls: string[];
  durationMs: number | null;
  quality: number | null;
  qualityLabel: string | null;
  format: string | null;
  authUsed: boolean;
  segmentCount: number;
}

const playbackCache = new Map<string, BilibiliPlaybackCacheEntry>();

function buildBilibiliApiHeaders(sessdata?: string): HeadersInit {
  const headers: Record<string, string> = {
    Referer: BILIBILI_REFERER,
    'User-Agent': BILIBILI_USER_AGENT,
  };
  if (sessdata) {
    headers.Cookie = `SESSDATA=${sessdata}`;
  }
  return headers;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildPlaybackCacheKey(
  bvid: string,
  cid: number,
  preferredQn?: number,
): string {
  return `${bvid}:${cid}:${preferredQn ?? 'auto'}`;
}

function readCachedPlayback(cacheKey: string): ResolvedBilibiliPlayback | null {
  const cached = playbackCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    playbackCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function writeCachedPlayback(
  cacheKey: string,
  value: ResolvedBilibiliPlayback,
) {
  playbackCache.set(cacheKey, {
    expiresAt: Date.now() + PLAYBACK_CACHE_TTL_MS,
    value,
  });
}

function normalizeQualityOrder(preferredQn?: number): number[] {
  const requested =
    preferredQn && Number.isFinite(preferredQn) ? [preferredQn] : [];
  return Array.from(new Set([...requested, ...DEFAULT_QUALITY_ORDER])).filter(
    (value) => value > 0,
  );
}

function formatPlayurlError(
  payload: BilibiliApiResponse<unknown>,
  requestedQn: number,
): string {
  const message = payload.message?.trim();
  if (message) return message;
  return `B站播放接口未返回 MP4 直链（qn=${requestedQn}, code=${payload.code})`;
}

export function invalidateBilibiliPlaybackCache(
  bvid: string,
  cid: number,
  preferredQn?: number,
) {
  playbackCache.delete(buildPlaybackCacheKey(bvid, cid, preferredQn));
}

export async function fetchBilibiliViewInfo(
  bvid: string,
): Promise<BilibiliViewInfo> {
  const sessdata = getBilibiliSessdata() || undefined;
  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    {
      headers: buildBilibiliApiHeaders(sessdata),
      cache: 'no-store',
    },
  );

  const payload =
    (await response.json()) as BilibiliApiResponse<BilibiliViewData>;
  if (payload.code !== 0 || !payload.data?.cid) {
    throw new Error(payload.message || '无法读取 B 站视频信息');
  }

  return {
    bvid,
    cid: payload.data.cid,
    aid: payload.data.aid ?? null,
    title: payload.data.title ?? null,
  };
}

export async function resolveBilibiliPlayback(
  bvid: string,
  cid: number,
  preferredQn?: number,
): Promise<ResolvedBilibiliPlayback> {
  const cacheKey = buildPlaybackCacheKey(bvid, cid, preferredQn);
  const cached = readCachedPlayback(cacheKey);
  if (cached) return cached;

  const sessdata = getBilibiliSessdata().trim();
  const sessionCandidates = sessdata ? [sessdata, ''] : [''];
  const qualities = normalizeQualityOrder(preferredQn);
  let lastError = '当前视频未返回可直接播放的 MP4 单路流';

  for (const currentSessdata of sessionCandidates) {
    for (const qn of qualities) {
      const response = await signAndFetchBilibili(
        'https://api.bilibili.com/x/player/wbi/playurl',
        {
          bvid,
          cid,
          qn,
          fnval: 1,
          fnver: 0,
          fourk: 0,
          platform: 'html5',
          high_quality: 1,
          try_look: 1,
        },
        currentSessdata || undefined,
      );

      const payload =
        (await response.json()) as BilibiliApiResponse<BilibiliPlayurlData>;
      if (payload.code !== 0 || !payload.data) {
        lastError = formatPlayurlError(payload, qn);
        continue;
      }

      const data = payload.data;
      const durl = Array.isArray(data.durl) ? data.durl : [];
      const primarySegment = durl.find(
        (item) => typeof item.url === 'string' && item.url.trim(),
      );
      if (!primarySegment?.url) {
        lastError = `B站播放接口未返回 MP4 直链（qn=${qn}）`;
        continue;
      }

      const resolved: ResolvedBilibiliPlayback = {
        directUrl: primarySegment.url,
        backupUrls: dedupeStrings(primarySegment.backup_url || []),
        durationMs: data.timelength ?? null,
        quality: data.quality ?? qn,
        qualityLabel:
          data.support_formats?.find(
            (item) => item.quality === (data.quality ?? qn),
          )?.new_description ||
          data.support_formats?.find(
            (item) => item.quality === (data.quality ?? qn),
          )?.display_desc ||
          null,
        format: data.format ?? null,
        authUsed: Boolean(currentSessdata),
        segmentCount: durl.length,
      };

      writeCachedPlayback(cacheKey, resolved);
      return resolved;
    }
  }

  throw new Error(lastError);
}

export function buildBilibiliMediaHeaders(
  requestHeaders?: Headers,
  sessdata?: string,
): Headers {
  const headers = new Headers({
    Referer: BILIBILI_REFERER,
    'User-Agent': BILIBILI_USER_AGENT,
  });

  const range = requestHeaders?.get('range');
  if (range) headers.set('Range', range);

  const ifRange = requestHeaders?.get('if-range');
  if (ifRange) headers.set('If-Range', ifRange);

  if (sessdata) {
    headers.set('Cookie', `SESSDATA=${sessdata}`);
  }

  return headers;
}
