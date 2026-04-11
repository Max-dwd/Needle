import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';

export const SUBTITLE_BROWSER_FETCH_CONFIG_KEY =
  'subtitle_browser_fetch_config';

export interface SubtitleBrowserFetchConfig {
  maxRetries: number;
  updatedAt: string | null;
}

interface StoredSubtitleBrowserFetchConfig {
  maxRetries?: unknown;
}

function normalizeMaxRetries(value: unknown): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0) return 2;
  return normalized;
}

function normalizeConfig(
  raw: unknown,
): Omit<SubtitleBrowserFetchConfig, 'updatedAt'> {
  const value =
    raw && typeof raw === 'object'
      ? (raw as StoredSubtitleBrowserFetchConfig)
      : {};

  return {
    maxRetries: normalizeMaxRetries(value.maxRetries),
  };
}

function parseStoredConfig(): Omit<SubtitleBrowserFetchConfig, 'updatedAt'> {
  const raw = getAppSetting(SUBTITLE_BROWSER_FETCH_CONFIG_KEY);
  if (!raw) return normalizeConfig(null);

  try {
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch {
    return normalizeConfig(null);
  }
}

export function getSubtitleBrowserFetchConfig(): SubtitleBrowserFetchConfig {
  return {
    ...parseStoredConfig(),
    updatedAt: getAppSettingUpdatedAt(SUBTITLE_BROWSER_FETCH_CONFIG_KEY),
  };
}

export function setSubtitleBrowserFetchConfig(
  input: unknown,
): SubtitleBrowserFetchConfig {
  const normalized = normalizeConfig(input);
  setAppSetting(
    SUBTITLE_BROWSER_FETCH_CONFIG_KEY,
    JSON.stringify({
      maxRetries: normalized.maxRetries,
    }),
  );
  return getSubtitleBrowserFetchConfig();
}
