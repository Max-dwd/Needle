import type { Video } from './db';

/**
 * Builds the public watch URL for a video, optionally anchored to a timestamp.
 *
 * @param platform - The source platform that determines the URL format.
 * @param videoId - The platform-specific video identifier.
 * @param seconds - Optional seek offset to append when greater than zero.
 * @returns The fully qualified video URL.
 */
export function buildVideoUrl(
  platform: Video['platform'],
  videoId: string,
  seconds?: number,
): string {
  if (platform === 'youtube') {
    const url = new URL(`https://www.youtube.com/watch?v=${videoId}`);
    if (typeof seconds === 'number' && seconds > 0) {
      url.searchParams.set('t', `${Math.floor(seconds)}s`);
    }
    return url.toString();
  }
  const url = new URL(`https://www.bilibili.com/video/${videoId}/`);
  if (typeof seconds === 'number' && seconds > 0) {
    url.searchParams.set('t', `${Math.floor(seconds)}`);
  }
  return url.toString();
}

/**
 * Builds the public channel profile URL for the given platform and channel id.
 */
export function buildChannelUrl(
  platform: Video['platform'],
  channelId: string,
): string {
  if (platform === 'youtube') {
    const normalized = channelId.trim();
    if (!normalized) return 'https://www.youtube.com/';
    if (/^https?:\/\//i.test(normalized)) return normalized;
    if (normalized.startsWith('@')) {
      return `https://www.youtube.com/${normalized}`;
    }
    return `https://www.youtube.com/channel/${normalized}`;
  }
  return `https://space.bilibili.com/${channelId}`;
}
