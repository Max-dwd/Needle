import fs from 'fs';
import path from 'path';
import { getDb, type Video } from './db';
import { resolveAiSummaryGenerationSettings } from './ai-summary-settings';
import {
  acquireSharedAiBudget,
  estimateTextTokens,
} from './shared-ai-budget';
import { buildVideoUrl } from './url-utils';
import { appEvents } from './events';
import type { AiSummaryModelConfig } from '@/types';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const SUBTITLE_ROOT =
  process.env.SUBTITLE_ROOT || path.join(DATA_ROOT, 'subtitles');
const SUMMARY_ROOT =
  process.env.SUMMARY_ROOT || path.join(DATA_ROOT, 'summaries');

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface SubtitlePayload {
  video_id: string;
  platform: string;
  language?: string;
  format?: string;
  segments?: SubtitleSegment[];
  text?: string;
}

interface SummaryVideoContext {
  videoId: string;
  platform: Video['platform'];
  videoTitle: string;
  channelId: string | null;
  channelName: string;
  duration: string | null;
  sourceUrl: string;
}

interface SummaryPromptVariables {
  video_title: string;
  channel_name: string;
  platform: string;
  platform_label: string;
  source_url: string;
  video_id: string;
  video_duration: string;
  subtitle: string;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
    delta?: {
      content?: string;
    };
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

interface AnthropicCompatibleResponse {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  delta?: {
    text?: string;
    type?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    type?: string;
    message?: string;
  };
}

type AiProviderResponse = OpenAiCompatibleResponse | AnthropicCompatibleResponse;
export type AiApiProtocol = 'openai-chat-completions' | 'anthropic-messages';

export interface ChatCompletionPromptInput {
  system: string;
  user: string;
}

interface GenerateSummaryOptions {
  modelIdOverride?: string | null;
  abortSignal?: AbortSignal;
  triggerSource?: 'manual' | 'auto';
  intentName?: string | null;
}

interface GeneratedSummaryMetadata {
  model: {
    id: string;
    name: string;
    endpoint: string;
    model: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  generation_time?: number;
  total_time_seconds?: number;
  ttft_seconds?: number;
  output_tps?: number;
  trigger_source?: 'manual' | 'auto';
  model_source?: 'default' | 'auto-default' | 'intent' | 'override' | 'fallback';
}

interface ResolvedSummaryGenerationContext {
  context: SummaryVideoContext;
  subtitle: SubtitlePayload | null;
  prompt: string;
  selectedModel: AiSummaryModelConfig;
  triggerSource: 'manual' | 'auto';
  modelSource: 'default' | 'auto-default' | 'intent' | 'override' | 'fallback';
}

const SUBTITLE_CHAR_LIMIT = 60000;
const STREAM_PROGRESS_INTERVAL_CHARS = 1200;
const SUMMARY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function createSummaryRequestSignal(
  abortSignal?: AbortSignal,
  timeoutMs = SUMMARY_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function readSubtitlePayload(
  platform: string,
  videoId: string,
): SubtitlePayload | null {
  const filePath = path.join(SUBTITLE_ROOT, platform, `${videoId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SubtitlePayload;
}

function getPlatformLabel(platform: Video['platform']): string {
  return platform === 'youtube' ? 'YouTube' : 'Bilibili';
}

function readSummaryVideoContext(
  videoId: string,
  platform: Video['platform'],
): SummaryVideoContext {
  const row = getDb()
    .prepare(
      `
      SELECT v.video_id, v.title, v.duration, c.name AS channel_name, c.channel_id AS source_channel_id
      FROM videos v
      LEFT JOIN channels c ON c.id = v.channel_id
      WHERE v.video_id = ? AND v.platform = ?
      LIMIT 1
    `,
    )
    .get(videoId, platform) as
    | {
        video_id?: string;
        title?: string | null;
        duration?: string | null;
        channel_name?: string | null;
        source_channel_id?: string | null;
      }
    | undefined;

  return {
    videoId,
    platform,
    videoTitle: row?.title?.trim() || videoId,
    channelId: row?.source_channel_id?.trim() || null,
    channelName: row?.channel_name?.trim() || '未知频道',
    duration: row?.duration?.trim() || null,
    sourceUrl: buildVideoUrl(platform, videoId),
  };
}

function buildSubtitleBlock(payload: SubtitlePayload | null): string {
  if (!payload) return '';

  const segments = payload.segments || [];
  const transcriptLines: string[] = [];
  let transcriptBlock = '';

  if (segments.length > 0) {
    let totalChars = 0;
    let truncatedAt = -1;
    for (let i = 0; i < segments.length; i++) {
      const line = `- ${formatSeconds(segments[i].start)} ${segments[i].text}`;
      totalChars += line.length + 1;
      if (totalChars > SUBTITLE_CHAR_LIMIT) {
        truncatedAt = i;
        break;
      }
      transcriptLines.push(line);
    }
    if (truncatedAt >= 0) {
      transcriptLines.push(
        `- [字幕已截断，仅展示前 ${truncatedAt} 段，共 ${segments.length} 段]`,
      );
    }
    transcriptBlock = transcriptLines.join('\n');
  } else if (payload.text) {
    transcriptBlock =
      payload.text.length > SUBTITLE_CHAR_LIMIT
        ? `${payload.text.slice(0, SUBTITLE_CHAR_LIMIT)}\n[字幕已截断]`
        : payload.text;
  }

  return transcriptBlock;
}

function renderPromptTemplate(
  template: string,
  variables: SummaryPromptVariables,
): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    const value = variables[key as keyof SummaryPromptVariables];
    return typeof value === 'string' ? value : match;
  });
}

function buildSummaryPrompt(
  context: SummaryVideoContext,
  subtitlePayload: SubtitlePayload | null,
  template: string,
): string {
  const subtitleBlock = buildSubtitleBlock(subtitlePayload);
  const normalizedTemplate =
    template.trim() ||
    '请根据以下视频字幕生成一份中文总结。\n\n## 字幕内容\n{{subtitle}}';

  return renderPromptTemplate(normalizedTemplate, {
    video_title: context.videoTitle,
    channel_name: context.channelName,
    platform: context.platform,
    platform_label: getPlatformLabel(context.platform),
    source_url: context.sourceUrl,
    video_id: context.videoId,
    video_duration: context.duration || '',
    subtitle: subtitleBlock || '（暂无可用字幕内容）',
  });
}

function parseStoredDurationToSeconds(duration: string | null | undefined): number {
  if (!duration) return 0;
  const normalized = duration.trim();
  if (!normalized) return 0;

  if (/^\d+$/.test(normalized)) {
    return Math.max(0, Math.floor(Number(normalized)));
  }

  const parts = normalized.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return 0;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Math.floor(minutes * 60 + seconds);
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Math.floor(hours * 3600 + minutes * 60 + seconds);
  }

  return 0;
}

function getSubtitleMaxSeconds(payload: SubtitlePayload | null): number {
  const segments = payload?.segments || [];
  if (segments.length === 0) return 0;
  return segments.reduce((max, segment) => {
    if (!Number.isFinite(segment.start) || segment.start < 0) {
      return max;
    }
    return Math.max(max, Math.floor(segment.start));
  }, 0);
}

function getSummaryMaxSeconds(
  context: SummaryVideoContext,
  subtitlePayload: SubtitlePayload | null,
): number {
  return Math.max(
    parseStoredDurationToSeconds(context.duration),
    getSubtitleMaxSeconds(subtitlePayload),
  );
}

function getTimestampRemovalSpacer(
  markdown: string,
  start: number,
  length: number,
): string {
  const prev = markdown[start - 1] || '';
  const next = markdown[start + length] || '';
  const prevBoundaryChars = '([{"\'`<，。！？；：、,.!?;:)]>}';
  const nextBoundaryChars = ')]}="\'`>,，。！？；：、,.!?;:';
  const prevNeedsSpace =
    prev !== '' && !/\s/.test(prev) && !prevBoundaryChars.includes(prev);
  const nextNeedsSpace =
    next !== '' && !/\s/.test(next) && !nextBoundaryChars.includes(next);
  return prevNeedsSpace && nextNeedsSpace ? ' ' : '';
}

export function sanitizeTimestamps(
  markdown: string,
  maxSeconds: number,
): string {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    return markdown;
  }

