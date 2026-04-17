import fs from 'fs';
import { log } from './logger';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb, type Video } from './db';
import { appEvents } from './events';
import { getAiSummarySettings } from './ai-summary-settings';
import { hasAvailableAiBudget } from './shared-ai-budget';
import {
  resetCrawlerScopeStatus,
  updateCrawlerScopeStatus,
  waitIfCrawlerPaused,
} from './crawler-status';
import { fetchBrowserBilibiliSubtitleRows } from './browser-bilibili-source';
import { fetchBrowserYoutubeTranscriptRows } from './browser-youtube-source';
import {
  normalizeBrowserError,
  type BrowserSubtitleRow,
} from './browser-source-shared';
import { BROWSER_METHOD_ID } from './browser-method';
import {
  resolveSubtitleApiFallbackMatch,
  type SubtitleApiFallbackMatch,
} from './subtitle-api-fallback-settings';
import {
  getEffectiveIntervalMs,
  recordSubtitleError,
  recordSubtitleRateLimit,
  recordSubtitleSuccess,
} from './subtitle-backoff';
import { getSubtitleBrowserFetchConfig } from './subtitle-browser-fetch-settings';
import { getTranscriber } from './subtitle-providers';
import type {
  MultimodalTranscriber,
  TranscribePriority,
} from './subtitle-providers';
import type { AiSummaryModelConfig } from '@/types';

const execFileAsync = promisify(execFile);

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const SUBTITLE_ROOT =
  process.env.SUBTITLE_ROOT || path.join(DATA_ROOT, 'subtitles');
const PYTHON_CANDIDATES = [process.env.PYTHON_BIN, 'python3'].filter(
  (value): value is string => Boolean(value && value.trim()),
);
const YOUTUBE_COOKIES_BROWSER = (
  process.env.YOUTUBE_COOKIES_BROWSER || ''
).trim();
const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  'yt-dlp',
].filter((value): value is string => Boolean(value && value.trim()));
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_BIN,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  'ffmpeg',
].filter((value): value is string => Boolean(value && value.trim()));
const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_BIN,
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  'ffprobe',
].filter((value): value is string => Boolean(value && value.trim()));

// Tiered timeouts for subtitle fallback chain.
const TIERED_TIMEOUTS = {
  first: 15_000, // 15s - Needle Browser
  last: 45_000, // 45s - AI API / yt-dlp extraction path
} as const;

interface SubtitlePayload {
  language: string;
  format: string;
  text: string;
  raw_path: string;
  segments?: SubtitleSegment[];
  sourceMethod?: string;
  segmentStyle?: 'coarse' | 'fine';
  metadata?: Record<string, string | number>;
}

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

interface SubtitleSourceFile {
  filePath: string;
  language: string;
  format: string;
}

type SubtitleRetryClass = 'missing' | 'temporary-error' | 'permanent';

interface BilibiliSubtitleFetchContext {
  aid?: number | null;
  cid?: number | null;
}

export interface SubtitleFetchOptions {
  requestSource?: 'default' | 'player';
  preferredMethod?: string;
  apiModelId?: string;
  allowBrowser?: boolean;
  allowOpenCli?: boolean;
  bilibiliContext?: BilibiliSubtitleFetchContext;
  force?: boolean;
  respectPause?: boolean;
  signal?: AbortSignal;
}

function createAbortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError(
    signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === 'string'
        ? signal.reason
        : 'Aborted',
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function waitForCrawlerResumeIfNeeded(
  respectPause: boolean,
): Promise<void> {
  if (!respectPause) return;
  await waitIfCrawlerPaused();
}

type SubtitleMethod = 'browser' | 'gemini';

interface YtDlpAttemptResult {
  selected: SubtitleSourceFile | null;
  errors: string[];
}

interface BilibiliSubtitleItem {
  id?: number;
  id_str?: string;
  type?: number;
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  ai_type?: number;
  ai_status?: number;
}

interface BilibiliPlayerSubtitleData {
  subtitles?: BilibiliSubtitleItem[];
}

interface BilibiliViewData {
  cid?: number;
  aid?: number;
}

interface BilibiliApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

interface BilibiliSubtitleBodyItem {
  from?: number;
  to?: number;
  content?: string;
}

interface BilibiliSubtitleJson {
  body?: BilibiliSubtitleBodyItem[];
}

interface TranscriptJsonPayload {
  language?: string;
  segments?: Array<{ start: number; duration: number; text: string }>;
}

interface AiGeneratedSubtitlePayload {
  language: string;
  format: string;
  text: string;
  segments: SubtitleSegment[];
  rawText: string;
  sourceMethod: string;
  segmentStyle: 'coarse';
  metadata?: Record<string, string | number>;
}

type SubtitleVideoContext = Video & {
  intent_id?: number | null;
};

interface SegmentedAudioChunk {
  index: number;
  startSeconds: number;
  endSeconds: number;
  filePath: string;
}

function getVideoUrl(video: Pick<Video, 'platform' | 'video_id'>): string {
  if (video.platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  }
  return `https://www.bilibili.com/video/${video.video_id}`;
}

function getVideoLabel(video: Pick<Video, 'title' | 'video_id'>): string {
  return (video.title || '').trim() || video.video_id;
}

function formatSecondsForAiRange(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function compactLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function logSubtitleAttempt(video: Video, method: string, isFallback: boolean) {
  log.info('subtitle', 'attempt', {
    platform: video.platform,
    method,
    fallback: isFallback,
    target: video.video_id,
    channel_id: video.channel_id,
    channel_name: video.channel_name ?? null,
  });
}

function logSubtitleFallback(
  video: Video,
  fromMethod: string,
  toMethod: string,
  reason: string,
) {
  log.warn('subtitle', 'fallback', {
    platform: video.platform,
    from: fromMethod,
    to: toMethod,
    target: video.video_id,
    reason: compactLogValue(reason),
    channel_id: video.channel_id,
    channel_name: video.channel_name ?? null,
  });
}

function logSubtitleSuccess(
  video: Video,
  method: string,
  source: SubtitleSourceFile,
) {
  log.info('subtitle', 'success', {
    platform: video.platform,
    method,
    target: video.video_id,
    language: source.language,
    format: source.format,
    channel_id: video.channel_id,
    channel_name: video.channel_name ?? null,
  });
}

function classifySubtitleErrorType(message: string): string {
  const m = message.toLowerCase();
  if (
    /members?[- ]only|requires membership|仅限会员|会员专享|大会员|付费|试看|limited free/.test(m)
  ) {
    return 'members_only';
  }
  if (
    /no subtitle|no subtitles|no transcript|transcript unavailable|subtitle.*not found|caption.*not found|no subtitle file found|empty result|returned no data|没有发现外挂或智能字幕/.test(
      m,
    )
  ) {
    return 'no_subtitle';
  }
  if (/empty after parsing/.test(m)) {
    return 'empty';
  }
  if (/http\s*(error)?\s*429|too many requests|rate limit/.test(m)) {
    return 'rate_limit';
  }
  if (/aborted|aborterror|operation was aborted|timed out|timeout/.test(m)) {
    return 'timeout';
  }
  if (/no enabled.*pipeline/.test(m)) {
    return 'no_pipeline';
  }
  return 'api_error';
}

function logSubtitleFailure(
  video: Video,
  method: string,
  reason: string,
  status: 'failure' | 'cooldown' = 'failure',
) {
  const errorType = classifySubtitleErrorType(reason);
  // Expected/content outcomes use warn; actual system errors use error
  const isExpected =
    errorType === 'no_subtitle' ||
    errorType === 'members_only' ||
    errorType === 'empty' ||
    errorType === 'timeout';
  const fields = {
    platform: video.platform,
    method,
    target: video.video_id,
    status,
    error_type: errorType,
    error: compactLogValue(reason),
    channel_id: video.channel_id,
    channel_name: video.channel_name ?? null,
  };
  if (isExpected) {
    log.warn('subtitle', 'failure', fields);
  } else {
    log.error('subtitle', 'failure', fields);
  }
}

function ensureSubtitleDir(platform: Video['platform']): string {
  const dir = path.join(SUBTITLE_ROOT, platform);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pickBinary(): string {
  for (const candidate of YT_DLP_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('yt-dlp binary not found');
}

function pickPythonBinary(): string {
  for (const candidate of PYTHON_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('python binary not found');
}

function pickFfmpegBinary(): string {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('ffmpeg binary not found');
}

function pickFfprobeBinary(): string {
  for (const candidate of FFPROBE_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('ffprobe binary not found');
}

function stripInlineTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSegmentText(value: string): string {
  return decodeHtmlEntities(stripInlineTags(value)).replace(/\s+/g, ' ').trim();
}

function parseTimestampToSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;

  const clockMatch = value.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/,
  );
  if (clockMatch) {
    const hours = Number(clockMatch[1] || 0);
    const minutes = Number(clockMatch[2] || 0);
    const seconds = Number(clockMatch[3] || 0);
    const fraction = Number((clockMatch[4] || '0').padEnd(3, '0'));
    return hours * 3600 + minutes * 60 + seconds + fraction / 1000;
  }

  const ttmlMatch = value.match(/^(\d+(?:\.\d+)?)(h|m|s|ms)$/);
  if (ttmlMatch) {
    const amount = Number(ttmlMatch[1]);
    const unit = ttmlMatch[2];
    if (unit === 'h') return amount * 3600;
    if (unit === 'm') return amount * 60;
    if (unit === 's') return amount;
    if (unit === 'ms') return amount / 1000;
  }

  const plainSeconds = Number(value);
  if (Number.isFinite(plainSeconds)) return plainSeconds;

  return null;
}

function parseAiRangeBlock(raw: string): SubtitleSegment[] {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const segments: SubtitleSegment[] = [];
  let current: {
    start: number;
    end: number;
    text: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.text.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      segments.push({
        start: current.start,
        end: Math.max(current.end, current.start + 1),
        text,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    const match = trimmed.match(
      /^\[(\d{1,2}:\d{2}(?::\d{2})?)-(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)?$/,
    );
    if (match) {
      flush();
      const start = parseTimestampToSeconds(match[1]);
      const end = parseTimestampToSeconds(match[2]);
      if (start === null || end === null) continue;
      current = {
        start,
        end,
        text: match[3] ? [match[3].trim()] : [],
      };
      continue;
    }

    if (current) {
      current.text.push(trimmed);
    }
  }

  flush();
  return dedupeSegments(segments);
}

function parseCueTimeRange(
  line: string,
): { start: number; end: number } | null {
  const match = line.match(/^\s*([^ ]+)\s+-->\s+([^ ]+)/);
  if (!match) return null;
  const start = parseTimestampToSeconds(match[1]);
  const end = parseTimestampToSeconds(match[2]);
  if (start === null || end === null) return null;
  return { start, end };
}

function estimateTxtSegments(raw: string): SubtitleSegment[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const segments: SubtitleSegment[] = [];
  let cursor = 0;

  for (const line of lines) {
    const text = normalizeSegmentText(line);
    if (!text) continue;
    const duration = Math.max(2, Math.min(8, Math.ceil(text.length / 12)));
    segments.push({
      start: cursor,
      end: cursor + duration,
      text,
    });
    cursor += duration;
  }

  return segments;
}

function parseSrtOrVttSegments(raw: string): SubtitleSegment[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const segments: SubtitleSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE)\b/i.test(line)) {
      i += 1;
      continue;
    }

    if (/^\d+$/.test(line) && i + 1 < lines.length) {
      i += 1;
    }

    const range = parseCueTimeRange(lines[i] || '');
    if (!range) {
      i += 1;
      continue;
    }

    i += 1;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const text = normalizeSegmentText(lines[i]);
      if (text) textLines.push(text);
      i += 1;
    }

    const text = textLines.join(' ').trim();
    if (text) {
      segments.push({
        start: range.start,
        end: Math.max(range.end, range.start + 1),
        text,
      });
    }
  }

  return segments;
}

function parseTtmlSegments(raw: string): SubtitleSegment[] {
  const matches = raw.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi);
  const segments: SubtitleSegment[] = [];

  for (const match of matches) {
    const attrs = match[1] || '';
    const content = match[2] || '';
    const beginMatch = attrs.match(/\bbegin="([^"]+)"/i);
    const endMatch = attrs.match(/\bend="([^"]+)"/i);
    const durMatch = attrs.match(/\bdur="([^"]+)"/i);
    const start = parseTimestampToSeconds(beginMatch?.[1] || '');
    const end =
      parseTimestampToSeconds(endMatch?.[1] || '') ??
      (start !== null ? start : 0) +
        (parseTimestampToSeconds(durMatch?.[1] || '') || 0);
    const text = normalizeSegmentText(content.replace(/<br\s*\/?>/gi, ' '));
    if (start === null || !text) continue;
    segments.push({
      start,
      end: Math.max(end, start + 1),
      text,
    });
  }

  return segments;
}

