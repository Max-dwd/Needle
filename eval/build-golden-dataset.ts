#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

type Platform = 'youtube' | 'bilibili';

interface TargetVideo {
  id: string;
  tier: 'short' | 'medium' | 'long';
  difficulty: 'normal' | 'hard';
  platform: Platform;
  videoId: string;
  url: string;
  note: string;
}

interface VideoRow {
  platform: Platform;
  video_id: string;
  title: string | null;
  duration: string | null;
  published_at: string | null;
  channel_name: string | null;
  subtitle_status: string | null;
  subtitle_path: string | null;
  subtitle_language: string | null;
  subtitle_format: string | null;
}

interface SubtitlePayload {
  language?: string;
  format?: string;
  text?: string;
  raw_path?: string;
  sourceMethod?: string;
  segmentStyle?: 'coarse' | 'fine';
  metadata?: Record<string, string | number>;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}

const DATASET_ID = 'llm-aligner-golden-v1';
const DATASET_VERSION = 1;
const DEFAULT_DATA_ROOT = path.resolve(process.cwd(), 'data');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'eval', 'data');

const TARGETS: TargetVideo[] = [
  {
    id: 'short-bilibili-ai-news',
    tier: 'short',
    difficulty: 'normal',
    platform: 'bilibili',
    videoId: 'BV1HpdBB7ETU',
    url: 'https://www.bilibili.com/video/BV1HpdBB7ETU',
    note: '短视频',
  },
  {
    id: 'medium-youtube-google-next',
    tier: 'medium',
    difficulty: 'normal',
    platform: 'youtube',
    videoId: 'ouSb6UoJqyc',
    url: 'https://www.youtube.com/watch?v=ouSb6UoJqyc',
    note: '中视频',
  },
  {
    id: 'long-youtube-world-model',
    tier: 'long',
    difficulty: 'normal',
    platform: 'youtube',
    videoId: 'SYuSZIIYOfI',
    url: 'https://www.youtube.com/watch?v=SYuSZIIYOfI',
    note: '长视频',
  },
  {
    id: 'long-hard-youtube-saas-ai',
    tier: 'long',
    difficulty: 'hard',
    platform: 'youtube',
    videoId: 'wVHIhiT1Ow0',
    url: 'https://www.youtube.com/watch?v=wVHIhiT1Ow0',
    note: '长视频 / 难',
  },
];

