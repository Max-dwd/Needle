import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  alignChunk,
  assembleSegments,
  buildTranscriptText,
  interpolateUtterances,
  mapAlignedWordsToUtterances,
  parseUtterancesJson,
  transcribeChunk,
  type AlignedChunkResult,
} from './subtitle-llm-align-correction';
import type { SubtitleLlmAlignerAlignerConfig } from './subtitle-llm-aligner-settings';
import type { MultimodalTranscriber } from './subtitle-providers';
import type { AiSummaryModelConfig } from '@/types';

const TEST_MODEL: AiSummaryModelConfig = {
  id: 'test-model',
  name: 'Test Model',
  endpoint: 'https://example.com',
  apiKey: 'sk-test',
  model: 'test/model',
  protocol: 'gemini',
};

const ALIGNER_CONFIG: SubtitleLlmAlignerAlignerConfig = {
  modelId: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
  minAvgProb: 0.3,
  minWordRatio: 0.3,
};

describe('parseUtterancesJson', () => {
  it('parses a valid utterances payload and trims text', () => {
    expect(
      parseUtterancesJson(
        JSON.stringify({
          utterances: [
            { speaker: 'S1', text: '  你好  ' },
            { speaker: 'S2', text: '大家好' },
          ],
        }),
      ),
    ).toEqual([
      { speaker: 'S1', text: '你好' },
      { speaker: 'S2', text: '大家好' },
    ]);
  });

  it('tolerates fenced JSON and array-shaped payloads', () => {
    expect(
      parseUtterancesJson('```json\n[{"speaker":"S1","text":"hi"}]\n```'),
    ).toEqual([{ speaker: 'S1', text: 'hi' }]);
  });

  it('drops empty-text utterances', () => {
    expect(
      parseUtterancesJson(
        JSON.stringify({
          utterances: [
            { speaker: 'S1', text: '' },
            { speaker: 'S1', text: 'ok' },
          ],
        }),
      ),
    ).toEqual([{ speaker: 'S1', text: 'ok' }]);
  });

  it('throws on invalid JSON shape', () => {
    expect(() => parseUtterancesJson('not json')).toThrow();
    expect(() => parseUtterancesJson('{"foo":1}')).toThrow();
  });
});

describe('buildTranscriptText / mapAlignedWordsToUtterances', () => {
  it('maps aligner words back to utterances by char order', () => {
    const utterances = [
      { speaker: 'S1', text: '你好世界' },
      { speaker: 'S2', text: 'hi there' },
    ];
    const { charMapping } = buildTranscriptText(utterances, false);
    expect(charMapping).toHaveLength('你好世界'.length + 'hithere'.length);

    const words = [
      { text: '你好', start: 0.1, end: 0.9, prob: 0.9 },
      { text: '世界', start: 1.0, end: 1.8, prob: 0.8 },
      { text: 'hi', start: 3.0, end: 3.4, prob: 0.7 },
      { text: 'there', start: 3.5, end: 4.1, prob: 0.6 },
    ];
    const mapped = mapAlignedWordsToUtterances(words, utterances, charMapping);
    expect(mapped.utteranceTimings[0]).toMatchObject({
      start: 0.1,
      end: 1.8,
    });
    expect(mapped.utteranceTimings[1]).toMatchObject({
      start: 3.0,
      end: 4.1,
    });
    expect(mapped.matchedChars).toBe(charMapping.length);
    expect(mapped.avgProb).toBeCloseTo((0.9 + 0.8 + 0.7 + 0.6) / 4);
  });

  it('interpolates utterances evenly when char counts tie', () => {
    expect(
      interpolateUtterances(
        [
          { speaker: 'S1', text: 'aaaa' },
          { speaker: 'S2', text: 'bbbb' },
        ],
        10,
      ),
    ).toEqual([
      { speaker: 'S1', text: 'aaaa', start: 0, end: 5, avgProb: null },
      { speaker: 'S2', text: 'bbbb', start: 5, end: 10, avgProb: null },
    ]);
  });
});

describe('alignChunk fallbacks', () => {
  const baseChunk = {
    chunkIndex: 0,
    chunkOffsetSec: 0,
    chunkEndSec: 10,
    audioPath: '/tmp/chunk-0.mp3',
    durationSec: 10,
  };

  const llmConfig = { expectSpeakerLabels: false };

  it('returns interpolated fallback when aligner throws', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [
        { speaker: 'S1', text: 'hello world' },
        { speaker: 'S2', text: 'goodbye' },
      ],
      alignerConfig: ALIGNER_CONFIG,
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => {
        throw new Error('boom');
      },
    });

    expect(result.alignFallback).toBe('interpolated');
    expect(result.utterances).toHaveLength(2);
    expect(result.utterances[0].start).toBe(0);
    expect(result.utterances[1].end).toBeGreaterThan(
      result.utterances[0].end,
    );
  });

  it('falls back to interpolation when avgProb is too low', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [{ speaker: 'S1', text: 'abcd' }],
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0.9 },
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => ({
        words: [{ text: 'abcd', start: 0.1, end: 0.5, prob: 0.1 }],
      }),
    });

    expect(result.alignFallback).toBe('interpolated');
    expect(result.avgProb).toBeCloseTo(0.1);
  });

  it('falls back to interpolation when matched char ratio is too low', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [{ speaker: 'S1', text: 'abcdefghij' }],
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0, minWordRatio: 0.8 },
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => ({
        words: [{ text: 'ab', start: 0, end: 0.5, prob: 1 }],
      }),
    });

    expect(result.alignFallback).toBe('interpolated');
  });

  it('returns aligned utterances when aligner output meets thresholds', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [
        { speaker: 'S1', text: 'abcd' },
        { speaker: 'S2', text: 'efgh' },
      ],
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0.3, minWordRatio: 0.5 },
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => ({
        words: [
          { text: 'abcd', start: 0.5, end: 1.5, prob: 0.8 },
          { text: 'efgh', start: 2.0, end: 3.5, prob: 0.7 },
        ],
      }),
    });

    expect(result.alignFallback).toBe('none');
    expect(result.utterances).toEqual([
      { speaker: 'S1', text: 'abcd', start: 0.5, end: 1.5, avgProb: 0.8 },
      { speaker: 'S2', text: 'efgh', start: 2.0, end: 3.5, avgProb: 0.7 },
    ]);
    expect(result.wordCount).toBe(2);
  });
});