  return markdown.replace(
    /\[(\d{2}:\d{2}(?::\d{2})?)\]\(([^)\s]+)\)/g,
    (match, _label, href, offset: number, source: string) => {
      let seekSeconds: number | null = null;
      try {
        const url = new URL(href);
        const t = url.searchParams.get('t');
        if (t && /^\d+s?$/.test(t)) {
          seekSeconds = Number(t.replace(/s$/i, ''));
        }
      } catch {
        return match;
      }

      if (seekSeconds === null || !Number.isFinite(seekSeconds)) {
        return match;
      }

      if (seekSeconds <= maxSeconds) {
        return match;
      }

      return getTimestampRemovalSpacer(source, offset, match.length);
    },
  );
}

function writeSummaryFile(
  platform: string,
  videoId: string,
  markdown: string,
  metadata?: GeneratedSummaryMetadata,
): string {
  const dir = path.join(SUMMARY_ROOT, platform);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${videoId}.md`);

  const sourceUrl = buildVideoUrl(platform as Video['platform'], videoId);
  const content = [
    '---',
    `video_id: ${videoId}`,
    `platform: ${platform}`,
    `source_url: ${sourceUrl}`,
    'generated_by: ai-summary-client',
    `generated_at: ${new Date().toISOString()}`,

    metadata?.model ? `generated_model_id: ${metadata.model.id}` : '',
    metadata?.model ? `generated_model_name: ${metadata.model.name}` : '',
    metadata?.model ? `generated_model: ${metadata.model.model}` : '',
    metadata?.model ? `generated_endpoint: ${metadata.model.endpoint}` : '',
    typeof metadata?.usage?.prompt_tokens === 'number'
      ? `prompt_tokens: ${metadata.usage.prompt_tokens}`
      : '',
    typeof metadata?.usage?.completion_tokens === 'number'
      ? `completion_tokens: ${metadata.usage.completion_tokens}`
      : '',
    typeof metadata?.usage?.total_tokens === 'number'
      ? `total_tokens: ${metadata.usage.total_tokens}`
      : '',
    typeof metadata?.generation_time === 'number'
      ? `generation_time: ${metadata.generation_time.toFixed(2)}`
      : '',
    typeof metadata?.total_time_seconds === 'number'
      ? `total_time_seconds: ${metadata.total_time_seconds.toFixed(2)}`
      : '',
    typeof metadata?.ttft_seconds === 'number'
      ? `ttft_seconds: ${metadata.ttft_seconds.toFixed(2)}`
      : '',
    typeof metadata?.output_tps === 'number'
      ? `output_tps: ${metadata.output_tps.toFixed(2)}`
      : '',
    metadata?.trigger_source ? `trigger_source: ${metadata.trigger_source}` : '',
    metadata?.model_source ? `model_source: ${metadata.model_source}` : '',

    '---',

    '',
    markdown,
  ]
    .filter(Boolean)
    .join('\n');

  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function resolveChatCompletionsUrl(rawEndpoint: string): string {
  const endpoint = rawEndpoint.trim();
  if (!endpoint) throw new Error('AI API Endpoint 未配置');

  const parsed = new URL(endpoint);
  if (parsed.pathname.endsWith('/chat/completions')) {
    return parsed.toString();
  }

  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`;
  return parsed.toString();
}

