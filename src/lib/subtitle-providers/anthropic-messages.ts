import fs from 'fs';
import type { AiSummaryModelConfig } from '@/types';
import { acquireSharedAiBudget } from '../shared-ai-budget';
import type {
  MultimodalTranscriber,
  TranscribeAudioInput,
  TranscribeResult,
  TranscribeUsage,
} from './types';

const DEFAULT_MAX_OUTPUT_TOKENS = 10240;

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  const content = Array.isArray(value.content) ? value.content : [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) parts.push(text);
  }
  return parts.join('\n').trim();
}

export const anthropicMessagesTranscriber: MultimodalTranscriber = {
  protocol: 'anthropic-messages',
  maxAudioChunkSeconds: 5 * 60,

  async transcribeAudio(
    model: AiSummaryModelConfig,
    input: TranscribeAudioInput,
  ): Promise<TranscribeResult> {
    if (!model.apiKey) {
      throw new Error(
        '未配置 AI API Key，无法执行 Anthropic 兼容字幕 fallback',
      );
    }
    const data = fs.readFileSync(input.audioPath).toString('base64');
    const prompt = input.responseSchema
      ? [
          input.prompt,
          '',
          'Output must be valid JSON matching this JSON Schema:',
          JSON.stringify(input.responseSchema),
        ].join('\n')
      : input.prompt;

    const budgetLease = await acquireSharedAiBudget({
      priority: input.priority,
      estimatedTokens: input.estimatedTokens,
      label: input.label,
    });

    let totalTokens: number | undefined;
    try {
      const requestStartTime = Date.now();
      const res = await fetch(model.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': model.apiKey,
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(input.systemPrompt?.trim()
            ? { system: input.systemPrompt.trim() }
            : {}),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'audio',
                  source: {
                    type: 'base64',
                    media_type: input.mediaType,
                    data,
                  },
                },
              ],
            },
          ],
        }),
        signal: input.signal,
      });
      const ttftSeconds = (Date.now() - requestStartTime) / 1000;
      const bodyText = await res.text();
      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = null;
      }
      if (!res.ok) {
        const snippet = bodyText.slice(0, 400).replace(/\s+/g, ' ').trim();
        throw new Error(
          `anthropic-messages subtitle failed: HTTP ${res.status} ${snippet}`,
        );
      }

      const usageRaw =
        payload && typeof payload === 'object'
          ? ((payload as Record<string, unknown>).usage as
              | Record<string, unknown>
              | undefined)
          : undefined;
      const inputTokens = Number(usageRaw?.input_tokens) || 0;
      const outputTokens = Number(usageRaw?.output_tokens) || 0;
      totalTokens =
        inputTokens + outputTokens > 0 ? inputTokens + outputTokens : undefined;

      const text = extractAnthropicText(payload);
      if (!text) {
        throw new Error('anthropic-messages subtitle returned empty content');
      }
      budgetLease.release(totalTokens);
      const usage: TranscribeUsage = { totalTokens };
      return { text, usage, ttftSeconds };
    } catch (error) {
      budgetLease.release(totalTokens);
      throw error;
    }
  },
};
