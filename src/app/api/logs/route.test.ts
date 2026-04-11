import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getBufferedEntriesMock, formatBufferedEntryMock } = vi.hoisted(() => ({
  getBufferedEntriesMock: vi.fn(),
  formatBufferedEntryMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  getBufferedEntries: getBufferedEntriesMock,
  formatBufferedEntry: formatBufferedEntryMock,
}));

import { GET } from './route';

describe('GET /api/logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns entries and legacy logs while forwarding normalized query filters', async () => {
    const entry = {
      ts: '2026-03-23T12:00:00.000Z',
      level: 'warn',
      scope: 'api',
      event: 'message',
      platform: 'youtube',
      message: 'test',
    };
    getBufferedEntriesMock.mockReturnValue([entry]);
    formatBufferedEntryMock.mockReturnValue(
      '[2026-03-23T12:00:00.000Z] [WARN] [api] message platform=youtube message=test',
    );

    const request = new NextRequest(
      'http://localhost/api/logs?lines=600&level=warn&scope=api&platform=youtube',
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(getBufferedEntriesMock).toHaveBeenCalledWith({
      lines: 500,
      level: 'warn',
      scope: 'api',
      platform: 'youtube',
    });
    await expect(response.json()).resolves.toEqual({
      entries: [entry],
      logs: [
        '[2026-03-23T12:00:00.000Z] [WARN] [api] message platform=youtube message=test',
      ],
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('clamps lines to the minimum and returns an empty log list', async () => {
    getBufferedEntriesMock.mockReturnValue([]);

    const request = new NextRequest('http://localhost/api/logs?lines=0');

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(getBufferedEntriesMock).toHaveBeenCalledWith({
      lines: 1,
      level: undefined,
      scope: undefined,
      platform: undefined,
    });
    await expect(response.json()).resolves.toEqual({ entries: [], logs: [] });
  });
});
