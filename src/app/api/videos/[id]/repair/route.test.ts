import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { prepareMock, getDbMock };
});

const { ensureEnrichmentQueue, enrichVideo } = vi.hoisted(() => ({
  ensureEnrichmentQueue: vi.fn(),
  enrichVideo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({ getDb: getDbMock }));
vi.mock('@/lib/enrichment-queue', () => ({
  ensureEnrichmentQueue,
  enrichVideo,
}));

import { POST } from './route';

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/videos/[id]/repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReset();
  });

  it('returns 400 for invalid ids', async () => {
    const response = await POST(new Request('http://localhost') as Request, makeParams('nope'));
    expect(response.status).toBe(400);
  });

  it('returns 404 when the video is missing', async () => {
    prepareMock.mockReturnValueOnce({
      get: vi.fn().mockReturnValue(undefined),
    });

    const response = await POST(new Request('http://localhost') as Request, makeParams('1'));
    expect(response.status).toBe(404);
  });

  it('enqueues manual repair and returns 202', async () => {
    prepareMock.mockReturnValueOnce({
      get: vi.fn().mockReturnValue({
        id: 1,
        video_id: 'BV1xx411c7mD',
        platform: 'bilibili',
      }),
    });

    const response = await POST(new Request('http://localhost') as Request, makeParams('1'));
    const result = await response.json();

    expect(response.status).toBe(202);
    expect(result).toEqual({
      accepted: true,
      videoId: 'BV1xx411c7mD',
      platform: 'bilibili',
    });
    expect(ensureEnrichmentQueue).toHaveBeenCalledTimes(1);
    expect(enrichVideo).toHaveBeenCalledWith(1);
  });

  it('returns 409 for videos marked as abandoned', async () => {
    prepareMock.mockReturnValueOnce({
      get: vi.fn().mockReturnValue({
        id: 2,
        video_id: 'gone123',
        platform: 'youtube',
        availability_status: 'abandoned',
      }),
    });

    const response = await POST(new Request('http://localhost') as Request, makeParams('2'));

    expect(response.status).toBe(409);
    expect(ensureEnrichmentQueue).not.toHaveBeenCalled();
    expect(enrichVideo).not.toHaveBeenCalled();
  });
});
