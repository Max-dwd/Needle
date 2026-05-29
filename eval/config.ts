import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { AiModelProtocol, AiSummaryModelConfig } from '@/types';

export type EvalVideoPlatform = 'youtube' | 'bilibili';
export type EvalVideoTier = 'short' | 'medium' | 'long';
export type EvalVideoDifficulty = 'normal' | 'hard';

export interface EvalConfigTargetVideo {
  id: string;
  tier: EvalVideoTier;
  difficulty: EvalVideoDifficulty;
  platform: EvalVideoPlatform;
  videoId: string;
  url: string;
  note: string;
  expectedLanguage?: string;
  requireManualCaptions?: boolean;
}

export interface EvalConfigDataset {
  outputDir: string;
  expectedLanguage?: string;
  requireManualCaptions?: boolean;
  live: {
    metadata: boolean;
    subtitles: boolean;
    audio: boolean;
  };
  targets: EvalConfigTargetVideo[];
}

export interface EvalConfigLlmAlignerPipeline {
  chunkSeconds: number;
  chunkConcurrency: number;
  maxSegmentSeconds: number;
  expectSpeakerLabels: boolean;
  verbatimCoveragePrompt: boolean;
}

export interface EvalConfigAligner {
  modelId: string;
  minAvgProb: number;
  minWordRatio: number;
}

export interface EvalConfigRun {
  outputRoot: string;
  concurrency: number;
  keepAudioChunks: boolean;
}

export interface EvalQualityGate {
  minCoverage?: number;
  maxNormalizedCharErrorRate?: number;
  maxStartMaeSeconds?: number;
  maxStartP95Seconds?: number;
  maxEndMaeSeconds?: number;
  maxEndP95Seconds?: number;
}

export interface EvalConfig {
  dataset: EvalConfigDataset;
  model: AiSummaryModelConfig;
  modelApiKeyEnv: string;
  pipeline: {
    llmAligner: EvalConfigLlmAlignerPipeline;
  };
  aligner: EvalConfigAligner;
  run: EvalConfigRun;
  qualityGate?: EvalQualityGate;
}

export interface EvalConfigLoadResult {
  config: EvalConfig;
  configSource: string;
  configSnapshot: unknown;
}

interface LoadEvalConfigOptions {
  requireApiKey?: boolean;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ALIGNER_MODEL_ID = 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit';
const PROTOCOLS = ['gemini', 'openai-chat', 'anthropic-messages'] as const;

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const normalized = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trimStart()
    : trimmed;
  const equalsIndex = normalized.indexOf('=');
  if (equalsIndex <= 0) return null;

  const key = normalized.slice(0, equalsIndex).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return null;

  let value = normalized.slice(equalsIndex + 1).trim();
  const quote = value[0];
  if (
    (quote === '"' || quote === "'") &&
    value.length >= 2 &&
    value[value.length - 1] === quote
  ) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  } else {
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) value = value.slice(0, hashIndex).trimEnd();
  }

  return [key, value];
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadRepoEnv(): void {
  loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  loadEnvFile(path.join(REPO_ROOT, '.env'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`eval config ${label} must be an object`);
  }
  return value;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return asRecord(value, label);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  fallback?: string,
): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`eval config ${label}.${key} must be a non-empty string`);
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
  label = 'section',
): boolean {
  if (!record || record[key] === undefined) return fallback;
  if (typeof record[key] === 'boolean') return record[key];
  throw new Error(`eval config ${label}.${key} must be a boolean`);
}

function readNumber(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  label: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = record?.[key];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`eval config ${label}.${key} must be a number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`eval config ${label}.${key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`eval config ${label}.${key} must be <= ${options.max}`);
  }
  return options.integer ? Math.round(value) : value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (record[key] === undefined || record[key] === null) return undefined;
  return readNumber(record, key, 0, label, options);
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  label: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = record[key];
  if (typeof value === 'string' && values.includes(value as T)) {
    return value as T;
  }
  if (fallback !== undefined && value === undefined) return fallback;
  throw new Error(
    `eval config ${label}.${key} must be one of: ${values.join(', ')}`,
  );
}

function resolveRepoPath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function relativeRepoPath(value: string): string {
  const relative = path.relative(REPO_ROOT, value);
  return relative || '.';
}

