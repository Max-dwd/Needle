import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_FORCED_ALIGNER_MODEL_ID } from './subtitle-llm-aligner-settings';

const execFileAsync = promisify(execFile);

const MLX_FORCED_ALIGNER_BIN = (
  process.env.MLX_FORCED_ALIGNER_BIN || 'mlx_forced_aligner'
).trim();
const CACHE_TTL_MS = 60_000;
const AVAILABILITY_CACHE_KEY = Symbol.for(
  'needle.forcedAlignerAvailabilityCache',
);

export interface MlxForcedAlignerStatus {
  available: boolean;
  binPath: string;
  version: string | null;
  checkedAt: string;
  error?: string;
}

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  prob?: number;
}

export interface AlignerResult {
  words: AlignedWord[];
  warnings?: string[];
}

export interface RunForcedAlignerOptions {
  modelId?: string;
  outputDir?: string;
  audioDurationSeconds?: number | null;
  signal?: AbortSignal;
}

interface CacheRecord {
  expiresAt: number;
  value: MlxForcedAlignerStatus;
}

type GlobalWithAlignerCache = typeof globalThis & {
  [AVAILABILITY_CACHE_KEY]?: CacheRecord;
};

function getGlobalCache(): CacheRecord | undefined {
  return (globalThis as GlobalWithAlignerCache)[AVAILABILITY_CACHE_KEY];
}

function setGlobalCache(value: MlxForcedAlignerStatus): void {
  (globalThis as GlobalWithAlignerCache)[AVAILABILITY_CACHE_KEY] = {
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

export async function getForcedAlignerStatus(
  force = false,
): Promise<MlxForcedAlignerStatus> {
  const cached = getGlobalCache();
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const checkedAt = new Date().toISOString();
  try {
    await execFileAsync(MLX_FORCED_ALIGNER_BIN, ['--help'], {
      signal: AbortSignal.timeout(10_000),
      maxBuffer: 512 * 1024,
    } as Parameters<typeof execFileAsync>[2]);

    let version: string | null = null;
    try {
      const versionResult = await execFileAsync(
        MLX_FORCED_ALIGNER_BIN,
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

    const status: MlxForcedAlignerStatus = {
      available: true,
      binPath: MLX_FORCED_ALIGNER_BIN,
      version,
      checkedAt,
    };
    setGlobalCache(status);
    return status;
  } catch (error) {
    const status: MlxForcedAlignerStatus = {
      available: false,
      binPath: MLX_FORCED_ALIGNER_BIN,
      version: null,
      checkedAt,
      error: readExecError(error),
    };
    setGlobalCache(status);
    return status;
  }
}

export async function isForcedAlignerAvailable(): Promise<boolean> {
  return (await getForcedAlignerStatus()).available;
}

function normalizeAlignedWord(raw: unknown): AlignedWord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const text = typeof value.text === 'string' ? value.text : '';
  const start = Number(value.start);
  const end = Number(value.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  if (end < start) return null;
  const probRaw = Number(value.prob ?? value.probability ?? value.confidence);
  return {
    text,
    start,
    end,
    prob: Number.isFinite(probRaw) ? probRaw : undefined,
  };
}

function parseAlignerJson(raw: string): AlignerResult {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const rawWords = Array.isArray(payload.words)
    ? payload.words
    : Array.isArray(payload.tokens)
      ? payload.tokens
      : Array.isArray(payload.alignments)
        ? payload.alignments
        : [];
  const words = rawWords
    .map((entry) => normalizeAlignedWord(entry))
    .filter((word): word is AlignedWord => Boolean(word));

  const warnings: string[] = [];
  if (Array.isArray(payload.warnings)) {
    for (const entry of payload.warnings) {
      if (typeof entry === 'string' && entry.trim()) {
        warnings.push(entry.trim());
      }
    }
  }

  return { words, warnings: warnings.length ? warnings : undefined };
}

function pickOutputJsonPath(outputDir: string, hint: string): string {
  const direct = path.join(outputDir, hint);
  if (fs.existsSync(direct)) return direct;
  const entries = fs
    .readdirSync(outputDir)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(outputDir, entry));
  if (entries.length === 0) {
    throw new Error('mlx_forced_aligner did not produce JSON output');
  }
  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return entries[0];
}

export async function runForcedAligner(
  audioPath: string,
  textPath: string,
  options: RunForcedAlignerOptions = {},
): Promise<AlignerResult> {
  const outputDir =
    options.outputDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'needle-aligner-'));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'aligned.json');
  const modelId = options.modelId || DEFAULT_FORCED_ALIGNER_MODEL_ID;

  const durationSeconds =
    Number.isFinite(Number(options.audioDurationSeconds)) &&
    Number(options.audioDurationSeconds) > 0
      ? Number(options.audioDurationSeconds)
      : 15 * 60;
  const timeoutSignal = AbortSignal.timeout(
    Math.max(60_000, Math.ceil(durationSeconds * 3 * 1000)),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  await execFileAsync(
    MLX_FORCED_ALIGNER_BIN,
    [
      '--audio',
      audioPath,
      '--text',
      textPath,
      '--model',
      modelId,
      '--output-format',
      'json',
      '--output',
      outputPath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
          .filter(Boolean)
          .join(':'),
      },
    } as Parameters<typeof execFileAsync>[2],
  );

  const jsonPath = pickOutputJsonPath(outputDir, 'aligned.json');
  const result = parseAlignerJson(fs.readFileSync(jsonPath, 'utf8'));
  if (result.words.length === 0) {
    throw new Error('mlx_forced_aligner returned no aligned words');
  }
  return result;
}

export const __forcedAlignerRuntimeTestUtils = {
  parseAlignerJson,
};
