import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, prepareMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { getDbMock, prepareMock };
});

const { ensureSubtitleForVideo, readStoredSubtitle } = vi.hoisted(() => ({
  ensureSubtitleForVideo: vi.fn(),
  readStoredSubtitle: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/subtitles', () => ({
  ensureSubtitleForVideo,
  readStoredSubtitle,
}));

import type { NextRequest } from 'next/server';
import { GET, POST } from './route';

function makeRequest(url: string, method: 'POST' | 'GET' = 'POST'): NextRequest {
  return {
    nextUrl: new URL(url),
    method,
  } as NextRequest;
}

describe('POST /api/videos/[id]/subtitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReset();
    prepareMock.mockReturnValue({
      get: vi.fn().mockReturnValue({
        subtitle_status: 'missing',
        subtitle_error: null,
        subtitle_cooldown_until: null,
      }),
    });
    ensureSubtitleForVideo.mockResolvedValue({
      id: 1,
      subtitle_status: 'missing',
      subtitle_error: null,
      subtitle_cooldown_until: null,
      subtitle_path: null,
    });
    readStoredSubtitle.mockReturnValue(null);
  });

  it('keeps browser subtitle fetching enabled for player retries', async () => {
    const response = await POST(
      makeRequest(
        'http://localhost/api/videos/1/subtitle?source=player&preferredMethod=bilibili-api&aid=123&cid=456&async=1',
      ),
      { params: Promise.resolve({ id: '1' }) },
    );

    expect(response.status).toBe(202);
    expect(ensureSubtitleForVideo).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        requestSource: 'player',
        preferredMethod: 'bilibili-api',
        allowBrowser: undefined,
        bilibiliContext: { aid: 123, cid: 456 },
        force: true,
        respectPause: false,
      }),
    );
  });

  it('returns stored status on GET without triggering subtitle fetch', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/videos/1/subtitle', 'GET'),
      { params: Promise.resolve({ id: '1' }) },
    );

    expect(response.status).toBe(404);
    expect(ensureSubtitleForVideo).not.toHaveBeenCalled();
  });

  it('disables browser subtitle fetching for player gemini extraction', async () => {
    const response = await POST(
      makeRequest(
        'http://localhost/api/videos/1/subtitle?source=player&preferredMethod=gemini&async=1',
      ),
      { params: Promise.resolve({ id: '1' }) },
    );

    expect(response.status).toBe(202);
    expect(ensureSubtitleForVideo).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        requestSource: 'player',
        preferredMethod: 'gemini',
        allowBrowser: false,
        force: true,
        respectPause: false,
      }),
    );
  });
});
