import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SummaryTaskStats } from '@/types';

const { getSummaryTaskStatsMock } = vi.hoisted(() => ({
  getSummaryTaskStatsMock: vi.fn(),
}));

vi.mock('@/lib/summary-tasks', () => ({
  getSummaryTaskStats: getSummaryTaskStatsMock,
}));

import { GET } from './route';

describe('GET /api/summary-tasks/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns summary task counts', async () => {
    const stats: SummaryTaskStats = {
      pending: 4,
      processing: 2,
      completed: 9,
      failed: 1,
    };
    getSummaryTaskStatsMock.mockReturnValue(stats);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(stats);
    expect(getSummaryTaskStatsMock).toHaveBeenCalledTimes(1);
  });

  it('returns zero counts when there are no tasks yet', async () => {
    const emptyStats: SummaryTaskStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    getSummaryTaskStatsMock.mockReturnValue(emptyStats);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(emptyStats);
  });
});