function parseBilibiliJsonSegments(raw: string): SubtitleSegment[] {
  try {
    const payload = JSON.parse(raw) as BilibiliSubtitleJson;
    return (payload.body || []).flatMap((item) => {
      const text = normalizeSegmentText(item.content || '');
      const start = Number(item.from);
      const end = Number(item.to);
      if (!text || !Number.isFinite(start)) return [];
      return [
        {
          start,
          end: Number.isFinite(end) && end > start ? end : start + 2,
          text,
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseTranscriptJsonSegments(raw: string): SubtitleSegment[] {
  try {
    const payload = JSON.parse(raw) as {
      segments?: Array<{ start?: number; duration?: number; text?: string }>;
    };
    return (payload.segments || []).flatMap((item) => {
      const text = normalizeSegmentText(item.text || '');
      const start = Number(item.start);
      const duration = Number(item.duration);
      if (!text || !Number.isFinite(start)) return [];
      return [
        {
          start,
          end:
            start + (Number.isFinite(duration) && duration > 0 ? duration : 2),
          text,
        },
      ];
    });
  } catch {
    return [];
  }
}

function dedupeSegments(segments: SubtitleSegment[]): SubtitleSegment[] {
  const output: SubtitleSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const normalized: SubtitleSegment = {
      start: Math.max(0, Math.floor(segment.start)),
      end: Math.max(Math.floor(segment.end), Math.floor(segment.start) + 1),
      text,
    };
    const previous = output[output.length - 1];
    if (
      previous &&
      previous.text === normalized.text &&
      previous.start === normalized.start
    ) {
      previous.end = Math.max(previous.end, normalized.end);
      continue;
    }
    output.push(normalized);
  }
  return output;
}

function parseSubtitleSegments(raw: string, format: string): SubtitleSegment[] {
  const lower = format.toLowerCase();
  if (
    lower === 'vtt' ||
    lower === 'srt' ||
    lower === 'ass' ||
    lower === 'srv3'
  ) {
    return dedupeSegments(parseSrtOrVttSegments(raw));
  }
  if (lower === 'ttml') {
    return dedupeSegments(parseTtmlSegments(raw));
  }
  if (lower === 'bili-json') {
    return dedupeSegments(parseBilibiliJsonSegments(raw));
  }
  if (lower === 'yt-json') {
    return dedupeSegments(parseTranscriptJsonSegments(raw));
  }
  if (lower === 'ai-json') {
    try {
      const payload = JSON.parse(raw) as { segments?: SubtitleSegment[] };
      return dedupeSegments(payload.segments || []);
    } catch {
      return dedupeSegments(parseAiRangeBlock(raw));
    }
  }
  return dedupeSegments(estimateTxtSegments(raw));
}

function parseSubtitleText(raw: string, format: string): string {
  const segments = parseSubtitleSegments(raw, format);
  if (segments.length > 0) {
    return segments.map((segment) => segment.text).join('\n');
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = stripInlineTags(line).trim();
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (/^\d+$/.test(trimmed) && format === 'srt') continue;
    if (
      /^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(
        trimmed,
      )
    )
      continue;
    if (/^\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{2}:\d{2}[.,]\d{3}/.test(trimmed))
      continue;
    if (
      /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(trimmed)
    )
      continue;
    if (/^(Kind|Language|NOTE)\b/i.test(trimmed)) continue;
    if (output[output.length - 1] === trimmed) continue;
    output.push(trimmed);
  }

  return output.join('\n');
}

function pickSubtitleFile(tempDir: string): SubtitleSourceFile | null {
  const entries = fs.readdirSync(tempDir);
  const subtitleFiles = entries.filter((entry) =>
    /\.(vtt|srt|ass|ttml|srv3)$/i.test(entry),
  );
  if (subtitleFiles.length === 0) return null;

  subtitleFiles.sort((a, b) => a.localeCompare(b));
  const selected = subtitleFiles[0];
  const match = selected.match(/\.([^.]+)\.(vtt|srt|ass|ttml|srv3)$/i);
  const formatMatch = selected.match(/\.(vtt|srt|ass|ttml|srv3)$/i);

  return {
    filePath: path.join(tempDir, selected),
    language: match?.[1] || 'unknown',
    format: formatMatch?.[1]?.toLowerCase() || 'unknown',
  };
}

function persistSubtitle(
  video: Pick<Video, 'platform' | 'video_id'>,
  subtitle: SubtitleSourceFile,
): SubtitlePayload {
  const targetDir = ensureSubtitleDir(video.platform);
  const baseName = `${video.video_id}`;
  const rawTargetPath = path.join(
    targetDir,
    `${baseName}.${subtitle.language}.${subtitle.format}`,
  );
  const jsonTargetPath = path.join(targetDir, `${baseName}.json`);
  const rawContent = fs.readFileSync(subtitle.filePath, 'utf8');
  const segments = parseSubtitleSegments(rawContent, subtitle.format);
  const text = parseSubtitleText(rawContent, subtitle.format);

  fs.copyFileSync(subtitle.filePath, rawTargetPath);
  fs.writeFileSync(
    jsonTargetPath,
    JSON.stringify(
      {
        video_id: video.video_id,
        platform: video.platform,
        language: subtitle.language,
        format: subtitle.format,
        text,
        raw_path: rawTargetPath,
        segments,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    language: subtitle.language,
    format: subtitle.format,
    text,
    raw_path: rawTargetPath,
    segments,
  };
}

function getJsonTargetPath(
  video: Pick<Video, 'platform' | 'video_id'>,
): string {
  return path.join(ensureSubtitleDir(video.platform), `${video.video_id}.json`);
}

function persistStructuredSubtitle(
  video: Pick<Video, 'platform' | 'video_id'>,
  payload: {
    language: string;
    format: string;
    text: string;
    segments: SubtitleSegment[];
    rawText: string;
    sourceMethod: string;
    segmentStyle: 'coarse' | 'fine';
    metadata?: Record<string, string | number>;
  },
): SubtitlePayload {
  const targetDir = ensureSubtitleDir(video.platform);
  const rawTargetPath = path.join(
    targetDir,
    `${video.video_id}.${payload.language}.txt`,
  );
  const jsonTargetPath = path.join(targetDir, `${video.video_id}.json`);

  fs.writeFileSync(rawTargetPath, payload.rawText, 'utf8');
  fs.writeFileSync(
    jsonTargetPath,
    JSON.stringify(
      {
        video_id: video.video_id,
        platform: video.platform,
        language: payload.language,
        format: payload.format,
        text: payload.text,
        raw_path: rawTargetPath,
        segments: payload.segments,
        sourceMethod: payload.sourceMethod,
        segmentStyle: payload.segmentStyle,
        metadata: payload.metadata,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    language: payload.language,
    format: payload.format,
    text: payload.text,
    raw_path: rawTargetPath,
    segments: payload.segments,
    sourceMethod: payload.sourceMethod,
    segmentStyle: payload.segmentStyle,
    metadata: payload.metadata,
  };
}


async function fetchSubtitleViaSegmentedAudio(
  video: Video,
  audioPath: string,
  priority: TranscribePriority,
  sourceMethod: string,
  respectPause: boolean,
  selectedModel: AiSummaryModelConfig,
  transcriber: MultimodalTranscriber,
): Promise<AiGeneratedSubtitlePayload> {
  const settings = getAiSummarySettings();
  const estimatedDuration =
    parseVideoDurationSeconds(video.duration) ??
    Math.ceil((await probeAudioDurationSeconds(audioPath)) || 0);
  if (!estimatedDuration || estimatedDuration <= 0) {
    throw new Error(
      'Unable to determine audio duration for segmented AI subtitle generation',
    );
  }

  const chunkSeconds = transcriber.maxAudioChunkSeconds;
  const chunks = await splitAudioIntoChunks(
    audioPath,
    path.dirname(audioPath),
    estimatedDuration,
    chunkSeconds,
  );
  const mergedSegments: SubtitleSegment[] = [];
  const rawBlocks: string[] = [];
  let totalTokens = 0;
  let firstChunkTtft: number | undefined;

  for (const chunk of chunks) {
    await waitForCrawlerResumeIfNeeded(respectPause);
    const raw = await transcriber.transcribeAudio(selectedModel, {
      audioPath: chunk.filePath,
      mediaType: 'audio/mpeg',
      prompt: buildSegmentedSubtitlePrompt(
        settings.subtitleApiPromptTemplate,
        settings.subtitleSegmentPromptTemplate,
        chunk.startSeconds,
        chunk.endSeconds,
        chunkSeconds,
      ),
      priority,
      label: `${sourceMethod}:${video.video_id}:chunk-${chunk.index + 1}`,
      estimatedTokens: settings.subtitleFallbackTokenReserve,
    });
    if (chunk.index === 0) {
      firstChunkTtft = raw.ttftSeconds;
    }
    const relativeSegments = parseAiRangeBlock(raw.text);
    if (relativeSegments.length === 0) {
      throw new Error(
        `AI subtitle fallback returned unparseable content for chunk ${chunk.index + 1}`,
      );
    }
    mergedSegments.push(
      ...shiftSubtitleSegments(relativeSegments, chunk.startSeconds),
    );
    rawBlocks.push(
      `# chunk ${chunk.index + 1} ${formatSecondsForAiRange(chunk.startSeconds)}-${formatSecondsForAiRange(chunk.endSeconds)}\n${raw.text.trim()}`,
    );
    totalTokens += raw.usage?.totalTokens || 0;
  }

  return {
    ...buildAiSubtitlePayloadFromSegments(
      video,
      dedupeSegments(mergedSegments),
      rawBlocks.join('\n\n'),
      sourceMethod,
    ),
    metadata: {
      generated_at: new Date().toISOString(),
      generated_model_name: selectedModel.name,
      generated_model: selectedModel.model,
      generated_endpoint: selectedModel.endpoint,
      generated_protocol: selectedModel.protocol,
      trigger_source: priority,
      chunk_count: chunks.length,
      chunk_seconds: chunkSeconds,
      ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
      ...(firstChunkTtft !== undefined ? { ttft_seconds: firstChunkTtft } : {}),
    },
  };
}

function buildAiSubtitlePayload(
  video: Video,
  rawText: string,
  sourceMethod: string,
): AiGeneratedSubtitlePayload {
  const segments = parseAiRangeBlock(rawText);
  return buildAiSubtitlePayloadFromSegments(
    video,
    segments,
    rawText,
    sourceMethod,
  );
}

function buildAiSubtitlePayloadFromSegments(
  video: Video,
  segments: SubtitleSegment[],
  rawText: string,
  sourceMethod: string,
): AiGeneratedSubtitlePayload {
  if (segments.length === 0) {
    throw new Error('AI subtitle fallback returned unparseable content');
  }
  return {
    language: 'zh',
    format: 'ai-json',
    text: segments
      .map(
        (segment) =>
          `[${formatSecondsForAiRange(segment.start)}-${formatSecondsForAiRange(segment.end)}] ${segment.text}`,
      )
      .join('\n\n'),
    segments,
    rawText,
    sourceMethod,
    segmentStyle: 'coarse',
  };
}

function parseVideoDurationSeconds(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const seconds = parseTimestampToSeconds(value);
  if (seconds === null || seconds <= 0) return null;
  return Math.floor(seconds);
}

async function probeAudioDurationSeconds(
  filePath: string,
): Promise<number | null> {
  try {
    const result = await execFileAsync(
      pickFfprobeBinary(),
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(30_000),
      } as Parameters<typeof execFileAsync>[2],
    );
    const seconds = Number(result.stdout?.toString('utf8').trim() || '');
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds;
  } catch {
    return null;
  }
}

function buildSegmentedSubtitlePrompt(
  baseTemplate: string,
  segmentTemplate: string,
  startSeconds: number,
  endSeconds: number,
  chunkSeconds: number,
): string {
  const chunkMinutes = Math.max(1, Math.round(chunkSeconds / 60));
  return [
    baseTemplate.trim(),
    segmentTemplate.trim(),
    `当前只处理原视频 ${formatSecondsForAiRange(startSeconds)} 到 ${formatSecondsForAiRange(endSeconds)} 的片段。`,
    `如果当前片段不足 ${chunkMinutes} 分钟，以当前片段实际结尾为准。`,
  ].join('\n');
}

function shiftSubtitleSegments(
  segments: SubtitleSegment[],
  offsetSeconds: number,
): SubtitleSegment[] {
  return segments.map((segment) => ({
    start: Math.max(0, Math.floor(segment.start + offsetSeconds)),
    end: Math.max(
      Math.floor(segment.end + offsetSeconds),
      Math.floor(segment.start + offsetSeconds) + 1,
    ),
    text: segment.text,
  }));
}

async function splitAudioIntoChunks(
  audioPath: string,
  tempDir: string,
  totalDurationSeconds: number,
  chunkSeconds: number,
): Promise<SegmentedAudioChunk[]> {
  if (totalDurationSeconds <= chunkSeconds) {
    return [
      {
        index: 0,
        startSeconds: 0,
        endSeconds: totalDurationSeconds,
        filePath: audioPath,
      },
    ];
  }

  const ffmpeg = pickFfmpegBinary();
  const chunks: SegmentedAudioChunk[] = [];
  for (
    let startSeconds = 0, index = 0;
    startSeconds < totalDurationSeconds;
    startSeconds += chunkSeconds, index += 1
  ) {
    const endSeconds = Math.min(
      totalDurationSeconds,
      startSeconds + chunkSeconds,
    );
    const outputPath = path.join(
      tempDir,
      `${path.parse(audioPath).name}.segment-${String(index).padStart(3, '0')}.mp3`,
    );
    await execFileAsync(
      ffmpeg,
      [
        '-y',
        '-ss',
        String(startSeconds),
        '-t',
        String(Math.max(1, endSeconds - startSeconds)),
        '-i',
        audioPath,
        '-vn',
        '-acodec',
        'copy',
        outputPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(5 * 60 * 1000),
      } as Parameters<typeof execFileAsync>[2],
    );
    chunks.push({ index, startSeconds, endSeconds, filePath: outputPath });
  }
  return chunks;
}

function buildYtDlpBaseArgs(video: Video, outputTemplate: string): string[] {
  const args = [
    '--skip-download',
    '--sub-format',
    'vtt/srt/best',
    '--sub-langs',
    'zh-Hans.*,zh-CN.*,zh-TW.*,zh.*,en.*',
    '--output',
    outputTemplate,
  ];

  if (video.platform === 'youtube') {
    args.push(
      '--js-runtimes',
      'deno,node',
      '--extractor-args',
      'youtube:player_client=ios,tv_simply,tv',
      '--sleep-subtitles',
      '1',
      '--retry-sleep',
      'http:exp=1:20',
    );
    if (YOUTUBE_COOKIES_BROWSER) {
      args.push('--cookies-from-browser', YOUTUBE_COOKIES_BROWSER);
    }
  }

  return args;
}

function readExecErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStderr =
    'stderr' in error
      ? (error.stderr as Buffer | string | undefined)
      : undefined;
  const stderr =
    typeof maybeStderr === 'string'
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString('utf8')
        : '';
  return stderr.trim() || error.message;
}

function normalizeSubtitleFetchError(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (/HTTP Error 429|Too Many Requests/i.test(compact)) {
    return 'YouTube subtitle requests are rate limited (HTTP 429). Retry later, or use browser cookies/impersonation support.';
  }
  if (
    /JS Challenge Provider .*no solutions|n challenge solving failed/i.test(
      compact,
    )
  ) {
    return 'yt-dlp could not solve the current YouTube JS challenge. A supported JS runtime or different client path is required.';
  }
  if (/no impersonate target is available/i.test(compact)) {
    return 'yt-dlp impersonation support is unavailable on this machine. Install curl_cffi-backed impersonation support to improve YouTube reliability.';
  }
  return compact;
}

function formatStageError(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${stage}: ${normalizeSubtitleFetchError(message)}`;
}

async function runYtDlpSubtitleAttempts(
  video: Video,
  bin: string,
  tempDir: string,
  outputTemplate: string,
  signal?: AbortSignal,
): Promise<YtDlpAttemptResult> {
  const attempts: Array<{ label: string; args: string[] }> = [
    { label: 'manual subtitles', args: ['--write-sub'] },
    { label: 'auto subtitles', args: ['--write-auto-sub'] },
  ];
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      await execFileAsync(
        bin,
        [
          ...buildYtDlpBaseArgs(video, outputTemplate),
          ...attempt.args,
          getVideoUrl(video),
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: signal ?? AbortSignal.timeout(TIERED_TIMEOUTS.last),
          env: {
            ...process.env,
            PATH: [
              '/opt/homebrew/bin',
              '/usr/local/bin',
              process.env.PATH || '',
            ]
              .filter(Boolean)
              .join(':'),
          },
        } as Parameters<typeof execFileAsync>[2],
      );
    } catch (error) {
      errors.push(
        `${attempt.label}: ${normalizeSubtitleFetchError(readExecErrorMessage(error))}`,
      );
    }

    const selected = pickSubtitleFile(tempDir);
    if (selected) {
      return { selected, errors };
    }
  }

  return { selected: null, errors };
}

async function extractAudioViaYtDlp(
  video: Video,
  bin: string,
  tempDir: string,
): Promise<string> {
  const outputTemplate = path.join(tempDir, `${video.video_id}.%(ext)s`);
  await execFileAsync(
    bin,
    [
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--output',
      outputTemplate,
      getVideoUrl(video),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(10 * 60 * 1000),
      env: {
        ...process.env,
        PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
          .filter(Boolean)
          .join(':'),
      },
    } as Parameters<typeof execFileAsync>[2],
  );
  const audioPath = path.join(tempDir, `${video.video_id}.mp3`);
  if (!fs.existsSync(audioPath)) {
    throw new Error('yt-dlp did not produce mp3 output');
  }
  return audioPath;
}

function parseBrowserSeconds(value: string | undefined): number {
  const normalized = (value || '').trim().replace(/s$/i, '');
  const seconds = Number(normalized);
  return Number.isFinite(seconds) ? seconds : 0;
}

function createTempSubtitleJsonFile(
  prefix: string,
  video: Video,
  language: string,
  format: SubtitleSourceFile['format'],
  payload: BilibiliSubtitleJson | TranscriptJsonPayload,
): SubtitleSourceFile {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-${video.video_id}-`),
  );
  const filePath = path.join(
    tempDir,
    `${video.video_id}.${language}.${format}`,
  );
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, language, format };
}

function mapBrowserYoutubeTranscriptRows(
  rows: BrowserSubtitleRow[],
): TranscriptJsonPayload {
  return {
    language: 'unknown',
    segments: rows
      .map((row) => {
        const start = parseBrowserSeconds(row.start);
        const end = parseBrowserSeconds(row.end);
        const text = (row.text || '').trim();
        if (!text) return null;
        return {
          start,
          duration: Math.max(1, end - start),
          text,
        };
      })
      .filter(
        (item): item is { start: number; duration: number; text: string } =>
          Boolean(item),
      ),
  };
}

function mapBrowserBilibiliSubtitleRows(
  rows: BrowserSubtitleRow[],
): BilibiliSubtitleJson {
  const body: BilibiliSubtitleBodyItem[] = [];
  for (const row of rows) {
    const content = (row.content || '').trim();
    if (!content) continue;
    body.push({
      from: parseBrowserSeconds(row.from),
      to: parseBrowserSeconds(row.to),
      content,
    });
  }

  return {
    body,
  };
}

async function fetchYoutubeSubtitleViaBrowser(
  video: Video,
  signal?: AbortSignal,
): Promise<SubtitleSourceFile | null> {
  const rows = await fetchBrowserYoutubeTranscriptRows(getVideoUrl(video), {
    signal,
  });
  const payload = mapBrowserYoutubeTranscriptRows(rows);
  if (!payload.segments?.length) return null;
  return createTempSubtitleJsonFile(
    'folo-browser-youtube-subtitles',
    video,
    payload.language || 'unknown',
    'yt-json',
    payload,
  );
}

async function fetchBilibiliSubtitleViaBrowser(
  video: Video,
  signal?: AbortSignal,
): Promise<SubtitleSourceFile | null> {
  const rows = await fetchBrowserBilibiliSubtitleRows(video.video_id, {
    signal,
  });
  const payload = mapBrowserBilibiliSubtitleRows(rows);
  if (!payload.body?.length) return null;
  return createTempSubtitleJsonFile(
    'folo-browser-bilibili-subtitles',
    video,
    'unknown',
    'bili-json',
    payload,
  );
}

function buildAiSubtitleMetadata(
  selectedModel: AiSummaryModelConfig,
  priority: TranscribePriority,
  totalTokens: number | undefined,
  ttftSeconds: number | undefined,
): Record<string, string | number> {
  const metadata: Record<string, string | number> = {
    generated_at: new Date().toISOString(),
    generated_model_name: selectedModel.name,
    generated_model: selectedModel.model,
    generated_endpoint: selectedModel.endpoint,
    generated_protocol: selectedModel.protocol,
    trigger_source: priority,
  };
  if (typeof totalTokens === 'number') metadata.total_tokens = totalTokens;
  if (typeof ttftSeconds === 'number') metadata.ttft_seconds = ttftSeconds;
  return metadata;
}

async function fetchYoutubeSubtitleViaAiApi(
  video: Video,
  priority: TranscribePriority,
  respectPause: boolean,
  selectedModel: AiSummaryModelConfig,
): Promise<AiGeneratedSubtitlePayload> {
  const settings = getAiSummarySettings();
  const transcriber = getTranscriber(selectedModel);
  const chunkSeconds = transcriber.maxAudioChunkSeconds;
  const durationSeconds = parseVideoDurationSeconds(video.duration);

  // Fast path: provider supports remote video URL and duration fits in a single request.
  if (
    transcriber.transcribeRemoteVideo &&
    (!durationSeconds || durationSeconds <= chunkSeconds)
  ) {
    const raw = await transcriber.transcribeRemoteVideo(selectedModel, {
      url: getVideoUrl(video),
      mediaType: 'video/mp4',
      prompt: settings.subtitleApiPromptTemplate,
      priority,
      label: `subtitle-youtube:${video.video_id}`,
      estimatedTokens: settings.subtitleFallbackTokenReserve,
    });
    return {
      ...buildAiSubtitlePayload(video, raw.text, 'ai-url'),
      metadata: buildAiSubtitleMetadata(
        selectedModel,
        priority,
        raw.usage?.totalTokens,
        raw.ttftSeconds,
      ),
    };
  }

  // Otherwise download audio locally and go through (segmented) audio path.
  const bin = pickBinary();
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `folo-ai-audio-${video.video_id}-`),
  );
  try {
    const audioPath = await extractAudioViaYtDlp(video, bin, tempDir);
    const resolvedDuration =
      durationSeconds ??
      Math.ceil((await probeAudioDurationSeconds(audioPath)) || 0);
    if (resolvedDuration > chunkSeconds) {
      return await fetchSubtitleViaSegmentedAudio(
        video,
        audioPath,
        priority,
        'ai-audio-segmented',
        respectPause,
        selectedModel,
        transcriber,
      );
    }
    const raw = await transcriber.transcribeAudio(selectedModel, {
      audioPath,
      mediaType: 'audio/mpeg',
      prompt: settings.subtitleApiPromptTemplate,
      priority,
      label: `subtitle-youtube:${video.video_id}`,
      estimatedTokens: settings.subtitleFallbackTokenReserve,
    });
    return {
      ...buildAiSubtitlePayload(video, raw.text, 'ai-audio'),
      metadata: buildAiSubtitleMetadata(
        selectedModel,
        priority,
        raw.usage?.totalTokens,
        raw.ttftSeconds,
      ),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function fetchBilibiliSubtitleViaAiApi(
  video: Video,
  priority: TranscribePriority,
  respectPause: boolean,
  selectedModel: AiSummaryModelConfig,
): Promise<AiGeneratedSubtitlePayload> {
  const settings = getAiSummarySettings();
  const transcriber = getTranscriber(selectedModel);
  const chunkSeconds = transcriber.maxAudioChunkSeconds;
  const bin = pickBinary();
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `folo-ai-audio-${video.video_id}-`),
  );

  try {
    const audioPath = await extractAudioViaYtDlp(video, bin, tempDir);
    const durationSeconds =
      parseVideoDurationSeconds(video.duration) ??
      Math.ceil((await probeAudioDurationSeconds(audioPath)) || 0);
    if (durationSeconds > chunkSeconds) {
      return await fetchSubtitleViaSegmentedAudio(
        video,
        audioPath,
        priority,
        'ai-audio-segmented',
        respectPause,
        selectedModel,
        transcriber,
      );
    }
    const raw = await transcriber.transcribeAudio(selectedModel, {
      audioPath,
      mediaType: 'audio/mpeg',
      prompt: settings.subtitleApiPromptTemplate,
      priority,
      label: `subtitle-bilibili:${video.video_id}`,
      estimatedTokens: settings.subtitleFallbackTokenReserve,
    });
    return {
      ...buildAiSubtitlePayload(video, raw.text, 'ai-audio'),
      metadata: buildAiSubtitleMetadata(
        selectedModel,
        priority,
        raw.usage?.totalTokens,
        raw.ttftSeconds,
      ),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function shouldRefetchLegacyBilibiliSubtitle(video: Video): boolean {
  if (video.platform !== 'bilibili') return false;
  if (video.subtitle_status !== 'fetched') return false;
  const language = (video.subtitle_language || '').toLowerCase();
  return language.startsWith('ai-') && video.subtitle_format === 'json';
}

function updateSubtitleState(
  videoDbId: number,
  state: {
    subtitle_path?: string | null;
    subtitle_language?: string | null;
    subtitle_format?: string | null;
    subtitle_status: string;
    subtitle_error?: string | null;
    subtitle_last_attempt_at?: string | null;
    subtitle_retry_count?: number | null;
    subtitle_cooldown_until?: string | null;
  },
): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE videos
    SET subtitle_path = ?,
        subtitle_language = ?,
        subtitle_format = ?,
        subtitle_status = ?,
        subtitle_error = ?,
        subtitle_last_attempt_at = COALESCE(?, subtitle_last_attempt_at),
        subtitle_retry_count = COALESCE(?, subtitle_retry_count),
        subtitle_cooldown_until = ?
    WHERE id = ?
  `,
  ).run(
    state.subtitle_path ?? null,
    state.subtitle_language ?? null,
    state.subtitle_format ?? null,
    state.subtitle_status,
    state.subtitle_error ?? null,
    state.subtitle_last_attempt_at ?? null,
    state.subtitle_retry_count ?? null,
    state.subtitle_cooldown_until ?? null,
    videoDbId,
  );
}

function markSubtitleRunning(
  video: Video,
  preferredMethod: string,
  activeMethod: string,
  isFallback: boolean,
  message: string,
) {
  updateCrawlerScopeStatus('subtitle', {
    state: 'running',
    platform: video.platform,
    preferredMethod,
    activeMethod,
    isFallback,
    targetId: video.video_id,
    targetLabel: getVideoLabel(video),
    message,
    cooldownUntil: undefined,
  });
  appEvents.emit('subtitle:status-changed', {
    videoId: video.video_id,
    platform: video.platform,
    status: 'fetching',
    error: null,
    cooldownUntil: null,
    preferredMethod,
    activeMethod,
    isFallback,
    message,
  });
}

function markSubtitleError(
  video: Video,
  preferredMethod: string,
  activeMethod: string,
  isFallback: boolean,
  message: string,
) {
  updateCrawlerScopeStatus('subtitle', {
    state: 'error',
    platform: video.platform,
    preferredMethod,
    activeMethod,
    isFallback,
    targetId: video.video_id,
    targetLabel: getVideoLabel(video),
    message,
    cooldownUntil: undefined,
  });
  appEvents.emit('subtitle:status-changed', {
    videoId: video.video_id,
    platform: video.platform,
    status: 'error',
    error: message,
    cooldownUntil: null,
    preferredMethod,
    activeMethod,
    isFallback,
    message,
  });
}

function markSubtitleIdle() {
  resetCrawlerScopeStatus('subtitle');
}

function cleanupTempDirBestEffort(tempDir: string): void {
  void fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch((error) => {
      log.warn('subtitle', 'cleanup_failed', {
        dir: tempDir,
        error: compactLogValue(
          error instanceof Error ? error.message : String(error),
        ),
      });
    });
}

function isRetryableMissingSubtitleError(
  message: string | null | undefined,
): boolean {
  const normalized = String(message || '').trim();
  if (!normalized) return false;
  return /(no subtitle|no subtitles|no transcript|transcript unavailable|subtitle.*not found|caption.*not found|no subtitle file found|empty result|returned no data|没有发现外挂或智能字幕|members?[- ]only|requires membership|仅限会员|会员专享|大会员|付费|试看|limited free)/i.test(
    normalized,
  );
}

function shouldRecordSubtitleBackoff(
  message: string | null | undefined,
): boolean {
  const normalized = String(message || '').trim();
  if (!normalized) return false;
  if (isRetryableMissingSubtitleError(normalized)) return false;
  return !/(aborted|aborterror|operation was aborted|timed out|timeout)/i.test(
    normalized,
  );
}

function isRateLimitError(message: string | null | undefined): boolean {
  const normalized = String(message || '').trim();
  if (!normalized) return false;
  return /(HTTP\s*(Error)?\s*429|Too Many Requests|rate limit)/i.test(
    normalized,
  );
}

function getSubtitleRetryDelayMs(
  platform: Video['platform'] = 'youtube',
): number {
  return getEffectiveIntervalMs(platform);
}

function resolveSubtitleApiModel(
  modelIdOverride: string | null | undefined,
): AiSummaryModelConfig {
  const settings = getAiSummarySettings();
  const multimodalModels = settings.models.filter(
    (model) => model.isMultimodal !== false,
  );
  const requestedModel = modelIdOverride
    ? multimodalModels.find((model) => model.id === modelIdOverride)
    : null;

  if (requestedModel) {
    return requestedModel;
  }

  if (multimodalModels.length > 0) {
    const preferredModel =
      multimodalModels.find((model) => model.id === settings.defaultModelId) ||
      multimodalModels[0];
    return preferredModel;
  }

  throw new Error('未配置多模态 AI 模型，无法执行 API 字幕提取');
}

function classifySubtitleFailure(
  status: string,
  error: string | null | undefined,
): SubtitleRetryClass {
  if (status === 'missing' || status === 'empty') return 'missing';
  if (status === 'error' && isRetryableMissingSubtitleError(error)) {
    return 'missing';
  }
  if (status === 'error') return 'temporary-error';
  return 'permanent';
}

function buildFailureState(
  video: Pick<Video, 'subtitle_retry_count'>,
  status: 'missing' | 'empty' | 'error',
  error: string,
  attemptAt: string,
) {
  return {
    subtitle_status: status,
    subtitle_error: error,
    subtitle_last_attempt_at: attemptAt,
    subtitle_retry_count: (video.subtitle_retry_count || 0) + 1,
    subtitle_cooldown_until: null,
  };
}

export function shouldRetrySubtitleFetch(video: Video): boolean {
  const { maxRetries } = getSubtitleBrowserFetchConfig();
  if (shouldRefetchLegacyBilibiliSubtitle(video)) return true;
  if (video.subtitle_path) return false;
  if (video.subtitle_status === 'fetching') return false;
  if ((video.subtitle_retry_count || 0) > maxRetries) return false;
  if (!video.subtitle_last_attempt_at) return true;

  const lastAttempt = Date.parse(video.subtitle_last_attempt_at);
  if (!Number.isFinite(lastAttempt)) return true;
  return Date.now() - lastAttempt >= getSubtitleRetryDelayMs(video.platform);
}

const AUTO_SUBTITLE_BUDGET_ESTIMATE_TOKENS = 16_000;

export function shouldEscapeToApi(
  video: Pick<Video, 'created_at' | 'subtitle_last_attempt_at'>,
  apiFallbackMatch: SubtitleApiFallbackMatch | null,
): boolean {
  if (!apiFallbackMatch || apiFallbackMatch.maxWaitSeconds <= 0) return false;
  if (!video.subtitle_last_attempt_at) return false;

  const firstAttemptAt = Date.parse(video.created_at || '');
  if (!Number.isFinite(firstAttemptAt)) return false;

  const elapsedSeconds = Math.floor((Date.now() - firstAttemptAt) / 1000);
  if (elapsedSeconds < apiFallbackMatch.maxWaitSeconds) return false;

  return hasAvailableAiBudget({
    estimatedTokens: AUTO_SUBTITLE_BUDGET_ESTIMATE_TOKENS,
  });
}

type AutoApiFallbackPhase = 'before-browser' | 'after-browser';

function getAutoApiFallbackReason(
  video: Pick<Video, 'created_at' | 'subtitle_last_attempt_at' | 'subtitle_retry_count'>,
  apiFallbackMatch: SubtitleApiFallbackMatch | null,
  phase: AutoApiFallbackPhase,
): string | null {
  if (!apiFallbackMatch) return null;

  if (shouldEscapeToApi(video, apiFallbackMatch)) {
    return `wait exceeded ${apiFallbackMatch.maxWaitSeconds}s`;
  }

  if (phase === 'after-browser') {
    const { maxRetries } = getSubtitleBrowserFetchConfig();
    if ((video.subtitle_retry_count || 0) + 1 > maxRetries) {
      return `browser retries exhausted (${maxRetries})`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subtitle fetch helper
// ---------------------------------------------------------------------------

export async function fetchAndStoreSubtitle(
  video: SubtitleVideoContext,
  options?: SubtitleFetchOptions,
): Promise<void> {
  log.info('subtitle', 'start', {
    platform: video.platform,
    target: video.video_id,
    label: compactLogValue(getVideoLabel(video)),
    channel_id: video.channel_id,
    channel_name: video.channel_name ?? null,
  });
  let tempDirToCleanup: string | null = null;
  const attemptAt = new Date().toISOString();
  const requestedMethod = (options?.preferredMethod || '').trim().toLowerCase();
  const allowBrowser = options?.allowBrowser ?? options?.allowOpenCli ?? true;
  const respectPause = options?.respectPause !== false;
  const aiApiPriority: 'manual-subtitle' | 'auto-subtitle' =
    options?.force || options?.requestSource === 'player'
      ? 'manual-subtitle'
      : 'auto-subtitle';
  const autoApiFallbackMatch =
    !requestedMethod && options?.requestSource !== 'player'
      ? resolveSubtitleApiFallbackMatch({
          channelId: video.channel_id,
          intentId: video.intent_id,
        })
      : null;
  const upfrontAutoApiFallbackReason =
    !requestedMethod && options?.requestSource !== 'player'
      ? getAutoApiFallbackReason(
          video,
          autoApiFallbackMatch,
          'before-browser',
        )
      : null;
  const statusPreferredMethod =
    requestedMethod === 'gemini' || upfrontAutoApiFallbackReason
      ? 'gemini'
      : BROWSER_METHOD_ID;
  const selectedApiModel = resolveSubtitleApiModel(
    requestedMethod === 'gemini'
      ? options?.apiModelId || null
      : autoApiFallbackMatch?.modelId,
  );
  const externalSignal = options?.signal;
  let innerWroteState = false;

  const updateSubtitleStateAndTrack = (
    state: Parameters<typeof updateSubtitleState>[1],
  ) => {
    updateSubtitleState(video.id, state);
    innerWroteState = true;
  };

  const persistSuccess = (method: string, source: SubtitleSourceFile) => {
    tempDirToCleanup = path.dirname(source.filePath);
    const stored = persistSubtitle(video, source);
    updateSubtitleStateAndTrack({
      subtitle_path: getJsonTargetPath(video),
      subtitle_language: stored.language,
      subtitle_format: stored.format,
      subtitle_status: stored.text ? 'fetched' : 'empty',
      subtitle_error: stored.text
        ? null
        : 'Subtitle file is empty after parsing',
      subtitle_last_attempt_at: attemptAt,
      subtitle_retry_count: stored.text ? 0 : video.subtitle_retry_count + 1,
      subtitle_cooldown_until: null,
    });
    logSubtitleSuccess(video, method, source);
    markSubtitleIdle();
  };

  const persistStructuredSuccess = (
    method: string,
    payload: AiGeneratedSubtitlePayload,
  ) => {
    const stored = persistStructuredSubtitle(video, payload);
    updateSubtitleStateAndTrack({
      subtitle_path: getJsonTargetPath(video),
      subtitle_language: stored.language,
      subtitle_format: stored.format,
      subtitle_status: stored.text ? 'fetched' : 'empty',
      subtitle_error: stored.text
        ? null
        : 'Subtitle file is empty after parsing',
      subtitle_last_attempt_at: attemptAt,
      subtitle_retry_count: stored.text ? 0 : video.subtitle_retry_count + 1,
      subtitle_cooldown_until: null,
    });
    log.info('subtitle', 'success', {
      platform: video.platform,
      method,
      target: video.video_id,
      language: stored.language,
      format: stored.format,
      source_method: stored.sourceMethod,
      channel_id: video.channel_id,
      channel_name: video.channel_name ?? null,
    });
    markSubtitleIdle();
  };

  const getMethodMessage = (method: SubtitleMethod, isFallback: boolean) => {
    if (method === 'gemini') {
      return isFallback
        ? 'Falling back to AI subtitle extraction'
        : 'Extracting subtitles via AI multimodal API';
    }
    if (method === BROWSER_METHOD_ID) {
      return video.platform === 'youtube'
        ? isFallback
          ? 'Falling back to YouTube subtitle via Needle Browser'
          : 'Fetching YouTube subtitle via Needle Browser'
        : isFallback
          ? 'Falling back to Bilibili subtitle via Needle Browser'
          : 'Fetching Bilibili subtitle via Needle Browser';
    }
    return isFallback
      ? 'Falling back to AI subtitle extraction'
      : 'Extracting subtitles via AI multimodal API';
  };

  const runMethod = async (
    method: SubtitleMethod,
    isFallback: boolean,
  ): Promise<boolean> => {
    throwIfAborted(externalSignal);
    await waitForCrawlerResumeIfNeeded(respectPause);
    throwIfAborted(externalSignal);
    logSubtitleAttempt(video, method, isFallback);
    markSubtitleRunning(
      video,
      statusPreferredMethod,
      method,
      isFallback,
      getMethodMessage(method, isFallback),
    );

    if (method === 'gemini') {
      const payload =
        video.platform === 'youtube'
          ? await fetchYoutubeSubtitleViaAiApi(
              video,
              aiApiPriority,
              respectPause,
              selectedApiModel,
            )
          : await fetchBilibiliSubtitleViaAiApi(
              video,
              aiApiPriority,
              respectPause,
              selectedApiModel,
            );
      persistStructuredSuccess('gemini', payload);
      return true;
    }

    if (method === BROWSER_METHOD_ID) {
      const signal = externalSignal
        ? AbortSignal.any([
            externalSignal,
            AbortSignal.timeout(TIERED_TIMEOUTS.first),
          ])
        : AbortSignal.timeout(TIERED_TIMEOUTS.first);
      const subtitle =
        video.platform === 'youtube'
          ? await fetchYoutubeSubtitleViaBrowser(video, signal)
          : await fetchBilibiliSubtitleViaBrowser(video, signal);
      if (!subtitle) return false;
      recordSubtitleSuccess(video.platform);
      persistSuccess(BROWSER_METHOD_ID, subtitle);
      return true;
    }

    return false;
  };

  const runBrowserAttempt = async (
    isFallback: boolean,
  ): Promise<string | null> => {
    try {
      if (await runMethod(BROWSER_METHOD_ID, isFallback)) {
        return null;
      }
      return 'No subtitle file found';
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return formatStageError(BROWSER_METHOD_ID, normalizeBrowserError(error));
    }
  };

  try {
    throwIfAborted(externalSignal);
    if (requestedMethod === 'gemini') {
      await runMethod('gemini', false);
      return;
    }

    if (upfrontAutoApiFallbackReason) {
      logSubtitleFallback(
        video,
        BROWSER_METHOD_ID,
        'gemini',
        upfrontAutoApiFallbackReason,
      );
      await runMethod('gemini', true);
      return;
    }

    if (!allowBrowser) {
      const message = `No enabled ${video.platform} subtitle pipeline sources configured`;
      updateSubtitleStateAndTrack({
        ...buildFailureState(video, 'error', message, attemptAt),
      });
      logSubtitleFailure(video, statusPreferredMethod, message);
      markSubtitleError(
        video,
        statusPreferredMethod,
        statusPreferredMethod,
        false,
        message,
      );
      return;
    }

    const firstBrowserError = await runBrowserAttempt(false);
    if (!firstBrowserError) {
      return;
    }

    let firstFailureStatus: 'missing' | 'error' =
      firstBrowserError === 'No subtitle file found' ? 'missing' : 'error';
    let firstFailureClass: SubtitleRetryClass = classifySubtitleFailure(
      firstFailureStatus,
      firstBrowserError,
    );

    const postBrowserAutoApiFallbackReason =
      !requestedMethod && options?.requestSource !== 'player'
        ? getAutoApiFallbackReason(
            video,
            autoApiFallbackMatch,
            'after-browser',
          )
        : null;
    if (postBrowserAutoApiFallbackReason) {
      logSubtitleFallback(
        video,
        BROWSER_METHOD_ID,
        'gemini',
        `${firstBrowserError} | ${postBrowserAutoApiFallbackReason}`,
      );
      try {
        await runMethod('gemini', true);
        return;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const geminiError = formatStageError('gemini', error);
        firstFailureStatus = 'error';
        firstFailureClass = classifySubtitleFailure(
          firstFailureStatus,
          `${firstBrowserError} | ${geminiError}`,
        );
        updateSubtitleStateAndTrack({
          ...buildFailureState(
            video,
            firstFailureStatus,
            `${firstBrowserError} | ${geminiError}`,
            attemptAt,
          ),
        });
        logSubtitleFailure(
          video,
          'gemini',
          `${firstBrowserError} | ${geminiError}`,
        );
        markSubtitleError(
          video,
          statusPreferredMethod,
          'gemini',
          true,
          `${firstBrowserError} | ${geminiError}`,
        );
        if (
          firstFailureClass === 'temporary-error' &&
          shouldRecordSubtitleBackoff(geminiError)
        ) {
          if (isRateLimitError(geminiError)) {
            recordSubtitleRateLimit(video.platform);
          } else {
            recordSubtitleError(video.platform);
          }
        }
        return;
      }
    }

    if (
      firstFailureClass === 'temporary-error' &&
      shouldRecordSubtitleBackoff(firstBrowserError)
    ) {
      if (isRateLimitError(firstBrowserError)) {
        recordSubtitleRateLimit(video.platform);
      } else {
        recordSubtitleError(video.platform);
      }
    }

    updateSubtitleStateAndTrack({
      ...buildFailureState(
        video,
        firstFailureStatus,
        firstBrowserError,
        attemptAt,
      ),
    });
    logSubtitleFailure(video, BROWSER_METHOD_ID, firstBrowserError);
    markSubtitleError(
      video,
      statusPreferredMethod,
      BROWSER_METHOD_ID,
      false,
      firstBrowserError,
    );
  } catch (error) {
    if (!innerWroteState) {
      if (isAbortError(error)) {
        updateSubtitleState(video.id, {
          subtitle_status: 'error',
          subtitle_error: 'subtitle fetch aborted',
          subtitle_last_attempt_at: attemptAt,
          subtitle_retry_count: video.subtitle_retry_count,
          subtitle_cooldown_until: null,
        });
      } else {
        updateSubtitleState(video.id, {
          subtitle_status: 'error',
          subtitle_error:
            error instanceof Error ? error.message : String(error),
          subtitle_last_attempt_at: attemptAt,
          subtitle_retry_count: (video.subtitle_retry_count || 0) + 1,
          subtitle_cooldown_until: null,
        });
      }
    }
    markSubtitleIdle();
    throw error;
  } finally {
    if (tempDirToCleanup) {
      cleanupTempDirBestEffort(tempDirToCleanup);
    }
  }
}

export async function ensureSubtitleForVideo(
  videoId: number,
  options?: SubtitleFetchOptions,
): Promise<Video | null> {
  const db = getDb();
  const video = db
    .prepare(
      `
      SELECT v.*, c.name AS channel_name, i.id AS intent_id
      FROM videos v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN intents i ON i.name = c.intent
      WHERE v.id = ?
    `,
    )
    .get(videoId) as SubtitleVideoContext | undefined;
  if (!video) return null;
  await waitForCrawlerResumeIfNeeded(options?.respectPause !== false);
  const apiFallbackMatch =
    !options?.preferredMethod && options?.requestSource !== 'player'
      ? resolveSubtitleApiFallbackMatch({
          channelId: video.channel_id,
          intentId: video.intent_id,
        })
      : null;
  const shouldFetch = options?.force
    ? video.subtitle_status !== 'fetching'
    : shouldRetrySubtitleFetch(video);

  if (shouldFetch) {
    updateSubtitleState(video.id, {
      subtitle_path: null,
      subtitle_language: null,
      subtitle_format: null,
      subtitle_status: 'fetching',
      subtitle_error: null,
      subtitle_last_attempt_at: new Date().toISOString(),
      subtitle_retry_count: video.subtitle_retry_count,
      subtitle_cooldown_until: null,
    });
    appEvents.emit('subtitle:status-changed', {
      videoId: video.video_id,
      platform: video.platform,
      status: 'fetching',
      error: null,
      cooldownUntil: null,
    });
    try {
      await fetchAndStoreSubtitle(video, options);
      const updated = db
        .prepare('SELECT * FROM videos WHERE id = ?')
        .get(videoId) as Video;
      // Emit subtitle:status-changed event for SSE real-time push
      appEvents.emit('subtitle:status-changed', {
        videoId: updated.video_id,
        platform: updated.platform,
        status: updated.subtitle_status,
        error: updated.subtitle_error,
        cooldownUntil: updated.subtitle_cooldown_until,
      });
      return updated;
    } catch (error) {
      const current = db
        .prepare('SELECT * FROM videos WHERE id = ?')
        .get(videoId) as Video;
      appEvents.emit('subtitle:status-changed', {
        videoId: current.video_id,
        platform: current.platform,
        status: current.subtitle_status,
        error: current.subtitle_error,
        cooldownUntil: current.subtitle_cooldown_until,
      });
      throw error;
    }
  }
  return video;
}

export function readStoredSubtitle(
  video: Pick<Video, 'subtitle_path'>,
): SubtitlePayload | null {
  if (!video.subtitle_path || !fs.existsSync(video.subtitle_path)) return null;
  const payload = JSON.parse(
    fs.readFileSync(video.subtitle_path, 'utf8'),
  ) as SubtitlePayload;
  if (!Array.isArray(payload.segments)) {
    const rawPath = payload.raw_path;
    if (rawPath && fs.existsSync(rawPath)) {
      try {
        const raw = fs.readFileSync(rawPath, 'utf8');
        payload.segments = parseSubtitleSegments(raw, payload.format);
      } catch {
        payload.segments = estimateTxtSegments(payload.text || '');
      }
    } else {
      payload.segments = estimateTxtSegments(payload.text || '');
    }
  }
  return payload;
}

export const __subtitleRetryTestUtils = {
  buildFailureState,
  buildSegmentedSubtitlePrompt,
  classifySubtitleFailure,
  cleanupTempDirBestEffort,
  getAutoApiFallbackReason,
  getSubtitleRetryDelayMs,
  parseVideoDurationSeconds,
  isRateLimitError,
  shouldRecordSubtitleBackoff,
  shouldEscapeToApi,
  shiftSubtitleSegments,
};
