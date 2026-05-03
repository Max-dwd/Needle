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
  buildTranscribeFailedChunk,
  interpolateUtterances,
  mapAlignedWordsToUtterances,
  parseUtterancesJson,
  transcribeChunk,
  type AlignedChunkResult,
} from './subtitle-llm-align-correction';
import { scoreLlmAlignerQuality } from '../../eval/llm-aligner-pipeline';
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

  it('parses common provider transcript shapes', () => {
    expect(
      parseUtterancesJson(
        JSON.stringify({
          transcript: '各位观众早上好，欢迎收看 AI 早报。',
        }),
      ),
    ).toEqual([{ speaker: 'S1', text: '各位观众早上好，欢迎收看 AI 早报。' }]);

    expect(
      parseUtterancesJson(
        JSON.stringify({
          captions: [
            { speaker_label: 'Speaker 1', content: '第一句' },
            { speaker_id: 'S2', transcript: '第二句' },
          ],
        }),
      ),
    ).toEqual([
      { speaker: 'S1', text: '第一句' },
      { speaker: 'S2', text: '第二句' },
    ]);

    expect(
      parseUtterancesJson(
        JSON.stringify({
          S1: '第一段',
          S2: ['第二段'],
        }),
      ),
    ).toEqual([
      { speaker: 'S1', text: '第一段' },
      { speaker: 'S2', text: '第二段' },
    ]);
  });

  it('parses non-json speaker-prefixed transcripts', () => {
    expect(parseUtterancesJson('S1: 你好\nS2: 大家好')).toEqual([
      { speaker: 'S1', text: '你好' },
      { speaker: 'S2', text: '大家好' },
    ]);
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

  it('matches normalized chars and only counts real matches', () => {
    const utterances = [
      { speaker: 'S1', text: 'ＡＩ，Hello!' },
      { speaker: 'S2', text: '下一句' },
    ];
    const { charMapping } = buildTranscriptText(utterances, false);

    const mapped = mapAlignedWordsToUtterances(
      [
        { text: 'ai', start: 0, end: 0.2, prob: 0.9 },
        { text: 'not-in-source', start: 0.3, end: 0.4, prob: 0.1 },
        { text: 'HELLO', start: 0.5, end: 1.1, prob: 0.8 },
        { text: '下一句', start: 2, end: 3, prob: 0.7 },
      ],
      utterances,
      charMapping,
    );

    expect(mapped.sourceChars).toBe('aihello下一句'.length);
    expect(mapped.matchedChars).toBe('aihello下一句'.length);
    expect(mapped.utteranceTimings[0]).toMatchObject({
      start: 0,
      end: 1.1,
      wordCount: 2,
    });
    expect(mapped.utteranceTimings[1]).toMatchObject({
      start: 2,
      end: 3,
      wordCount: 1,
    });
    expect(mapped.avgProb).toBeCloseTo((0.9 + 0.8 + 0.7) / 3);
  });

  it('does not send speaker labels into aligner transcript text', () => {
    const utterances = [
      { speaker: 'S1', text: '你好世界' },
      { speaker: 'S2', text: '继续测试' },
    ];
    const { text, charMapping } = buildTranscriptText(utterances, true);

    expect(text).toBe('你好世界\n继续测试');
    expect(text).not.toContain('S1:');
    expect(text).not.toContain('S2:');
    expect(charMapping).toHaveLength('你好世界继续测试'.length);
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

  const llmConfig = { expectSpeakerLabels: false, maxSegmentSeconds: 12 };

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
    expect(result.utterances[1].end).toBeGreaterThan(result.utterances[0].end);
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
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0.3, minWordRatio: 0.3 },
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

  it('interpolates utterances that miss individual aligner timings', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [
        { speaker: 'S1', text: 'abcd' },
        { speaker: 'S2', text: 'missing words' },
        { speaker: 'S3', text: 'efgh' },
      ],
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0.3, minWordRatio: 0.3 },
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => ({
        words: [
          { text: 'abcd', start: 1, end: 2, prob: 0.8 },
          { text: 'efgh', start: 6, end: 7, prob: 0.7 },
        ],
      }),
    });

    expect(result.alignFallback).toBe('none');
    expect(result.utterances).toHaveLength(3);
    expect(result.utterances[1]).toMatchObject({
      speaker: 'S2',
      text: 'missing words',
      avgProb: null,
    });
    expect(result.utterances[1].start).toBe(2);
    expect(result.utterances[1].end).toBe(6);
    expect(result.utterances.map((utterance) => utterance.text)).toEqual([
      'abcd',
      'missing words',
      'efgh',
    ]);
  });

  it('interpolates long utterances with collapsed aligner timings', async () => {
    const result = await alignChunk({
      chunk: baseChunk,
      utterances: [
        { speaker: 'S1', text: '前一句正常' },
        {
          speaker: 'S1',
          text: 'WorldStereo 2.0基于全局空间一致性记忆，实现稳定连贯的新视角合成。',
        },
        {
          speaker: 'S1',
          text: 'WorldMirror 2.0可将多视角预测结果整合为高精度资产。',
        },
      ],
      alignerConfig: { ...ALIGNER_CONFIG, minAvgProb: 0.3, minWordRatio: 0.3 },
      llmConfig,
      transcriptWritePath: '/tmp/transcript.txt',
      alignerOutputDir: '/tmp/out',
      writeTranscript: () => undefined,
      runAligner: async () => ({
        words: [
          { text: '前一句正常', start: 1, end: 2, prob: 0.8 },
          { text: 'WorldStereo', start: 5, end: 5, prob: 0.7 },
          { text: '基于全局空间一致性记忆', start: 5, end: 5, prob: 0.7 },
          { text: '实现稳定连贯的新视角合成', start: 5, end: 5, prob: 0.7 },
          { text: 'WorldMirror', start: 5, end: 5, prob: 0.7 },
          { text: '可将多视角预测结果整合为高精度资产', start: 5, end: 5, prob: 0.7 },
        ],
      }),
    });

    expect(result.alignFallback).toBe('none');
    expect(result.utterances).toHaveLength(3);
    expect(result.collapsedTimingUtteranceCount).toBe(2);
    expect(result.localInterpolatedUtteranceCount).toBe(2);
    expect(result.utterances[0]).toMatchObject({ start: 1, end: 2 });
    expect(result.utterances[1].end - result.utterances[1].start).toBeGreaterThan(
      3,
    );
    expect(result.utterances[2].end).toBe(10);
  });
});

