import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rescrapeVideo } = vi.hoisted(() => ({
  rescrapeVideo: vi.fn(),
}));

vi.mock('@/lib/video-rescrape', () => ({
  rescrapeVideo,
}));

import { POST } from './route';

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/videos/[id]/repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for invalid ids', async () => {
    const response = await POST(
      new Request('http://localhost'),
      makeParams('nope'),
    );
    expect(response.status).toBe(400);
    expect(rescrapeVideo).not.toHaveBeenCalled();
  });

  it('returns 404 when the video is missing', async () => {
    rescrapeVideo.mockResolvedValueOnce({ ok: false, reason: 'not_found' });

    const response = await POST(
      new Request('http://localhost'),
      makeParams('1'),
    );

    expect(response.status).toBe(404);
    expect(rescrapeVideo).toHaveBeenCalledWith(1);
  });

  it('returns 409 when a rescrape is already in progress', async () => {
    rescrapeVideo.mockResolvedValueOnce({ ok: false, reason: 'in_progress' });

    const response = await POST(
      new Request('http://localhost'),
      makeParams('2'),
    );
    const result = await response.json();

    expect(response.status).toBe(409);
    expect(result).toEqual({ error: 'rescrape_in_progress' });
    expect(rescrapeVideo).toHaveBeenCalledWith(2);
  });

  it('starts a rescrape and returns 202', async () => {
    rescrapeVideo.mockResolvedValueOnce({
      ok: true,
      videoId: 'BV1xx411c7mD',
      platform: 'bilibili',
    });

    const response = await POST(
      new Request('http://localhost'),
      makeParams('1'),
    );
    const result = await response.json();

    expect(response.status).toBe(202);
    expect(result).toEqual({
      accepted: true,
      videoId: 'BV1xx411c7mD',
      platform: 'bilibili',
    });
    expect(rescrapeVideo).toHaveBeenCalledWith(1);
  });

  it('allows abandoned videos to reach the rescrape path', async () => {
    rescrapeVideo.mockResolvedValueOnce({
      ok: true,
      videoId: 'gone123',
      platform: 'youtube',
    });

    const response = await POST(
      new Request('http://localhost'),
      makeParams('3'),
    );

    expect(response.status).toBe(202);
    expect(rescrapeVideo).toHaveBeenCalledWith(3);
  });
});
