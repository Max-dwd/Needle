import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPage } from '../types.js';
import { runBilibiliFollowing, runBilibiliUserVideos } from './bilibili.js';

function createPageMock(overrides: Partial<IPage> = {}): IPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockRejectedValue(new Error('page.evaluate should not be called')),
    getCookies: vi.fn().mockResolvedValue([
      {
        name: 'SESSDATA',
        value: 'sess-token',
        domain: '.bilibili.com',
        path: '/',
      },
    ]),
    tabs: vi.fn().mockResolvedValue([]),
    closeTab: vi.fn().mockResolvedValue(undefined),
    newTab: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
}

describe('bilibili runtime commands', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches bilibili user-videos via Node fetch with browser cookies', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: {
              wbi_img: {
                img_url:
                  'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyzabcdef.png',
                sub_url:
                  'https://i0.hdslb.com/bfs/wbi/ghijklmnopqrstuvwxyzabcdefghijkl.png',
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: {
              list: {
                vlist: [
                  {
                    bvid: 'BV1test123',
                    title: 'Node Fetch Video',
                    pic: '//i0.hdslb.com/bfs/archive/test.jpg',
                    created: 1774708800,
                    length: '08:01',
                  },
                ],
              },
            },
          }),
      } as Response);
    global.fetch = fetchMock;

    const page = createPageMock();
    const result = await runBilibiliUserVideos(page, {
      positionals: ['12345'],
      flags: { limit: '20' },
    });

    expect(result).toEqual([
      {
        video_id: 'BV1test123',
        title: 'Node Fetch Video',
        url: 'https://www.bilibili.com/video/BV1test123',
        thumbnail_url: 'https://i0.hdslb.com/bfs/archive/test.jpg',
        published_at: '2026-03-28T14:40:00.000Z',
        duration: '08:01',
        is_members_only: undefined,
        access_status: undefined,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.bilibili.com/x/web-interface/nav',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/x/space/wbi/arc/search?');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('mid=12345');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('order=pubdate');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('pn=1');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('ps=20');
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(
      /mid=12345&order=pubdate&pn=1&ps=20&wts=\d+&w_rid=/,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'SESSDATA=sess-token',
          Referer: 'https://www.bilibili.com/',
        }),
      }),
    );
  });

  it('fetches bilibili following via Node fetch with browser cookies', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: {
              mid: 778899,
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: {
              list: [
                {
                  mid: 42,
                  uname: '测试 UP',
                  face: '//i0.hdslb.com/bfs/face.jpg',
                  sign: '简介',
                  attribute: 2,
                  official_verify: { desc: '认证' },
                },
              ],
            },
          }),
      } as Response);
    global.fetch = fetchMock;

    const page = createPageMock();
    const result = await runBilibiliFollowing(page, {
      positionals: [],
      flags: { page: '1', limit: '50' },
    });

    expect(result).toEqual([
      {
        mid: 42,
        name: '测试 UP',
        uname: '测试 UP',
        face: 'https://i0.hdslb.com/bfs/face.jpg',
        sign: '简介',
        following: '已关注',
        fans: '认证',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      '/x/relation/followings?vmid=778899&pn=1&ps=50&order=desc',
    );
  });

  it('throws the bilibili API error instead of returning an empty list', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: {
              wbi_img: {
                img_url:
                  'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyzabcdef.png',
                sub_url:
                  'https://i0.hdslb.com/bfs/wbi/ghijklmnopqrstuvwxyzabcdefghijkl.png',
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            code: -403,
            message: '访问权限不足',
          }),
      } as Response);
    global.fetch = fetchMock;

    const page = createPageMock();
    await expect(
      runBilibiliUserVideos(page, {
        positionals: ['12345'],
        flags: { limit: '20' },
      }),
    ).rejects.toThrow('获取 Bilibili 视频列表失败: 访问权限不足 (-403)');
  });
});
