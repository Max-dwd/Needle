import { afterEach, describe, expect, it, vi } from 'vitest';

const acquireSharedAiBudgetMock = vi.hoisted(() => vi.fn());
const estimateTextTokensMock = vi.hoisted(() => vi.fn(() => 42));

vi.mock('./shared-ai-budget', () => ({
  acquireSharedAiBudget: acquireSharedAiBudgetMock,
  estimateTextTokens: estimateTextTokensMock,
}));

import { buildChatPrompt, createChatStream } from './ai-chat-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  acquireSharedAiBudgetMock.mockResolvedValue({
    release: vi.fn(),
  });
});

describe('buildChatPrompt', () => {
  it('includes obsidian YAML frontmatter instructions with video metadata', () => {
    const prompt = buildChatPrompt(
      'obsidian',
      '整理成项目笔记',
      [{ start: 15, end: 18, text: '这是一个关键观点。' }],
      {
        title: 'AI 架构设计',
        channel: 'Needle Channel',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=abc123',
        generatedAt: '2026-04-03T12:34:56.000Z',
      },
    );

    expect(prompt.system).toContain('YAML frontmatter');
    expect(prompt.system).toContain(
      'title、channel、platform、source_url、creat_at',
    );
    expect(prompt.system).toContain('不要改写成 `created_at`');
    expect(prompt.user).toContain(
      '--- 输出 YAML frontmatter（请原样作为笔记开头） ---',
    );
    expect(prompt.user).toContain('title: "AI 架构设计"');
    expect(prompt.user).toContain('channel: "Needle Channel"');
    expect(prompt.user).toContain('platform: "youtube"');
    expect(prompt.user).toContain(
      'source_url: "https://www.youtube.com/watch?v=abc123"',
    );
    expect(prompt.user).toContain('creat_at: "2026-04-03T12:34:56.000Z"');
  });
});

describe('createChatStream', () => {
  it('passes the caller abort signal into shared budget acquisition', async () => {
    acquireSharedAiBudgetMock.mockResolvedValue({
      release: vi.fn(),
    });

    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                    'data: {"usage":{"total_tokens":1}}\n\n',
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const abortController = new AbortController();
    const stream = createChatStream(
      {
        system: 'system prompt',
        user: 'user prompt',
      },
      {
        id: 'model-1',
        name: 'Test Model',
        endpoint: 'https://example.com/v1',
        apiKey: 'secret',
        model: 'test-model',
      },
      abortController.signal,
    );

    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain stream
    }

    expect(acquireSharedAiBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'chat-stream:model-1',
      }),
      abortController.signal,
    );
  });
});
