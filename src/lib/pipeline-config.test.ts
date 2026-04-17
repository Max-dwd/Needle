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
  CRAWL_PIPELINE_CONFIG_KEY,
  SUBTITLE_PIPELINE_CONFIG_KEY,
  getCrawlPipelineConfig,
  getSubtitlePipelineConfig,
} from './pipeline-config';

describe('pipeline config normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSettingUpdatedAt.mockReturnValue(null);
  });

  it('drops deprecated crawl sources from stored config', () => {
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key !== CRAWL_PIPELINE_CONFIG_KEY) return null;
      return JSON.stringify({
        platforms: [
          {
            platform: 'youtube',
            sources: [
              { id: 'rss', enabled: true },
              { id: 'piped', enabled: true },
            ],
          },
          {
            platform: 'bilibili',
            sources: [
              { id: 'yt-dlp', enabled: true },
              { id: 'opencli', enabled: true },
            ],
          },
        ],
      });
    });

    expect(getCrawlPipelineConfig()).toEqual({
      platforms: [
        {
          platform: 'youtube',
          label: 'YouTube',
          description: '通过 Needle Browser 在受控浏览器中抓取频道视频列表。',
          sources: [
            {
              id: 'browser',
              label: 'Needle Browser',
              description: '当前唯一抓取源，直接读取频道页注入数据。',
              enabled: true,
            },
          ],
        },
        {
          platform: 'bilibili',
          label: 'Bilibili',
          description: '通过 Needle Browser 在受控浏览器中抓取 UP 主视频列表。',
          sources: [
            {
              id: 'browser',
              label: 'Needle Browser',
              description: '当前唯一抓取源，直接读取浏览器上下文中的视频列表。',
              enabled: true,
            },
          ],
        },
      ],
      updatedAt: null,
    });
  });

  it('keeps supported subtitle sources and filters removed ones', () => {
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key !== SUBTITLE_PIPELINE_CONFIG_KEY) return null;
      return JSON.stringify({
        platforms: [
          {
            platform: 'youtube',
            sources: [
              { id: 'piped', enabled: true },
              { id: 'gemini', enabled: false },
              { id: 'opencli', enabled: true },
            ],
          },
          {
            platform: 'bilibili',
            sources: [
              { id: 'bilibili-api', enabled: true },
              { id: 'opencli', enabled: true },
            ],
          },
        ],
      });
    });

    expect(getSubtitlePipelineConfig()).toEqual({
      platforms: [
        {
          platform: 'youtube',
          label: 'YouTube',
          description:
            '字幕提取优先走 Needle Browser，失败时可回退到 AI 多模态 API。',
          sources: [
            {
              id: 'browser',
              label: 'Needle Browser',
              description: '当前默认主链路，优先提取现成字幕。',
              enabled: true,
            },
            {
              id: 'whisper-ai',
              label: 'Whisper + AI 校对',
              description:
                '本地 Whisper 提供时间戳，多模态 AI 听音频校对文本。',
              enabled: true,
            },
            {
              id: 'gemini',
              label: 'AI 多模态 API',
              description: 'AI 提取 fallback，适合无字幕或字幕失效场景。',
              enabled: false,
            },
          ],
        },
        {
          platform: 'bilibili',
          label: 'Bilibili',
          description:
            '字幕提取优先走 Needle Browser，失败时可回退到 AI 多模态 API。',
          sources: [
            {
              id: 'browser',
              label: 'Needle Browser',
              description: '当前默认主链路，优先拉取现成字幕。',
              enabled: true,
            },
            {
              id: 'whisper-ai',
              label: 'Whisper + AI 校对',
              description:
                '本地 Whisper 提供时间戳，多模态 AI 听音频校对文本。',
              enabled: true,
            },
            {
              id: 'gemini',
              label: 'AI 多模态 API',
              description: 'AI 字幕补全或提取兜底。',
              enabled: true,
            },
          ],
        },
      ],
      updatedAt: null,
    });
  });
});