export function detectAiApiProtocol(rawEndpoint: string): AiApiProtocol {
  const endpoint = rawEndpoint.trim();
  if (!endpoint) throw new Error('AI API Endpoint 未配置');

  const parsed = new URL(endpoint);
  const pathname = parsed.pathname.replace(/\/+$/, '');

  if (pathname.endsWith('/messages')) {
    return 'anthropic-messages';
  }

  return 'openai-chat-completions';
}

export function resolveAiApiUrl(rawEndpoint: string): string {
  if (detectAiApiProtocol(rawEndpoint) === 'anthropic-messages') {
    return rawEndpoint.trim();
  }
  return resolveChatCompletionsUrl(rawEndpoint);
}

export function createAiApiHeaders(
  model: AiSummaryModelConfig,
): Record<string, string> {
  if (detectAiApiProtocol(model.endpoint) === 'anthropic-messages') {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': model.apiKey,
    };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${model.apiKey}`,
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content.map((item) => extractTextFromContent(item)).join('');
  }

  if (!content || typeof content !== 'object') {
    return '';
  }

  const value = content as Record<string, unknown>;

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (Array.isArray(value.parts)) {
    return value.parts.map((part) => extractTextFromContent(part)).join('');
  }

  if (Array.isArray(value.content)) {
    return value.content.map((part) => extractTextFromContent(part)).join('');
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  return '';
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  const error = value.error;
  if (typeof error === 'string') return error;
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return ((error as Record<string, unknown>).message as string).trim();
  }
  if (typeof value.message === 'string') return value.message.trim();
  return '';
}

function extractProviderText(
  payload: unknown,
  options?: { preferDelta?: boolean; trim?: boolean },
): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice =
    choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>)
      : null;

  const deltaCandidates = [
    firstChoice?.delta && typeof firstChoice.delta === 'object'
      ? (firstChoice.delta as Record<string, unknown>).content
      : undefined,
    firstChoice?.delta && typeof firstChoice.delta === 'object'
      ? (firstChoice.delta as Record<string, unknown>).text
      : undefined,
    value.delta && typeof value.delta === 'object'
      ? (value.delta as Record<string, unknown>).content
      : undefined,
    value.delta && typeof value.delta === 'object'
      ? (value.delta as Record<string, unknown>).text
      : undefined,
  ];

  const fullCandidates = [
    firstChoice?.message && typeof firstChoice.message === 'object'
      ? (firstChoice.message as Record<string, unknown>).content
      : undefined,
    firstChoice?.text,
    value.message && typeof value.message === 'object'
      ? (value.message as Record<string, unknown>).content
      : undefined,
    value.content,
    value.response && typeof value.response === 'object'
      ? (value.response as Record<string, unknown>).output_text
      : undefined,
    Array.isArray(value.output)
      ? value.output
          .map((item) =>
            item && typeof item === 'object'
              ? extractTextFromContent(
                  (item as Record<string, unknown>).content,
                )
              : '',
          )
          .join('')
      : undefined,
    Array.isArray(value.candidates)
      ? value.candidates
          .map((candidate) => {
            if (!candidate || typeof candidate !== 'object') return '';
            const candidateRecord = candidate as Record<string, unknown>;
            const candidateContent = candidateRecord.content;
            if (candidateContent && typeof candidateContent === 'object') {
              return extractTextFromContent(
                (candidateContent as Record<string, unknown>).parts ??
                  candidateContent,
              );
            }
            return '';
          })
          .join('')
      : undefined,
  ];

  const orderedCandidates = options?.preferDelta
    ? [...deltaCandidates, ...fullCandidates]
    : [...fullCandidates, ...deltaCandidates];

  const text =
    orderedCandidates
      .map((candidate) => extractTextFromContent(candidate))
      .find((candidate) => Boolean(candidate)) || '';

  return options?.trim === false ? text : text.trim();
}

export function extractStreamText(
  payload: unknown,
  fullContent: string,
): string {
  const error = extractErrorMessage(payload);
  if (error) {
    throw new Error(error);
  }

  const deltaText = extractProviderText(payload, {
    preferDelta: true,
    trim: false,
  });
  if (deltaText) return deltaText;

  const fullText = extractProviderText(payload, {
    preferDelta: false,
    trim: false,
  });
  if (!fullText) return '';
  if (!fullContent) return fullText;
  if (
    fullText.startsWith(fullContent) &&
    fullText.length > fullContent.length
  ) {
    return fullText.slice(fullContent.length);
  }

  return '';
}

export function parseSseBlocks(buffer: string): {
  events: string[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() || '';
  return { events: blocks, remainder };
}

export function extractSseEventData(block: string): string | null {
  const dataLines = block
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

function parseJsonChunk(data: string): unknown | null {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function normalizeUsage(
  usage?:
    | OpenAiCompatibleResponse['usage']
    | AnthropicCompatibleResponse['usage']
    | NonNullable<AnthropicCompatibleResponse['message']>['usage'],
): GeneratedSummaryMetadata['usage'] | undefined {
  if (!usage) return undefined;
  const value = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  return {
    prompt_tokens: value.prompt_tokens ?? value.input_tokens,
    completion_tokens: value.completion_tokens ?? value.output_tokens,
    total_tokens:
      value.total_tokens ??
      ((value.prompt_tokens ?? value.input_tokens ?? 0) +
        (value.completion_tokens ?? value.output_tokens ?? 0)),
  };
}

export function extractUsage(
  payload: unknown,
): GeneratedSummaryMetadata['usage'] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;

  if (value.usage && typeof value.usage === 'object') {
    return normalizeUsage(
      value.usage as
        | OpenAiCompatibleResponse['usage']
        | AnthropicCompatibleResponse['usage'],
    );
  }

  if (
    value.message &&
    typeof value.message === 'object' &&
    (value.message as Record<string, unknown>).usage &&
    typeof (value.message as Record<string, unknown>).usage === 'object'
  ) {
    return normalizeUsage(
      (value.message as Record<string, unknown>).usage as NonNullable<
        AnthropicCompatibleResponse['message']
      >['usage'],
    );
  }

  return undefined;
}

function calculateOutputTps(
  usage: GeneratedSummaryMetadata['usage'] | undefined,
  totalTimeSeconds: number,
  ttftSeconds?: number,
): number | undefined {
  if (
    typeof usage?.completion_tokens !== 'number' ||
    usage.completion_tokens <= 0
  ) {
    return undefined;
  }

  const streamingWindow = totalTimeSeconds - (ttftSeconds ?? 0);
  if (streamingWindow <= 0) {
    return undefined;
  }

  return usage.completion_tokens / streamingWindow;
}

function emitSummaryProgress(
  videoId: string,
  payload: {
    stage: 'preparing_prompt' | 'calling_api' | 'streaming' | 'writing_file';
    message: string;
    receivedChars?: number;
    modelId?: string;
    modelName?: string;
    channelId?: string | null;
  },
) {
  appEvents.emit(
    'summary:progress',
    payload.receivedChars !== undefined
      ? {
          videoId,
          ...payload,
        }
      : {
          videoId,
          ...payload,
        },
  );
}

export function createChatCompletionRequest(
  prompt: string | ChatCompletionPromptInput,
  model: AiSummaryModelConfig,
  stream = false,
) {
  const normalizedPrompt =
    typeof prompt === 'string'
      ? {
          system:
            '你是一个严谨的中文视频内容总结助手。输出必须为中文 Markdown。',
          user: prompt,
        }
      : prompt;

  return {
    model: model.model,
    temperature: 0.3,
    ...(stream
      ? {
          stream: true,
          stream_options: { include_usage: true },
        }
      : {}),
    messages: [
      {
        role: 'system',
        content: normalizedPrompt.system,
      },
      {
        role: 'user',
        content: normalizedPrompt.user,
      },
    ],
  };
}

export function createAiApiRequest(
  prompt: string | ChatCompletionPromptInput,
  model: AiSummaryModelConfig,
  stream = false,
) {
  const normalizedPrompt =
    typeof prompt === 'string'
      ? {
          system:
            '你是一个严谨的中文视频内容总结助手。输出必须为中文 Markdown。',
          user: prompt,
        }
      : prompt;

  if (detectAiApiProtocol(model.endpoint) === 'anthropic-messages') {
    return {
      model: model.model,
      max_tokens: 4096,
      ...(stream ? { stream: true } : {}),
      system: normalizedPrompt.system,
      messages: [
        {
          role: 'user',
          content: normalizedPrompt.user,
        },
      ],
    };
  }

  return createChatCompletionRequest(normalizedPrompt, model, stream);
}

function resolveSummaryGenerationContext(
  videoId: string,
  platform: Video['platform'],
  options?: GenerateSummaryOptions,
): ResolvedSummaryGenerationContext {
  const context = readSummaryVideoContext(videoId, platform);
  const subtitle = readSubtitlePayload(platform, videoId);
  if (!subtitle) {
    throw new Error(`No subtitle data found for ${platform}/${videoId}`);
  }

  const resolvedSettings = resolveAiSummaryGenerationSettings({
    modelIdOverride: options?.modelIdOverride,
    triggerSource: options?.triggerSource ?? 'manual',
    intentName: options?.intentName,
  });

  emitSummaryProgress(videoId, {
    stage: 'preparing_prompt',
    message: context.channelId
      ? '正在按频道解析 Prompt 与模型...'
      : '正在解析 Prompt 与模型...',
    modelId: resolvedSettings.selectedModel.id,
    modelName: resolvedSettings.selectedModel.name,
    channelId: context.channelId,
  });

  const prompt = buildSummaryPrompt(
    context,
    subtitle,
    resolvedSettings.promptTemplate,
  );

  return {
    context,
    subtitle,
    prompt,
    selectedModel: resolvedSettings.selectedModel,
    triggerSource: resolvedSettings.triggerSource,
    modelSource: resolvedSettings.modelSource,
  };
}
async function generateViaOpenAiCompatibleApi(
  prompt: string,
  model: AiSummaryModelConfig,
  options?: {
    abortSignal?: AbortSignal;
    triggerSource?: 'manual' | 'auto';
    onQueued?: (details: { queuePosition: number; waitMs: number }) => void;
  },
): Promise<{ content: string; usage?: OpenAiCompatibleResponse['usage']; ttftSeconds?: number }> {
  if (!model.apiKey) {
    throw new Error('未配置 AI API Key，请先到设置页填写后再生成总结');
  }

  if (!model.model) {
    throw new Error('未配置 AI 模型名称，请先到设置页填写后再生成总结');
  }

  const url = resolveAiApiUrl(model.endpoint);
  const budgetLease = await acquireSharedAiBudget({
    priority:
      options?.triggerSource === 'auto' ? 'auto-summary' : 'manual-summary',
    estimatedTokens: estimateTextTokens(prompt),
    label: `summary:${model.id}`,
    modelId: model.id,
    onQueued: options?.onQueued
      ? ({ queuePosition, waitMs }) => {
          options.onQueued?.({ queuePosition, waitMs });
        }
      : undefined,
  }, options?.abortSignal);

  let parsed: AiProviderResponse | null = null;
  try {
    const requestStartTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      signal: createSummaryRequestSignal(options?.abortSignal),
      headers: createAiApiHeaders(model),
      body: JSON.stringify(createAiApiRequest(prompt, model)),
    });

    const ttftSeconds = (Date.now() - requestStartTime) / 1000;
    const raw = await response.text();
    try {
      parsed = JSON.parse(raw) as AiProviderResponse;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const apiError =
        parsed?.error?.message?.trim() || extractErrorMessage(parsed);
      const detail = apiError || raw.slice(0, 300) || `HTTP ${response.status}`;
      throw new Error(`调用 AI 接口失败: ${detail}`);
    }

    if (!parsed) {
      throw new Error('AI 接口返回了无效 JSON');
    }

    const content = extractProviderText(parsed, {
      preferDelta: false,
      trim: true,
    });
    if (!content) {
      throw new Error('AI 接口返回空内容');
    }

    const usage = extractUsage(parsed);

    budgetLease.release(usage?.total_tokens);
    return {
      content,
      usage,
      ttftSeconds,
    };
  } catch (error) {
    budgetLease.release(extractUsage(parsed)?.total_tokens);
    throw error;
  }
}

/**
 * Generates a summary through the configured API provider and writes the markdown file to disk.
 *
 * @param videoId - Platform video identifier to summarize.
 * @param platform - Source platform for the video.
 * @param options - Optional model selection and abort configuration.
 * @returns Generated markdown content together with output metadata.
 */
export async function generateSummaryViaApi(
  videoId: string,
  platform: Video['platform'],
  options?: GenerateSummaryOptions,
): Promise<{
  markdown: string;
  outputPath: string;
  model: { id: string; name: string; endpoint: string; model: string };
  usage?: OpenAiCompatibleResponse['usage'];
  generationTime?: number;
}> {
  const { prompt, selectedModel, context, subtitle, triggerSource, modelSource } =
    resolveSummaryGenerationContext(videoId, platform, options);

  emitSummaryProgress(videoId, {
    stage: 'calling_api',
    message: `正在调用 ${selectedModel.name}...`,
    modelId: selectedModel.id,
    modelName: selectedModel.name,
    channelId: context.channelId,
  });
  const startTime = Date.now();
  const { content: markdown, usage, ttftSeconds } = await generateViaOpenAiCompatibleApi(
    prompt,
    selectedModel,
    {
      abortSignal: options?.abortSignal,
      triggerSource,
      onQueued: ({ queuePosition, waitMs }) => {
        emitSummaryProgress(videoId, {
          stage: 'calling_api',
          message: `共享预算排队中，前方 ${queuePosition} 个任务，预计 ${Math.ceil(waitMs / 1000)} 秒`,
          modelId: selectedModel.id,
          modelName: selectedModel.name,
          channelId: context.channelId,
        });
      },
    },
  );
  const sanitizedMarkdown = sanitizeTimestamps(
    markdown,
    getSummaryMaxSeconds(context, subtitle),
  );
  const totalTimeSeconds = (Date.now() - startTime) / 1000;
  const outputTps = calculateOutputTps(usage, totalTimeSeconds);

  emitSummaryProgress(videoId, {
    stage: 'writing_file',
    message: '正在写入总结文件...',
    modelId: selectedModel.id,
    modelName: selectedModel.name,
    channelId: context.channelId,
  });
  const outputPath = writeSummaryFile(platform, videoId, sanitizedMarkdown, {
    model: selectedModel,
    usage,
    generation_time: totalTimeSeconds,
    total_time_seconds: totalTimeSeconds,
    ttft_seconds: ttftSeconds,
    output_tps: outputTps,
    trigger_source: triggerSource,
    model_source: modelSource,
  });

  return {
    markdown: sanitizedMarkdown,
    outputPath,
    model: selectedModel,
    usage,
    generationTime: totalTimeSeconds,
  };
}

/**
 * Streams summary tokens from the configured API provider and saves the final markdown output.
 *
 * @param videoId - Platform video identifier to summarize.
 * @param platform - Source platform for the video.
 * @param options - Optional model selection and abort configuration.
 * @returns An async generator that yields streamed text chunks and finishes with the full summary.
 */
export async function* generateSummaryStream(
  videoId: string,
  platform: Video['platform'],
  options?: GenerateSummaryOptions,
): AsyncGenerator<string, string, undefined> {
  const {
    prompt,
    selectedModel,
    context,
    subtitle,
    triggerSource,
    modelSource,
  } =
    resolveSummaryGenerationContext(videoId, platform, options);

  if (!selectedModel.apiKey) {
    throw new Error('未配置 AI API Key，请先到设置页填写后再生成总结');
  }

  const url = resolveAiApiUrl(selectedModel.endpoint);
  emitSummaryProgress(videoId, {
    stage: 'calling_api',
    message: `正在调用 ${selectedModel.name}...`,
    modelId: selectedModel.id,
    modelName: selectedModel.name,
    channelId: context.channelId,
  });

  const requestStartedAt = Date.now();
  const budgetLease = await acquireSharedAiBudget({
    priority: triggerSource === 'auto' ? 'auto-summary' : 'manual-summary',
    estimatedTokens: estimateTextTokens(prompt),
    label: `summary-stream:${selectedModel.id}`,
    modelId: selectedModel.id,
    onQueued: ({ queuePosition, waitMs }) => {
      emitSummaryProgress(videoId, {
        stage: 'calling_api',
        message: `共享预算排队中，前方 ${queuePosition} 个任务，预计 ${Math.ceil(waitMs / 1000)} 秒`,
        modelId: selectedModel.id,
        modelName: selectedModel.name,
        channelId: context.channelId,
      });
    },
  }, options?.abortSignal);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: createSummaryRequestSignal(options?.abortSignal),
      headers: createAiApiHeaders(selectedModel),
      body: JSON.stringify(createAiApiRequest(prompt, selectedModel, true)),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = `HTTP ${response.status}`;
      try {
        const json = JSON.parse(text);
        detail = extractErrorMessage(json) || detail;
      } catch {
        if (text) detail = text.slice(0, 300);
      }
      throw new Error(`调用 AI 接口失败: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let lastProgressChars = 0;
    let lastUsage: GeneratedSummaryMetadata['usage'] | undefined;
    let firstTokenAt: number | null = null;

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

          const json = parseJsonChunk(data) as AiProviderResponse;
          if (!json) continue;

          const usage = extractUsage(json);
          if (usage) {
            lastUsage = usage;
          }

          const delta = extractStreamText(json, fullContent);
          if (!delta) continue;

          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }
          fullContent += delta;

          if (
            fullContent.length - lastProgressChars >=
              STREAM_PROGRESS_INTERVAL_CHARS ||
            lastProgressChars === 0
          ) {
            lastProgressChars = fullContent.length;
            emitSummaryProgress(videoId, {
              stage: 'streaming',
              message: `模型返回中，已接收 ${fullContent.length} 字`,
              receivedChars: fullContent.length,
              modelId: selectedModel.id,
              modelName: selectedModel.name,
              channelId: context.channelId,
            });
          }

          yield delta;
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
        const json = parseJsonChunk(data);
        if (!json) continue;
        const delta = extractStreamText(json, fullContent);
        if (!delta) continue;
        fullContent += delta;
        yield delta;
      }
    } finally {
      reader.releaseLock();
    }

    const totalTimeSeconds = (Date.now() - requestStartedAt) / 1000;
    const ttftSeconds =
      firstTokenAt === null
        ? undefined
        : (firstTokenAt - requestStartedAt) / 1000;
    const outputTps = calculateOutputTps(
      lastUsage,
      totalTimeSeconds,
      ttftSeconds,
    );

    if (!fullContent) {
      throw new Error('AI 接口返回空内容');
    }

    const sanitizedMarkdown = sanitizeTimestamps(
      fullContent,
      getSummaryMaxSeconds(context, subtitle),
    );

    emitSummaryProgress(videoId, {
      stage: 'writing_file',
      message: '正在写入总结文件...',
      receivedChars: sanitizedMarkdown.length,
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      channelId: context.channelId,
    });
    writeSummaryFile(platform, videoId, sanitizedMarkdown, {
      model: selectedModel,
      usage: lastUsage,
      generation_time: totalTimeSeconds,
      total_time_seconds: totalTimeSeconds,
      ttft_seconds: ttftSeconds,
      output_tps: outputTps,
      trigger_source: triggerSource,
      model_source: modelSource,
    });
    budgetLease.release(lastUsage?.total_tokens);
    return sanitizedMarkdown;
  } catch (error) {
    budgetLease.release();
    throw error;
  }
}

/**
 * Checks whether a stored subtitle JSON file already exists for the given video.
 */
export function hasSubtitleData(videoId: string, platform: string): boolean {
  const filePath = path.join(SUBTITLE_ROOT, platform, `${videoId}.json`);
  return fs.existsSync(filePath);
}

/**
 * Checks whether a generated summary markdown file exists for the given video.
 */
export function hasSummaryFile(videoId: string, platform: string): boolean {
  const filePath = path.join(SUMMARY_ROOT, platform, `${videoId}.md`);
  return fs.existsSync(filePath);
}

/**
 * Renames an existing summary file to the `.prev.md` backup path when present.
 */
export function backupSummaryFile(videoId: string, platform: string): void {
  const filePath = path.join(SUMMARY_ROOT, platform, `${videoId}.md`);
  const prevPath = path.join(SUMMARY_ROOT, platform, `${videoId}.prev.md`);
  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, prevPath);
  }
}