function parseArgs(argv: string[]): {
  dataRoot: string;
  outputDir: string;
  strict: boolean;
} {
  let dataRoot = process.env.DATA_ROOT
    ? path.resolve(process.env.DATA_ROOT)
    : DEFAULT_DATA_ROOT;
  let outputDir = DEFAULT_OUTPUT_DIR;
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
      case '--data-root':
        dataRoot = path.resolve(next());
        break;
      case '--output-dir':
        outputDir = path.resolve(next());
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

  return { dataRoot, outputDir, strict };
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:golden:build

Options:
  --data-root <dir>    Needle runtime data root (default: DATA_ROOT or ./data)
  --output-dir <dir>   Golden dataset output directory (default: eval/data)
  --strict             Exit non-zero if any target subtitle is missing
`);
}

function readVideoRows(dbPath: string): Map<string, VideoRow> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `
        SELECT platform,
               video_id,
               title,
               duration,
               published_at,
               channel_name,
               subtitle_status,
               subtitle_path,
               subtitle_language,
               subtitle_format
        FROM videos
        WHERE video_id IN (${TARGETS.map(() => '?').join(', ')})
      `,
      )
      .all(...TARGETS.map((target) => target.videoId)) as VideoRow[];
    return new Map(rows.map((row) => [row.video_id, row]));
  } finally {
    db.close();
  }
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

function resolveSubtitlePath(
  dataRoot: string,
  row: VideoRow | undefined,
  target: TargetVideo,
): string | null {
  const candidates = [
    row?.subtitle_path || '',
    path.join(dataRoot, 'subtitles', target.platform, `${target.videoId}.json`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(process.cwd(), candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

function normalizeSegments(payload: SubtitlePayload) {
  return (payload.segments || [])
    .map((segment) => {
      const start = Number(segment.start);
      const end = Number(segment.end);
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.join(options.dataRoot, 'folo.db');
  const videoRows = readVideoRows(dbPath);
  const generatedAt = new Date().toISOString();
  const cases = [];
  const missing = [];

  for (const target of TARGETS) {
    const row = videoRows.get(target.videoId);
    const subtitlePath = resolveSubtitlePath(options.dataRoot, row, target);
    if (!row || !subtitlePath) {
      missing.push({
        ...target,
        reason: !row ? 'missing_video_row' : 'missing_local_subtitle',
        dbSubtitleStatus: row?.subtitle_status || null,
        dbSubtitlePath: row?.subtitle_path || null,
        title: row?.title || null,
        duration: row?.duration || null,
      });
      continue;
    }

    const payload = JSON.parse(
      fs.readFileSync(subtitlePath, 'utf8'),
    ) as SubtitlePayload;
    const segments = normalizeSegments(payload);
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const durationSeconds =
      parseDurationSeconds(row.duration) ||
      segments.reduce((max, segment) => Math.max(max, segment.end), 0);
    const maxSegmentSeconds = segments.reduce(
      (max, segment) => Math.max(max, segment.end - segment.start),
      0,
    );
    const caseDir = path.join(options.outputDir, 'cases', target.id);
    const goldenJsonPath = path.join(caseDir, 'golden.json');
    const goldenTxtPath = path.join(caseDir, 'golden.txt');
    const subtitleText = buildSubtitleText(segments);

    const golden = {
      datasetId: DATASET_ID,
      datasetVersion: DATASET_VERSION,
      generatedAt,
      id: target.id,
      tier: target.tier,
      difficulty: target.difficulty,
      note: target.note,
      video: {
        platform: target.platform,
        videoId: target.videoId,
        url: target.url,
        title: row.title,
        channelName: row.channel_name,
        duration: row.duration,
        durationSeconds,
        publishedAt: row.published_at,
      },
      reference: {
        language: payload.language || row.subtitle_language || 'unknown',
        format: payload.format || row.subtitle_format || 'unknown',
        sourceMethod: payload.sourceMethod || null,
        segmentStyle: payload.segmentStyle || null,
        sourceSubtitlePath: path.relative(process.cwd(), subtitlePath),
        rawPath: payload.raw_path || null,
        text,
        segments,
      },
      stats: {
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
      },
    };

    writeJson(goldenJsonPath, golden);
    writeText(goldenTxtPath, subtitleText);
    cases.push({
      id: target.id,
      tier: target.tier,
      difficulty: target.difficulty,
      platform: target.platform,
      videoId: target.videoId,
      url: target.url,
      title: row.title,
      duration: row.duration,
      durationSeconds,
      segmentCount: segments.length,
      textCharCount: text.length,
      sourceSubtitlePath: path.relative(process.cwd(), subtitlePath),
      goldenJsonPath: path.relative(process.cwd(), goldenJsonPath),
      goldenTextPath: path.relative(process.cwd(), goldenTxtPath),
    });
  }

  const manifest = {
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    generatedAt,
    source: {
      kind: 'needle-local-subtitles',
      dataRoot: path.relative(process.cwd(), options.dataRoot) || '.',
      databasePath: path.relative(process.cwd(), dbPath),
    },
    cases,
    missing,
  };

  writeJson(path.join(options.outputDir, 'manifest.json'), manifest);
  writeText(
    path.join(options.outputDir, 'README.md'),
    [
      '# LLM Aligner Golden Dataset',
      '',
      `Generated at: ${generatedAt}`,
      '',
      `Complete cases: ${cases.length}`,
      `Missing cases: ${missing.length}`,
      '',
      'See `manifest.json` for case metadata and `cases/*/golden.json` for reference subtitles.',
    ].join('\n'),
  );

  for (const entry of cases) {
    console.log(
      `[ok] ${entry.id} segments=${entry.segmentCount} chars=${entry.textCharCount}`,
    );
  }
  for (const entry of missing) {
    console.warn(`[missing] ${entry.id}: ${entry.reason}`);
  }
  if (options.strict && missing.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
