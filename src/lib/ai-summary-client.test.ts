import { describe, expect, it } from 'vitest';
import {
  createAiApiHeaders,
  createAiApiRequest,
  createChatCompletionRequest,
  createSummaryRequestSignal,
  detectAiApiProtocol,
  extractStreamText,
  extractUsage,
  resolveAiApiUrl,
  resolveAiApiUrlForModel,
} from './ai-summary-client';

describe('ai-summary-client provider compatibility', () => {
  it('keeps anthropic messages endpoints unchanged', () => {
    expect(
      detectAiApiProtocol('https://opencode.ai/zen/go/v1/messages'),
    ).toBe('anthropic-messages');
    expect(
      resolveAiApiUrl('https://opencode.ai/zen/go/v1/messages'),
    ).toBe('https://opencode.ai/zen/go/v1/messages');
    expect(
      resolveAiApiUrl('https://opencode.ai/zen/go/v1'),
    ).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('builds anthropic-compatible headers and body for messages endpoints', () => {
    const model = {
      id: 'go',
      name: 'OpenCode Go',
      endpoint: 'https://opencode.ai/zen/go/v1/messages',
      apiKey: 'secret-key',
      model: 'minimax-m2.5',
      protocol: 'anthropic-messages' as const,
    };

    expect(createAiApiHeaders(model)).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'secret-key',
    });

    expect(
      createAiApiRequest(
        {
          system: 'system prompt',
          user: 'user prompt',
        },
        model,
        true,
      ),
    ).toEqual({
      model: 'minimax-m2.5',
      max_tokens: 4096,
      stream: true,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user prompt' }],
    });
  });

  it('filters blank chat messages and keeps the non-empty user message', () => {
    const model = {
      id: 'deepseek',
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1',
      apiKey: 'secret-key',
      model: 'deepseek-chat',
      protocol: 'openai-chat' as const,
    };

    expect(
      createChatCompletionRequest(
        {
          system: '   ',
          user: '  hello world  ',
        },
        model,
      ),
    ).toMatchObject({
      messages: [{ role: 'user', content: 'hello world' }],
    });
  });

  it('throws before calling the provider when all openai-compatible messages are blank', () => {
    const model = {
      id: 'deepseek',
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1',
      apiKey: 'secret-key',
      model: 'deepseek-chat',
      protocol: 'openai-chat' as const,
    };

    expect(() =>
      createChatCompletionRequest(
        {
          system: '   ',
          user: '   ',
        },
        model,
      ),
    ).toThrow('AI 请求缺少有效消息内容');
  });

  it('prefers explicit model protocol over endpoint guessing', () => {
    const model = {
      id: 'anthropic-proxy',
      name: 'Anthropic Proxy',
      endpoint: 'https://example.com/proxy',
      apiKey: 'secret-key',
      model: 'claude-sonnet',
      protocol: 'anthropic-messages' as const,
    };

    expect(createAiApiHeaders(model)).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'secret-key',
    });

    expect(
      createAiApiRequest(
        {
          system: 'system prompt',
          user: 'user prompt',
        },
        model,
      ),
    ).toEqual({
      model: 'claude-sonnet',
      max_tokens: 4096,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user prompt' }],
    });

    expect(resolveAiApiUrlForModel(model)).toBe('https://example.com/proxy');
  });

  it('builds openai-compatible URL from protocol even when endpoint looks anthropic-like', () => {
    const model = {
      id: 'deepseek',
      name: 'DeepSeek',
      endpoint: 'https://opencode.ai/zen/go/v1/messages',
      apiKey: 'secret-key',
      model: 'deepseek-v4-flash',
      protocol: 'openai-chat' as const,
    };

    expect(resolveAiApiUrlForModel(model)).toBe(
      'https://opencode.ai/zen/go/v1/chat/completions',
    );
  });

  it('extracts anthropic stream deltas and usage', () => {
    expect(
      extractStreamText(
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '连接成功' },
        },
        '',
      ),
    ).toBe('连接成功');

    expect(
      extractUsage({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 12,
            output_tokens: 0,
          },
        },
      }),
    ).toEqual({
      prompt_tokens: 12,
      completion_tokens: 0,
      total_tokens: 12,
    });
  });

  it('combines caller abort signals with the summary timeout', () => {
    const controller = new AbortController();
    const combined = createSummaryRequestSignal(controller.signal, 1000);

    expect(combined).not.toBe(controller.signal);
    expect(combined.aborted).toBe(false);

    controller.abort();

    expect(combined.aborted).toBe(true);
  });
});
