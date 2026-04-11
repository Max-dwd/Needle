import {
  getAppSetting,
  getPositiveIntAppSetting,
  setAppSetting,
} from './app-settings';

const SUBTITLE_INTERVAL_SETTING_KEY = 'scheduler_subtitle_interval';
export const SUBTITLE_BACKOFF_STATE_KEY = 'subtitle_backoff_state';
const MAX_MULTIPLIER = 64;
const RATE_LIMIT_MULTIPLIER = 32;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
export type SubtitleBackoffPlatform = 'youtube' | 'bilibili';
const SUBTITLE_BACKOFF_PLATFORMS: SubtitleBackoffPlatform[] = [
  'youtube',
  'bilibili',
];

export interface SubtitleBackoffState {
  consecutiveErrors: number;
  multiplier: number;
  lastErrorAt: string | null;
  rateLimitedUntil: string | null;
}

export interface SubtitleBackoffStates {
  youtube: SubtitleBackoffState;
  bilibili: SubtitleBackoffState;
}

interface StoredSubtitleBackoffState {
  consecutiveErrors?: unknown;
  multiplier?: unknown;
  lastErrorAt?: unknown;
  rateLimitedUntil?: unknown;
}

interface StoredSubtitleBackoffStates extends StoredSubtitleBackoffState {
  youtube?: unknown;
  bilibili?: unknown;
}

const DEFAULT_SINGLE_STATE: SubtitleBackoffState = {
  consecutiveErrors: 0,
  multiplier: 1,
  lastErrorAt: null,
  rateLimitedUntil: null,
};

const DEFAULT_STATE: SubtitleBackoffStates = {
  youtube: { ...DEFAULT_SINGLE_STATE },
  bilibili: { ...DEFAULT_SINGLE_STATE },
};

function normalizeMultiplier(value: unknown): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 1) return 1;
  if (normalized <= 1) return 1;
  if (normalized <= 2) return 2;
  if (normalized <= 4) return 4;
  if (normalized <= 8) return 8;
  if (normalized <= 16) return 16;
  if (normalized <= 32) return 32;
  return MAX_MULTIPLIER;
}

function normalizeState(raw: unknown): SubtitleBackoffState {
  const value =
    raw && typeof raw === 'object' ? (raw as StoredSubtitleBackoffState) : {};
  return {
    consecutiveErrors: Math.max(
      0,
      Math.floor(Number(value.consecutiveErrors) || 0),
    ),
    multiplier: normalizeMultiplier(value.multiplier),
    lastErrorAt:
      typeof value.lastErrorAt === 'string' && value.lastErrorAt.trim()
        ? value.lastErrorAt
        : null,
    rateLimitedUntil:
      typeof value.rateLimitedUntil === 'string' &&
      value.rateLimitedUntil.trim()
        ? value.rateLimitedUntil
        : null,
  };
}

function createDefaultStates(): SubtitleBackoffStates {
  return {
    youtube: { ...DEFAULT_SINGLE_STATE },
    bilibili: { ...DEFAULT_SINGLE_STATE },
  };
}

function normalizeStates(raw: unknown): SubtitleBackoffStates {
  const value =
    raw && typeof raw === 'object' ? (raw as StoredSubtitleBackoffStates) : {};
  const hasPerPlatformState =
    Object.prototype.hasOwnProperty.call(value, 'youtube') ||
    Object.prototype.hasOwnProperty.call(value, 'bilibili');

  if (hasPerPlatformState) {
    return {
      youtube: normalizeState(value.youtube),
      bilibili: normalizeState(value.bilibili),
    };
  }

  const legacyState = normalizeState(value);
  return {
    youtube: { ...legacyState },
    bilibili: { ...legacyState },
  };
}

let cache: SubtitleBackoffStates | null = null;

function loadState(): SubtitleBackoffStates {
  if (cache) return cache;
  const raw = getAppSetting(SUBTITLE_BACKOFF_STATE_KEY);
  if (!raw) {
    cache = createDefaultStates();
    return cache;
  }
  try {
    cache = normalizeStates(JSON.parse(raw) as unknown);
  } catch {
    cache = createDefaultStates();
  }
  return cache;
}

