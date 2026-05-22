import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, listChatArtifactsMock, createChatArtifactMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    listChatArtifactsMock: vi.fn(),
    createChatArtifactMock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/chat-artifacts', () => ({
  listChatArtifacts: listChatArtifactsMock,
  createChatArtifact: createChatArtifactMock,
}));

import { GET, POST } from './route';

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) } as {
    params: Promise<{ id: string }>;
  };
}

describe('/api/videos/[id]/chat/artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 1 }),
      }),
    });
  });

  it('lists saved chat artifacts for a video', async () => {
    listChatArtifactsMock.mockReturnValue([
      {
        id: 10,
        video_id: 1,
        mode: 'obsidian',
        prompt: '整理一下',
        rangeStart: 0,
        rangeEnd: 60,
        content: '# Note',
        createdAt: '2026-04-26 10:00:00',
      },
    ]);

    const response = await GET(
      new Request('http://localhost/api/videos/1/chat/artifacts') as never,
      makeParams('1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: 10,
          mode: 'obsidian',
          content: '# Note',
        }),
      ],
    });
    expect(listChatArtifactsMock).toHaveBeenCalledWith(1);
  });

  it('creates a saved chat artifact', async () => {
    createChatArtifactMock.mockReturnValue({
      id: 11,
      video_id: 1,
      mode: 'roast',
      prompt: '吐槽一下',
      rangeStart: 5,
      rangeEnd: 25,
      content: '## 评论',
      createdAt: '2026-04-26 10:01:00',
    });

    const request = new Request('http://localhost/api/videos/1/chat/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'roast',
        prompt: '吐槽一下',
        rangeStart: 5,
        rangeEnd: 25,
        content: '## 评论',
      }),
    });

    const response = await POST(request as never, makeParams('1'));

    expect(response.status).toBe(201);
    expect(createChatArtifactMock).toHaveBeenCalledWith({
      videoId: 1,
      mode: 'roast',
      prompt: '吐槽一下',
      rangeStart: 5,
      rangeEnd: 25,
      content: '## 评论',
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ id: 11, mode: 'roast' }),
    );
  });

  it('rejects empty generated content', async () => {
    const request = new Request('http://localhost/api/videos/1/chat/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'obsidian',
        prompt: '整理一下',
        rangeStart: 5,
        rangeEnd: 25,
        content: '   ',
      }),
    });

    const response = await POST(request as never, makeParams('1'));

    expect(response.status).toBe(400);
    expect(createChatArtifactMock).not.toHaveBeenCalled();
  });
});