describe('assembleSegments', () => {
  it('builds an interpolated placeholder for failed transcription chunks', () => {
    expect(
      buildTranscribeFailedChunk({
        chunkIndex: 2,
        chunkOffsetSec: 120,
        durationSec: 30,
      }),
    ).toEqual({
      offsetSec: 120,
      durationSec: 30,
      utterances: [
        {
          speaker: 'S1',
          text: '[转写失败]',
          start: 0,
          end: 30,
          avgProb: null,
        },
      ],
      alignFallback: 'interpolated',
      transcribeFailed: true,
      avgProb: null,
      wordCount: 0,
    });
  });

  it('caps failed transcription placeholder segment duration', () => {
    const result = buildTranscribeFailedChunk({
      chunkIndex: 2,
      chunkOffsetSec: 120,
      durationSec: 30,
      maxSegmentSeconds: 12,
    });

    expect(result.utterances).toHaveLength(3);
    expect(result.utterances[0]).toMatchObject({
      text: '[转写失败] 1/3',
      start: 0,
      end: 10,
    });
    expect(result.utterances[2]).toMatchObject({
      text: '[转写失败] 3/3',
      start: 20,
      end: 30,
    });
  });

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

  it('splits long output segments without changing chunk duration', () => {
    const chunks: AlignedChunkResult[] = [
      {
        offsetSec: 100,
        durationSec: 60,
        utterances: [
          {
            speaker: 'S1',
            text: '第一句很长，需要拆成更短的字幕段。第二句继续说明同一个说话人也不能合成长段。',
            start: 0,
            end: 30,
            avgProb: null,
          },
        ],
        alignFallback: 'none',
        transcribeFailed: false,
        avgProb: null,
        wordCount: 1,
      },
    ];

    const segments = assembleSegments(chunks, { maxSegmentSeconds: 12 });

    expect(segments.length).toBe(3);
    expect(segments[0].start).toBe(100);
    expect(segments.at(-1)?.end).toBe(130);
    expect(segments.every((segment) => segment.end - segment.start <= 12)).toBe(
      true,
    );
    expect(segments.every((segment) => segment.speaker === 'S1')).toBe(true);
    expect(segments.map((segment) => segment.text).join('')).toBe(
      chunks[0].utterances[0].text,
    );
    expect(chunks[0].durationSec).toBe(60);
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

describe('scoreLlmAlignerQuality', () => {
  it('uses LCS text coverage instead of greedy ordered coverage', () => {
    const quality = scoreLlmAlignerQuality({
      golden: {
        goldenPath: '/tmp/golden.json',
        segments: [{ start: 0, end: 7, text: 'ABCBDAB' }],
        text: 'ABCBDAB',
      },
      hypothesisSegments: [{ start: 0, end: 6, text: 'BDCABA' }],
      fallbackRatio: 0,
    });

    expect(quality.pairingMethod).toBe('lcs-anchor');
    expect(quality.text.coverage).toBe(0.5714);
  });

  it('maps timing by text position so different segment counts still compare', () => {
    const quality = scoreLlmAlignerQuality({
      golden: {
        goldenPath: '/tmp/golden.json',
        segments: [
          { start: 0, end: 1, text: 'aa' },
          { start: 1, end: 2, text: 'bb' },
          { start: 2, end: 3, text: 'cc' },
          { start: 3, end: 4, text: 'dd' },
        ],
        text: 'aabbccdd',
      },
      hypothesisSegments: [
        { start: 0, end: 2, text: 'aabb' },
        { start: 2, end: 4, text: 'ccdd' },
      ],
      fallbackRatio: 0,
    });

    expect(quality.timing).toMatchObject({
      pairCount: 2,
      startMaeSeconds: 0,
      startP95Seconds: 0,
      endMaeSeconds: 0,
      endP95Seconds: 0,
    });
    expect(quality.textPositionTiming).toMatchObject({
      pairCount: 2,
      startMaeSeconds: 0,
      endMaeSeconds: 0,
    });
  });

  it('uses LCS anchors so local text insertions do not shift later timing', () => {
    const quality = scoreLlmAlignerQuality({
      golden: {
        goldenPath: '/tmp/golden.json',
        segments: [
          { start: 0, end: 1, text: 'aa' },
          { start: 10, end: 11, text: 'bb' },
        ],
        text: 'aabb',
      },
      hypothesisSegments: [
        { start: 0, end: 1, text: 'aaXX' },
        { start: 10, end: 11, text: 'bb' },
      ],
      fallbackRatio: 0,
    });

    expect(quality.timing.endMaeSeconds).toBe(0);
    expect(quality.textPositionTiming.endMaeSeconds).toBeGreaterThan(1);
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
      llmConfig: { expectSpeakerLabels: true, maxSegmentSeconds: 12 },
      priority: 'manual-subtitle',
      chunkSeconds: 600,
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const call = transcribeAudio.mock.calls[0]?.[1] as {
      prompt?: string;
      systemPrompt?: string;
      responseSchema?: unknown;
      estimatedTokens?: number;
    };
    expect(call.systemPrompt).toContain('测试视频');
    expect(call.systemPrompt).toContain('S1/S2/S3');
    expect(call.systemPrompt).toContain('短句');
    expect(call.prompt).toContain('"utterances"');
    expect(call.prompt).toContain('12 秒');
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
        llmConfig: { expectSpeakerLabels: false, maxSegmentSeconds: 12 },
        priority: 'auto-subtitle',
        chunkSeconds: 600,
      }),
    ).rejects.toThrow();
  });
});
