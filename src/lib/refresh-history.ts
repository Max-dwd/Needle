import { getAppSetting, setAppSetting } from './app-settings';

const CHANNEL_REFRESH_PREFIX = 'refresh_channel_';
const INTENT_REFRESH_PREFIX = 'refresh_intent_';

function normalizeIntentName(intent: string | null | undefined): string | null {
  if (typeof intent !== 'string') return null;
  const normalized = intent.trim();
  return normalized ? normalized : null;
}

function buildChannelRefreshKey(channelId: number | string): string {
  return `${CHANNEL_REFRESH_PREFIX}${String(channelId)}`;
}

function buildIntentRefreshKey(intent: string): string {
  return `${INTENT_REFRESH_PREFIX}${encodeURIComponent(intent)}`;
}

export function recordChannelRefresh(channelId: number | string, at = new Date().toISOString()) {
  setAppSetting(buildChannelRefreshKey(channelId), at);
}

export function recordIntentRefresh(intent: string, at = new Date().toISOString()) {
  const normalized = normalizeIntentName(intent);
  if (!normalized) return;
  setAppSetting(buildIntentRefreshKey(normalized), at);
}

export function getChannelRefreshAt(channelId: number | string | null | undefined): string | null {
  if (channelId === null || channelId === undefined) return null;
  return getAppSetting(buildChannelRefreshKey(channelId));
}

export function getIntentRefreshAt(intent: string | null | undefined): string | null {
  const normalized = normalizeIntentName(intent);
  if (!normalized) return null;
  return getAppSetting(buildIntentRefreshKey(normalized));
}

export function getScopeLastRefreshAt(scope: {
  channelId?: number | string | null;
  intent?: string | null;
  fallback?: string | null;
}): string | null {
  if (scope.channelId !== null && scope.channelId !== undefined) {
    return getChannelRefreshAt(scope.channelId) ?? scope.fallback ?? null;
  }

  const intentRefreshAt = getIntentRefreshAt(scope.intent);
  if (intentRefreshAt) {
    return intentRefreshAt;
  }

  return scope.fallback ?? null;
}
