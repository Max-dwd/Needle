import { describe, expect, it } from 'vitest';
import {
  __subtitleWhisperCorrectionTestUtils,
  buildCorrectionPrompt,
  isLikelyHallucination,
  mergeCorrections,
  splitIntoBatches,
} from './subtitle-whisper-correction';
import type { WhisperSegment } from './whisper-runtime';

function segment(
  id: number,
  start: number,
  end: number,
  text = `raw ${id}`,
): WhisperSegment {
  return { id, start, end, text };
}

describe('whisper-ai batch splitter', () => {
  it('cuts near the target at the largest silence gap', () => {
    const segments = [
      segment(1, 0, 20),
      segment(2, 22, 55),
      segment(3, 75, 90),
      segment(4, 92, 125),
      segment(5, 128, 150),
    ];

    expect(
      splitIntoBatches(segments, {
        targetSeconds: 60,
        maxSeconds: 300,
        maxSegments: 60,
        minSeconds: 10,
        silenceWindow: 30,
      }).map((batch) => batch.segments.map((item) => item.id)),
    ).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it('honors max segment hard limits before merging short tails', () => {
    const segments = [
      segment(1, 0, 10),
      segment(2, 11, 20),
      segment(3, 21, 30),
      segment(4, 31, 40),
      segment(5, 41, 45),
    ];

    expect(
      splitIntoBatches(segments, {
        targetSeconds: 120,
        maxSeconds: 300,
        maxSegments: 2,
        minSeconds: 10,
        silenceWindow: 30,
      }).map((batch) => batch.segments.map((item) => item.id)),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });
});

describe('whisper-ai correction merger', () => {
  it('sends Whisper draft text with each correction segment', () => {
    const { systemPrompt, prompt } = buildCorrectionPrompt(
      {
        index: 0,
        offsetSec: 10,
        endSec: 20,
        segments: [segment(1, 10.25, 12.5, '上海光基索的科因團隊')],
      },
      {
        platform: 'bilibili',
        video_id: 'BV_TEST',
        title: '测试视频',
        channel_name: '测试频道',
      },
    );

    expect(systemPrompt).toContain('whisper_text');
    expect(JSON.parse(prompt)).toEqual({
      segments: [
        {
          id: 1,
          rel_start: 0.25,
          rel_end: 2.5,
          whisper_text: '上海光基索的科因團隊',
        },
      ],
    });
  });

  it('uses LLM text while preserving Whisper timestamps', () => {
    expect(
      mergeCorrections(
        [segment(1, 0.2, 2.8), segment(2, 3, 4)],
        [
          { id: 1, text: '校对后的文本', drop: false },
          { id: 2, text: '', drop: true },
        ],
      ),
    ).toEqual([{ start: 0.2, end: 2.8, text: '校对后的文本' }]);
  });

  it('falls back to raw Whisper text for a missing correction id', () => {
    expect(
      mergeCorrections(
        [segment(1, 0, 1, '原始文本'), segment(2, 1, 2, '保底文本')],
        [{ id: 1, text: '新文本', drop: false }],
      ),
    ).toEqual([
      { start: 0, end: 1, text: '新文本' },
      { start: 1, end: 2, text: '保底文本' },
    ]);
  });

  it('accepts common model responses that name corrections as segments', () => {
    expect(
      __subtitleWhisperCorrectionTestUtils.parseCorrections(
        JSON.stringify({
          segments: [{ id: 1, text: '兼容返回字段', drop: false }],
        }),
      ),
    ).toEqual([{ id: 1, text: '兼容返回字段', drop: false }]);
  });
});

describe('whisper-ai hallucination filter', () => {
  const config = {
    noSpeechProbThreshold: 0.8,
    avgLogprobThreshold: -1,
  };

  it('drops likely silence hallucinations', () => {
    expect(
      isLikelyHallucination(
        { ...segment(1, 0, 1), noSpeechProb: 0.81 },
        config,
      ),
    ).toBe(true);
  });

  it('keeps confident speech segments', () => {
    expect(
      isLikelyHallucination(
        { ...segment(1, 0, 1), noSpeechProb: 0.2, avgLogprob: -0.3 },
        config,
      ),
    ).toBe(false);
  });
});