function normalizeDataset(rawRoot: Record<string, unknown>): EvalConfigDataset {
  const dataset = asRecord(rawRoot.dataset, 'dataset');
  const live = optionalRecord(dataset.live, 'dataset.live');
  const targetsRaw = dataset.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    throw new Error('eval config dataset.targets must be a non-empty array');
  }

  return {
    outputDir: resolveRepoPath(
      readString(dataset, 'outputDir', 'dataset', 'eval/data'),
    ),
    expectedLanguage:
      typeof dataset.expectedLanguage === 'string' &&
      dataset.expectedLanguage.trim()
        ? dataset.expectedLanguage.trim()
        : undefined,
    requireManualCaptions: readBoolean(
      dataset,
      'requireManualCaptions',
      false,
      'dataset',
    ),
    live: {
      metadata: readBoolean(live, 'metadata', true, 'dataset.live'),
      subtitles: readBoolean(live, 'subtitles', true, 'dataset.live'),
      audio: readBoolean(live, 'audio', true, 'dataset.live'),
    },
    targets: targetsRaw.map((entry, index) => {
      const target = asRecord(entry, `dataset.targets[${index}]`);
      return {
        id: readString(target, 'id', `dataset.targets[${index}]`),
        tier: readEnum(
          target,
          'tier',
          `dataset.targets[${index}]`,
          ['short', 'medium', 'long'],
          'medium',
        ),
        difficulty: readEnum(
          target,
          'difficulty',
          `dataset.targets[${index}]`,
          ['normal', 'hard'],
          'normal',
        ),
        platform: readEnum(target, 'platform', `dataset.targets[${index}]`, [
          'youtube',
          'bilibili',
        ]),
        videoId: readString(target, 'videoId', `dataset.targets[${index}]`),
        url: readString(target, 'url', `dataset.targets[${index}]`),
        note: readString(target, 'note', `dataset.targets[${index}]`, ''),
        expectedLanguage:
          typeof target.expectedLanguage === 'string' &&
          target.expectedLanguage.trim()
            ? target.expectedLanguage.trim()
            : undefined,
        requireManualCaptions:
          target.requireManualCaptions === undefined
            ? undefined
            : readBoolean(
                target,
                'requireManualCaptions',
                false,
                `dataset.targets[${index}]`,
              ),
      };
    }),
  };
}

function normalizeModel(
  rawRoot: Record<string, unknown>,
  requireApiKey: boolean,
): { model: AiSummaryModelConfig; apiKeyEnv: string } {
  const model = asRecord(rawRoot.model, 'model');
  const protocol = readEnum(
    model,
    'protocol',
    'model',
    PROTOCOLS,
  ) as AiModelProtocol;
  const apiKeyEnv = readString(model, 'apiKeyEnv', 'model');
  const apiKey = process.env[apiKeyEnv] || '';
  if (requireApiKey && !apiKey) {
    throw new Error(
      `eval config model.apiKeyEnv points to ${apiKeyEnv}, but that environment variable is not set`,
    );
  }

  return {
    apiKeyEnv,
    model: {
      id: readString(model, 'id', 'model', 'eval-config-model'),
      name: readString(model, 'name', 'model', 'Eval Config Model'),
      endpoint: readString(model, 'endpoint', 'model'),
      apiKey,
      model: readString(model, 'model', 'model'),
      protocol,
      isMultimodal: readBoolean(model, 'isMultimodal', true, 'model'),
      requestsPerMinute: readOptionalNumber(
        model,
        'requestsPerMinute',
        'model',
        { min: 1 },
      ),
      requestsPerDay: readOptionalNumber(model, 'requestsPerDay', 'model', {
        min: 1,
      }),
      tokensPerMinute: readOptionalNumber(model, 'tokensPerMinute', 'model', {
        min: 1,
      }),
      fallbackModelId:
        typeof model.fallbackModelId === 'string' &&
        model.fallbackModelId.trim()
          ? model.fallbackModelId.trim()
          : undefined,
    },
  };
}

function normalizePipeline(
  rawRoot: Record<string, unknown>,
): EvalConfig['pipeline'] {
  const pipeline = optionalRecord(rawRoot.pipeline, 'pipeline');
  const llmAligner = optionalRecord(
    pipeline?.llmAligner,
    'pipeline.llmAligner',
  );
  return {
    llmAligner: {
      chunkSeconds: readNumber(
        llmAligner,
        'chunkSeconds',
        300,
        'pipeline.llmAligner',
        { min: 60, max: 3600, integer: true },
      ),
      chunkConcurrency: readNumber(
        llmAligner,
        'chunkConcurrency',
        1,
        'pipeline.llmAligner',
        { min: 1, max: 16, integer: true },
      ),
      maxSegmentSeconds: readNumber(
        llmAligner,
        'maxSegmentSeconds',
        3,
        'pipeline.llmAligner',
        { min: 3, max: 60, integer: true },
      ),
      expectSpeakerLabels: readBoolean(
        llmAligner,
        'expectSpeakerLabels',
        true,
        'pipeline.llmAligner',
      ),
      verbatimCoveragePrompt: readBoolean(
        llmAligner,
        'verbatimCoveragePrompt',
        false,
        'pipeline.llmAligner',
      ),
    },
  };
}

