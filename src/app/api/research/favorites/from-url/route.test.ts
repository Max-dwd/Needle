import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { prepareMock, getDbMock };
});

const { enqueueSubtitleJobForVideoDbId } = vi.hoisted(() => ({
  enqueueSubtitleJobForVideoDbId: vi.fn(),
}));

const { fetchYouTubeVideoDetail, fetchBilibiliVideoDetail } = vi.hoisted(() => ({
  fetchYouTubeVideoDetail: vi.fn(),
  fetchBilibiliVideoDetail: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/auto-pipeline', () => ({
  enqueueSubtitleJobForVideoDbId,
}));

vi.mock('@/lib/browser-source-shared', () => ({
  parseYoutubeVideoIdFromUrl: vi.fn(() => 'abc123'),
  parseBilibiliVideoIdFromUrl: vi.fn(() => 'BV1abc123'),
}));

vi.mock('@/lib/fetcher', () => ({
  fetchYouTubeVideoDetail,
  fetchBilibiliVideoDetail,
}));

import { POST } from './route';

function makeRequest(body: unknown): NextRequest {
  return new Request('http://localhost/api/research/favorites/from-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe('POST /api/research/favorites/from-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues subtitle fetching for an existing video after creating the favorite', async () => {
    const selectVideoGet = vi.fn().mockReturnValue({ id: 42 });
    const insertFavoriteRun = vi.fn().mockReturnValue({});
    prepareMock
      .mockReturnValueOnce({ get: selectVideoGet })
      .mockReturnValueOnce({ run: insertFavoriteRun });

    const response = await POST(
      makeRequest({
        url: 'https://www.youtube.com/watch?v=abc123',
        intent_type_id: 1,
        note: 'test note',
      }),
    );

    expect(response.status).toBe(201);
    await Promise.resolve();
    expect(enqueueSubtitleJobForVideoDbId).toHaveBeenCalledWith(42, 0);
  });

  it('enqueues subtitle fetching for a newly inserted external video', async () => {
    const selectVideoGet = vi.fn().mockReturnValue(undefined);
    const insertVideoRun = vi.fn().mockReturnValue({ lastInsertRowid: 9 });
    const insertFavoriteRun = vi.fn().mockReturnValue({});
    fetchYouTubeVideoDetail.mockResolvedValue({
      title: 'External Video',
      thumbnail_url: 'https://example.com/thumb.jpg',
      published_at: '2026-04-08T00:00:00.000Z',
      duration: '12:34',
      channel_name: 'External Channel',
    });
    prepareMock
      .mockReturnValueOnce({ get: selectVideoGet })
      .mockReturnValueOnce({ run: insertVideoRun })
      .mockReturnValueOnce({ run: insertFavoriteRun });

    const response = await POST(
      makeRequest({
        url: 'https://www.youtube.com/watch?v=abc123',
        intent_type_id: 1,
        note: 'test note',
      }),
    );

    expect(response.status).toBe(201);
    await Promise.resolve();
    expect(fetchYouTubeVideoDetail).toHaveBeenCalledWith('abc123');
    expect(enqueueSubtitleJobForVideoDbId).toHaveBeenCalledWith(9, 0);
  });
});
