import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  readSubtitlePayloadMock,
  getAiSummarySettingsMock,
  resolveAiSummaryGenerationSettingsMock,
  buildChatPromptMock,
  createChatStreamMock,
} = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const readSubtitlePayloadMock = vi.fn();
  const getAiSummarySettingsMock = vi.fn();
  const resolveAiSummaryGenerationSettingsMock = vi.fn();
  const buildChatPromptMock = vi.fn();
  const createChatStreamMock = vi.fn();

  return {
    getDbMock,
    readSubtitlePayloadMock,
    getAiSummarySettingsMock,
    resolveAiSummaryGenerationSettingsMock,
    buildChatPromptMock,
    createChatStreamMock,
  };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/ai-summary-client', () => ({
  readSubtitlePayload: readSubtitlePayloadMock,
}));

vi.mock('@/lib/ai-summary-settings', () => ({
  getAiSummarySettings: getAiSummarySettingsMock,
  resolveAiSummaryGenerationSettings: resolveAiSummaryGenerationSettingsMock,
}));

vi.mock('@/lib/ai-chat-client', () => ({
  buildChatPrompt: buildChatPromptMock,
  createChatStream: createChatStreamMock,
}));

import { POST } from './route';

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) } as {
    params: Promise<{ id: string }>;
  };
}

describe('POST /api/videos/[id]/chat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:34:56.000Z'));
    vi.clearAllMocks();

    getDbMock.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 1,
          video_id: 'abc123',
          platform: 'youtube',
          title: 'Test Video',
          channel_id: 11,
          channel_name: 'Test Channel',
        }),
      }),
    });

    readSubtitlePayloadMock.mockReturnValue({
      video_id: 'abc123',
      platform: 'youtube',
      segments: [
        { start: 5, end: 7, text: 'skip me' },
        { start: 15, end: 18, text: 'keep me' },
        { start: 25, end: 28, text: 'skip me too' },
      ],
    });

    resolveAiSummaryGenerationSettingsMock.mockReturnValue({
      selectedModel: {
        id: 'model-1',
        name: 'Test Model',
        endpoint: 'https://example.com/v1',
        apiKey: 'secret',
        model: 'test-model',
      },
    });

    getAiSummarySettingsMock.mockReturnValue({
      promptTemplates: {
        chatObsidian: 'obsidian-template',
        chatRoast: 'roast-template',
      },
    });

    buildChatPromptMock.mockReturnValue({
      system: 'system',
      user: 'user',
    });

    createChatStreamMock.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
  });

  it('filters subtitle segments to the selected time range', async () => {
    const request = new Request('http://localhost/api/videos/1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'obsidian',
        prompt: '记下这个观点',
        rangeStart: 10,
        rangeEnd: 20,
      }),
    });

    const response = await POST(request as never, makeParams('1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(resolveAiSummaryGenerationSettingsMock).toHaveBeenCalledWith({
      modelIdOverride: null,
      triggerSource: 'manual',
    });
    expect(buildChatPromptMock).toHaveBeenCalledWith(
      'obsidian',
      '记下这个观点',
      [{ start: 15, end: 18, text: 'keep me' }],
      expect.objectContaining({
        title: 'Test Video',
        channel: 'Test Channel',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=abc123',
        generatedAt: '2026-04-03T12:34:56.000Z',
      }),
      {
        chatObsidian: 'obsidian-template',
        chatRoast: 'roast-template',
      },
    );
    expect(createChatStreamMock).toHaveBeenCalledWith(
      { system: 'system', user: 'user' },
      expect.objectContaining({ id: 'model-1' }),
      request.signal,
    );
  });

  it('rejects an empty filtered range', async () => {
    const request = new Request('http://localhost/api/videos/1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'roast',
        prompt: '这个也太离谱了',
        rangeStart: 30,
        rangeEnd: 40,
      }),
    });

    const response = await POST(request as never, makeParams('1'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '选定时间范围内没有可用字幕片段',
    });
    expect(buildChatPromptMock).not.toHaveBeenCalled();
    expect(createChatStreamMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
