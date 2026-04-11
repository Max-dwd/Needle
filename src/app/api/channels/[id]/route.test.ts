import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { DELETE, PATCH } from './route';

const makeParams = (id: string) =>
  ({ params: Promise.resolve({ id }) }) as {
    params: Promise<{ id: string }>;
  };

describe('PATCH /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates intent when valid intent name is provided', async () => {
    const runMock = vi.fn();

    prepareMock
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      ) // channel exists
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 3, name: '探索' }) }),
      ) // intent exists in intents table
      .mockReturnValueOnce(mockStmt({ run: runMock })); // UPDATE channels SET intent

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ intent: '探索' }),
    });
    const response = await PATCH(req as never, makeParams('1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(runMock).toHaveBeenCalledWith('探索', '1');
  });

  it('normalizes blank intent to 未分类', async () => {
    const runMock = vi.fn();

    prepareMock
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      ) // channel exists
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 5, name: '未分类' }) }),
      ) // 未分类 exists in intents table
      .mockReturnValueOnce(mockStmt({ run: runMock })); // UPDATE channels SET intent

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ intent: '' }),
    });
    const response = await PATCH(req as never, makeParams('1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(runMock).toHaveBeenCalledWith('未分类', '1');
  });

  it('returns 400 when intent does not exist in intents table', async () => {
    prepareMock
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      ) // channel exists
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue(undefined) }),
      ); // intent NOT found in intents table

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ intent: '不存在的分类' }),
    });
    const response = await PATCH(req as never, makeParams('1'));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it('ignores legacy category fields in the request body', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
    );

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ category: 'Tech', category2: 'AI' }),
    });
    const response = await PATCH(req as never, makeParams('1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(prepareMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/channels/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes channel when it exists', async () => {
    const runMock = vi.fn();

    prepareMock
      .mockReturnValueOnce(
        mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) }),
      ) // channel exists
      .mockReturnValueOnce(mockStmt({ run: runMock })); // DELETE

    const req = new Request('http://localhost', { method: 'DELETE' });
    const response = await DELETE(req as never, makeParams('1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('returns 404 when channel not found', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue(undefined) }),
    );

    const req = new Request('http://localhost', { method: 'DELETE' });
    const response = await DELETE(req as never, makeParams('999'));

    expect(response.status).toBe(404);
  });
});
