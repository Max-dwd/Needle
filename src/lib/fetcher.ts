import { execFile } from 'child_process';
import { log } from './logger';
import { updateCrawlerScopeStatus } from './crawler-status';
import { BROWSER_METHOD_ID, isBrowserMethodId } from './browser-method';
import {
  fetchBrowserBilibiliChannelInfo,
  fetchBrowserBilibiliUserVideos,
  fetchBrowserBilibiliVideoMeta,
} from './browser-bilibili-source';
import {
  fetchBrowserYoutubeChannelInfo,
  fetchBrowserYoutubeChannelVideos,
  fetchBrowserYoutubeVideoMeta,
} from './browser-youtube-source';
import { normalizeBrowserError } from './browser-source-shared';
import {
  getCrawlPipelineSourceOrder,
  getPreferredCrawlMethod,
} from './pipeline-config';

interface VideoInfo {
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string;
  thumbnail_url: string;
  published_at: string;
  duration?: string;
  is_members_only?: number;
  access_status?: 'members_only' | 'limited_free';
  channel_name?: string;
}

export interface ChannelInfo {
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string;
  avatar_url: string;
}

export function runYtDlp(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function resolveFeedTargetLabel(
  channelName: string | undefined,
  channelId: string,
): string {
  const label = channelName?.trim();
  return label || channelId;
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim();
}

function normalizeThumb(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url.replace(/^http:\/\//, 'https://');
}

function normalizeBrowserVideo(
  platform: 'youtube' | 'bilibili',
  video: {
    video_id: string;
    title: string;
    thumbnail_url?: string;
    published_at?: string;
    duration?: string;
    is_members_only?: number;
    access_status?: 'members_only' | 'limited_free';
    channel_name?: string;
  },
): VideoInfo | null {
  const videoId = video.video_id.trim();
  const title = stripHtmlTags(video.title || '');
  if (!videoId || !title) return null;

  return {
    video_id: videoId,
    platform,
    title,
    thumbnail_url: normalizeThumb(video.thumbnail_url),
    published_at: video.published_at || '',
    duration: video.duration || '',
    is_members_only: video.is_members_only,
    access_status: video.access_status,
    channel_name: video.channel_name,
  };
}

function compactLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function logFeedAttempt(
  platform: 'youtube' | 'bilibili',
  method: string,
  channel_id: string,
  channel_name?: string,
) {
  log.info('feed', 'attempt', {
    platform,
    method,
    channel_id,
    channel_name: channel_name ?? null,
  });
}

function logFeedSuccess(
  platform: 'youtube' | 'bilibili',
  method: string,
  channel_id: string,
  count: number,
  channel_name?: string,
) {
  log.info('feed', 'success', {
    platform,
    method,
    channel_id,
    channel_name: channel_name ?? null,
    count,
  });
}

function logFeedFailure(
  platform: 'youtube' | 'bilibili',
  method: string,
  channel_id: string,
  reason: string,
  channel_name?: string,
) {
  log.error('feed', 'failure', {
    platform,
    method,
    channel_id,
    channel_name: channel_name ?? null,
    error: compactLogValue(reason),
  });
}

export async function resolveYouTubeChannelId(url: string): Promise<string> {
  const patterns = [
    /youtube\.com\/channel\/([A-Za-z0-9_-]+)/i,
    /youtube\.com\/(@[A-Za-z0-9._-]+)/i,
    /youtube\.com\/user\/([A-Za-z0-9._-]+)/i,
    /youtube\.com\/c\/([A-Za-z0-9._-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }

  throw new Error(`Cannot parse YouTube channel ID from URL: ${url}`);
}

export async function parseBilibiliUid(url: string): Promise<string> {
  const match = url.match(/space\.bilibili\.com\/(\d+)/i);
  if (match?.[1]) return match[1];
  const trimmed = url.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  throw new Error(`Cannot parse Bilibili UID from: ${url}`);
}

export async function fetchYouTubeChannelInfo(
  channelInput: string,
): Promise<ChannelInfo> {
  const info = await fetchBrowserYoutubeChannelInfo(channelInput);
  return {
    platform: 'youtube',
    channel_id: info.channel_id,
    name: info.name,
    avatar_url: info.avatar_url,
  };
}

export async function fetchBilibiliChannelInfo(
  uidOrUrl: string,
): Promise<ChannelInfo> {
  const info = await fetchBrowserBilibiliChannelInfo(uidOrUrl);
  return {
    platform: 'bilibili',
    channel_id: info.channel_id,
    name: info.name,
    avatar_url: info.avatar_url,
  };
}

export async function fetchYouTubeVideoDetail(
  videoId: string,
): Promise<Partial<VideoInfo> | null> {
  try {
    const detail = await fetchBrowserYoutubeVideoMeta(videoId);
    return normalizeBrowserVideo('youtube', detail);
  } catch {
    return null;
  }
}

export async function fetchBilibiliVideoDetail(
  bvid: string,
): Promise<Partial<VideoInfo> | null> {
  try {
    const detail = await fetchBrowserBilibiliVideoMeta(bvid);
    return normalizeBrowserVideo('bilibili', detail);
  } catch {
    return null;
  }
}

export async function fetchYouTubeFeed(
  channelId: string,
  channelName?: string,
): Promise<VideoInfo[]> {
  const methods = getCrawlPipelineSourceOrder('youtube').filter(
    (method): method is 'browser' => isBrowserMethodId(method),
  );
  const preferredMethod =
    getPreferredCrawlMethod('youtube') || BROWSER_METHOD_ID;

  if (methods.length === 0) {
    const message = 'No enabled YouTube crawl pipeline sources configured';
    updateCrawlerScopeStatus('feed', {
      state: 'error',
      platform: 'youtube',
      preferredMethod,
      activeMethod: preferredMethod,
      isFallback: false,
      targetId: channelId,
      targetLabel: resolveFeedTargetLabel(channelName, channelId),
      message,
    });
    throw new Error(message);
  }

  logFeedAttempt('youtube', BROWSER_METHOD_ID, channelId, channelName);
  updateCrawlerScopeStatus('feed', {
    state: 'running',
    platform: 'youtube',
    preferredMethod,
    activeMethod: BROWSER_METHOD_ID,
    isFallback: false,
    targetId: channelId,
    targetLabel: resolveFeedTargetLabel(channelName, channelId),
    message: 'Fetching YouTube feed via Needle Browser',
  });

  try {
    const videos = (await fetchBrowserYoutubeChannelVideos(channelId, 30))
      .map((item) => normalizeBrowserVideo('youtube', item))
      .filter((item): item is VideoInfo => Boolean(item));

    if (videos.length === 0) {
      throw new Error(
        'Needle Browser YouTube channel-videos returned empty result',
      );
    }

    logFeedSuccess(
      'youtube',
      BROWSER_METHOD_ID,
      channelId,
      videos.length,
      channelName,
    );
    return videos;
  } catch (error) {
    const reason = normalizeBrowserError(error);
    updateCrawlerScopeStatus('feed', {
      state: 'error',
      platform: 'youtube',
      preferredMethod,
      activeMethod: BROWSER_METHOD_ID,
      isFallback: false,
      targetId: channelId,
      targetLabel: resolveFeedTargetLabel(channelName, channelId),
      message: reason,
    });
    logFeedFailure(
      'youtube',
      BROWSER_METHOD_ID,
      channelId,
      reason,
      channelName,
    );
    throw new Error(reason);
  }
}

export async function fetchBilibiliFeed(
  uid: string,
  channelName?: string,
): Promise<VideoInfo[]> {
  const methods = getCrawlPipelineSourceOrder('bilibili').filter(
    (method): method is 'browser' => isBrowserMethodId(method),
  );
  const preferredMethod =
    getPreferredCrawlMethod('bilibili') || BROWSER_METHOD_ID;

  if (methods.length === 0) {
    const message = 'No enabled Bilibili crawl pipeline sources configured';
    updateCrawlerScopeStatus('feed', {
      state: 'error',
      platform: 'bilibili',
      preferredMethod,
      activeMethod: preferredMethod,
      isFallback: false,
      targetId: uid,
      targetLabel: resolveFeedTargetLabel(channelName, uid),
      message,
    });
    throw new Error(message);
  }

  logFeedAttempt('bilibili', BROWSER_METHOD_ID, uid, channelName);
  updateCrawlerScopeStatus('feed', {
    state: 'running',
    platform: 'bilibili',
    preferredMethod,
    activeMethod: BROWSER_METHOD_ID,
    isFallback: false,
    targetId: uid,
    targetLabel: resolveFeedTargetLabel(channelName, uid),
    message: 'Fetching Bilibili feed via Needle Browser',
  });

  try {
    const videos = (await fetchBrowserBilibiliUserVideos(uid, 20))
      .map((item) => normalizeBrowserVideo('bilibili', item))
      .filter((item): item is VideoInfo => Boolean(item));

    if (videos.length === 0) {
      throw new Error(
        'Needle Browser bilibili user-videos returned empty result',
      );
    }

    logFeedSuccess(
      'bilibili',
      BROWSER_METHOD_ID,
      uid,
      videos.length,
      channelName,
    );
    return videos;
  } catch (error) {
    const reason = normalizeBrowserError(error);
    updateCrawlerScopeStatus('feed', {
      state: 'error',
      platform: 'bilibili',
      preferredMethod,
      activeMethod: BROWSER_METHOD_ID,
      isFallback: false,
      targetId: uid,
      targetLabel: resolveFeedTargetLabel(channelName, uid),
      message: reason,
    });
    logFeedFailure('bilibili', BROWSER_METHOD_ID, uid, reason, channelName);
    throw new Error(reason);
  }
}

export async function resolveChannelFromUrl(url: string): Promise<ChannelInfo> {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return fetchYouTubeChannelInfo(url);
  }
  if (url.includes('bilibili.com') || url.includes('space.bilibili.com')) {
    return fetchBilibiliChannelInfo(url);
  }
  throw new Error(`Unsupported platform URL: ${url}`);
}
