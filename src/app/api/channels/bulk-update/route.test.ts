import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn();
  return { prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

// Helper to create a full mock statement
function mockStmt(overrides: {
  get?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
  all?: ReturnType<typeof vi.fn>;
}) {
  return {
    get: overrides.get ?? vi.fn(),
    run: overrides.run ?? vi.fn(),
    all: overrides.all ?? vi.fn(),
  };
}

import { POST } from './route';

describe('POST /api/channels/bulk-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: db with prepare and transaction
    // db.transaction(fn) returns a wrapper function; calling it runs fn inside a transaction
    const dbMock = {
      prepare: prepareMock,
      transaction: vi.fn((fn: () => void) => () => fn()),
    };
    getDbMock.mockReturnValue(dbMock);
  });

  describe('intent update', () => {
    it('updates intent for multiple channels', async () => {
      // Chain: intent lookup (get) → UPDATE (run) → SELECT channels (all)
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ id: 1, name: '工作' }) }))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 2 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '工作', topics: '[]', video_count: 5 },
          { id: 2, name: 'Channel B', platform: 'bilibili', channel_id: 'BV1', intent: '工作', topics: '[]', video_count: 3 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1, 2], intent: '工作' }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      expect(result).toHaveLength(2);
      expect(result[0].intent).toBe('工作');
      expect(result[1].intent).toBe('工作');
    });

    it('rejects non-existent intent', async () => {
      prepareMock.mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(null) }));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1, 2], intent: '不存在的意图' }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain('不存在的意图');
    });

    it('batch intent update does NOT modify topics', async () => {
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ id: 1, name: '娱乐' }) }))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '娱乐', topics: '["AI","Tech"]', video_count: 5 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], intent: '娱乐' }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      // Topics should be preserved (parsed from JSON string)
      expect(result[0].topics).toEqual(['AI', 'Tech']);
    });
  });

  describe('addTopics', () => {
    it('appends new topics deduplicated', async () => {
      // Chain: SELECT channel (get) → UPDATE topics (run) → SELECT updated (all)
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '未分类', topics: '["AI"]', video_count: 5 }
        )}))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '未分类', topics: '["AI","Tech","学习"]', video_count: 5 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], addTopics: ['Tech', '学习'] }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      expect(result[0].topics).toEqual(['AI', 'Tech', '学习']);
    });

    it('addTopics does not modify intent', async () => {
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '工作', topics: '[]', video_count: 5 }
        )}))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '工作', topics: '["新主题"]', video_count: 5 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], addTopics: ['新主题'] }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      expect(result[0].intent).toBe('工作'); // unchanged
    });
  });

  describe('removeTopics', () => {
    it('removes matching topics', async () => {
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '未分类', topics: '["AI","Tech","学习"]', video_count: 5 }
        )}))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '未分类', topics: '["AI"]', video_count: 5 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], removeTopics: ['Tech', '学习'] }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      expect(result[0].topics).toEqual(['AI']);
    });
  });

  describe('combined intent + addTopics', () => {
    it('updates both intent and adds topics when both provided', async () => {
      // Chain: intent lookup (get) → SELECT channel (get) → UPDATE topics (run) → UPDATE intent (run) → SELECT updated (all)
      prepareMock
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ id: 1, name: '工作' }) }))
        .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '未分类', topics: '[]', video_count: 5 }
        )}))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ changes: 1 }) }))
        .mockReturnValueOnce(mockStmt({ all: vi.fn().mockReturnValue([
          { id: 1, name: 'Channel A', platform: 'youtube', channel_id: 'UC1', intent: '工作', topics: '["新主题"]', video_count: 5 },
        ])}));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], intent: '工作', addTopics: ['新主题'] }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(200);
      const result = await response.json() as Array<Record<string, unknown>>;
      expect(result[0].intent).toBe('工作');
      expect(result[0].topics).toEqual(['新主题']);
    });
  });

  describe('validation', () => {
    it('rejects empty ids array', async () => {
      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [] }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain('ids');
    });

    it('rejects non-array ids', async () => {
      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: 'not-an-array' }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(400);
    });

    it('rejects non-existent intent when provided', async () => {
      prepareMock.mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(null) }));

      const req = new Request('http://localhost/api/channels/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ ids: [1], intent: '不存在的' }),
      });

      const response = await POST(req as never);
      expect(response.status).toBe(400);
    });
  });
});
