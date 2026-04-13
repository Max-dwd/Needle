import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({ getDb: getDbMock }));

import { GET } from './route';

function mockStmt(overrides: {
  all?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    all: overrides.all ?? vi.fn().mockReturnValue([]),
    get: overrides.get ?? vi.fn().mockReturnValue({ count: 0 }),
  };
}

describe('GET /api/settings/error-handling/videos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReset();
  });

  it('returns only tracked unavailable videos', async () => {
    prepareMock
      .mockReturnValueOnce(
        mockStmt({
          all: vi.fn().mockReturnValue([
            {
              id: 1,
              video_id: 'gone123',
              platform: 'youtube',
              title: 'Removed video',
              channel_name: 'XIAOHAN',
              availability_status: 'unavailable',
            },
          ]),
        }),
      )
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ count: 1 }) }),
      );

    const request = new Request(
      'http://localhost/api/settings/error-handling/videos?limit=50',
    ) as NextRequest;
    const response = await GET(request);

    expect(response.status).toBe(200);
    const query = prepareMock.mock.calls[0]?.[0] as string;
    expect(query).toContain(
      "WHERE v.availability_status IN ('unavailable', 'abandoned')",
    );
    const data = (await response.json()) as {
      totalTracked: number;
      videos: Array<{ video_id: string }>;
    };
    expect(data.totalTracked).toBe(1);
    expect(data.videos).toHaveLength(1);
    expect(data.videos[0]?.video_id).toBe('gone123');
  });

  it('caps the requested limit to avoid huge responses', async () => {
    const allMock = vi.fn().mockReturnValue([]);
    prepareMock
      .mockReturnValueOnce(mockStmt({ all: allMock }))
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ count: 0 }) }),
      );

    const request = new Request(
      'http://localhost/api/settings/error-handling/videos?limit=9999',
    ) as NextRequest;
    await GET(request);

    expect(allMock).toHaveBeenCalledWith(200);
  });
});
