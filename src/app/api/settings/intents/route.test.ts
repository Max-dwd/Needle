import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Intent } from '@/lib/db';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const getDbMock = vi.fn(() => ({ prepare: prepareMock }));
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

import { GET, POST } from './route';

const mockIntents: Intent[] = [
  {
    id: 1,
    name: '工作',
    auto_subtitle: 1,
    auto_summary: 1,
    sort_order: 0,
    auto_summary_model_id: null,
    agent_prompt: null,
    agent_trigger: null,
    agent_schedule_time: '09:00',
    agent_memory: null,
    created_at: '2026-03-24T00:00:00.000Z',
  },
  {
    id: 2,
    name: '娱乐',
    auto_subtitle: 0,
    auto_summary: 0,
    sort_order: 1,
    auto_summary_model_id: null,
    agent_prompt: null,
    agent_trigger: null,
    agent_schedule_time: '09:00',
    agent_memory: null,
    created_at: '2026-03-24T00:00:00.000Z',
  },
  {
    id: 5,
    name: '未分类',
    auto_subtitle: 0,
    auto_summary: 0,
    sort_order: 99,
    auto_summary_model_id: null,
    agent_prompt: null,
    agent_trigger: null,
    agent_schedule_time: '09:00',
    agent_memory: null,
    created_at: '2026-03-24T00:00:00.000Z',
  },
];

describe('GET /api/settings/intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all intents sorted by sort_order', async () => {
    prepareMock.mockReturnValue(mockStmt({ all: vi.fn().mockReturnValue(mockIntents) }));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(mockIntents);
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY sort_order'),
    );
  });

  it('returns empty array when no intents exist', async () => {
    prepareMock.mockReturnValue(mockStmt({ all: vi.fn().mockReturnValue([]) }));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });
});

describe('POST /api/settings/intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a new intent with auto-assigned sort_order', async () => {
    const newIntent: Intent = {
      id: 6,
      name: '学习',
      auto_subtitle: 0,
      auto_summary: 0,
      sort_order: 4,
      auto_summary_model_id: null,
      agent_prompt: null,
      agent_trigger: null,
      agent_schedule_time: '09:00',
      agent_memory: null,
      created_at: '2026-03-24T00:00:00.000Z',
    };

    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(null) })) // no duplicate
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ max_order: 3 }) })) // max sort_order
      .mockReturnValueOnce(mockStmt({ run: vi.fn().mockReturnValue({ lastInsertRowid: 6 }) })) // insert
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(newIntent) })); // fetch created

    const req = new Request('http://localhost/api/settings/intents', {
      method: 'POST',
      body: JSON.stringify({ name: '学习' }),
    });

    const response = await POST(req as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(newIntent);
  });

  it('rejects empty name', async () => {
    const req = new Request('http://localhost/api/settings/intents', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });

    const response = await POST(req as never);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects whitespace-only name', async () => {
    const req = new Request('http://localhost/api/settings/intents', {
      method: 'POST',
      body: JSON.stringify({ name: '   ' }),
    });

    const response = await POST(req as never);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects duplicate name', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
    );

    const req = new Request('http://localhost/api/settings/intents', {
      method: 'POST',
      body: JSON.stringify({ name: '工作' }),
    });

    const response = await POST(req as never);

    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('工作');
  });

  it('accepts auto_subtitle and auto_summary flags', async () => {
    const newIntent: Intent = {
      id: 6,
      name: '学习',
      auto_subtitle: 1,
      auto_summary: 1,
      sort_order: 4,
      auto_summary_model_id: null,
      agent_prompt: null,
      agent_trigger: null,
      agent_schedule_time: '09:00',
      agent_memory: null,
      created_at: '2026-03-24T00:00:00.000Z',
    };

    const insertRunMock = vi.fn().mockReturnValue({ lastInsertRowid: 6 });
    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(null) }))
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ max_order: 3 }) }))
      .mockReturnValueOnce(mockStmt({ run: insertRunMock }))
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(newIntent) }));

    const req = new Request('http://localhost/api/settings/intents', {
      method: 'POST',
      body: JSON.stringify({ name: '学习', auto_subtitle: 1, auto_summary: 1 }),
    });

    const response = await POST(req as never);

    expect(response.status).toBe(201);
    // Verify auto_subtitle=1 was passed
    expect(insertRunMock).toHaveBeenCalledWith('学习', 1, 1, expect.any(Number));
  });
});
