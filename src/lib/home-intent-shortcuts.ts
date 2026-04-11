import { getAppSetting, setAppSetting } from './app-settings';

const HOME_INTENT_SHORTCUTS_ENABLED_KEY = 'home_intent_shortcuts_enabled';

export interface HomeIntentShortcutSettings {
  enabled: boolean;
}

export function getHomeIntentShortcutSettings(): HomeIntentShortcutSettings {
  const stored = getAppSetting(HOME_INTENT_SHORTCUTS_ENABLED_KEY)?.trim();
  return {
    enabled: stored === '0' || stored === 'false' ? false : true,
  };
}

export function setHomeIntentShortcutSettings(enabled: boolean) {
  setAppSetting(HOME_INTENT_SHORTCUTS_ENABLED_KEY, enabled ? '1' : '0');
}
