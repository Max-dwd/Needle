import { describe, expect, it } from 'vitest';

import { buildChannelUrl, buildVideoUrl } from '@/lib/url-utils';

describe('buildVideoUrl', () => {
  it('builds a YouTube URL without a timestamp', () => {
    expect(buildVideoUrl('youtube', 'abc123')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('builds a YouTube URL with floored seconds in the t parameter', () => {
    expect(buildVideoUrl('youtube', 'abc123', 90.9)).toBe(
      'https://www.youtube.com/watch?v=abc123&t=90s',
    );
  });

  it('builds a Bilibili URL without a timestamp', () => {
    expect(buildVideoUrl('bilibili', 'BV1xx411c7mD')).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );
  });

  it('builds a Bilibili URL with floored seconds in the t parameter', () => {
    expect(buildVideoUrl('bilibili', 'BV1xx411c7mD', 42.8)).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD/?t=42',
    );
  });

  it('ignores zero and negative timestamps', () => {
    expect(buildVideoUrl('youtube', 'abc123', 0)).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
    expect(buildVideoUrl('bilibili', 'BV1xx411c7mD', -5)).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );
  });
});

describe('buildChannelUrl', () => {
  it('builds a YouTube channel URL', () => {
    expect(buildChannelUrl('youtube', 'UCYO_jab_esuFRV4b17AJtAw')).toBe(
      'https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw',
    );
  });

  it('builds a YouTube handle URL', () => {
    expect(buildChannelUrl('youtube', '@hubermanlab')).toBe(
      'https://www.youtube.com/@hubermanlab',
    );
  });

  it('builds a Bilibili space URL', () => {
    expect(buildChannelUrl('bilibili', '12345678')).toBe(
      'https://space.bilibili.com/12345678',
    );
  });
});
