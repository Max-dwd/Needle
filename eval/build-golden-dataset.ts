#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import type { EvalSubtitleVideo, SubtitlePayload } from '@/lib/subtitles';
import {
  loadEvalConfig,
  loadRepoEnv,
  type EvalConfigDataset,
  type EvalConfigTargetVideo,
} from './config';

interface LiveVideoDetail {
  title?: string;
  duration?: string;
  published_at?: string;
  channel_name?: string;
  thumbnail_url?: string;
}

const DATASET_ID = 'llm-aligner-golden-v1';
const DATASET_VERSION = 1;
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'eval', 'data');

const TARGETS: EvalConfigTargetVideo[] = [
  {
    id: 'short-youtube-llm-ibm',
    tier: 'short',
    difficulty: 'normal',
    platform: 'youtube',
    videoId: '5sLYAQS9sWQ',
    url: 'https://www.youtube.com/watch?v=5sLYAQS9sWQ',
    note: 'English short LLM explainer from IBM Technology',
  },
  {
    id: 'medium-youtube-transformers-3b1b',
    tier: 'medium',
    difficulty: 'normal',
    platform: 'youtube',
    videoId: 'wjZofJX0v4M',
    url: 'https://www.youtube.com/watch?v=wjZofJX0v4M',
    note: 'English medium visual transformer explainer from 3Blue1Brown',
  },
  {
    id: 'long-youtube-state-of-gpt',
    tier: 'long',
    difficulty: 'normal',
    platform: 'youtube',
    videoId: 'bZQun8Y4L2A',
    url: 'https://www.youtube.com/watch?v=bZQun8Y4L2A',
    note: 'English long technical talk, single primary speaker',
  },
  {
    id: 'long-hard-youtube-openai-devday',
    tier: 'long',
    difficulty: 'hard',
    platform: 'youtube',
    videoId: 'U9mJuUkhUzk',
    url: 'https://www.youtube.com/watch?v=U9mJuUkhUzk',
    note: 'English long-hard keynote with live pacing, demos, audience audio, and speaker transitions',
  },
];

