import fs from 'fs';
import path from 'path';
import { type Video } from './db';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const SUMMARY_ROOT =
  process.env.SUMMARY_ROOT || path.join(DATA_ROOT, 'summaries');

export interface VideoSummaryMarkdownPayload {
  video_id: string;
  platform: Video['platform'];
  format: 'markdown';
  metadata: Record<string, string>;
  markdown: string;
  version?: 'current' | 'previous';
}

export interface VideoSummaryHistoryPayload {
  current: VideoSummaryMarkdownPayload | null;
  previous: VideoSummaryMarkdownPayload | null;
}

interface LegacySummaryBullet {
  timestamp: number;
  text: string;
}

interface LegacySummaryChapter {
  title: string;
  start: number;
  end: number;
  bullets: LegacySummaryBullet[];
}

interface LegacySummaryJsonPayload {
  video_id: string;
  platform: Video['platform'];
  summary: string;
  chapters: LegacySummaryChapter[];
}

function ensureSummaryDir(platform: Video['platform']): string {
  const dir = path.join(SUMMARY_ROOT, platform);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSummaryMarkdownPath(
  video: Pick<Video, 'platform' | 'video_id'>,
  version: 'current' | 'previous' = 'current',
): string {
  return path.join(
    ensureSummaryDir(video.platform),
    version === 'previous'
      ? `${video.video_id}.prev.md`
      : `${video.video_id}.md`,
  );
}

function getSummaryJsonPath(
  video: Pick<Video, 'platform' | 'video_id'>,
): string {
  return path.join(ensureSummaryDir(video.platform), `${video.video_id}.json`);
}

function parseFrontmatter(raw: string): {
  metadata: Record<string, string>;
  markdown: string;
} {
  if (!raw.startsWith('---\n')) {
    return { metadata: {}, markdown: raw.trim() };
  }

  const closingIndex = raw.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return { metadata: {}, markdown: raw.trim() };
  }

  const header = raw.slice(4, closingIndex).trim();
  const markdown = raw.slice(closingIndex + 5).trim();
  const metadata: Record<string, string> = {};

  for (const line of header.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    metadata[key] = value;
  }

  return { metadata, markdown };
}

function secondsToDisplay(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function buildVideoUrl(
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

function convertLegacyJsonToMarkdown(
  payload: LegacySummaryJsonPayload,
): string {
  const lines: string[] = [
    '---',
    `video_id: ${payload.video_id}`,
    `platform: ${payload.platform}`,
    `source_url: ${buildVideoUrl(payload.platform, payload.video_id)}`,
    'generated_from: legacy-json',
    '---',
    '',
    '# 视频总结',
    '',
    '## 核心总结',
    '',
    payload.summary || '暂无总结。',
    '',
  ];

  if (payload.chapters?.length) {
    lines.push('## 详细总结', '');
    for (const chapter of payload.chapters) {
      lines.push(`### ${chapter.title}`, '');
      for (const bullet of chapter.bullets || []) {
        const link = buildVideoUrl(
          payload.platform,
          payload.video_id,
          bullet.timestamp,
        );
        lines.push(
          `- ${bullet.text} [${secondsToDisplay(bullet.timestamp)}](${link})`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function buildPayloadFromMarkdown(
  video: Pick<Video, 'platform' | 'video_id'>,
  raw: string,
  version: 'current' | 'previous' = 'current',
): VideoSummaryMarkdownPayload {
  const { metadata, markdown } = parseFrontmatter(raw);
  return {
    video_id: metadata.video_id || video.video_id,
    platform: (metadata.platform as Video['platform']) || video.platform,
    format: 'markdown',
    metadata,
    markdown,
    version,
  };
}

function readMarkdownSummary(
  video: Pick<Video, 'platform' | 'video_id'>,
  version: 'current' | 'previous' = 'current',
): VideoSummaryMarkdownPayload | null {
  const markdownPath = getSummaryMarkdownPath(video, version);
  if (!fs.existsSync(markdownPath)) return null;

  const raw = fs.readFileSync(markdownPath, 'utf8');
  return buildPayloadFromMarkdown(video, raw, version);
}

export function readStoredVideoSummaryVersion(
  video: Pick<Video, 'platform' | 'video_id'>,
  version: 'current' | 'previous' = 'current',
): VideoSummaryMarkdownPayload | null {
  const markdownSummary = readMarkdownSummary(video, version);
  if (markdownSummary) return markdownSummary;

  if (version === 'previous') return null;

  const jsonPath = getSummaryJsonPath(video);
  if (!fs.existsSync(jsonPath)) return null;

  const legacy = JSON.parse(
    fs.readFileSync(jsonPath, 'utf8'),
  ) as LegacySummaryJsonPayload;
  const markdown = convertLegacyJsonToMarkdown(legacy);
  return buildPayloadFromMarkdown(video, markdown, 'current');
}

export function readStoredVideoSummaryHistory(
  video: Pick<Video, 'platform' | 'video_id'>,
): VideoSummaryHistoryPayload {
  return {
    current: readStoredVideoSummaryVersion(video, 'current'),
    previous: readStoredVideoSummaryVersion(video, 'previous'),
  };
}

export function readStoredVideoSummary(
  video: Pick<Video, 'platform' | 'video_id'>,
): VideoSummaryMarkdownPayload | null {
  return readStoredVideoSummaryVersion(video, 'current');
}

export function hasStoredVideoSummary(
  video: Pick<Video, 'platform' | 'video_id'>,
): boolean {
  return readStoredVideoSummary(video) !== null;
}

export function batchCheckSummaryExistence(
  videos: Array<Pick<Video, 'platform' | 'video_id'>>,
): Set<string> {
  const existingSummaryIds = new Set<string>();
  const requestedIdsByPlatform = new Map<Video['platform'], Set<string>>();

  for (const video of videos) {
    let platformIds = requestedIdsByPlatform.get(video.platform);
    if (!platformIds) {
      platformIds = new Set<string>();
      requestedIdsByPlatform.set(video.platform, platformIds);
    }
    platformIds.add(video.video_id);
  }

  for (const [platform, requestedIds] of requestedIdsByPlatform) {
    const summaryDir = path.join(SUMMARY_ROOT, platform);
    if (!fs.existsSync(summaryDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(summaryDir)) {
      let videoId: string | null = null;
      if (entry.endsWith('.prev.md')) {
        continue;
      }
      if (entry.endsWith('.md')) {
        videoId = entry.slice(0, -3);
      } else if (entry.endsWith('.json')) {
        videoId = entry.slice(0, -5);
      }

      if (videoId && requestedIds.has(videoId)) {
        existingSummaryIds.add(videoId);
      }
    }
  }

  return existingSummaryIds;
}
