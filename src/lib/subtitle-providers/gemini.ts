import fs from 'fs';
import path from 'path';
import type { AiSummaryModelConfig } from '@/types';
import { acquireSharedAiBudget } from '../shared-ai-budget';
import type {
  MultimodalTranscriber,
  TranscribeAudioInput,
  TranscribeRemoteVideoInput,
  TranscribeResult,
  TranscribeUsage,
} from './types';

const GEMINI_RETRY_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_DELAY_MS = 800;

function deriveGeminiApiBase(endpoint: string): {
  apiBase: string;
  uploadBase: string;
} {
  const parsed = new URL(endpoint);
  const versionMatch = parsed.pathname.match(/\/(v\d+(?:beta|alpha)?)/i);
  const version = versionMatch?.[1] || 'v1beta';
  return {
    apiBase: `${parsed.origin}/${version}`,
    uploadBase: `${parsed.origin}/upload/${version}`,
  };
}

function normalizeGeminiModelName(model: string): string {
  return model.replace(/^models\//, '').trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP (408|409|429|5\d\d)/i.test(
    error.message,
  );
}

function describeGeminiError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeMessage =
    cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message?: unknown }).message || '')
      : '';
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code || '')
      : '';
  return [error.message, causeCode, causeMessage].filter(Boolean).join(' / ');
}

async function withGeminiRetry<T>(
  stage: string,
  signal: AbortSignal | undefined,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GEMINI_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= GEMINI_RETRY_ATTEMPTS || !isRetryableGeminiError(error)) {
        break;
      }
      await sleep(GEMINI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
    }
  }

  throw new Error(
    `Gemini ${stage} failed after ${GEMINI_RETRY_ATTEMPTS} attempts: ${describeGeminiError(lastError)}`,
    lastError instanceof Error ? { cause: lastError } : undefined,
  );
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const parts: string[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const rawParts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(rawParts)) continue;
    for (const part of rawParts) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) {
        parts.push(text);
      }
    }
  }

  return parts.join('\n').trim();
}