function normalizeAligner(rawRoot: Record<string, unknown>): EvalConfigAligner {
  const aligner = optionalRecord(rawRoot.aligner, 'aligner');
  return {
    modelId:
      typeof aligner?.modelId === 'string' && aligner.modelId.trim()
        ? aligner.modelId.trim()
        : DEFAULT_ALIGNER_MODEL_ID,
    minAvgProb: readNumber(aligner, 'minAvgProb', 0.3, 'aligner', {
      min: 0,
      max: 1,
    }),
    minWordRatio: readNumber(aligner, 'minWordRatio', 0.3, 'aligner', {
      min: 0,
      max: 1,
    }),
  };
}

function normalizeRun(rawRoot: Record<string, unknown>): EvalConfigRun {
  const run = optionalRecord(rawRoot.run, 'run');
  return {
    outputRoot: resolveRepoPath(
      typeof run?.outputRoot === 'string' && run.outputRoot.trim()
        ? run.outputRoot.trim()
        : 'eval/runs',
    ),
    concurrency: readNumber(run, 'concurrency', 1, 'run', {
      min: 1,
      max: 32,
      integer: true,
    }),
    keepAudioChunks: readBoolean(run, 'keepAudioChunks', false, 'run'),
  };
}

function normalizeQualityGate(
  rawRoot: Record<string, unknown>,
): EvalQualityGate | undefined {
  const qualityGate = optionalRecord(rawRoot.qualityGate, 'qualityGate');
  if (!qualityGate) return undefined;
  const normalized: EvalQualityGate = {};
  for (const key of [
    'minCoverage',
    'maxNormalizedCharErrorRate',
    'maxStartMaeSeconds',
    'maxStartP95Seconds',
    'maxEndMaeSeconds',
    'maxEndP95Seconds',
  ] as const) {
    const value = readOptionalNumber(qualityGate, key, 'qualityGate', {
      min: 0,
    });
    if (value !== undefined) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function buildEvalConfigSnapshot(input: EvalConfig): unknown {
  return {
    dataset: {
      ...input.dataset,
      outputDir: relativeRepoPath(input.dataset.outputDir),
    },
    model: {
      id: input.model.id,
      name: input.model.name,
      protocol: input.model.protocol,
      endpoint: input.model.endpoint,
      model: input.model.model,
      apiKeyEnv: input.modelApiKeyEnv,
      apiKey: input.model.apiKey ? '[redacted]' : '',
      isMultimodal: input.model.isMultimodal,
      requestsPerMinute: input.model.requestsPerMinute,
      requestsPerDay: input.model.requestsPerDay,
      tokensPerMinute: input.model.tokensPerMinute,
      fallbackModelId: input.model.fallbackModelId,
    },
    pipeline: input.pipeline,
    aligner: input.aligner,
    run: {
      ...input.run,
      outputRoot: relativeRepoPath(input.run.outputRoot),
    },
    qualityGate: input.qualityGate || null,
  };
}

export function loadEvalConfig(
  configPath: string,
  options: LoadEvalConfigOptions = {},
): EvalConfigLoadResult {
  loadRepoEnv();

  const resolvedPath = resolveRepoPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`eval config not found: ${resolvedPath}`);
  }
  const raw = parseYaml(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  const root = asRecord(raw, 'root');
  const dataset = normalizeDataset(root);
  const { model, apiKeyEnv } = normalizeModel(
    root,
    options.requireApiKey !== false,
  );
  const pipeline = normalizePipeline(root);
  const aligner = normalizeAligner(root);
  const run = normalizeRun(root);
  const qualityGate = normalizeQualityGate(root);
  const config: EvalConfig = {
    dataset,
    model,
    modelApiKeyEnv: apiKeyEnv,
    pipeline,
    aligner,
    run,
    ...(qualityGate ? { qualityGate } : {}),
  };

  return {
    config,
    configSource: resolvedPath,
    configSnapshot: buildEvalConfigSnapshot(config),
  };
}
