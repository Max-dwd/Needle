import { describe, expect, it } from 'vitest';

import {
  isNativeYouTubeStreamUrl,
  selectNativeYouTubeStreamUrl,
  YOUTUBE_PLAYBACK_FORMAT,
} from './youtube-playback';

describe('YOUTUBE_PLAYBACK_FORMAT', () => {
  it('requests the old native 720p-capable MP4/HLS format', () => {
    expect(YOUTUBE_PLAYBACK_FORMAT).toBe(
      'best[ext=mp4][height<=720]/best',
    );
  });
});

describe('isNativeYouTubeStreamUrl', () => {
  it('accepts googlevideo progressive MP4 URLs', () => {
    expect(
      isNativeYouTubeStreamUrl(
        'https://rr2---sn.example.googlevideo.com/videoplayback?mime=video%2Fmp4&expire=1778388654',
      ),
    ).toBe(true);
  });

  it('accepts YouTube HLS manifest URLs', () => {
    expect(
      isNativeYouTubeStreamUrl(
        'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1778388631/playlist/index.m3u8',
      ),
    ).toBe(true);
  });

  it('rejects non-MP4 media URLs', () => {
    expect(
      isNativeYouTubeStreamUrl(
        'https://rr2---sn.example.googlevideo.com/videoplayback?mime=video%2Fwebm&expire=1778388654',
      ),
    ).toBe(false);
  });
});

describe('selectNativeYouTubeStreamUrl', () => {
  it('keeps HLS output before lower progressive MP4 fallbacks', () => {
    const hlsUrl =
      'https://manifest.googlevideo.com/api/manifest/hls_playlist/playlist/index.m3u8';
    const mp4Url =
      'https://rr2---sn.example.googlevideo.com/videoplayback?mime=video%2Fmp4&expire=1778388654';

    expect(
      selectNativeYouTubeStreamUrl([hlsUrl, mp4Url]),
    ).toBe(hlsUrl);
  });
});
