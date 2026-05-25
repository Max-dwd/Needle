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
  DEFAULT_FORCED_ALIGNER_MODEL_ID,
  DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
  getSubtitleLlmAlignerConfig,
  setSubtitleLlmAlignerConfig,
  SUBTITLE_LLM_ALIGNER_CONFIG_KEY,
} from './subtitle-llm-aligner-settings';

describe('subtitle-llm-aligner-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAppSettingUpdatedAt.mockReturnValue(null);
  });

  it('returns defaults when no config is stored', () => {
    mockGetAppSetting.mockReturnValue(null);
    expect(getSubtitleLlmAlignerConfig()).toEqual({
      enabled: false,
      chunkSeconds: DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
      aligner: {
        modelId: DEFAULT_FORCED_ALIGNER_MODEL_ID,
        minAvgProb: 0.3,
        minWordRatio: 0.3,
      },
      llm: {
        expectSpeakerLabels: true,
        maxSegmentSeconds: 3,
        verbatimCoveragePrompt: false,
      },
      quality: {
        minMatchedCharRatio: 0.9,
        maxInterpolatedChunkRatio: 0,
        maxLocalInterpolatedUtteranceRatio: 0.25,
      },
      updatedAt: null,
    });
  });

  it('clamps chunkSeconds and ratio fields to valid ranges', () => {
    mockGetAppSetting.mockReturnValue(
      JSON.stringify({
        enabled: true,
        chunkSeconds: 10,
        aligner: { modelId: '  custom/id  ', minAvgProb: 2, minWordRatio: -1 },
        llm: { expectSpeakerLabels: false, maxSegmentSeconds: 120 },
        quality: {
          minMatchedCharRatio: -1,
          maxInterpolatedChunkRatio: 2,
          maxLocalInterpolatedUtteranceRatio: 'bad',
        },
      }),
    );

    expect(getSubtitleLlmAlignerConfig()).toEqual({
      enabled: true,
      chunkSeconds: 60,
      aligner: {
        modelId: 'custom/id',
        minAvgProb: 1,
        minWordRatio: 0,
      },
      llm: {
        expectSpeakerLabels: false,
        maxSegmentSeconds: 60,
        verbatimCoveragePrompt: false,
      },
      quality: {
        minMatchedCharRatio: 0,
        maxInterpolatedChunkRatio: 1,
        maxLocalInterpolatedUtteranceRatio: 0.25,
      },
      updatedAt: null,
    });
  });

  it('round-trips through set → stored JSON → get', () => {
    setSubtitleLlmAlignerConfig({
      enabled: true,
      chunkSeconds: 600,
      aligner: {
        modelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
        minAvgProb: 0.4,
        minWordRatio: 0.5,
      },
      llm: {
        expectSpeakerLabels: true,
        maxSegmentSeconds: 8,
        verbatimCoveragePrompt: false,
      },
      quality: {
        minMatchedCharRatio: 0.95,
        maxInterpolatedChunkRatio: 0,
        maxLocalInterpolatedUtteranceRatio: 0.2,
      },
    });

    expect(mockSetAppSetting).toHaveBeenCalledTimes(1);
    const [key, serialized] = mockSetAppSetting.mock.calls[0] as [
      string,
      string,
    ];
    expect(key).toBe(SUBTITLE_LLM_ALIGNER_CONFIG_KEY);
    expect(JSON.parse(serialized)).toEqual({
      enabled: true,
      chunkSeconds: 600,
      aligner: {
        modelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
        minAvgProb: 0.4,
        minWordRatio: 0.5,
      },
      llm: {
        expectSpeakerLabels: true,
        maxSegmentSeconds: 8,
        verbatimCoveragePrompt: false,
      },
      quality: {
        minMatchedCharRatio: 0.95,
        maxInterpolatedChunkRatio: 0,
        maxLocalInterpolatedUtteranceRatio: 0.2,
      },
    });

    mockGetAppSetting.mockReturnValue(serialized);
    expect(getSubtitleLlmAlignerConfig()).toEqual({
      enabled: true,
      chunkSeconds: 600,
      aligner: {
        modelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
        minAvgProb: 0.4,
        minWordRatio: 0.5,
      },
      llm: {
        expectSpeakerLabels: true,
        maxSegmentSeconds: 8,
        verbatimCoveragePrompt: false,
      },
      quality: {
        minMatchedCharRatio: 0.95,
        maxInterpolatedChunkRatio: 0,
        maxLocalInterpolatedUtteranceRatio: 0.2,
      },
      updatedAt: null,
    });
  });
});
