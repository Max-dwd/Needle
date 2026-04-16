import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAppSetting, setAppSetting } from './app-settings';

const execFileAsync = promisify(execFile);

const YOUTUBE_PLAYBACK_CACHE_KEY = 'youtube_playback_cache';
const CACHE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_REFRESH_GRACE_MS = 60 * 1000;
const YOUTUBE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  'yt-dlp',
].filter((value): value is string => Boolean(value && value.trim()));

interface YouTubePlaybackCache {
  version: 1;
  entries: Record<string, ResolvedYouTubeStream>;
}

export interface ResolvedYouTubeStream {
  url: string;
  expiresAt: number;
}

function pickYtDlpBinary(): string {
  for (const candidate of YT_DLP_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('yt-dlp binary not found');
}

function readCache(): YouTubePlaybackCache {
  const raw = getAppSetting(YOUTUBE_PLAYBACK_CACHE_KEY);
  if (!raw) return { version: 1, entries: {} };

  try {
    const parsed = JSON.parse(raw) as Partial<YouTubePlaybackCache>;
    if (!parsed || parsed.version !== 1 || !parsed.entries) {
      return { version: 1, entries: {} };
    }
    return {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(parsed.entries).filter(([, entry]) => {
          return (
            typeof entry?.url === 'string' &&
            entry.url.startsWith('http') &&
            typeof entry.expiresAt === 'number' &&
            Number.isFinite(entry.expiresAt)
          );
        }),
      ),
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeCache(cache: YouTubePlaybackCache) {
  const now = Date.now();
  const entries = Object.fromEntries(
    Object.entries(cache.entries).filter(
      ([, entry]) => entry.expiresAt > now - CACHE_TTL_MS,
    ),
  );
  setAppSetting(
    YOUTUBE_PLAYBACK_CACHE_KEY,
    JSON.stringify({ version: 1, entries }),
  );
}

function readCachedStream(videoId: string): ResolvedYouTubeStream | null {
  const cache = readCache();
  const cached = cache.entries[videoId];
  if (!cached) return null;
  if (cached.expiresAt <= Date.now() + EXPIRY_REFRESH_GRACE_MS) {
    delete cache.entries[videoId];
    writeCache(cache);
    return null;
  }
  return cached;
}

function writeCachedStream(videoId: string, value: ResolvedYouTubeStream) {
  const cache = readCache();
  cache.entries[videoId] = value;
  writeCache(cache);
}

function extractExpiryFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const raw =
      parsed.searchParams.get('expire') || parsed.searchParams.get('expires');
    if (!raw) return null;
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  } catch {
    return null;
  }
}

function parseYtDlpUrls(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

export function invalidateYouTubePlaybackCache(videoId: string) {
  const cache = readCache();
  delete cache.entries[videoId];
  writeCache(cache);
}

export async function resolveYouTubeStream(
  videoId: string,
  options?: { refresh?: boolean },
): Promise<ResolvedYouTubeStream> {
  if (!options?.refresh) {
    const cached = readCachedStream(videoId);
    if (cached) return cached;
  }

  const targetUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const result = await execFileAsync(
    pickYtDlpBinary(),
    [
      '-g',
      '-f',
      'best[ext=mp4][height<=720]/best',
      '--no-playlist',
      '--',
      targetUrl,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      signal: AbortSignal.timeout(45_000),
    } as Parameters<typeof execFileAsync>[2],
  );

  const urls = parseYtDlpUrls(String(result.stdout || ''));
  const url = urls[0];
  if (!url) {
    throw new Error('yt-dlp did not return a playable YouTube stream');
  }

  const now = Date.now();
  const remoteExpiresAt = extractExpiryFromUrl(url) ?? now + 6 * 60 * 60 * 1000;
  const expiresAt = Math.min(remoteExpiresAt, now + CACHE_TTL_MS);
  const resolved = { url, expiresAt };
  writeCachedStream(videoId, resolved);
  return resolved;
}

export function buildYouTubeMediaHeaders(
  requestHeaders: Headers,
  videoId: string,
): Headers {
  const headers = new Headers({
    Referer: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    'User-Agent': YOUTUBE_USER_AGENT,
  });

  const range = requestHeaders.get('range');
  if (range) headers.set('Range', range);

  const ifRange = requestHeaders.get('if-range');
  if (ifRange) headers.set('If-Range', ifRange);

  return headers;
}
