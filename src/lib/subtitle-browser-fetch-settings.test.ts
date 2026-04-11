import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAppSetting = vi.hoisted(() => vi.fn());
const mockGetAppSettingUpdatedAt = vi.hoisted(() => vi.fn());
const mockSetAppSetting = vi.hoisted(() => vi.fn());

vi.mock('./app-settings', () => ({
  getAppSetting: mockGetAppSetting,
  getAppSettingUpdatedAt: mockGetAppSettingUpdatedAt,
  setAppSetting: mockSetAppSetting,
}));

import {
  getSubtitleBrowserFetchConfig,
  setSubtitleBrowserFetchConfig,
} from './subtitle-browser-fetch-settings';

describe('subtitle browser fetch settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSetting.mockReturnValue(null);
    mockGetAppSettingUpdatedAt.mockReturnValue(null);
  });

  it('returns defaults when config is missing', () => {
    expect(getSubtitleBrowserFetchConfig()).toEqual({
      maxRetries: 2,
      updatedAt: null,
    });
  });

  it('preserves values greater than 5 when reading stored config', () => {
    mockGetAppSetting.mockReturnValue(JSON.stringify({ maxRetries: 8 }));

    expect(getSubtitleBrowserFetchConfig()).toEqual({
      maxRetries: 8,
      updatedAt: null,
    });
  });

  it('persists values greater than 5 without clamping', () => {
    setSubtitleBrowserFetchConfig({ maxRetries: 12 });

    expect(mockSetAppSetting).toHaveBeenCalledWith(
      'subtitle_browser_fetch_config',
      JSON.stringify({ maxRetries: 12 }),
    );
  });
});
