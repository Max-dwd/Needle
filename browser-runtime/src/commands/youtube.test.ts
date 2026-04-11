import { describe, expect, it } from 'vitest';
import { __youtubeCommandTestUtils } from './youtube.js';

describe('youtube runtime duration extraction', () => {
  it('reads duration from videoRenderer.lengthText.simpleText', () => {
    const result = __youtubeCommandTestUtils.extractVideoRendererSummary({
      videoId: 'abc123',
      title: {
        simpleText: 'Test Video',
      },
      thumbnail: {
        thumbnails: [{ url: 'https://img.example/thumb.jpg' }],
      },
      lengthText: {
        simpleText: '12:34',
        accessibility: {
          accessibilityData: {
            label: '12 minutes, 34 seconds',
          },
        },
      },
      publishedTimeText: {
        simpleText: '1 day ago',
      },
    });

    expect(result).toEqual({
      video_id: 'abc123',
      title: 'Test Video',
      url: 'https://www.youtube.com/watch?v=abc123',
      thumbnail_url: 'https://img.example/thumb.jpg',
      published_at: '1 day ago',
      duration: '12:34',
      is_members_only: 0,
    });
  });

  it('falls back to overlay duration when simpleText is absent', () => {
    const result = __youtubeCommandTestUtils.extractVideoRendererSummary({
      videoId: 'overlay123',
      title: {
        simpleText: 'Overlay Video',
      },
      thumbnail: {
        thumbnails: [{ url: 'https://img.example/overlay.jpg' }],
      },
      thumbnailOverlays: [
        {
          thumbnailOverlayTimeStatusRenderer: {
            text: {
              simpleText: '8:01',
            },
          },
        },
      ],
    });

    expect(result?.duration).toBe('8:01');
  });

  it('parses legacy text caption XML', () => {
    const result = __youtubeCommandTestUtils.parseYoutubeCaptionXml(
      '<transcript><text start="1.25" dur="2.5">Hello &amp; world</text><text start="4.00" dur="1.0">Next line</text></transcript>',
    );

    expect(result).toEqual([
      { start: 1.25, end: 3.75, text: 'Hello & world' },
      { start: 4, end: 5, text: 'Next line' },
    ]);
  });

  it('parses format3 caption XML', () => {
    const result = __youtubeCommandTestUtils.parseYoutubeCaptionXml(
      '<timedtext><body><p t="1500" d="2000">Line 1</p><p t="4200" d="800">Line 2</p></body></timedtext>',
    );

    expect(result).toEqual([
      { start: 1.5, end: 3.5, text: 'Line 1' },
      { start: 4.2, end: 5, text: 'Line 2' },
    ]);
  });
});
