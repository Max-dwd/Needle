import { describe, expect, it } from 'vitest';
import { __forcedAlignerRuntimeTestUtils } from './forced-aligner-runtime';

const { parseAlignerJson } = __forcedAlignerRuntimeTestUtils;

describe('forced-aligner runtime JSON parsing', () => {
  it('extracts normalized AlignedWord entries from a words array', () => {
    expect(
      parseAlignerJson(
        JSON.stringify({
          words: [
            { text: '你好', start: 0.1, end: 0.8, prob: 0.97 },
            { text: '', start: 1, end: 2 },
            { text: 'world', start: 2, end: 1.5 },
            { text: 'hi', start: 5.1, end: 5.6 },
          ],
          warnings: ['low confidence'],
        }),
      ),
    ).toEqual({
      words: [
        { text: '你好', start: 0.1, end: 0.8, prob: 0.97 },
        { text: 'hi', start: 5.1, end: 5.6, prob: undefined },
      ],
      warnings: ['low confidence'],
    });
  });

  it('accepts alternate key names (tokens + probability)', () => {
    expect(
      parseAlignerJson(
        JSON.stringify({
          tokens: [
            { text: 'foo', start: 0, end: 0.5, probability: 0.8 },
            { text: 'bar', start: 0.5, end: 1.2, confidence: 0.6 },
          ],
        }),
      ),
    ).toEqual({
      words: [
        { text: 'foo', start: 0, end: 0.5, prob: 0.8 },
        { text: 'bar', start: 0.5, end: 1.2, prob: 0.6 },
      ],
      warnings: undefined,
    });
  });
});
