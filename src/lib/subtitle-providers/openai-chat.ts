import fs from 'fs';
import path from 'path';
import type { AiSummaryModelConfig } from '@/types';
import { acquireSharedAiBudget } from '../shared-ai-budget';
import type {
  MultimodalTranscriber,
  TranscribeAudioInput,
  TranscribeResult,
  TranscribeUsage,
} from './types';

const DEFAULT_MAX_OUTPUT_TOKENS = 10240;

function audioFormatFromPath(audioPath: string): string {
  const ext = path.extname(audioPath).toLowerCase().replace('.', '');
  if (ext === 'mp3' || ext === 'mpeg') return 'mp3';
  if (ext === 'wav') return 'wav';
  if (ext === 'm4a' || ext === 'mp4') return 'm4a';
  return 'mp3';
}

function extractOpenAiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const parts: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string' && text.trim()) parts.push(text);
      }
    }
  }
  return parts.join('\n').trim();
}

export const openAiChatTranscriber: MultimodalTranscriber = {
  protocol: 'openai-chat',
  maxAudioChunkSeconds: 5 * 60,

  async transcribeAudio(
    model: AiSummaryModelConfig,
    input: TranscribeAudioInput,
  ): Promise<TranscribeResult> {
    if (!model.apiKey) {
      throw new Error('未配置 AI API Key，无法执行 OpenAI 兼容字幕 fallback');
    }
    const data = fs.readFileSync(input.audioPath).toString('base64');
    const format = audioFormatFromPath(input.audioPath);
    const messages: Array<Record<string, unknown>> = [];
    if (input.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: input.systemPrompt.trim() });
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: input.prompt },
        {
          type: 'input_audio',
          input_audio: { data, format },
        },
      ],
    });

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
          Authorization: `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(input.responseSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'subtitle_corrections',
                    strict: true,
                    schema: input.responseSchema,
                  },
                },
              }
            : {}),
          messages,
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
          `openai-chat subtitle failed: HTTP ${res.status} ${snippet}`,
        );
      }

      const usageRaw =
        payload && typeof payload === 'object'
          ? ((payload as Record<string, unknown>).usage as
              | Record<string, unknown>
              | undefined)
          : undefined;
      totalTokens =
        Number(usageRaw?.total_tokens) ||
        Number(usageRaw?.totalTokens) ||
        undefined;

      const text = extractOpenAiText(payload);
      if (!text) {
        throw new Error('openai-chat subtitle returned empty content');
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
