import { describe, expect, it } from 'vitest';
import { __whisperRuntimeTestUtils } from './whisper-runtime';

describe('whisper runtime JSON parsing', () => {
  it('normalizes mlx-whisper segment timing and confidence fields', () => {
    expect(
      __whisperRuntimeTestUtils.parseWhisperJson(
        JSON.stringify({
          language: 'zh',
          segments: [
            {
              id: 7,
              start: 1.25,
              end: 3.5,
              text: ' hello ',
              no_speech_prob: 0,
              avg_logprob: -0.2,
            },
            { start: 'bad', end: 5, text: 'ignored' },
          ],
        }),
      ),
    ).toEqual({
      language: 'zh',
      segments: [
        {
          id: 7,
          start: 1.25,
          end: 3.5,
          text: 'hello',
          noSpeechProb: 0,
          avgLogprob: -0.2,
        },
      ],
    });
  });

  it('accepts mlx-whisper JSON containing bare NaN confidence values', () => {
    expect(
      __whisperRuntimeTestUtils.parseWhisperJson(
        [
          '{"language":"zh","segments":[',
          '{"id":1,"start":0,"end":1.5,"text":"保留 NaN 这个词","avg_logprob": NaN, "compression_ratio": Infinity},',
          '{"id":2,"start":2,"end":3,"text":"ok","no_speech_prob": -Infinity}',
          ']}',
        ].join(''),
      ),
    ).toEqual({
      language: 'zh',
      segments: [
        {
          id: 1,
          start: 0,
          end: 1.5,
          text: '保留 NaN 这个词',
          noSpeechProb: undefined,
          avgLogprob: undefined,
        },
        {
          id: 2,
          start: 2,
          end: 3,
          text: 'ok',
          noSpeechProb: undefined,
          avgLogprob: undefined,
        },
      ],
    });
  });
});
