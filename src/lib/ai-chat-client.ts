import { formatSecondsLabel } from './format';
import { DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE } from './ai-summary-settings';
import { acquireSharedAiBudget, estimateTextTokens } from './shared-ai-budget';
import {
  createAiApiHeaders,
  createAiApiRequest,
  extractUsage,
  extractSseEventData,
  extractStreamText,
  parseSseBlocks,
  resolveAiApiUrl,
  type SubtitleSegment,
  type ChatCompletionPromptInput,
} from './ai-summary-client';
import type { AiSummaryModelConfig, ChatMode } from '@/types';

const SUBTITLE_CHAR_LIMIT = 60000;

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface StreamPayload {
  choices?: Array<{
    delta?: { content?: string; text?: string };
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface ChatVideoContext {
  title: string;
  channel: string;
  platform: string;
  url: string;
  generatedAt: string;
}

function buildObsidianSystemPrompt(template?: string): string {
  return template?.trim() || DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE;
}

function buildRoastSystemPrompt(template?: string): string {
  return (
    template?.trim() ||
    [
      '你是一个犀利的视频评论家。用户看了一个视频片段，有一个吐槽点。',
      '请根据视频内容扩写这个吐槽，打造一段适合社交媒体分享的犀利评论。',
      '',
      '输出格式（严格遵循）：',
      '## 一句话总结',
      '（一句话概括视频内容 + 槽点方向）',
      '',
      '## 关键片段',
      '- 「[mm:ss](视频URL?t=秒数)」引用原文片段1',
      '- 「[mm:ss](视频URL?t=秒数)」引用原文片段2',
      '（选 2-3 个最能支撑吐槽点的片段）',
      '',
      '## 评论',
      '（扩写用户的吐槽点，2-4 句话，保持用户的角度，语气犀利但不恶毒，适度夸张）',
      '',
      '要求：',
      '- 引用必须来自提供的字幕片段，不要编造',
      '- 吐槽要有梗，适合截图分享',
    ].join('\n')
  );
}

function normalizeSegmentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildSubtitleExcerpt(segments: SubtitleSegment[]): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const line = `[${formatSecondsLabel(segment.start)}] ${normalizeSegmentText(segment.text)}`;
    totalChars += line.length + 1;

    if (totalChars > SUBTITLE_CHAR_LIMIT) {
      lines.push(
        `[字幕已截断，仅展示前 ${index} 段，共 ${segments.length} 段]`,
      );
      break;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

function toYamlDoubleQuoted(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

export function buildChatPrompt(
  mode: ChatMode,
  userPrompt: string,
  segments: SubtitleSegment[],
  videoContext: ChatVideoContext,
  templates?: { chatObsidian?: string; chatRoast?: string },
): ChatCompletionPromptInput {
  const system =
    mode === 'roast'
      ? buildRoastSystemPrompt(templates?.chatRoast)
      : buildObsidianSystemPrompt(templates?.chatObsidian);

  const subtitleBlock = buildSubtitleExcerpt(segments);

  const user = [
    `视频：${videoContext.title}`,
    `频道：${videoContext.channel}`,
    `平台：${videoContext.platform}`,
    `链接：${videoContext.url}`,
    `笔记生成时间：${videoContext.generatedAt}`,
    '',
    '--- 输出 YAML frontmatter（请原样作为笔记开头） ---',
    '---',
    `title: ${toYamlDoubleQuoted(videoContext.title)}`,
    `channel: ${toYamlDoubleQuoted(videoContext.channel)}`,
    `platform: ${toYamlDoubleQuoted(videoContext.platform)}`,
    `source_url: ${toYamlDoubleQuoted(videoContext.url)}`,
    `creat_at: ${toYamlDoubleQuoted(videoContext.generatedAt)}`,
    '---',
    '',
    '--- 选定的视频片段 ---',
    subtitleBlock || '（当前范围内没有可用字幕）',
    '',
    '--- 我的想法 ---',
    userPrompt.trim(),
  ].join('\n');

  return { system, user };
}

function extractProviderError(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as StreamPayload;
    return parsed.error?.message?.trim() || '';
  } catch {
    return '';
  }
}

function createForwardedAbortController(
  signal?: AbortSignal,
): AbortController {
  const controller = new AbortController();

  if (!signal) {
    return controller;
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }

  signal.addEventListener(
    'abort',
    () => {
      controller.abort(signal.reason);
    },
    { once: true },
  );

  return controller;
}

export function createChatStream(
  prompt: ChatCompletionPromptInput,
  model: AiSummaryModelConfig,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const upstreamAbort = createForwardedAbortController(signal);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let released = false;
      let lastUsage: StreamUsage | undefined;
      let lease: Awaited<ReturnType<typeof acquireSharedAiBudget>> | null = null;

      const releaseBudget = () => {
        if (released || !lease) return;
        lease.release(lastUsage?.total_tokens);
        released = true;
      };

      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      try {
        if (!model.apiKey) {
          throw new Error('未配置 AI API Key，请先到设置页填写后再使用问答功能');
        }
        if (!model.model) {
          throw new Error('未配置 AI 模型名称，请先到设置页填写后再使用问答功能');
        }

        const url = resolveAiApiUrl(model.endpoint);
        lease = await acquireSharedAiBudget({
          priority: 'manual-summary',
          estimatedTokens: estimateTextTokens(
            `${prompt.system}\n\n${prompt.user}`,
          ),
          label: `chat-stream:${model.id}`,
          modelId: model.id,
        }, signal);

        const response = await fetch(url, {
          method: 'POST',
          signal: upstreamAbort.signal,
          headers: createAiApiHeaders(model),
          body: JSON.stringify(createAiApiRequest(prompt, model, true)),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const detail =
            extractProviderError(text) || text.slice(0, 300) || `HTTP ${response.status}`;
          throw new Error(`调用 AI 接口失败: ${detail}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('AI 接口没有返回可读取的流');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseBlocks(buffer);
            buffer = parsed.remainder;

            for (const block of parsed.events) {
              const data = extractSseEventData(block);
              if (!data || data === '[DONE]') continue;

              const json = JSON.parse(data) as StreamPayload;
              const usage = extractUsage(json);
              if (usage) {
                lastUsage = usage;
              }

              const delta = extractStreamText(json, fullContent);
              if (!delta) continue;

              fullContent += delta;
              send({ delta, done: false });
            }
          }

          const flushed = decoder.decode();
          if (flushed) {
            buffer += flushed;
          }

          const finalParsed = parseSseBlocks(
            buffer.trim() ? `${buffer}\n\n` : buffer,
          );
          for (const block of finalParsed.events) {
            const data = extractSseEventData(block);
            if (!data || data === '[DONE]') continue;

            const json = JSON.parse(data) as StreamPayload;
            const usage = extractUsage(json);
            if (usage) {
              lastUsage = usage;
            }

            const delta = extractStreamText(json, fullContent);
            if (!delta) continue;

            fullContent += delta;
            send({ delta, done: false });
          }
        } finally {
          reader.releaseLock();
        }

        if (!fullContent.trim()) {
          throw new Error('AI 接口返回空内容');
        }

        releaseBudget();
        send({ done: true, usage: lastUsage });
      } catch (error) {
        releaseBudget();
        if (!upstreamAbort.signal.aborted) {
          const message =
            error instanceof Error ? error.message : '问答生成失败';
          send({ error: message, done: true });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* stream already closed */
        }
      }
    },
    cancel() {
      upstreamAbort.abort();
    },
  });
}
