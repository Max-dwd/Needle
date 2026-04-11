import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
  return { prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({ getDb: getDbMock }));
vi.mock('@/lib/video-summary', () => ({
  batchCheckSummaryExistence: vi.fn().mockReturnValue(new Set<string>()),
}));
vi.mock('@/lib/refresh-history', () => ({
  getScopeLastRefreshAt: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/app-settings', () => ({
  getAppSetting: vi.fn().mockReturnValue(null),
}));

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

describe('GET /api/videos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockReset();
  });

  it('uses a hybrid published_at sort that handles relative time text', async () => {
    prepareMock
      .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([]) }))
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ count: 0 }) }));

    const request = new Request('http://localhost/api/videos') as NextRequest;
    await GET(request);

    const query = prepareMock.mock.calls[0]?.[0] as string;
    expect(query).toContain("WHEN v.published_at LIKE '%天前'");
    expect(query).toContain("WHEN v.published_at LIKE '%年前'");
    expect(query).toContain("WHEN v.published_at LIKE '% hours ago'");
    expect(query).toContain("ELSE julianday(v.created_at)");
    expect(query).toContain('ORDER BY');
    expect(query).toContain('DESC, v.created_at DESC, v.id DESC');
  });

  it('only joins research tables when include_research=1', async () => {
    prepareMock
      .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([]) }))
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ count: 0 }) }),
      );

    const request = new Request(
      'http://localhost/api/videos?include_research=1',
    ) as NextRequest;
    await GET(request);

    const query = prepareMock.mock.calls[0]?.[0] as string;
    expect(query).toContain('LEFT JOIN research_favorites rf ON rf.video_id = v.id');
    expect(query).toContain('LEFT JOIN research_intent_types rit ON rit.id = rf.intent_type_id');
    expect(query).toContain('research_is_favorited');
  });
});
