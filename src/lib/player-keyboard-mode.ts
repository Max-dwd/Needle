import { getAppSetting, setAppSetting } from './app-settings';

const PLAYER_KEYBOARD_MODE_ENABLED_KEY = 'player_keyboard_mode_enabled';

export interface PlayerKeyboardModeSettings {
  enabled: boolean;
}

export function getPlayerKeyboardModeSettings(): PlayerKeyboardModeSettings {
  const stored = getAppSetting(PLAYER_KEYBOARD_MODE_ENABLED_KEY)?.trim();
  return {
    enabled: stored === '0' || stored === 'false' ? false : true,
  };
}

export function setPlayerKeyboardModeSettings(enabled: boolean) {
  setAppSetting(PLAYER_KEYBOARD_MODE_ENABLED_KEY, enabled ? '1' : '0');
}
