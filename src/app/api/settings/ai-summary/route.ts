import { NextRequest, NextResponse } from 'next/server';
import {
  DEFAULT_AI_SUMMARY_ENDPOINT,
  DEFAULT_AI_SUMMARY_MODEL,
  DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
  DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
  DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
  DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE,
  DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE,
  getAiSummarySettings,
  setAiSummarySettings,
  type AiSummaryModelInput,
  type AiSummaryPromptTemplatesInput,
} from '@/lib/ai-summary-settings';

function maskSecret(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function createResponse() {
  const settings = getAiSummarySettings();
  return {
    endpoint: settings.endpoint,
    apiKey: '',
    apiKeyMasked: maskSecret(settings.apiKey),
    hasApiKey: Boolean(settings.apiKey),
    model: settings.model,
    modelId: settings.modelId,
    modelName: settings.modelName,
    promptTemplate: settings.promptTemplate,
    subtitleApiPromptTemplate: settings.subtitleApiPromptTemplate,
    subtitleSegmentPromptTemplate: settings.subtitleSegmentPromptTemplate,
    promptTemplates: settings.promptTemplates,
    defaultModelId: settings.defaultModelId,
    autoDefaultModelId: settings.autoDefaultModelId,
    sharedRequestsPerMinute: settings.sharedRequestsPerMinute,
    sharedRequestsPerDay: settings.sharedRequestsPerDay,
    sharedTokensPerMinute: settings.sharedTokensPerMinute,
    subtitleFallbackTokenReserve: settings.subtitleFallbackTokenReserve,
    models: settings.models.map((model) => ({
      ...model,
      apiKey: '',
      apiKeyMasked: maskSecret(model.apiKey),
      hasApiKey: Boolean(model.apiKey),
    })),
    updatedAt: settings.updatedAt,
    defaults: {
      endpoint: DEFAULT_AI_SUMMARY_ENDPOINT,
      model: DEFAULT_AI_SUMMARY_MODEL,
      promptTemplate: DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
      subtitleApiPromptTemplate: DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
      subtitleSegmentPromptTemplate:
        DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
      chatObsidianPromptTemplate: DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE,
      chatRoastPromptTemplate: DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE,
    },
  };
}

export async function GET() {
  return NextResponse.json(createResponse());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    promptTemplate?: string;
    subtitleApiPromptTemplate?: string;
    subtitleSegmentPromptTemplate?: string;
    promptTemplates?: AiSummaryPromptTemplatesInput;
    defaultModelId?: string;
    autoDefaultModelId?: string;
    sharedRequestsPerMinute?: number;
    sharedRequestsPerDay?: number;
    sharedTokensPerMinute?: number;
    subtitleFallbackTokenReserve?: number;
    models?: AiSummaryModelInput[];
  } | null;

  const hasModels = Array.isArray(body?.models);
  const hasExplicitFields = Boolean(
    body?.endpoint?.trim() ||
    body?.apiKey?.trim() ||
    body?.model?.trim() ||
    body?.promptTemplate !== undefined ||
    body?.subtitleApiPromptTemplate !== undefined ||
    body?.subtitleSegmentPromptTemplate !== undefined ||
    body?.promptTemplates !== undefined ||
    body?.defaultModelId !== undefined ||
    body?.autoDefaultModelId !== undefined ||
    body?.sharedRequestsPerMinute !== undefined ||
    body?.sharedRequestsPerDay !== undefined ||
    body?.sharedTokensPerMinute !== undefined ||
    body?.subtitleFallbackTokenReserve !== undefined ||
    hasModels,
  );

  if (!hasExplicitFields) {
    return NextResponse.json(
      { error: '请提供至少一个 AI 总结配置项' },
      { status: 400 },
    );
  }

  const endpoint = body?.endpoint?.trim() || '';
  const apiKey = body?.apiKey?.trim() || '';
  const model = body?.model?.trim() || '';

  if (endpoint) {
    try {
      new URL(endpoint);
    } catch {
      return NextResponse.json(
        { error: 'API Endpoint 不是有效 URL' },
        { status: 400 },
      );
    }
  }

  if (hasModels) {
    for (const modelConfig of body?.models || []) {
      const modelEndpoint = modelConfig?.endpoint?.trim();
      if (!modelEndpoint) continue;
      try {
        new URL(modelEndpoint);
      } catch {
        return NextResponse.json(
          {
            error: `模型 ${modelConfig?.name || modelConfig?.id || '(未命名)'} 的 Endpoint 不是有效 URL`,
          },
          { status: 400 },
        );
      }
    }
  }

  setAiSummarySettings({
    endpoint: endpoint || undefined,
    apiKey: apiKey || undefined,
    model: model || undefined,
    promptTemplate: body?.promptTemplate,
    subtitleApiPromptTemplate: body?.subtitleApiPromptTemplate,
    promptTemplates:
      body?.promptTemplates || body?.subtitleSegmentPromptTemplate !== undefined
        ? {
            ...body?.promptTemplates,
            subtitleSegment: body?.subtitleSegmentPromptTemplate,
          }
        : undefined,
    defaultModelId: body?.defaultModelId,
    autoDefaultModelId: body?.autoDefaultModelId,
    sharedRequestsPerMinute: body?.sharedRequestsPerMinute,
    sharedRequestsPerDay: body?.sharedRequestsPerDay,
    sharedTokensPerMinute: body?.sharedTokensPerMinute,
    subtitleFallbackTokenReserve: body?.subtitleFallbackTokenReserve,
    models: hasModels ? body?.models : undefined,
  });
  return NextResponse.json(createResponse());
}
