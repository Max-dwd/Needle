import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

function mockJsonOnce(payload: unknown) {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void;
    callback(null, JSON.stringify(payload), '');
  });
}

describe('browser source commands', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('parses youtube channel recent videos from legacy field/value output', async () => {
    mockJsonOnce([
      { field: 'name', value: 'Test Channel' },
      { field: 'channelId', value: 'UC123' },
      { field: '---', value: '--- Recent Videos ---' },
      {
        field: 'Video A',
        value:
          '12:34 | 3 days ago | https://www.youtube.com/watch?v=abc123def45',
      },
      {
        field: 'Video B',
        value: '8:01 | 1 day ago | https://www.youtube.com/watch?v=zyx987wvu65',
      },
    ]);

    const { fetchBrowserYoutubeChannelVideos } = await import(
      './browser-youtube-source'
    );
    await expect(
      fetchBrowserYoutubeChannelVideos('UC123', 10),
    ).resolves.toEqual([
      {
        video_id: 'abc123def45',
        title: 'Video A',
        url: 'https://www.youtube.com/watch?v=abc123def45',
        duration: '12:34',
      },
      {
        video_id: 'zyx987wvu65',
        title: 'Video B',
        url: 'https://www.youtube.com/watch?v=zyx987wvu65',
        duration: '8:01',
      },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      'youtube',
      'channel-videos',
      'UC123',
      '--limit',
      '10',
      '-f',
      'json',
    ]);
  });

  it('uses the canonical youtube channel-videos invocation', async () => {
    mockJsonOnce([
      { field: 'name', value: 'Test Channel' },
      { field: 'channelId', value: 'UC123' },
      { field: '---', value: '--- Recent Videos ---' },
      {
        field: 'Video A',
        value:
          '12:34 | 3 days ago | https://www.youtube.com/watch?v=abc123def45',
      },
    ]);

    const { fetchBrowserYoutubeChannelVideos } = await import(
      './browser-youtube-source'
    );
    await expect(
      fetchBrowserYoutubeChannelVideos('UC123', 10),
    ).resolves.toEqual([
      {
        video_id: 'abc123def45',
        title: 'Video A',
        url: 'https://www.youtube.com/watch?v=abc123def45',
        duration: '12:34',
      },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      'youtube',
      'channel-videos',
      'UC123',
      '--limit',
      '10',
      '-f',
      'json',
    ]);
  });

  it('converts chinese relative published_at to ISO date from channel-videos', async () => {
    mockJsonOnce([
      {
        video_id: 'abc123def45',
        title: 'Video A',
        url: 'https://www.youtube.com/watch?v=abc123def45',
        published_at: '3天前',
        duration: '12:34',
      },
    ]);

    const { fetchBrowserYoutubeChannelVideos } = await import(
      './browser-youtube-source'
    );
    const results = await fetchBrowserYoutubeChannelVideos('UC123', 10);
    expect(results).toHaveLength(1);
    expect(results[0].published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('normalizes bilibili user-videos into the one-pass contract', async () => {
    mockJsonOnce([
      {
        video_id: 'BV1xx411c7mD',
        title: 'Video B',
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        thumbnail_url: '//i0.hdslb.com/bfs/archive/example.jpg',
        published_at: '2026-03-28T12:00:00.000Z',
        duration: '12:34',
        is_members_only: 1,
      },
    ]);

    const { fetchBrowserBilibiliUserVideos } = await import(
      './browser-bilibili-source'
    );
    await expect(fetchBrowserBilibiliUserVideos('12345', 10)).resolves.toEqual([
      {
        video_id: 'BV1xx411c7mD',
        title: 'Video B',
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        thumbnail_url: '//i0.hdslb.com/bfs/archive/example.jpg',
        published_at: '2026-03-28T12:00:00.000Z',
        duration: '12:34',
        is_members_only: 1,
      },
    ]);
  });

  it('preserves bilibili members-only detection when the list payload exposes badge text', async () => {
    mockJsonOnce([
      {
        bvid: 'BVcharge001',
        title: 'Charge Video',
        pic: 'https://i0.hdslb.com/bfs/archive/charge.jpg',
        created: 1774708800,
        length: '08:01',
        badge: {
          text: '充电专属',
        },
      },
    ]);

    const { fetchBrowserBilibiliUserVideos } = await import(
      './browser-bilibili-source'
    );
    await expect(fetchBrowserBilibiliUserVideos('12345', 10)).resolves.toEqual([
      {
        video_id: 'BVcharge001',
        title: 'Charge Video',
        url: undefined,
        thumbnail_url: 'https://i0.hdslb.com/bfs/archive/charge.jpg',
        published_at: '2026-03-28T14:40:00.000Z',
        duration: '08:01',
        is_members_only: 1,
        access_status: 'members_only',
      },
    ]);
  });

  it('parses youtube video metadata from legacy field/value output', async () => {
    mockJsonOnce([
      { field: 'title', value: 'Example Video' },
      { field: 'videoId', value: 'abc123def45' },
      { field: 'thumbnail', value: 'https://img.example/thumb.jpg' },
      { field: 'publishDate', value: '2026-03-28' },
      { field: 'duration', value: '125s' },
    ]);

    const { fetchBrowserYoutubeVideoMeta } = await import(
      './browser-youtube-source'
    );
    await expect(fetchBrowserYoutubeVideoMeta('abc123def45')).resolves.toEqual({
      video_id: 'abc123def45',
      title: 'Example Video',
      thumbnail_url: 'https://img.example/thumb.jpg',
      published_at: '2026-03-28T00:00:00.000Z',
      duration: '2:05',
      channel_name: '',
      access_status: undefined,
      is_members_only: undefined,
    });
  });

  it('passes a watch URL to youtube video-meta when given a bare video id', async () => {
    mockJsonOnce({
      video_id: 'abc123def45',
      title: 'Example Video',
      thumbnail_url: 'https://img.example/thumb.jpg',
      published_at: '2026-03-28T00:00:00.000Z',
      duration: '2:05',
      is_members_only: 0,
    });

    const { fetchBrowserYoutubeVideoMeta } = await import(
      './browser-youtube-source'
    );
    await fetchBrowserYoutubeVideoMeta('abc123def45');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      'youtube',
      'video-meta',
      'https://www.youtube.com/watch?v=abc123def45',
      '-f',
      'json',
    ]);
  });

  it('parses youtube channel info from structured output', async () => {
    mockJsonOnce({
      channel_id: 'UC123',
      name: 'Test Channel',
      avatar_url: 'https://img.example/youtube-avatar.jpg',
      recentVideos: [],
    });

    const { fetchBrowserYoutubeChannelInfo } = await import(
      './browser-youtube-source'
    );
    await expect(fetchBrowserYoutubeChannelInfo('UC123')).resolves.toEqual({
      channel_id: 'UC123',
      name: 'Test Channel',
      avatar_url: 'https://img.example/youtube-avatar.jpg',
    });
  });

  it('passes through youtube transcript rows from raw mode output', async () => {
    mockJsonOnce([
      {
        start: '0.0',
        end: '1.5',
        text: 'Hello world',
      },
      {
        start: '1.5',
        end: '3.0',
        text: 'Next line',
      },
    ]);

    const { fetchBrowserYoutubeTranscriptRows } = await import(
      './browser-youtube-source'
    );
    await expect(
      fetchBrowserYoutubeTranscriptRows(
        'https://www.youtube.com/watch?v=abc123def45',
      ),
    ).resolves.toEqual([
      {
        start: '0.0',
        end: '1.5',
        text: 'Hello world',
      },
      {
        start: '1.5',
        end: '3.0',
        text: 'Next line',
      },
    ]);
  });

  it('parses bilibili channel info from direct structured output', async () => {
    mockJsonOnce({
      channel_id: '12345',
      name: 'UP 主',
      avatar_url: 'https://img.example/avatar.jpg',
    });

    const { fetchBrowserBilibiliChannelInfo } = await import(
      './browser-bilibili-source'
    );
    await expect(fetchBrowserBilibiliChannelInfo('12345')).resolves.toEqual({
      channel_id: '12345',
      name: 'UP 主',
      avatar_url: 'https://img.example/avatar.jpg',
    });
  });

  it('parses bilibili video metadata from structured output', async () => {
    mockJsonOnce({
      video_id: 'BV1xx411c7mD',
      title: 'Bilibili Video',
      thumbnail_url: 'https://img.example/bilibili-thumb.jpg',
      published_at: '2026-03-28T12:00:00.000Z',
      duration: '12:34',
      access_status: 'members_only',
    });

    const { fetchBrowserBilibiliVideoMeta } = await import(
      './browser-bilibili-source'
    );
    await expect(
      fetchBrowserBilibiliVideoMeta('BV1xx411c7mD'),
    ).resolves.toEqual({
      video_id: 'BV1xx411c7mD',
      title: 'Bilibili Video',
      thumbnail_url: 'https://img.example/bilibili-thumb.jpg',
      published_at: '2026-03-28T12:00:00.000Z',
      duration: '12:34',
      channel_name: '',
      access_status: 'members_only',
      is_members_only: 1,
    });
  });

  it('passes through bilibili subtitle rows', async () => {
    mockJsonOnce([
      {
        from: '0.0',
        to: '2.0',
        content: '第一句',
      },
    ]);

    const { fetchBrowserBilibiliSubtitleRows } = await import(
      './browser-bilibili-source'
    );
    await expect(
      fetchBrowserBilibiliSubtitleRows('BV1xx411c7mD'),
    ).resolves.toEqual([
      {
        from: '0.0',
        to: '2.0',
        content: '第一句',
      },
    ]);
  });

  it('passes through bilibili following rows and builds canonical args', async () => {
    mockJsonOnce([
      {
        mid: 42,
        uname: '测试 UP',
        face: 'https://img.example/face.jpg',
        following: '已关注',
      },
    ]);

    const { fetchBrowserBilibiliFollowing } = await import(
      './browser-bilibili-source'
    );
    await expect(
      fetchBrowserBilibiliFollowing({
        uid: '12345',
        page: 2,
        limit: 20,
      }),
    ).resolves.toEqual([
      {
        mid: 42,
        uname: '测试 UP',
        face: 'https://img.example/face.jpg',
        following: '已关注',
      },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      'bilibili',
      'following',
      '12345',
      '--page',
      '2',
      '--limit',
      '20',
      '-f',
      'json',
    ]);
  });

  it('serializes metadata commands with default commands when metadata isolation is unsafe', async () => {
    const callbacks: Array<
      (error: Error | null, stdout?: string, stderr?: string) => void
    > = [];
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callbacks.push(callback);
    });

    const { fetchBrowserYoutubeChannelVideos, fetchBrowserYoutubeVideoMeta } =
      await import('./browser-youtube-source');

    const feedPromise = fetchBrowserYoutubeChannelVideos('UC123', 1);
    const metaPromise = fetchBrowserYoutubeVideoMeta('abc123def45');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockExecFile).toHaveBeenCalledTimes(1);

    callbacks[0](
      null,
      JSON.stringify([
        {
          title: 'Video A',
          url: 'https://www.youtube.com/watch?v=abc123def45',
        },
      ]),
      '',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockExecFile).toHaveBeenCalledTimes(2);

    callbacks[1](
      null,
      JSON.stringify({
        video_id: 'abc123def45',
        title: 'Example Video',
        thumbnail_url: 'https://img.example/thumb.jpg',
        published_at: '2026-03-28T00:00:00.000Z',
        duration: '2:05',
      }),
      '',
    );

    await expect(feedPromise).resolves.toEqual([
      {
        video_id: 'abc123def45',
        title: 'Video A',
        url: 'https://www.youtube.com/watch?v=abc123def45',
        thumbnail_url: undefined,
        published_at: undefined,
        duration: '',
        is_members_only: undefined,
      },
    ]);
    await expect(metaPromise).resolves.toEqual({
      video_id: 'abc123def45',
      title: 'Example Video',
      thumbnail_url: 'https://img.example/thumb.jpg',
      published_at: '2026-03-28T00:00:00.000Z',
      duration: '2:05',
      channel_name: '',
      access_status: undefined,
      is_members_only: undefined,
    });
  });

  it('includes the first-class bridge install hint when extension is missing', async () => {
    const { normalizeBrowserError } = await import('./browser-source-shared');
    const result = normalizeBrowserError(
      new Error('Browser Bridge extension not connected'),
    );

    expect(result).toContain('npm run browser:bridge:build');
    expect(result).toContain('chrome://extensions');
    expect(result).toContain('browser-bridge/extension');
  });

  it('includes the first-class runtime build hint when runtime assets are missing', async () => {
    const { normalizeBrowserError } = await import('./browser-source-shared');
    const result = normalizeBrowserError(
      new Error('first-class Needle browser runtime bundle not found'),
    );

    expect(result).toContain('browser-runtime/');
    expect(result).toContain('npm run browser:runtime:build');
  });
});
