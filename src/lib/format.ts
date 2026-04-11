/**
 * Formats a duration in seconds as a zero-padded `mm:ss` string.
 */
export function formatSecondsToDisplay(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

/**
 * Returns a human-readable relative timestamp for a published date.
 */
export function timeAgo(dateStr: string): string {
  const parsed = Date.parse(dateStr);
  if (!Number.isFinite(parsed)) return dateStr;

  const now = Date.now();
  const then = parsed;
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
  return new Date(parsed).toLocaleDateString('zh-CN');
}

/**
 * Formats a duration in seconds as either `mm:ss` or `h:mm:ss`.
 */
export function formatSecondsLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return formatSecondsToDisplay(safe);
}

/**
 * Maps subtitle state to the compact badge label shown in the UI.
 *
 * @param video - Video subtitle status fields used to determine the badge text.
 * @returns The badge label to render, or `null` when no badge is needed.
 */
export function getSubtitleBadgeLabel(video: {
  subtitle_status: string | null;
  subtitle_cooldown_until: string | null;
}): string | null {
  switch (getSubtitleDisplayState(video)) {
    case 'ready':
      return '🇨';
    case 'fetching':
      return '抓取中';
    case 'cooldown':
    case 'error':
      return '!';
    default:
      return null;
  }
}

export function getSubtitleDisplayState(video: {
  subtitle_status: string | null;
  subtitle_cooldown_until: string | null;
}): 'ready' | 'fetching' | 'cooldown' | 'error' | 'missing' | 'idle' {
  const status = video.subtitle_status;
  if (status === 'fetched') {
    return 'ready';
  }
  if (status === 'fetching') {
    return 'fetching';
  }
  if (status === 'cooldown' || Boolean(video.subtitle_cooldown_until)) {
    return 'cooldown';
  }
  if (status === 'error') {
    return 'error';
  }
  if (status === 'missing' || status === 'empty') {
    return 'missing';
  }
  return 'idle';
}

export function hasSubtitleReady(video: {
  subtitle_status: string | null;
  subtitle_cooldown_until: string | null;
}): boolean {
  switch (getSubtitleDisplayState(video)) {
    case 'ready':
      return true;
    default:
      return false;
  }
}

/**
 * Normalizes a relative or absolute YouTube comment URL into a full URL.
 */
export function normalizeCommentUrl(url?: string): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `https://www.youtube.com${url}`;
  return null;
}

function getExternalUrl(video: {
  platform: 'youtube' | 'bilibili';
  video_id: string;
}): string {
  if (video.platform === 'youtube')
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  return `https://www.bilibili.com/video/${video.video_id}`;
}

function parseDurationParam(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const compactSeconds = normalized.endsWith('s')
    ? normalized.slice(0, -1)
    : normalized;
  if (/^\d+$/.test(compactSeconds)) {
    return Math.max(0, Math.floor(Number(compactSeconds)));
  }

  const matches = Array.from(normalized.matchAll(/(\d+)(h|m|s)/g));
  if (matches.length === 0) return null;

  let consumed = '';
  let totalSeconds = 0;
  for (const match of matches) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    consumed += match[0];
    if (match[2] === 'h') totalSeconds += amount * 3600;
    if (match[2] === 'm') totalSeconds += amount * 60;
    if (match[2] === 's') totalSeconds += amount;
  }

  if (consumed !== normalized) return null;
  return totalSeconds;
}

/**
 * Extracts a seek timestamp from a YouTube or Bilibili link for the same video.
 *
 * @param href - The timestamped link to inspect.
 * @param video - The video that the link must refer to.
 * @returns The parsed seek offset in seconds, or `null` when no valid timestamp exists.
 */
export function parseSeekSeconds(
  href: string,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): number | null {
  try {
    const url = new URL(href, getExternalUrl(video));
    if (video.platform === 'youtube') {
      if (
        url.hostname !== 'www.youtube.com' &&
        url.hostname !== 'youtube.com' &&
        url.hostname !== 'youtu.be'
      ) {
        return null;
      }
      const videoId =
        url.searchParams.get('v') ||
        url.pathname.split('/').filter(Boolean).pop();
      if (videoId !== video.video_id) return null;
      const tValue = url.searchParams.get('t') || url.searchParams.get('start');
      if (!tValue) return null;
      return parseDurationParam(tValue);
    }

    if (!url.hostname.includes('bilibili.com')) return null;
    if (!url.pathname.includes(video.video_id)) return null;
    const tValue = url.searchParams.get('t');
    if (!tValue) return null;
    return parseDurationParam(tValue);
  } catch {
    return null;
  }
}
