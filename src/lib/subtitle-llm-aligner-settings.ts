import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';

export const SUBTITLE_LLM_ALIGNER_CONFIG_KEY = 'subtitle_llm_aligner_config';

export const DEFAULT_FORCED_ALIGNER_MODEL_ID =
  process.env.FORCED_ALIGNER_MODEL_ID ||
  'mlx-community/Qwen3-ForcedAligner-0.6B-8bit';

export const DEFAULT_LLM_ALIGNER_CHUNK_SECONDS = 900; // 15 分钟

export interface SubtitleLlmAlignerAlignerConfig {
  modelId: string;
  minAvgProb: number;
  minWordRatio: number;
}

export interface SubtitleLlmAlignerLlmConfig {
  expectSpeakerLabels: boolean;
}

export interface SubtitleLlmAlignerConfig {
  enabled: boolean;
  chunkSeconds: number;
  aligner: SubtitleLlmAlignerAlignerConfig;
  llm: SubtitleLlmAlignerLlmConfig;
  updatedAt: string | null;
}

interface StoredSubtitleLlmAlignerConfig {
  enabled?: unknown;
  chunkSeconds?: unknown;
  aligner?: unknown;
  llm?: unknown;
}

const DEFAULT_ALIGNER_CONFIG: SubtitleLlmAlignerAlignerConfig = {
  modelId: DEFAULT_FORCED_ALIGNER_MODEL_ID,
  minAvgProb: 0.3,
  minWordRatio: 0.3,
};

const DEFAULT_LLM_CONFIG: SubtitleLlmAlignerLlmConfig = {
  expectSpeakerLabels: true,
};

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeRatio(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeAlignerConfig(
  raw: unknown,
): SubtitleLlmAlignerAlignerConfig {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Partial<SubtitleLlmAlignerAlignerConfig>)
      : {};
  return {
    modelId: normalizeText(value.modelId, DEFAULT_ALIGNER_CONFIG.modelId),
    minAvgProb: normalizeRatio(
      value.minAvgProb,
      DEFAULT_ALIGNER_CONFIG.minAvgProb,
    ),
    minWordRatio: normalizeRatio(
      value.minWordRatio,
      DEFAULT_ALIGNER_CONFIG.minWordRatio,
    ),
  };
}

function normalizeLlmConfig(raw: unknown): SubtitleLlmAlignerLlmConfig {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Partial<SubtitleLlmAlignerLlmConfig>)
      : {};
  return {
    expectSpeakerLabels:
      value.expectSpeakerLabels === undefined
        ? DEFAULT_LLM_CONFIG.expectSpeakerLabels
        : Boolean(value.expectSpeakerLabels),
  };
}

function normalizeConfig(
  raw: unknown,
): Omit<SubtitleLlmAlignerConfig, 'updatedAt'> {
  const value =
    raw && typeof raw === 'object'
      ? (raw as StoredSubtitleLlmAlignerConfig)
      : {};

  return {
    // Default disabled for gradual rollout
    enabled: value.enabled === undefined ? false : Boolean(value.enabled),
    chunkSeconds: normalizeInteger(
      value.chunkSeconds,
      DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
      5 * 60,
      60 * 60,
    ),
    aligner: normalizeAlignerConfig(value.aligner),
    llm: normalizeLlmConfig(value.llm),
  };
}

function parseStoredConfig(): Omit<SubtitleLlmAlignerConfig, 'updatedAt'> {
  const raw = getAppSetting(SUBTITLE_LLM_ALIGNER_CONFIG_KEY);
  if (!raw) return normalizeConfig(null);
  try {
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    return normalizeConfig(null);
  }
}

export function getSubtitleLlmAlignerConfig(): SubtitleLlmAlignerConfig {
  return {
    ...parseStoredConfig(),
    updatedAt: getAppSettingUpdatedAt(SUBTITLE_LLM_ALIGNER_CONFIG_KEY),
  };
}

export function setSubtitleLlmAlignerConfig(
  input: unknown,
): SubtitleLlmAlignerConfig {
  const normalized = normalizeConfig(input);
  setAppSetting(
    SUBTITLE_LLM_ALIGNER_CONFIG_KEY,
    JSON.stringify({
      enabled: normalized.enabled,
      chunkSeconds: normalized.chunkSeconds,
      aligner: normalized.aligner,
      llm: normalized.llm,
    }),
  );
  return getSubtitleLlmAlignerConfig();
}