function parseArgs(argv: string[]): {
  config?: string;
  outputDir?: string;
  validateConfig: boolean;
  strict: boolean;
} {
  let config: string | undefined;
  let outputDir: string | undefined;
  let validateConfig = false;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--config':
        config = next();
        break;
      case '--output-dir':
        outputDir = path.resolve(next());
        break;
      case '--validate-config':
        validateConfig = true;
        break;
      case '--strict':
        strict = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return {
    ...(config ? { config } : {}),
    ...(outputDir ? { outputDir } : {}),
    validateConfig,
    strict,
  };
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:golden:build -- --config eval/config.local.yaml

Options:
  --config <yaml>     Eval config file (recommended)
  --output-dir <dir>   Golden dataset output directory (default: eval/data)
  --validate-config    Validate YAML config and exit without fetching live data
  --strict             Exit non-zero if any target cannot be fetched
`);
}

function parseDurationSeconds(
  duration: string | null | undefined,
): number | null {
  if (!duration) return null;
  const parts = duration
    .split(':')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

function isChineseExpectedLanguage(expectedLanguage?: string): boolean {
  return Boolean(expectedLanguage?.toLowerCase().startsWith('zh'));
}

function normalizeReferenceText(
  text: string,
  expectedLanguage?: string,
): string {
  const normalized = text.trim();
  if (!isChineseExpectedLanguage(expectedLanguage)) return normalized;

  const firstCjkIndex = normalized.search(/[\u3400-\u9fff]/u);
  if (firstCjkIndex > 0) return normalized.slice(firstCjkIndex).trim();
  return normalized;
}

function normalizeSegments(
  payload: SubtitlePayload,
  expectedLanguage?: string,
) {
  return (payload.segments || [])
    .map((segment) => {
      const start = Number(segment.start);
      const end = Number(segment.end);
      const text =
        typeof segment.text === 'string'
          ? normalizeReferenceText(segment.text, expectedLanguage)
          : '';
      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
        return null;
      }
      return {
        start,
        end: Math.max(end, start + 0.05),
        text,
        ...(segment.speaker?.trim() ? { speaker: segment.speaker.trim() } : {}),
      };
    })
    .filter((segment): segment is NonNullable<typeof segment> =>
      Boolean(segment),
    );
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildSubtitleText(
  segments: ReturnType<typeof normalizeSegments>,
): string {
  return segments
    .map((segment) => {
      const speaker = segment.speaker ? `[${segment.speaker}] ` : '';
      return `[${formatTimestamp(segment.start)}-${formatTimestamp(segment.end)}] ${speaker}${segment.text}`;
    })
    .join('\n');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value.trim()}\n`, 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildEvalVideo(
  target: EvalConfigTargetVideo,
  detail: LiveVideoDetail | null,
): EvalSubtitleVideo {
  return {
    id: 0,
    channel_id: 0,
    platform: target.platform,
    video_id: target.videoId,
    title: detail?.title || target.videoId,
    thumbnail_url: detail?.thumbnail_url || null,
    published_at: detail?.published_at || null,
    duration: detail?.duration || null,
    is_read: 0,
    is_members_only: 0,
    access_status: null,
    availability_status: null,
    availability_reason: null,
    availability_checked_at: null,
    subtitle_path: null,
    subtitle_language: null,
    subtitle_format: null,
    subtitle_status: null,
    subtitle_error: null,
    subtitle_last_attempt_at: null,
    subtitle_retry_count: 0,
    subtitle_cooldown_until: null,
    members_only_checked_at: null,
    created_at: new Date().toISOString(),
    channel_name: detail?.channel_name || null,
  };
}

async function main(): Promise<void> {
  loadRepoEnv();
  const options = parseArgs(process.argv.slice(2));
  const configLoad = options.config
    ? loadEvalConfig(options.config, { requireApiKey: false })
    : null;
  const dataset: EvalConfigDataset = configLoad
    ? {
        ...configLoad.config.dataset,
        outputDir: options.outputDir || configLoad.config.dataset.outputDir,
      }
    : {
        outputDir: options.outputDir || DEFAULT_OUTPUT_DIR,
        expectedLanguage: 'en',
        live: { metadata: true, subtitles: true, audio: true },
        targets: TARGETS,
      };
  const outputDir = dataset.outputDir;
  if (options.validateConfig) {
    if (!configLoad) {
      throw new Error('--validate-config requires --config');
    }
    console.log(
      `[ok] eval config ${path.relative(process.cwd(), configLoad.configSource)} targets=${dataset.targets.length} outputDir=${path.relative(process.cwd(), outputDir)}`,
    );
    return;
  }

  const generatedAt = new Date().toISOString();
  const cases = [];
  const missing = [];
  const { fetchYouTubeVideoDetail, fetchBilibiliVideoDetail } =
    await import('@/lib/fetcher');
  const { cacheAudioForEval, fetchBrowserSubtitleForEval } =
    await import('@/lib/subtitles');

  for (const target of dataset.targets) {
    const caseDir = path.join(outputDir, 'cases', target.id);
    try {
      const detail = dataset.live.metadata
        ? target.platform === 'youtube'
          ? await fetchYouTubeVideoDetail(target.videoId)
          : await fetchBilibiliVideoDetail(target.videoId)
        : null;
      const video = buildEvalVideo(target, detail);
      if (!dataset.live.subtitles) {
        throw new Error(
          'dataset.live.subtitles is false; golden builder needs a live subtitle reference',
        );
      }
      const payload = await fetchBrowserSubtitleForEval(video, {
        language: target.expectedLanguage || dataset.expectedLanguage,
      });
      const cachedAudio = dataset.live.audio
        ? await cacheAudioForEval(video, caseDir)
        : null;
      const expectedLanguage =
        target.expectedLanguage || dataset.expectedLanguage;
      const requireManualCaptions =
        target.requireManualCaptions ?? dataset.requireManualCaptions ?? false;
      const isAutoGenerated = Number(payload.metadata?.is_auto_generated) === 1;
      if (expectedLanguage && video.platform === 'youtube') {
        const actualLanguage = payload.language || 'unknown';
        if (
          actualLanguage === 'unknown' ||
          !actualLanguage
            .toLowerCase()
            .startsWith(expectedLanguage.toLowerCase())
        ) {
          throw new Error(
            `expected ${expectedLanguage} subtitles, got ${actualLanguage}`,
          );
        }
      }
      if (requireManualCaptions && video.platform === 'youtube') {
        if (isAutoGenerated) {
          throw new Error(
            `expected manual subtitles, got auto-generated track ${String(
              payload.metadata?.track_name || payload.language || 'unknown',
            )}`,
          );
        }
      }
      const segments = normalizeSegments(payload, expectedLanguage);
      if (segments.length === 0) {
        throw new Error('live subtitle fetch produced zero valid segments');
      }

      const text = isChineseExpectedLanguage(expectedLanguage)
        ? segments.map((segment) => segment.text).join('\n')
        : typeof payload.text === 'string' && payload.text.trim()
          ? payload.text.trim()
          : segments.map((segment) => segment.text).join('\n');
      const durationSeconds =
        parseDurationSeconds(video.duration) ||
        cachedAudio?.durationSeconds ||
        segments.reduce((max, segment) => Math.max(max, segment.end), 0);
      const maxSegmentSeconds = segments.reduce(
        (max, segment) => Math.max(max, segment.end - segment.start),
        0,
      );
      const goldenJsonPath = path.join(caseDir, 'golden.json');
      const goldenTxtPath = path.join(caseDir, 'golden.txt');
      const metadataPath = path.join(caseDir, 'metadata.json');
      const subtitleText = buildSubtitleText(segments);

      const videoMetadata = {
        platform: target.platform,
        videoId: target.videoId,
        url: target.url,
        title: video.title,
        channelName: video.channel_name,
        duration: video.duration,
        durationSeconds,
        publishedAt: video.published_at,
        thumbnailUrl: video.thumbnail_url,
      };
      const stats = {
        segmentCount: segments.length,
        textCharCount: text.length,
        maxSegmentSeconds: Number(maxSegmentSeconds.toFixed(3)),
        avgSegmentSeconds:
          segments.length > 0
            ? Number(
                (
                  segments.reduce(
                    (sum, segment) => sum + segment.end - segment.start,
                    0,
                  ) / segments.length
                ).toFixed(3),
              )
            : 0,
      };
      const golden = {
        datasetId: DATASET_ID,
        datasetVersion: DATASET_VERSION,
        generatedAt,
        id: target.id,
        tier: target.tier,
        difficulty: target.difficulty,
        note: target.note,
        video: videoMetadata,
        reference: {
          language: payload.language || 'unknown',
          format: payload.format || 'unknown',
          sourceMethod: payload.sourceMethod || null,
          segmentStyle: payload.segmentStyle || null,
          expectedLanguage: expectedLanguage || null,
          trackName:
            typeof payload.metadata?.track_name === 'string'
              ? payload.metadata.track_name
              : null,
          isAutoGenerated,
          textTransform: isChineseExpectedLanguage(expectedLanguage)
            ? 'strip-leading-latin-before-cjk'
            : null,
          source: 'needle-browser-live',
          text,
          segments,
        },
        stats,
      };
      const metadata = {
        datasetId: DATASET_ID,
        datasetVersion: DATASET_VERSION,
        generatedAt,
        id: target.id,
        tier: target.tier,
        difficulty: target.difficulty,
        note: target.note,
        video: videoMetadata,
        golden: {
          jsonPath: path.relative(process.cwd(), goldenJsonPath),
          textPath: path.relative(process.cwd(), goldenTxtPath),
          source: 'needle-browser-live',
          sourceMethod: payload.sourceMethod || null,
          expectedLanguage: expectedLanguage || null,
          language: payload.language || 'unknown',
          trackName:
            typeof payload.metadata?.track_name === 'string'
              ? payload.metadata.track_name
              : null,
          isAutoGenerated,
          segmentCount: segments.length,
          textCharCount: text.length,
        },
        audio: {
          cachedAudioPath: cachedAudio
            ? path.relative(process.cwd(), cachedAudio.audioPath)
            : null,
          cached: Boolean(cachedAudio),
          durationSeconds: cachedAudio?.durationSeconds || null,
          source: cachedAudio ? 'yt-dlp-live' : null,
        },
        stats,
      };

      writeJson(goldenJsonPath, golden);
      writeText(goldenTxtPath, subtitleText);
      writeJson(metadataPath, metadata);
      cases.push({
        id: target.id,
        tier: target.tier,
        difficulty: target.difficulty,
        platform: target.platform,
        videoId: target.videoId,
        url: target.url,
        title: video.title,
        duration: video.duration,
        durationSeconds,
        expectedLanguage: expectedLanguage || null,
        language: payload.language || 'unknown',
        trackName:
          typeof payload.metadata?.track_name === 'string'
            ? payload.metadata.track_name
            : null,
        isAutoGenerated,
        segmentCount: segments.length,
        textCharCount: text.length,
        caseDir: path.relative(process.cwd(), caseDir),
        ...(cachedAudio
          ? { audioPath: path.relative(process.cwd(), cachedAudio.audioPath) }
          : {}),
        goldenJsonPath: path.relative(process.cwd(), goldenJsonPath),
        goldenTextPath: path.relative(process.cwd(), goldenTxtPath),
        metadataPath: path.relative(process.cwd(), metadataPath),
      });
      console.log(
        `[ok] ${target.id} segments=${segments.length} chars=${text.length} audio=${
          cachedAudio
            ? path.relative(process.cwd(), cachedAudio.audioPath)
            : 'skipped'
        }`,
      );
    } catch (error) {
      missing.push({
        ...target,
        reason: errorMessage(error),
      });
      console.warn(`[missing] ${target.id}: ${errorMessage(error)}`);
    }
  }

  const manifest = {
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    generatedAt,
    source: {
      kind: 'needle-live-app-interfaces',
      ...(configLoad
        ? {
            configSource: path.relative(process.cwd(), configLoad.configSource),
            configSnapshot: configLoad.configSnapshot,
          }
        : {}),
      subtitleSource: 'fetchBrowserSubtitleForEval',
      audioSource: 'cacheAudioForEval',
      metadataSource: 'fetchYouTubeVideoDetail/fetchBilibiliVideoDetail',
      live: dataset.live,
      expectedLanguage: dataset.expectedLanguage || null,
      requireManualCaptions: dataset.requireManualCaptions || false,
    },
    cases,
    missing,
  };

  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  writeText(
    path.join(outputDir, 'README.md'),
    [
      '# LLM Aligner Golden Dataset',
      '',
      `Generated at: ${generatedAt}`,
      '',
      `Complete cases: ${cases.length}`,
      `Missing cases: ${missing.length}`,
      '',
      'See `manifest.json` for case metadata and `cases/*/{metadata.json,golden.json,audio.*}` for stable eval inputs.',
    ].join('\n'),
  );

  if (options.strict && missing.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