function persistState(state: SubtitleBackoffStates): SubtitleBackoffStates {
  cache = state;
  setAppSetting(SUBTITLE_BACKOFF_STATE_KEY, JSON.stringify(state));
  return state;
}

function updatePlatformState(
  platform: SubtitleBackoffPlatform,
  next: SubtitleBackoffState,
): SubtitleBackoffStates {
  const current = loadState();
  return persistState({
    ...current,
    [platform]: next,
  });
}

export function getSubtitleBackoffState(
  platform: SubtitleBackoffPlatform,
): SubtitleBackoffState {
  return { ...loadState()[platform] };
}

export function getAllSubtitleBackoffStates(): SubtitleBackoffStates {
  const current = loadState();
  return {
    youtube: { ...current.youtube },
    bilibili: { ...current.bilibili },
  };
}

export function recordSubtitleSuccess(
  platform: SubtitleBackoffPlatform,
): SubtitleBackoffState {
  const current = loadState()[platform];
  const nextMultiplier =
    current.multiplier <= 1 ? 1 : Math.max(1, Math.floor(current.multiplier / 2));
  updatePlatformState(platform, {
    consecutiveErrors: 0,
    multiplier: normalizeMultiplier(nextMultiplier),
    lastErrorAt: null,
    rateLimitedUntil: null,
  });
  return getSubtitleBackoffState(platform);
}

export function recordSubtitleError(
  platform: SubtitleBackoffPlatform,
): SubtitleBackoffState {
  const current = loadState()[platform];
  const consecutiveErrors = current.consecutiveErrors + 1;
  updatePlatformState(platform, {
    consecutiveErrors,
    multiplier: Math.min(2 ** consecutiveErrors, MAX_MULTIPLIER),
    lastErrorAt: new Date().toISOString(),
    rateLimitedUntil: null,
  });
  return getSubtitleBackoffState(platform);
}

export function recordSubtitleRateLimit(
  platform: SubtitleBackoffPlatform,
): SubtitleBackoffState {
  const current = loadState()[platform];
  const now = Date.now();
  updatePlatformState(platform, {
    consecutiveErrors: current.consecutiveErrors + 1,
    multiplier: Math.max(
      RATE_LIMIT_MULTIPLIER,
      normalizeMultiplier(current.multiplier * 2),
    ),
    lastErrorAt: new Date(now).toISOString(),
    rateLimitedUntil: new Date(now + RATE_LIMIT_COOLDOWN_MS).toISOString(),
  });
  return getSubtitleBackoffState(platform);
}

export function resetBackoff(
  platform?: SubtitleBackoffPlatform,
): SubtitleBackoffState | SubtitleBackoffStates {
  if (!platform) {
    return persistState(createDefaultStates());
  }
  updatePlatformState(platform, { ...DEFAULT_SINGLE_STATE });
  return getSubtitleBackoffState(platform);
}

export function getEffectiveIntervalMs(
  platform: SubtitleBackoffPlatform,
  baseIntervalSeconds?: number,
): number {
  const baseSeconds =
    typeof baseIntervalSeconds === 'number'
      ? Math.max(0, Math.floor(baseIntervalSeconds))
      : getPositiveIntAppSetting(SUBTITLE_INTERVAL_SETTING_KEY, 20);
  return baseSeconds * loadState()[platform].multiplier * 1000;
}

export function getRateLimitCooldownRemainingMs(
  platform: SubtitleBackoffPlatform,
): number {
  const rateLimitedUntil = loadState()[platform].rateLimitedUntil;
  if (!rateLimitedUntil) return 0;

  const remainingMs = new Date(rateLimitedUntil).getTime() - Date.now();
  return Number.isFinite(remainingMs) && remainingMs > 0
    ? remainingMs
    : 0;
}

export const __subtitleBackoffTestUtils = {
  clearCache() {
    cache = null;
  },
};
