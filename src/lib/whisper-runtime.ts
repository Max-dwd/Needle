import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_WHISPER_MODEL_ID } from './subtitle-whisper-ai-settings';

const execFileAsync = promisify(execFile);

const MLX_WHISPER_BIN = (process.env.MLX_WHISPER_BIN || 'mlx_whisper').trim();
const CACHE_TTL_MS = 60_000;
const AVAILABILITY_CACHE_KEY = Symbol.for('needle.mlxWhisperAvailabilityCache');

export interface MlxWhisperStatus {
  available: boolean;
  binPath: string;
  version: string | null;
  checkedAt: string;
  error?: string;
}

export interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  noSpeechProb?: number;
  avgLogprob?: number;
}

export interface WhisperResult {
  language: string;
  segments: WhisperSegment[];
}

export interface RunWhisperOptions {
  modelId?: string;
  outputDir?: string;
  audioDurationSeconds?: number | null;
  signal?: AbortSignal;
}

interface CacheRecord {
  expiresAt: number;
  value: MlxWhisperStatus;
}

type GlobalWithWhisperCache = typeof globalThis & {
  [AVAILABILITY_CACHE_KEY]?: CacheRecord;
};

function getGlobalCache(): CacheRecord | undefined {
  return (globalThis as GlobalWithWhisperCache)[AVAILABILITY_CACHE_KEY];
}

function setGlobalCache(value: MlxWhisperStatus): void {
  (globalThis as GlobalWithWhisperCache)[AVAILABILITY_CACHE_KEY] = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  };
}

function readExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr =
    'stderr' in error && error.stderr
      ? Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8')
        : String(error.stderr)
      : '';
  return (stderr || error.message).replace(/\s+/g, ' ').trim();
}

function firstUsefulLine(value: string | Buffer | undefined): string | null {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value || '';
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 160) || null
  );
}

export async function getMlxWhisperStatus(
  force = false,
): Promise<MlxWhisperStatus> {
  const cached = getGlobalCache();
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const checkedAt = new Date().toISOString();
  try {
    await execFileAsync(MLX_WHISPER_BIN, ['--help'], {
      signal: AbortSignal.timeout(10_000),
      maxBuffer: 512 * 1024,
    } as Parameters<typeof execFileAsync>[2]);

    let version: string | null = null;
    try {
      const versionResult = await execFileAsync(
        MLX_WHISPER_BIN,
        ['--version'],
        {
          signal: AbortSignal.timeout(10_000),
          maxBuffer: 512 * 1024,
        } as Parameters<typeof execFileAsync>[2],
      );
      version =
        firstUsefulLine(versionResult.stdout) ||
        firstUsefulLine(versionResult.stderr);
    } catch {
      version = null;
    }

    const status: MlxWhisperStatus = {
      available: true,
      binPath: MLX_WHISPER_BIN,
      version,
      checkedAt,
    };
    setGlobalCache(status);
    return status;
  } catch (error) {
    const status: MlxWhisperStatus = {
      available: false,
      binPath: MLX_WHISPER_BIN,
      version: null,
      checkedAt,
      error: readExecError(error),
    };
    setGlobalCache(status);
    return status;
  }
}

export async function isMlxWhisperAvailable(): Promise<boolean> {
  return (await getMlxWhisperStatus()).available;
}

function normalizeWhisperSegment(
  raw: unknown,
  index: number,
): WhisperSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const noSpeechProbRaw = Number(value.no_speech_prob ?? value.noSpeechProb);
  const avgLogprobRaw = Number(value.avg_logprob ?? value.avgLogprob);
  return {
    id: Number.isInteger(value.id) ? Number(value.id) : index,
    start,
    end,
    text: typeof value.text === 'string' ? value.text.trim() : '',
    noSpeechProb: Number.isFinite(noSpeechProbRaw)
      ? noSpeechProbRaw
      : undefined,
    avgLogprob: Number.isFinite(avgLogprobRaw) ? avgLogprobRaw : undefined,
  };
}

function normalizeNonFiniteJsonNumbers(raw: string): string {
  let normalized = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      normalized += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }

    if (raw.startsWith('-Infinity', index)) {
      normalized += 'null';
      index += '-Infinity'.length - 1;
      continue;
    }
    if (raw.startsWith('Infinity', index)) {
      normalized += 'null';
      index += 'Infinity'.length - 1;
      continue;
    }
    if (raw.startsWith('NaN', index)) {
      normalized += 'null';
      index += 'NaN'.length - 1;
      continue;
    }

    normalized += char;
  }

  return normalized;
}

function parseWhisperJson(raw: string): WhisperResult {
  const payload = JSON.parse(normalizeNonFiniteJsonNumbers(raw)) as Record<
    string,
    unknown
  >;
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  return {
    language:
      typeof payload.language === 'string' && payload.language.trim()
        ? payload.language.trim()
        : 'unknown',
    segments: segments
      .map((segment, index) => normalizeWhisperSegment(segment, index))
      .filter((segment): segment is WhisperSegment => Boolean(segment)),
  };
}

function findWhisperJson(outputDir: string): string {
  const entries = fs
    .readdirSync(outputDir)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(outputDir, entry));
  if (entries.length === 0) {
    throw new Error('mlx-whisper did not produce JSON output');
  }
  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

export async function runWhisper(
  audioPath: string,
  options: RunWhisperOptions = {},
): Promise<WhisperResult> {
  const outputDir =
    options.outputDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'needle-whisper-'));
  fs.mkdirSync(outputDir, { recursive: true });
  const modelId = options.modelId || DEFAULT_WHISPER_MODEL_ID;
  const durationSeconds =
    Number.isFinite(Number(options.audioDurationSeconds)) &&
    Number(options.audioDurationSeconds) > 0
      ? Number(options.audioDurationSeconds)
      : 30 * 60;
  const timeoutSignal = AbortSignal.timeout(
    Math.max(60_000, Math.ceil(durationSeconds * 2 * 1000)),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  await execFileAsync(
    MLX_WHISPER_BIN,
    [
      audioPath,
      '--model',
      modelId,
      '--output-format',
      'json',
      '--word-timestamps',
      'True',
      '--output-dir',
      outputDir,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
          .filter(Boolean)
          .join(':'),
      },
    } as Parameters<typeof execFileAsync>[2],
  );

  const jsonPath = findWhisperJson(outputDir);
  const result = parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'));
  if (result.segments.length === 0) {
    throw new Error('mlx-whisper returned no usable segments');
  }
  return result;
}

export const __whisperRuntimeTestUtils = {
  parseWhisperJson,
  normalizeNonFiniteJsonNumbers,
};
