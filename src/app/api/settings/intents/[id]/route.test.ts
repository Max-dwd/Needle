import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Intent } from '@/lib/db';

const { prepareMock, getDbMock } = vi.hoisted(() => {
  const prepareMock = vi.fn();
  const transactionMock = vi.fn((fn: () => void) => fn);
  const getDbMock = vi.fn(() => ({ prepare: prepareMock, transaction: transactionMock }));
  return { prepareMock, getDbMock };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/intent-agent', () => ({
  removeArtifactDir: vi.fn(),
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
  ({ params: Promise.resolve({ id }) }) as { params: Promise<{ id: string }> };

const mockIntent: Intent = {
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
};

const mockUnclassified: Intent = {
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
};

describe('PATCH /api/settings/intents/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when intent not found', async () => {
    prepareMock.mockReturnValue(mockStmt({ get: vi.fn().mockReturnValue(undefined) }));

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ name: '新名称' }),
    });
    const response = await PATCH(req as never, makeParams('999'));

    expect(response.status).toBe(404);
  });

  it('renames intent and cascades to channels', async () => {
    const updatedIntent = { ...mockIntent, name: '休闲' };

    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(mockIntent) })) // fetch intent
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(null) })) // no duplicate name
      .mockReturnValueOnce(mockStmt({ run: vi.fn() })) // cascade update channels
      .mockReturnValueOnce(mockStmt({ run: vi.fn() })) // update intent name
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(updatedIntent) })); // fetch updated

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ name: '休闲' }),
    });
    const response = await PATCH(req as never, makeParams('2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(updatedIntent);
  });

  it('rejects rename of 未分类', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue(mockUnclassified) }),
    );

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ name: '新名称' }),
    });
    const response = await PATCH(req as never, makeParams('5'));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('未分类');
  });

  it('rejects rename to existing name', async () => {
    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(mockIntent) })) // fetch intent
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue({ id: 1 }) })); // duplicate found

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ name: '工作' }),
    });
    const response = await PATCH(req as never, makeParams('2'));

    expect(response.status).toBe(409);
  });

  it('rejects empty name', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue(mockIntent) }),
    );

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ name: '' }),
    });
    const response = await PATCH(req as never, makeParams('2'));

    expect(response.status).toBe(400);
  });

  it('updates auto_subtitle toggle', async () => {
    const updatedIntent = { ...mockIntent, auto_subtitle: 1 };

    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(mockIntent) }))
      .mockReturnValueOnce(mockStmt({ run: vi.fn() })) // update auto_subtitle
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(updatedIntent) }));

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ auto_subtitle: 1 }),
    });
    const response = await PATCH(req as never, makeParams('2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ auto_subtitle: 1 });
  });

  it('updates auto_summary toggle', async () => {
    const updatedIntent = { ...mockIntent, auto_summary: 1 };

    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(mockIntent) }))
      .mockReturnValueOnce(mockStmt({ run: vi.fn() })) // update auto_summary
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(updatedIntent) }));

    const req = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ auto_summary: 1 }),
    });
    const response = await PATCH(req as never, makeParams('2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ auto_summary: 1 });
  });


});

describe('DELETE /api/settings/intents/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes intent and reassigns channels to 未分类', async () => {
    const channelRunMock = vi.fn();
    const deleteRunMock = vi.fn();

    prepareMock
      .mockReturnValueOnce(mockStmt({ get: vi.fn().mockReturnValue(mockIntent) })) // fetch intent
      .mockReturnValueOnce(mockStmt({ run: channelRunMock })) // reassign channels
      .mockReturnValueOnce(mockStmt({ run: deleteRunMock })); // delete intent

    const req = new Request('http://localhost', { method: 'DELETE' });
    const response = await DELETE(req as never, makeParams('2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(channelRunMock).toHaveBeenCalledWith('娱乐'); // reassign channels where intent = '娱乐'
    expect(deleteRunMock).toHaveBeenCalledWith('2'); // delete intent
  });

  it('returns 404 when intent not found', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue(undefined) }),
    );

    const req = new Request('http://localhost', { method: 'DELETE' });
    const response = await DELETE(req as never, makeParams('999'));

    expect(response.status).toBe(404);
  });

  it('rejects deletion of 未分类', async () => {
    prepareMock.mockReturnValueOnce(
      mockStmt({ get: vi.fn().mockReturnValue(mockUnclassified) }),
    );

    const req = new Request('http://localhost', { method: 'DELETE' });
    const response = await DELETE(req as never, makeParams('5'));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('未分类');
  });
});