async function uploadGeminiFile(
  filePath: string,
  mimeType: string,
  apiKey: string,
  uploadBase: string,
  signal?: AbortSignal,
): Promise<{ uri: string; mimeType: string }> {
  const data = fs.readFileSync(filePath);
  return withGeminiRetry('file upload', signal, async (attempt) => {
    const startRes = await fetch(
      `${uploadBase}/files?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(data.byteLength),
          'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({
          file: {
            display_name: path.basename(filePath),
          },
        }),
        signal,
      },
    );
    if (!startRes.ok) {
      if (attempt < GEMINI_RETRY_ATTEMPTS) {
        throw new Error(
          `Gemini file upload start failed: HTTP ${startRes.status}`,
        );
      }
      const body = await startRes.text().catch(() => '');
      throw new Error(
        `Gemini file upload start failed: HTTP ${startRes.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
      );
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('Gemini file upload did not return upload URL');
    }

    const finalizeRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(data.byteLength),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: data,
      signal,
    });
    if (!finalizeRes.ok) {
      if (attempt < GEMINI_RETRY_ATTEMPTS) {
        throw new Error(
          `Gemini file upload finalize failed: HTTP ${finalizeRes.status}`,
        );
      }
      const body = await finalizeRes.text().catch(() => '');
      throw new Error(
        `Gemini file upload finalize failed: HTTP ${finalizeRes.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
      );
    }

    const uploaded = (await finalizeRes.json()) as {
      file?: { uri?: string; mimeType?: string };
    };
    if (!uploaded.file?.uri) {
      throw new Error('Gemini file upload response missing file URI');
    }
    return {
      uri: uploaded.file.uri,
      mimeType: uploaded.file.mimeType || mimeType,
    };
  });
}

async function generateGeminiContent(
  parts: Array<Record<string, unknown>>,
  priority: 'manual-subtitle' | 'auto-subtitle',
  label: string,
  estimatedTokens: number,
  selectedModel: AiSummaryModelConfig,
  options: {
    systemPrompt?: string;
    responseSchema?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<TranscribeResult> {
  if (!selectedModel.apiKey) {
    throw new Error('未配置 AI API Key，无法执行 Gemini 字幕 fallback');
  }
  const { apiBase } = deriveGeminiApiBase(selectedModel.endpoint);
  const modelName = normalizeGeminiModelName(selectedModel.model);
  const budgetLease = await acquireSharedAiBudget({
    priority,
    estimatedTokens,
    label,
  });

  let totalTokens: number | undefined;
  try {
    let requestStartTime = Date.now();
    const res = await withGeminiRetry(
      'generateContent',
      options.signal,
      async () => {
        requestStartTime = Date.now();
        const response = await fetch(
          `${apiBase}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(selectedModel.apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(options.systemPrompt
                ? {
                    systemInstruction: {
                      parts: [{ text: options.systemPrompt }],
                    },
                  }
                : {}),
              ...(options.responseSchema
                ? {
                    generationConfig: {
                      responseMimeType: 'application/json',
                      responseSchema: options.responseSchema,
                    },
                  }
                : {}),
              contents: [
                {
                  role: 'user',
                  parts,
                },
              ],
            }),
            signal: options.signal,
          },
        );
        if (
          !response.ok &&
          ([408, 409, 429].includes(response.status) || response.status >= 500)
        ) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response;
      },
    );
    const ttftSeconds = (Date.now() - requestStartTime) / 1000;
    const payload = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      const message =
        typeof payload.error === 'object' &&
        payload.error &&
        typeof (payload.error as Record<string, unknown>).message === 'string'
          ? String((payload.error as Record<string, unknown>).message)
          : `HTTP ${res.status}`;
      throw new Error(`gemini subtitle failed: ${message}`);
    }

    const usageMetadata =
      payload.usageMetadata && typeof payload.usageMetadata === 'object'
        ? (payload.usageMetadata as Record<string, unknown>)
        : {};
    totalTokens =
      Number(usageMetadata.totalTokenCount) ||
      Number(usageMetadata.totalTokens) ||
      undefined;
    const text = extractGeminiText(payload);
    if (!text) {
      throw new Error('gemini subtitle returned empty content');
    }
    budgetLease.release(totalTokens);
    const usage: TranscribeUsage = { totalTokens };
    return { text, usage, ttftSeconds };
  } catch (error) {
    budgetLease.release(totalTokens);
    throw error;
  }
}

export const geminiTranscriber: MultimodalTranscriber = {
  protocol: 'gemini',
  maxAudioChunkSeconds: 15 * 60,

  async transcribeAudio(
    model: AiSummaryModelConfig,
    input: TranscribeAudioInput,
  ): Promise<TranscribeResult> {
    const { uploadBase } = deriveGeminiApiBase(model.endpoint);
    const uploaded = await uploadGeminiFile(
      input.audioPath,
      input.mediaType,
      model.apiKey,
      uploadBase,
      input.signal,
    );
    return generateGeminiContent(
      [
        {
          file_data: {
            file_uri: uploaded.uri,
            mime_type: uploaded.mimeType,
          },
        },
        { text: input.prompt },
      ],
      input.priority,
      input.label,
      input.estimatedTokens,
      model,
      {
        systemPrompt: input.systemPrompt,
        responseSchema: input.responseSchema,
        signal: input.signal,
      },
    );
  },

  async transcribeRemoteVideo(
    model: AiSummaryModelConfig,
    input: TranscribeRemoteVideoInput,
  ): Promise<TranscribeResult> {
    return generateGeminiContent(
      [
        {
          file_data: {
            file_uri: input.url,
            mime_type: input.mediaType,
          },
        },
        { text: input.prompt },
      ],
      input.priority,
      input.label,
      input.estimatedTokens,
      model,
      {},
    );
  },
};
