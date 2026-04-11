import { describe, expect, it } from 'vitest';

import {
  createYouTubeListeningMessage,
  isTrustedYouTubeOrigin,
  parseYouTubePlayerMessage,
  resolveYouTubeEmbedOrigin,
} from '@/lib/youtube-player';

describe('createYouTubeListeningMessage', () => {
  it('builds the widget listening handshake payload', () => {
    expect(JSON.parse(createYouTubeListeningMessage())).toEqual({
      event: 'listening',
      id: 1,
      channel: 'widget',
    });
  });
});

describe('resolveYouTubeEmbedOrigin', () => {
  it('returns the iframe origin when the embed URL is valid', () => {
    expect(
      resolveYouTubeEmbedOrigin(
        'https://www.youtube.com/embed/abc123?autoplay=1&enablejsapi=1',
      ),
    ).toBe('https://www.youtube.com');
  });

  it('falls back to the standard youtube origin for invalid input', () => {
    expect(resolveYouTubeEmbedOrigin('not-a-url')).toBe(
      'https://www.youtube.com',
    );
  });
});

describe('isTrustedYouTubeOrigin', () => {
  it('accepts known youtube embed origins', () => {
    expect(isTrustedYouTubeOrigin('https://www.youtube.com')).toBe(true);
    expect(isTrustedYouTubeOrigin('https://www.youtube-nocookie.com')).toBe(
      true,
    );
  });

  it('rejects non-youtube origins', () => {
    expect(isTrustedYouTubeOrigin('https://example.com')).toBe(false);
    expect(isTrustedYouTubeOrigin('http://www.youtube.com')).toBe(false);
  });
});

describe('parseYouTubePlayerMessage', () => {
  it('extracts current time and duration from infoDelivery payloads', () => {
    expect(
      parseYouTubePlayerMessage({
        event: 'infoDelivery',
        info: {
          currentTime: 42.25,
          duration: 120.5,
        },
      }),
    ).toEqual({
      currentTime: 42.25,
      duration: 120.5,
    });
  });

  it('extracts telemetry from getter responses', () => {
    expect(
      parseYouTubePlayerMessage({
        func: 'getCurrentTime',
        result: 18.75,
      }),
    ).toEqual({
      currentTime: 18.75,
    });

    expect(
      parseYouTubePlayerMessage({
        func: 'getDuration',
        result: 300,
      }),
    ).toEqual({
      duration: 300,
    });
  });

  it('treats onReady as a valid signal even without timing data', () => {
    expect(
      parseYouTubePlayerMessage({
        event: 'onReady',
      }),
    ).toEqual({
      playerReady: true,
    });
  });

  it('parses stringified payloads and ignores unrelated messages', () => {
    expect(
      parseYouTubePlayerMessage(
        JSON.stringify({
          event: 'initialDelivery',
          info: {
            currentTime: 3,
          },
        }),
      ),
    ).toEqual({
      currentTime: 3,
    });

    expect(parseYouTubePlayerMessage('not json')).toBeNull();
    expect(parseYouTubePlayerMessage({ event: 'noop' })).toBeNull();
  });
});
