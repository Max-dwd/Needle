import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';
import { getAiSummarySettings } from './ai-summary-settings';

export const SUBTITLE_API_FALLBACK_CONFIG_KEY = 'subtitle_api_fallback_config';

export type SubtitleApiFallbackScope = 'global' | 'custom';
export type SubtitleApiFallbackTargetType = 'intent' | 'channel';

export interface SubtitleApiFallbackRule {
  id: string;
  targetType: SubtitleApiFallbackTargetType;
  targetId: string;
  targetLabel: string;
  maxWaitSeconds: number;
  modelId: string;
}

export interface SubtitleApiFallbackConfig {
  enabled: boolean;
  scope: SubtitleApiFallbackScope;
  globalMaxWaitSeconds: number;
  globalModelId: string;
  customRules: SubtitleApiFallbackRule[];
  updatedAt: string | null;
}

interface StoredSubtitleApiFallbackRule {
  id?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  targetLabel?: unknown;
  maxWaitSeconds?: unknown;
  modelId?: unknown;
}

interface StoredSubtitleApiFallbackConfig {
  enabled?: unknown;
  scope?: unknown;
  globalMaxWaitSeconds?: unknown;
  globalModelId?: unknown;
  customRules?: unknown;
}

export interface SubtitleApiFallbackMatch {
  source: SubtitleApiFallbackScope;
  maxWaitSeconds: number;
  modelId: string | null;
  ruleId: string | null;
}

export interface SubtitleApiFallbackMatchCandidate {
  channelId: number;
  intentId?: number | null;
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback = 0): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0) return fallback;
  return normalized;
}

function normalizeRule(
  raw: StoredSubtitleApiFallbackRule,
  index: number,
  validModelIds: Set<string>,
): SubtitleApiFallbackRule | null {
  const targetType =
    raw.targetType === 'intent' || raw.targetType === 'channel'
      ? raw.targetType
      : null;
  const targetId = normalizeText(raw.targetId);
  const targetLabel = normalizeText(raw.targetLabel);
  const modelId = normalizeText(raw.modelId);
  if (!targetType || !targetId || !targetLabel || !modelId) return null;
  if (!validModelIds.has(modelId)) return null;
  return {
    id: normalizeText(raw.id, `rule-${index + 1}`),
    targetType,
    targetId,
    targetLabel,
    maxWaitSeconds: normalizeNonNegativeInt(raw.maxWaitSeconds, 0),
    modelId,
  };
}

function normalizeConfig(
  raw: unknown,
): Omit<SubtitleApiFallbackConfig, 'updatedAt'> {
  const settings = getAiSummarySettings();
  const multimodalModels = settings.models.filter(
    (model) => model.isMultimodal !== false,
  );
  const validModelIds = new Set(multimodalModels.map((model) => model.id));
  const preferredGlobalModelId =
    multimodalModels.find((model) => model.id === settings.defaultModelId)?.id ||
    multimodalModels[0]?.id ||
    '';
  const value =
    raw && typeof raw === 'object'
      ? (raw as StoredSubtitleApiFallbackConfig)
      : {};
  const customRulesRaw = Array.isArray(value.customRules)
    ? value.customRules
    : [];

  return {
    enabled: Boolean(value.enabled),
    scope: value.scope === 'custom' ? 'custom' : 'global',
    globalMaxWaitSeconds: normalizeNonNegativeInt(
      value.globalMaxWaitSeconds,
      0,
    ),
    globalModelId: validModelIds.has(normalizeText(value.globalModelId))
      ? normalizeText(value.globalModelId)
      : preferredGlobalModelId,
    customRules: customRulesRaw
      .map((rule, index) =>
        normalizeRule(
          (rule && typeof rule === 'object'
            ? rule
            : {}) as StoredSubtitleApiFallbackRule,
          index,
          validModelIds,
        ),
      )
      .filter((rule): rule is SubtitleApiFallbackRule => Boolean(rule)),
  };
}

function parseStoredConfig(): Omit<SubtitleApiFallbackConfig, 'updatedAt'> {
  const raw = getAppSetting(SUBTITLE_API_FALLBACK_CONFIG_KEY);
  if (!raw) {
    return normalizeConfig(null);
  }

  try {
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    return normalizeConfig(null);
  }
}

export function getSubtitleApiFallbackConfig(): SubtitleApiFallbackConfig {
  return {
    ...parseStoredConfig(),
    updatedAt: getAppSettingUpdatedAt(SUBTITLE_API_FALLBACK_CONFIG_KEY),
  };
}

export function setSubtitleApiFallbackConfig(
  input: unknown,
): SubtitleApiFallbackConfig {
  const normalized = normalizeConfig(input);
  setAppSetting(
    SUBTITLE_API_FALLBACK_CONFIG_KEY,
    JSON.stringify({
      enabled: normalized.enabled,
      scope: normalized.scope,
      globalMaxWaitSeconds: normalized.globalMaxWaitSeconds,
      globalModelId: normalized.globalModelId,
      customRules: normalized.customRules,
    }),
  );
  return getSubtitleApiFallbackConfig();
}

export function resolveSubtitleApiFallbackMatch(
  candidate: SubtitleApiFallbackMatchCandidate,
): SubtitleApiFallbackMatch | null {
  const config = getSubtitleApiFallbackConfig();
  if (!config.enabled) return null;

  if (config.scope === 'global') {
    return {
      source: 'global',
      maxWaitSeconds: config.globalMaxWaitSeconds,
      modelId: config.globalModelId || null,
      ruleId: null,
    };
  }

  const matchedRule =
    config.customRules.find(
      (rule) =>
        rule.targetType === 'channel' &&
        rule.targetId === String(candidate.channelId),
    ) ||
    config.customRules.find(
      (rule) =>
        rule.targetType === 'intent' &&
        rule.targetId === String(candidate.intentId || ''),
    );

  if (!matchedRule) return null;

  return {
    source: 'custom',
    maxWaitSeconds: matchedRule.maxWaitSeconds,
    modelId: matchedRule.modelId,
    ruleId: matchedRule.id,
  };
}
