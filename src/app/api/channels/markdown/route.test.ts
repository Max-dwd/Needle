import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NextRequest } from 'next/server';

const {
  importChannelsFromMarkdownMock,
  resolveChannelFromUrlMock,
  getDbMock,
  prepareMock,
  transactionMock,
  findExistingGetMock,
  upsertRunMock,
} = vi.hoisted(() => {
  const importChannelsFromMarkdownMock = vi.fn();
  const resolveChannelFromUrlMock = vi.fn();
  const findExistingGetMock = vi.fn();
  const upsertRunMock = vi.fn();
  const prepareMock = vi.fn((sql: string) => {
    if (sql.includes('SELECT id FROM channels WHERE channel_id = ?')) {
      return { get: findExistingGetMock };
    }
    if (sql.includes('INSERT INTO channels')) {
      return { run: upsertRunMock };
    }
    return {};
  });
  const transactionMock = vi.fn((fn: () => void) => fn);
  const getDbMock = vi.fn(() => ({
    prepare: prepareMock,
    transaction: transactionMock,
  }));

  return {
    importChannelsFromMarkdownMock,
    resolveChannelFromUrlMock,
    getDbMock,
    prepareMock,
    transactionMock,
    findExistingGetMock,
    upsertRunMock,
  };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/channel-markdown', () => ({
  exportChannelsToMarkdown: vi.fn(),
  importChannelsFromMarkdown: importChannelsFromMarkdownMock,
}));

vi.mock('@/lib/fetcher', () => ({
  resolveChannelFromUrl: resolveChannelFromUrlMock,
}));

import { POST } from './route';

describe('POST /api/channels/markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareMock.mockClear();
    transactionMock.mockClear();
    findExistingGetMock.mockReset();
    upsertRunMock.mockReset();
  });

  it('hydrates avatar_url for newly imported channels', async () => {
    importChannelsFromMarkdownMock.mockResolvedValue([
      {
        platform: 'youtube',
        channel_id: 'UC123',
        name: 'Alpha',
        url: 'https://www.youtube.com/channel/UC123',
        intent: '工作',
        topics: ['AI'],
      },
    ]);
    resolveChannelFromUrlMock.mockResolvedValue({
      platform: 'youtube',
      channel_id: 'UC123',
      name: 'Alpha',
      avatar_url: 'https://img.example/alpha.png',
    });
    findExistingGetMock.mockReturnValue(undefined);

    const response = await POST(
      new Request('http://localhost/api/channels/markdown', {
        method: 'POST',
        body: JSON.stringify({ markdown: '# Needle Subscriptions' }),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      created: 1,
      updated: 0,
      total: 1,
    });
    expect(resolveChannelFromUrlMock).toHaveBeenCalledWith(
      'https://www.youtube.com/channel/UC123',
    );
    expect(upsertRunMock).toHaveBeenCalledWith(
      'youtube',
      'UC123',
      'Alpha',
      'https://img.example/alpha.png',
      '工作',
      '["AI"]',
    );
  });

  it('refreshes avatar_url for existing channels on re-import', async () => {
    importChannelsFromMarkdownMock.mockResolvedValue([
      {
        platform: 'bilibili',
        channel_id: '12345',
        name: 'Beta',
        url: 'https://space.bilibili.com/12345',
        intent: '娱乐',
        topics: [],
      },
    ]);
    resolveChannelFromUrlMock.mockResolvedValue({
      platform: 'bilibili',
      channel_id: '12345',
      name: 'Beta',
      avatar_url: 'https://img.example/beta.png',
    });
    findExistingGetMock.mockReturnValue({ id: 9 });

    const response = await POST(
      new Request('http://localhost/api/channels/markdown', {
        method: 'POST',
        body: JSON.stringify({ markdown: '# Needle Subscriptions' }),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      created: 0,
      updated: 1,
      total: 1,
    });
    expect(upsertRunMock).toHaveBeenCalledWith(
      'bilibili',
      '12345',
      'Beta',
      'https://img.example/beta.png',
      '娱乐',
      '[]',
    );
  });

  it('keeps import working when metadata hydration fails', async () => {
    importChannelsFromMarkdownMock.mockResolvedValue([
      {
        platform: 'youtube',
        channel_id: 'UC999',
        name: 'Gamma',
        url: 'https://www.youtube.com/channel/UC999',
        intent: '未分类',
        topics: [],
      },
    ]);
    resolveChannelFromUrlMock.mockRejectedValue(new Error('network error'));
    findExistingGetMock.mockReturnValue({ id: 3 });

    const response = await POST(
      new Request('http://localhost/api/channels/markdown', {
        method: 'POST',
        body: JSON.stringify({ markdown: '# Needle Subscriptions' }),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      created: 0,
      updated: 1,
      total: 1,
    });
    expect(upsertRunMock).toHaveBeenCalledWith(
      'youtube',
      'UC999',
      'Gamma',
      '',
      '未分类',
      '[]',
    );
  });
});
