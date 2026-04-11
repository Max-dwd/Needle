import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getMock, prepareMock, getDbMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  const prepareMock = vi.fn(() => ({ get: getMock }));
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { getMock, prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

import { GET } from './route';

describe('GET /api/videos/lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReturnValue({ get: getMock });
  });

  it('returns a single video payload by video_id', async () => {
    getMock.mockReturnValue({
      id: 1,
      channel_id: 2,
      platform: 'youtube',
      video_id: 'abc123',
      title: 'Preview Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 123,
      is_read: 0,
      is_members_only: 0,
      subtitle_status: null,
      subtitle_path: null,
      subtitle_language: null,
      subtitle_format: null,
      subtitle_error: null,
      subtitle_last_attempt_at: null,
      subtitle_cooldown_until: null,
      created_at: '2026-03-25T12:00:00.000Z',
      channel_name: 'Channel',
      avatar_url: 'https://example.com/avatar.png',
      channel_channel_id: 'UC123',
      intent: '工作',
      topics: '[]',
      summary_status: 'completed',
    });

    const response = await GET(
      new Request('http://localhost/api/videos/lookup?video_id=abc123') as NextRequest,
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as { video: Record<string, unknown> };
    expect(result.video.video_id).toBe('abc123');
    expect(result.video.title).toBe('Preview Video');
    expect(getDbMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 without video_id', async () => {
    const response = await GET(
      new Request('http://localhost/api/videos/lookup') as NextRequest,
    );

    expect(response.status).toBe(400);
  });

  it('returns research videos without a channel row', async () => {
    getMock.mockReturnValue({
      id: 2,
      channel_id: null,
      platform: 'youtube',
      video_id: 'research123',
      title: 'Research Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-03-25T12:00:00.000Z',
      duration: 456,
      is_read: 0,
      is_members_only: 0,
      subtitle_status: 'fetching',
      subtitle_path: null,
      subtitle_language: null,
      subtitle_format: null,
      subtitle_error: null,
      subtitle_last_attempt_at: null,
      subtitle_cooldown_until: null,
      created_at: '2026-03-25T12:00:00.000Z',
      channel_name: 'External Channel',
      avatar_url: null,
      channel_channel_id: null,
      intent: '未分类',
      topics: null,
      summary_status: null,
    });

    const response = await GET(
      new Request(
        'http://localhost/api/videos/lookup?video_id=research123&platform=youtube',
      ) as NextRequest,
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as { video: Record<string, unknown> };
    expect(result.video.channel_name).toBe('External Channel');
    expect(result.video.intent).toBe('未分类');
  });
});
