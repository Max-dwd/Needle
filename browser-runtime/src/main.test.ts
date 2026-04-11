import { describe, expect, it } from 'vitest';
import { parseCliRequest } from './commands/index.js';

describe('needle browser cli parser', () => {
  it('parses canonical positional commands with json output', () => {
    expect(
      parseCliRequest([
        'youtube',
        'channel-videos',
        'UC123',
        '--limit',
        '10',
        '-f',
        'json',
      ]),
    ).toEqual({
      format: 'json',
      commandInput: {
        site: 'youtube',
        command: 'channel-videos',
        positionals: ['UC123'],
        flags: {
          limit: '10',
        },
      },
    });
  });

  it('parses named argument compatibility variants', () => {
    expect(
      parseCliRequest([
        'bilibili',
        'subtitle',
        '--bvid',
        'BV1xx411c7mD',
        '-f',
        'json',
      ]),
    ).toEqual({
      format: 'json',
      commandInput: {
        site: 'bilibili',
        command: 'subtitle',
        positionals: [],
        flags: {
          bvid: 'BV1xx411c7mD',
        },
      },
    });
  });
});
