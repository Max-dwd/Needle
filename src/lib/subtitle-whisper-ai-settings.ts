import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';

export const SUBTITLE_WHISPER_AI_CONFIG_KEY = 'subtitle_whisper_ai_config';

export const DEFAULT_WHISPER_MODEL_ID =
  process.env.WHISPER_MODEL_ID || 'mlx-community/whisper-base-mlx-q4';

export interface SubtitleWhisperAiBatchConfig {
  targetSeconds: number;
  maxSeconds: number;
  maxSegments: number;
  silenceWindow: number;
  minSeconds: number;
}

export interface SubtitleWhisperAiHallucinationConfig {
  noSpeechProbThreshold: number;
  avgLogprobThreshold: number;
}

export interface SubtitleWhisperAiConfig {
  enabled: boolean;
  whisperModelId: string;
  batch: SubtitleWhisperAiBatchConfig;
  hallucination: SubtitleWhisperAiHallucinationConfig;
  updatedAt: string | null;
}

interface StoredSubtitleWhisperAiConfig {
  enabled?: unknown;
  whisperModelId?: unknown;
  batch?: unknown;
  hallucination?: unknown;
}

const DEFAULT_BATCH_CONFIG: SubtitleWhisperAiBatchConfig = {
  targetSeconds: 180,
  maxSeconds: 300,
  maxSegments: 60,
  silenceWindow: 30,
  minSeconds: 30,
};

const DEFAULT_HALLUCINATION_CONFIG: SubtitleWhisperAiHallucinationConfig = {
  noSpeechProbThreshold: 0.8,
  avgLogprobThreshold: -1.0,
};

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizePositiveNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(normalized)));
}

function normalizeThreshold(value: unknown, fallback: number): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeBatchConfig(raw: unknown): SubtitleWhisperAiBatchConfig {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Partial<SubtitleWhisperAiBatchConfig>)
      : {};
  const targetSeconds = normalizePositiveNumber(
    value.targetSeconds,
    DEFAULT_BATCH_CONFIG.targetSeconds,
    30,
    300,
  );
  const maxSeconds = normalizePositiveNumber(
    value.maxSeconds,
    DEFAULT_BATCH_CONFIG.maxSeconds,
    targetSeconds,
    600,
  );
  const maxSegments = normalizePositiveNumber(
    value.maxSegments,
    DEFAULT_BATCH_CONFIG.maxSegments,
    1,
    300,
  );
  const silenceWindow = normalizePositiveNumber(
    value.silenceWindow,
    DEFAULT_BATCH_CONFIG.silenceWindow,
    0,
    120,
  );
  const minSeconds = normalizePositiveNumber(
    value.minSeconds,
    DEFAULT_BATCH_CONFIG.minSeconds,
    0,
    targetSeconds,
  );

  return {
    targetSeconds,
    maxSeconds,
    maxSegments,
    silenceWindow,
    minSeconds,
  };
}

function normalizeHallucinationConfig(
  raw: unknown,
): SubtitleWhisperAiHallucinationConfig {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Partial<SubtitleWhisperAiHallucinationConfig>)
      : {};

  return {
    noSpeechProbThreshold: normalizeThreshold(
      value.noSpeechProbThreshold,
      DEFAULT_HALLUCINATION_CONFIG.noSpeechProbThreshold,
    ),
    avgLogprobThreshold: normalizeThreshold(
      value.avgLogprobThreshold,
      DEFAULT_HALLUCINATION_CONFIG.avgLogprobThreshold,
    ),
  };
}

function normalizeConfig(
  raw: unknown,
): Omit<SubtitleWhisperAiConfig, 'updatedAt'> {
  const value =
    raw && typeof raw === 'object'
      ? (raw as StoredSubtitleWhisperAiConfig)
      : {};

  return {
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    whisperModelId: normalizeText(
      value.whisperModelId,
      DEFAULT_WHISPER_MODEL_ID,
    ),
    batch: normalizeBatchConfig(value.batch),
    hallucination: normalizeHallucinationConfig(value.hallucination),
  };
}

function parseStoredConfig(): Omit<SubtitleWhisperAiConfig, 'updatedAt'> {
  const raw = getAppSetting(SUBTITLE_WHISPER_AI_CONFIG_KEY);
  if (!raw) return normalizeConfig(null);

  try {
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    return normalizeConfig(null);
  }
}

export function getSubtitleWhisperAiConfig(): SubtitleWhisperAiConfig {
  return {
    ...parseStoredConfig(),
    updatedAt: getAppSettingUpdatedAt(SUBTITLE_WHISPER_AI_CONFIG_KEY),
  };
}

export function setSubtitleWhisperAiConfig(
  input: unknown,
): SubtitleWhisperAiConfig {
  const normalized = normalizeConfig(input);
  setAppSetting(
    SUBTITLE_WHISPER_AI_CONFIG_KEY,
    JSON.stringify({
      enabled: normalized.enabled,
      whisperModelId: normalized.whisperModelId,
      batch: normalized.batch,
      hallucination: normalized.hallucination,
    }),
  );
  return getSubtitleWhisperAiConfig();
}
