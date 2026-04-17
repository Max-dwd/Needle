import { getAppSetting, setAppSetting } from './app-settings';
import {
  DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  PLAYER_KEYBOARD_ACTION_IDS,
  normalizeKeyboardKey,
  type PlayerKeyboardActionId,
  type PlayerKeyboardBinding,
} from './player-keyboard-arbiter';

const PLAYER_KEYBOARD_MODE_ENABLED_KEY = 'player_keyboard_mode_enabled';

export interface PlayerKeyboardModeSettings {
  enabled: boolean;
  bindings: PlayerKeyboardBinding[];
  rateTogglePreset: number;
  rateStep: number;
  seekSeconds: number;
  rateMin: number;
  rateMax: number;
}

export type PlayerKeyboardModeSettingsInput =
  Partial<PlayerKeyboardModeSettings>;

export const DEFAULT_PLAYER_KEYBOARD_MODE_SETTINGS: PlayerKeyboardModeSettings =
{
  enabled: true,
  bindings: DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  rateTogglePreset: 2,
  rateStep: 0.1,
  seekSeconds: 10,
  rateMin: 0.2,
  rateMax: 8,
};

function cloneSettings(
  settings: PlayerKeyboardModeSettings,
): PlayerKeyboardModeSettings {
  return {
    ...settings,
    bindings: settings.bindings.map((binding) => ({ ...binding })),
  };
}

function parseLegacyEnabled(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  return null;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBindings(value: unknown): PlayerKeyboardBinding[] {
  if (!Array.isArray(value)) {
    return DEFAULT_PLAYER_KEYBOARD_BINDINGS.map((binding) => ({ ...binding }));
  }

  const byAction = new Map<PlayerKeyboardActionId, PlayerKeyboardBinding>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const action = record.action;
    const key = record.key;
    if (
      typeof action !== 'string' ||
      !PLAYER_KEYBOARD_ACTION_IDS.includes(action as PlayerKeyboardActionId) ||
      typeof key !== 'string' ||
      !key.trim()
    ) {
      continue;
    }
    byAction.set(action as PlayerKeyboardActionId, {
      action: action as PlayerKeyboardActionId,
      key: key.trim(),
    });
  }

  return PLAYER_KEYBOARD_ACTION_IDS.map(
    (action) =>
      byAction.get(action) ??
      DEFAULT_PLAYER_KEYBOARD_BINDINGS.find(
        (binding) => binding.action === action,
      )!,
  ).map((binding) => ({ ...binding }));
}

function normalizeSettingsValue(value: unknown): PlayerKeyboardModeSettings {
  const defaults = DEFAULT_PLAYER_KEYBOARD_MODE_SETTINGS;
  if (!value || typeof value !== 'object') {
    return cloneSettings(defaults);
  }

  const record = value as Record<string, unknown>;
  const rateMin = asFiniteNumber(record.rateMin, defaults.rateMin);
  const rateMax = Math.max(
    rateMin,
    asFiniteNumber(record.rateMax, defaults.rateMax),
  );
  const rateTogglePreset = Math.min(
    rateMax,
    Math.max(
      rateMin,
      asFiniteNumber(record.rateTogglePreset, defaults.rateTogglePreset),
    ),
  );

  return {
    enabled:
      typeof record.enabled === 'boolean' ? record.enabled : defaults.enabled,
    bindings: normalizeBindings(record.bindings),
    rateTogglePreset,
    rateStep: Math.max(
      Number.EPSILON,
      asFiniteNumber(record.rateStep, defaults.rateStep),
    ),
    seekSeconds: Math.max(
      Number.EPSILON,
      asFiniteNumber(record.seekSeconds, defaults.seekSeconds),
    ),
    rateMin,
    rateMax,
  };
}

export function getPlayerKeyboardModeSettings(): PlayerKeyboardModeSettings {
  const stored = getAppSetting(PLAYER_KEYBOARD_MODE_ENABLED_KEY)?.trim();
  if (!stored) return cloneSettings(DEFAULT_PLAYER_KEYBOARD_MODE_SETTINGS);

  const legacyEnabled = parseLegacyEnabled(stored);
  if (legacyEnabled !== null) {
    return {
      ...cloneSettings(DEFAULT_PLAYER_KEYBOARD_MODE_SETTINGS),
      enabled: legacyEnabled,
    };
  }

  try {
    return normalizeSettingsValue(JSON.parse(stored));
  } catch {
    return cloneSettings(DEFAULT_PLAYER_KEYBOARD_MODE_SETTINGS);
  }
}

export function mergePlayerKeyboardModeSettings(
  current: PlayerKeyboardModeSettings,
  input: PlayerKeyboardModeSettingsInput,
): PlayerKeyboardModeSettings {
  const merged = {
    ...current,
    ...input,
    bindings: input.bindings ?? current.bindings,
  };

  return {
    ...merged,
    bindings: merged.bindings.map((binding) => ({ ...binding })),
  };
}

export function setPlayerKeyboardModeSettings(
  settings: PlayerKeyboardModeSettings,
) {
  setAppSetting(PLAYER_KEYBOARD_MODE_ENABLED_KEY, JSON.stringify(settings));
}

export function validatePlayerKeyboardModeSettings(
  settings: PlayerKeyboardModeSettings,
): string | null {
  if (!Array.isArray(settings.bindings)) {
    return 'Invalid bindings';
  }

  const seenActions = new Set<PlayerKeyboardActionId>();
  const seenKeys = new Set<string>();

  for (const binding of settings.bindings) {
    if (!binding || typeof binding !== 'object') {
      return 'Invalid binding entry';
    }
    if (
      typeof binding.action !== 'string' ||
      !PLAYER_KEYBOARD_ACTION_IDS.includes(
        binding.action as PlayerKeyboardActionId,
      )
    ) {
      return `Unknown action: ${String(binding.action)}`;
    }
    if (seenActions.has(binding.action as PlayerKeyboardActionId)) {
      return `Duplicate action: ${binding.action}`;
    }
    seenActions.add(binding.action as PlayerKeyboardActionId);

    if (typeof binding.key !== 'string') {
      return `Invalid key for action: ${binding.action}`;
    }
    const normalizedKey = normalizeKeyboardKey(binding.key);
    if (!normalizedKey) return `Missing key for action: ${binding.action}`;
    if (seenKeys.has(normalizedKey)) {
      return `Duplicate key: ${binding.key}`;
    }
    seenKeys.add(normalizedKey);
  }

  for (const action of PLAYER_KEYBOARD_ACTION_IDS) {
    if (!seenActions.has(action)) {
      return `Missing action: ${action}`;
    }
  }

  if (!Number.isFinite(settings.rateMin) || settings.rateMin <= 0) {
    return 'rateMin must be greater than 0';
  }
  if (
    !Number.isFinite(settings.rateMax) ||
    settings.rateMax < settings.rateMin
  ) {
    return 'rateMax must be greater than or equal to rateMin';
  }
  if (!Number.isFinite(settings.rateStep) || settings.rateStep <= 0) {
    return 'rateStep must be greater than 0';
  }
  if (!Number.isFinite(settings.seekSeconds) || settings.seekSeconds <= 0) {
    return 'seekSeconds must be greater than 0';
  }
  if (
    !Number.isFinite(settings.rateTogglePreset) ||
    settings.rateTogglePreset < settings.rateMin ||
    settings.rateTogglePreset > settings.rateMax
  ) {
    return 'rateTogglePreset must be within rateMin and rateMax';
  }

  return null;
}
