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
const FORCED_ALIGNER_REMOTE_URL = (
  process.env.FORCED_ALIGNER_REMOTE_URL || ''
).trim();
const CACHE_TTL_MS = 60_000;
const AVAILABILITY_CACHE_KEY = Symbol.for(
  'needle.forcedAlignerAvailabilityCache',
);

export type ForcedAlignerRuntime = 'local' | 'remote';

export interface MlxForcedAlignerStatus {
  available: boolean;
  runtime: ForcedAlignerRuntime;
  binPath: string;
  remoteUrl?: string;
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

function getForcedAlignerRuntime(): ForcedAlignerRuntime {
  return process.env.FORCED_ALIGNER_RUNTIME?.trim().toLowerCase() === 'remote'
    ? 'remote'
    : 'local';
}

function getForcedAlignerRemoteUrl(): string {
  return (process.env.FORCED_ALIGNER_REMOTE_URL || FORCED_ALIGNER_REMOTE_URL)
    .trim()
    .replace(/\/+$/, '');
}

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

function getAlignerTimeoutSignal(
  audioDurationSeconds: number | null | undefined,
  userSignal?: AbortSignal,
): AbortSignal {
  const durationSeconds =
    Number.isFinite(Number(audioDurationSeconds)) &&
    Number(audioDurationSeconds) > 0
      ? Number(audioDurationSeconds)
      : 15 * 60;
  const timeoutSignal = AbortSignal.timeout(
    Math.max(60_000, Math.ceil(durationSeconds * 3 * 1000)),
  );
  return userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
}

function remoteStatusToLocalStatus(
  payload: Record<string, unknown>,
  remoteUrl: string,
  checkedAt: string,
): MlxForcedAlignerStatus {
  const available = payload.available === true;
  const version = typeof payload.version === 'string' ? payload.version : null;
  const binPath =
    typeof payload.binPath === 'string' && payload.binPath.trim()
      ? payload.binPath.trim()
      : 'remote';
  const error =
    typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : undefined;

  return {
    available,
    runtime: 'remote',
    binPath,
    remoteUrl,
    version,
    checkedAt,
    ...(error ? { error } : {}),
  };
}

async function getRemoteForcedAlignerStatus(
  checkedAt: string,
): Promise<MlxForcedAlignerStatus> {
  const remoteUrl = getForcedAlignerRemoteUrl();
  if (!remoteUrl) {
    return {
      available: false,
      runtime: 'remote',
      binPath: 'remote',
      remoteUrl: undefined,
      version: null,
      checkedAt,
      error: 'FORCED_ALIGNER_REMOTE_URL is required when FORCED_ALIGNER_RUNTIME=remote',
    };
  }

  try {
    const res = await fetch(`${remoteUrl}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `remote status returned HTTP ${res.status}`,
      );
    }
    const status = remoteStatusToLocalStatus(payload, remoteUrl, checkedAt);
    setGlobalCache(status);
    return status;
  } catch (error) {
    const status: MlxForcedAlignerStatus = {
      available: false,
      runtime: 'remote',
      binPath: 'remote',
      remoteUrl,
      version: null,
      checkedAt,
      error: readExecError(error),
    };
    setGlobalCache(status);
    return status;
  }
}

export async function getForcedAlignerStatus(
  force = false,
): Promise<MlxForcedAlignerStatus> {
  const cached = getGlobalCache();
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const checkedAt = new Date().toISOString();
  if (getForcedAlignerRuntime() === 'remote') {
    return getRemoteForcedAlignerStatus(checkedAt);
  }

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
      runtime: 'local',
      binPath: MLX_FORCED_ALIGNER_BIN,
      version,
      checkedAt,
    };
    setGlobalCache(status);
    return status;
  } catch (error) {
    const status: MlxForcedAlignerStatus = {
      available: false,
      runtime: 'local',
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

async function runRemoteForcedAligner(
  audioPath: string,
  textPath: string,
  options: RunForcedAlignerOptions,
  modelId: string,
): Promise<AlignerResult> {
  const remoteUrl = getForcedAlignerRemoteUrl();
  if (!remoteUrl) {
    throw new Error(
      'FORCED_ALIGNER_REMOTE_URL is required when FORCED_ALIGNER_RUNTIME=remote',
    );
  }

  const signal = getAlignerTimeoutSignal(
    options.audioDurationSeconds,
    options.signal,
  );
  const payload = {
    audioFilename: path.basename(audioPath),
    audioBase64: fs.readFileSync(audioPath).toString('base64'),
    text: fs.readFileSync(textPath, 'utf8'),
    modelId,
  };

  const res = await fetch(`${remoteUrl}/align`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const responseText = await res.text();
  if (!res.ok) {
    let message = responseText.trim();
    try {
      const errorPayload = JSON.parse(responseText) as Record<string, unknown>;
      if (typeof errorPayload.error === 'string') {
        message = errorPayload.error;
      }
    } catch {
      // Keep the raw response text.
    }
    throw new Error(
      message || `remote forced aligner returned HTTP ${res.status}`,
    );
  }

  const result = parseAlignerJson(responseText);
  if (result.words.length === 0) {
    throw new Error('remote forced aligner returned no aligned words');
  }
  return result;
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

  if (getForcedAlignerRuntime() === 'remote') {
    return runRemoteForcedAligner(audioPath, textPath, options, modelId);
  }

  const signal = getAlignerTimeoutSignal(
    options.audioDurationSeconds,
    options.signal,
  );

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
  getForcedAlignerRuntime,
  getForcedAlignerRemoteUrl,
};
