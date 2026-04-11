import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel } from '@/lib/db';
import type { NextRequest } from 'next/server';

const { allMock, prepareMock, getDbMock } = vi.hoisted(() => {
  const allMock = vi.fn();
  const prepareMock = vi.fn(() => ({ all: allMock }));
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));

  return { allMock, prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/fetcher', () => ({
  resolveChannelFromUrl: vi.fn(),
}));

import { GET } from './route';

describe('GET /api/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReturnValue({ all: allMock });
  });

  it('returns the channels list with video counts', async () => {
    // DB returns topics as a JSON string; the route parses it to an array
    const dbRow = {
      id: 1,
      platform: 'youtube' as Channel['platform'],
      channel_id: 'UC123',
      name: 'Factory News',
      avatar_url: 'https://example.com/avatar.png',
      intent: '未分类',
      topics: '["Tech","AI"]', // raw DB string
      category: 'Tech',
      category2: 'AI',
      crawl_error_count: 0,
      crawl_backoff_until: null,
      created_at: '2026-03-23T12:00:00.000Z',
      video_count: 3,
    };
    allMock.mockReturnValue([dbRow]);

    const response = await GET(new Request('http://localhost') as NextRequest);

    expect(response.status).toBe(200);
    const result = await response.json() as Array<Channel & { video_count: number }>;
    expect(result).toHaveLength(1);
    expect(result[0].topics).toEqual(['Tech', 'AI']); // parsed to array
    expect(result[0].intent).toBe('未分类');
    expect(getDbMock).toHaveBeenCalledTimes(1);
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT c.*'),
    );
  });

  it('returns an empty array when no channels are stored', async () => {
    allMock.mockReturnValue([]);

    const response = await GET(new Request('http://localhost') as NextRequest);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('filters channels by channel_id and platform', async () => {
    allMock.mockReturnValue([]);

    await GET(
      new Request('http://localhost/api/channels?channel_id=UC123&platform=youtube') as NextRequest,
    );

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('c.channel_id = ?'));
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('c.platform = ?'));
  });
});
