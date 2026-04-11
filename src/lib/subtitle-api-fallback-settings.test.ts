import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAppSetting = vi.hoisted(() => vi.fn());
const mockGetAppSettingUpdatedAt = vi.hoisted(() => vi.fn());
const mockSetAppSetting = vi.hoisted(() => vi.fn());
const mockGetAiSummarySettings = vi.hoisted(() => vi.fn());

vi.mock('./app-settings', () => ({
  getAppSetting: mockGetAppSetting,
  getAppSettingUpdatedAt: mockGetAppSettingUpdatedAt,
  setAppSetting: mockSetAppSetting,
}));

vi.mock('./ai-summary-settings', () => ({
  getAiSummarySettings: mockGetAiSummarySettings,
}));

import {
  getSubtitleApiFallbackConfig,
  resolveSubtitleApiFallbackMatch,
  setSubtitleApiFallbackConfig,
} from './subtitle-api-fallback-settings';

describe('subtitle api fallback settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSetting.mockReturnValue(null);
    mockGetAppSettingUpdatedAt.mockReturnValue(null);
    mockGetAiSummarySettings.mockReturnValue({
      models: [
        {
          id: 'default',
          name: '默认模型',
          endpoint: 'https://example.com',
          apiKey: '',
          model: 'm1',
        },
        {
          id: 'fast',
          name: '快速模型',
          endpoint: 'https://example.com',
          apiKey: '',
          model: 'm2',
        },
      ],
    });
  });

  it('returns disabled defaults when no config is stored', () => {
    expect(getSubtitleApiFallbackConfig()).toEqual({
      enabled: false,
      scope: 'global',
      globalMaxWaitSeconds: 0,
      customRules: [],
      updatedAt: null,
    });
  });

  it('filters invalid custom rules when saving', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        enabled: true,
        scope: 'custom',
        customRules: [
          {
            id: 'ok',
            targetType: 'intent',
            targetId: '12',
            targetLabel: '工作',
            modelId: 'fast',
          },
          {
            id: 'bad-model',
            targetType: 'channel',
            targetId: '5',
            targetLabel: '频道',
            modelId: 'missing',
          },
        ],
      }),
    );

    expect(getSubtitleApiFallbackConfig().customRules).toEqual([
      {
        id: 'ok',
        targetType: 'intent',
        targetId: '12',
        targetLabel: '工作',
        maxWaitSeconds: 0,
        modelId: 'fast',
      },
    ]);
  });

  it('matches explicit custom channel or intent rules only', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        enabled: true,
        scope: 'custom',
        customRules: [
          {
            id: 'channel-rule',
            targetType: 'channel',
            targetId: '7',
            targetLabel: '频道 A',
            modelId: 'fast',
          },
          {
            id: 'intent-rule',
            targetType: 'intent',
            targetId: '3',
            targetLabel: '探索',
            modelId: 'default',
          },
        ],
      }),
    );

    expect(
      resolveSubtitleApiFallbackMatch({ channelId: 7, intentId: 99 }),
    ).toMatchObject({
      source: 'custom',
      modelId: 'fast',
      ruleId: 'channel-rule',
    });

    expect(
      resolveSubtitleApiFallbackMatch({ channelId: 1, intentId: 3 }),
    ).toMatchObject({
      source: 'custom',
      modelId: 'default',
      ruleId: 'intent-rule',
    });

    expect(
      resolveSubtitleApiFallbackMatch({ channelId: 1, intentId: 2 }),
    ).toBeNull();
  });

  it('persists normalized config payload', () => {
    setSubtitleApiFallbackConfig({
      enabled: true,
      scope: 'global',
      globalMaxWaitSeconds: 10,
      customRules: [],
    });

    expect(mockSetAppSetting).toHaveBeenCalledTimes(1);
    expect(mockSetAppSetting.mock.calls[0]?.[1]).toContain('"enabled":true');
    expect(mockSetAppSetting.mock.calls[0]?.[1]).toContain('"scope":"global"');
  });
});
