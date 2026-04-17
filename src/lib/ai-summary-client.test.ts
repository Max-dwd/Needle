import { describe, expect, it } from 'vitest';
import {
  createAiApiHeaders,
  createAiApiRequest,
  createSummaryRequestSignal,
  detectAiApiProtocol,
  extractStreamText,
  extractUsage,
  resolveAiApiUrl,
} from './ai-summary-client';

describe('ai-summary-client provider compatibility', () => {
  it('keeps anthropic messages endpoints unchanged', () => {
    expect(
      detectAiApiProtocol('https://opencode.ai/zen/go/v1/messages'),
    ).toBe('anthropic-messages');
    expect(
      resolveAiApiUrl('https://opencode.ai/zen/go/v1/messages'),
    ).toBe('https://opencode.ai/zen/go/v1/messages');
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