describe('assembleSegments', () => {
  it('adds chunk offsets and preserves speakers', () => {
    const chunks: AlignedChunkResult[] = [
      {
        offsetSec: 0,
        durationSec: 10,
        utterances: [
          { speaker: 'S1', text: 'hi', start: 1, end: 2, avgProb: null },
        ],
        alignFallback: 'none',
        transcribeFailed: false,
        avgProb: null,
        wordCount: 1,
      },
      {
        offsetSec: 10,
        durationSec: 10,
        utterances: [
          {
            speaker: 'S2',
            text: 'there',
            start: 0,
            end: 3,
            avgProb: null,
          },
        ],
        alignFallback: 'none',
        transcribeFailed: false,
        avgProb: null,
        wordCount: 1,
      },
    ];

    expect(assembleSegments(chunks)).toEqual([
      { start: 1, end: 2, text: 'hi', speaker: 'S1' },
      { start: 10, end: 13, text: 'there', speaker: 'S2' },
    ]);
  });

  it('skips empty text and drops undefined speakers', () => {
    expect(
      assembleSegments([
        {
          offsetSec: 0,
          durationSec: 5,
          utterances: [
            { speaker: '', text: 'hi', start: 0, end: 1, avgProb: null },
            { speaker: 'S1', text: '   ', start: 1, end: 2, avgProb: null },
          ],
          alignFallback: 'none',
          transcribeFailed: false,
          avgProb: null,
          wordCount: 1,
        },
      ]),
    ).toEqual([{ start: 0, end: 1, text: 'hi' }]);
  });
});

describe('transcribeChunk', () => {
  it('forwards system prompt and response schema to the transcriber', async () => {
    const transcribeAudio = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        utterances: [{ speaker: 'S1', text: '内容' }],
      }),
      usage: { totalTokens: 1234 },
      ttftSeconds: 0.42,
    });
    const transcriber: MultimodalTranscriber = {
      protocol: 'gemini',
      maxAudioChunkSeconds: 900,
      transcribeAudio,
    };

    const result = await transcribeChunk({
      chunk: {
        chunkIndex: 0,
        chunkOffsetSec: 0,
        chunkEndSec: 600,
        audioPath: '/tmp/chunk-0.mp3',
      },
      video: {
        platform: 'youtube',
        video_id: 'abc',
        title: '测试视频',
        channel_name: '频道',
        description: '描述',
      },
      model: TEST_MODEL,
      transcriber,
      llmConfig: { expectSpeakerLabels: true },
      priority: 'manual-subtitle',
      chunkSeconds: 600,
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const call = transcribeAudio.mock.calls[0]?.[1] as {
      systemPrompt?: string;
      responseSchema?: unknown;
      estimatedTokens?: number;
    };
    expect(call.systemPrompt).toContain('测试视频');
    expect(call.systemPrompt).toContain('S1/S2/S3');
    expect(call.responseSchema).toMatchObject({
      type: 'object',
      required: ['utterances'],
    });
    expect(call.estimatedTokens).toBeGreaterThan(0);
    expect(result).toEqual({
      utterances: [{ speaker: 'S1', text: '内容' }],
      totalTokens: 1234,
      ttftSeconds: 0.42,
    });
  });

  it('propagates JSON parse failures', async () => {
    const transcriber: MultimodalTranscriber = {
      protocol: 'gemini',
      maxAudioChunkSeconds: 900,
      transcribeAudio: vi
        .fn()
        .mockResolvedValue({ text: 'not json', usage: {} }),
    };

    await expect(
      transcribeChunk({
        chunk: {
          chunkIndex: 0,
          chunkOffsetSec: 0,
          chunkEndSec: 600,
          audioPath: '/tmp/chunk.mp3',
        },
        video: { platform: 'youtube', video_id: 'abc' },
        model: TEST_MODEL,
        transcriber,
        llmConfig: { expectSpeakerLabels: false },
        priority: 'auto-subtitle',
        chunkSeconds: 600,
      }),
    ).rejects.toThrow();
  });
});
