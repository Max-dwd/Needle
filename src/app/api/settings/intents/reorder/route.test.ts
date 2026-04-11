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

describe('POST /api/settings/intents/reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: db with prepare and transaction
    const runMock = vi.fn();
    const dbMock = {
      prepare: prepareMock,
      transaction: vi.fn((fn: (args: unknown[]) => void) => fn),
    };
    getDbMock.mockReturnValue(dbMock);
    prepareMock.mockReturnValue(mockStmt({ run: runMock }));
  });

  it('rejects missing ids', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await POST(req as never);

    expect(response.status).toBe(400);
  });

  it('rejects empty ids array', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ids: [] }),
    });
    const response = await POST(req as never);

    expect(response.status).toBe(400);
  });

  it('rejects non-integer ids', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ids: ['a', 'b'] }),
    });
    const response = await POST(req as never);

    expect(response.status).toBe(400);
  });

  it('rejects float ids', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ids: [1.5, 2] }),
    });
    const response = await POST(req as never);

    expect(response.status).toBe(400);
  });

  it('updates sort_order for each id and returns success', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ids: [1, 2, 3, 4] }),
    });
    const response = await POST(req as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('ensures 未分类 always gets sort_order=99', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });
    await POST(req as never);

    // Check that we called prepare with a statement to set 未分类 sort_order=99
    const calls = prepareMock.mock.calls.map((c) => c[0] as string);
    const fixUnclassifiedCall = calls.find(
      (sql) => sql.includes('99') && sql.includes('未分类'),
    );
    expect(fixUnclassifiedCall).toBeDefined();
  });
});
