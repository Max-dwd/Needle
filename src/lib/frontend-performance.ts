import { getAppSetting, setAppSetting } from './app-settings';

export type PerformanceMode = 'full' | 'reduced';

export interface FrontendPerformanceSettings {
  desktop: PerformanceMode;
  mobile: PerformanceMode;
}

const DESKTOP_KEY = 'frontend_performance_desktop';
const MOBILE_KEY = 'frontend_performance_mobile';

export function getFrontendPerformanceSettings(): FrontendPerformanceSettings {
  const desktopRaw = getAppSetting(DESKTOP_KEY);
  const mobileRaw = getAppSetting(MOBILE_KEY);

  return {
    desktop: (desktopRaw as PerformanceMode) || 'full',
    mobile: (mobileRaw as PerformanceMode) || 'full',
  };
}

export function setFrontendPerformanceSettings(settings: Partial<FrontendPerformanceSettings>) {
  if (settings.desktop) {
    setAppSetting(DESKTOP_KEY, settings.desktop);
  }
  if (settings.mobile) {
    setAppSetting(MOBILE_KEY, settings.mobile);
  }
}
