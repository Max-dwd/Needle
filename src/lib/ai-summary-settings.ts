import { getDb } from './db';
import type { AiSummaryModelConfig } from '@/types';

const AI_CONFIG_KEY = 'ai_summary_config';
const AI_ENDPOINT_KEY = 'ai_summary_api_endpoint';
const AI_API_KEY_KEY = 'ai_summary_api_key';
const AI_MODEL_KEY = 'ai_summary_model';

export const DEFAULT_AI_SUMMARY_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_AI_SUMMARY_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE = [
  '请根据以下视频字幕生成一份中文总结。',
  '',
  '视频标题：{{video_title}}',
  '频道名称：{{channel_name}}',
  '平台：{{platform_label}}',
  '原视频：{{source_url}}',
  '视频 ID：{{video_id}}',
  '视频时长：{{video_duration}}',
  '',
  '字幕内容：',
  '{{subtitle}}',
  '',
  '硬性要求：',
  '1. 只用中文输出最终总结。',
  '2. 尽可能覆盖全文，不要只覆盖前半段或只摘最显眼的观点。',
  '3. 要覆盖：主论点、关键论据、例子、转折、例外、结论、行动建议。',
  '4. 详细总结的 `##` 小节**标题必须按视频时间先后排列**：每个小节的标题以锚点时间戳开头，该时间戳严格晚于上一小节，不得回跳、不得重叠。这是为进度条章节导航提供稳定的时间骨架。',
  '5. 小节**内部**不受时间限制，可以自由引用视频任意位置的时间戳来汇总跨时段的同一主题或呼应前后观点。不要写成逐条字幕改写。',
  '6. 小节数量建议：视频 < 20 分钟 3-5 节，20-60 分钟 5-8 节，> 60 分钟 8-12 节。相邻小节锚点间隔应大致均匀，避免某一节跨越一半视频，也不要把极短的过场独立成节。',
  '7. 同一主题在视频多处出现时，归属到该主题被**首次系统性讨论**的那一小节，在正文里用内部时间戳链接指向其他位置，不要为同一主题创建两个 `##` 小节。',
  '8. 时间戳数量：每个 `##` 小节标题必须带一个锚点时间戳（该节起点），正文按需附 0-3 个支撑性时间戳。全文时间戳总数不超过 30 个。',
  '9. 时间戳只能使用"完整可点击 Markdown 链接"，禁止输出裸时间、禁止只输出 `[mm:ss]`、禁止输出不带 URL 的占位符。',
  '10. 如果无法确定某个时间戳对应的完整链接，就不要输出该时间戳。',
  '11. 如果字幕存在明显 ASR 错字，按语义纠正后再总结，但不要编造原文没有的信息。',
  '12. 如果有广告、寒暄、引流、口播或免责声明，不要混入核心总结。',
  '13. 不要输出"可能""大概""猜测链接"等不确定措辞。',
  '14. 注意上下文的连贯性，读者只看总结也能理解通畅。例如下文出现的术语或缩写，一定要在前文介绍。',
  '15. 时间戳必须来自字幕中实际出现的时间，不得推测或编造。所有时间戳不得超过视频总时长。',
  '16. 注意在时长超过15分钟的视频中，在整15分钟处会有因为音频切分，导致字幕识别不准确的情况。',
  '',
  '时间戳链接格式规则：',
  '- YouTube 必须写成：`[00:17](https://www.youtube.com/watch?v={{video_id}}&t=17s)`',
  '- Bilibili 必须写成：`[00:17](https://www.bilibili.com/video/{{video_id}}/?t=17)`',
  '- `00:17` 只是链接文字；括号内必须是完整 URL。',
  '- 同一个时间戳的显示文字必须和链接中的秒数一致。',
  '- 如果视频超过 1 小时，显示文字可写成 `01:02:03`，链接仍然使用总秒数。',
  '- 除以上两种格式外，不要发明其他格式。',
  '',
  '输出前自检：',
  '- 检查是否存在裸 `00:17`、裸 `[00:17]`、`[00:17]()`、`[mm:ss]`、`[hh:mm:ss]`；如果存在，改掉或删除。',
  '- 检查每个时间戳是否都是完整 Markdown 链接。',
  '- 检查每个时间戳的URL是否和当前视频的`{{source_url}}`一致。',
  '- 检查链接是否使用当前视频的 `{{video_id}}`，不要链接到其他视频。',
  '- 检查每个 `##` 小节标题开头是否有锚点时间戳，且这些锚点时间戳严格递增；若有回跳，调整小节顺序或合并。',
  '',
  '最终输出必须使用 Markdown，严格遵循以下结构：',
  '',
  '# 核心总结',
  '用 1-2 段或若干条项目符号，尽可能完整但精简地概括全文主旨。关键词/重要信息加粗。',
  '',
  '# 详细总结',
  '按视频时间顺序组织若干小节：小节标题以锚点时间戳开头、标注该节覆盖内容的起点；标题文字清晰、简洁、有吸引力。小节之间空一行。关键词加粗。小节内容用项目符号搭配术语/短语/短句+时间戳来总结；正文时间戳不受时间顺序限制，可跨时段汇总同一主题、呼应前后观点。对于适合横向对比的内容，可以使用表格来总结。',
  '以下是参考格式, 注意小节标题前要带数字序号和锚点时间戳',
  '## 1. 小节标题 [12:34](完整URL)',
  '- **术语/短语/短报**：一到两个短句+时间戳，必要时可跨时段呼应 [28:10](完整URL)。',
  '',
  '# 结论 / 观点 / 建议',
  '总结视频最后的判断、观点归纳、建议或行动项。',
].join('\n');

export const DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE = [
  '输出完整、带时间范围、以整句/整段为主的字幕。',
  '检查每个时间段是否和视频内容保持一致。',
  '输出格式示范：',
  '[00:00-00:23] 发言1',
  '[00:23-00:50] 发言2',
].join('\n');

export const DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE = [
  '当前只处理原视频的一个切片。',
  '时间戳必须相对于当前切片开头，从 00:00 起算。',
  '时间戳不得超过 15:00。',
].join('\n');

export const DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE = [
  '你是一个专业的笔记整理助手。用户正在观看一个视频，选取了部分片段，并给出了一个简短的想法。',
  '请根据视频片段内容，围绕用户的想法，扩写成一篇结构化的 Obsidian 笔记。',
  '',
  '要求：',
  '- 输出必须以 YAML frontmatter 开头，并且紧跟一个空行后再开始正文',
  '- YAML frontmatter 必须严格包含这些字段：title、channel、platform、source_url、creat_at',
  '- `creat_at` 字段名保持原样，不要改写成 `created_at`',
  '- 使用 Markdown 格式：## 二级标题、### 三级标题、- 列表、**粗体**',
  '- 在引用视频内容时，附上时间戳链接：[mm:ss](视频URL?t=秒数)',
  '- 围绕用户的想法展开，视频内容作为论据和素材',
  '- 笔记应当自成体系，即使脱离视频也能独立阅读',
  '- 语言风格：简洁、信息密度高、适合知识管理',
  '- 严格基于提供的片段，不要编造片段中没有出现的信息',
].join('\n');

export const DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE = [
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
].join('\n');

export interface AiSummaryPromptTemplates {
  default: string;
  subtitleApi: string;
  subtitleSegment: string;
  chatObsidian: string;
  chatRoast: string;
}

export interface AiSummaryModelInput {
  id?: string;
  name?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

export interface AiSummaryPromptTemplatesInput {
  default?: string;
  subtitleApi?: string;
  subtitleSegment?: string;
  chatObsidian?: string;
  chatRoast?: string;
}

export interface AiSummaryConfigDocument {
  version: 5;
  promptTemplates: AiSummaryPromptTemplates;
  defaultModelId: string;
  autoDefaultModelId: string;
  sharedRequestsPerMinute: number;
  sharedRequestsPerDay: number;
  sharedTokensPerMinute: number;
  subtitleFallbackTokenReserve: number;
  models: AiSummaryModelConfig[];
}

export interface AiSummarySettings {
  endpoint: string;
  apiKey: string;
  model: string;
  modelId: string;
  modelName: string;
  promptTemplate: string;
  subtitleApiPromptTemplate: string;
  subtitleSegmentPromptTemplate: string;
  chatObsidianPromptTemplate: string;
  chatRoastPromptTemplate: string;
  promptTemplates: AiSummaryPromptTemplates;
  defaultModelId: string | null;
  autoDefaultModelId: string | null;
  sharedRequestsPerMinute: number;
  sharedRequestsPerDay: number;
  sharedTokensPerMinute: number;
  subtitleFallbackTokenReserve: number;
  models: AiSummaryModelConfig[];
  selectedModel: AiSummaryModelConfig;
  updatedAt: string | null;
}

export interface SetAiSummarySettingsInput {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  promptTemplate?: string;
  subtitleApiPromptTemplate?: string;
  promptTemplates?: AiSummaryPromptTemplatesInput;
  defaultModelId?: string;
  autoDefaultModelId?: string;
  sharedRequestsPerMinute?: number;
  sharedRequestsPerDay?: number;
  sharedTokensPerMinute?: number;
  subtitleFallbackTokenReserve?: number;
  models?: AiSummaryModelInput[];
}

export type SummaryTriggerSource = 'manual' | 'auto';

export interface ResolveAiSummaryGenerationOptions {
  modelIdOverride?: string | null;
  triggerSource?: SummaryTriggerSource;
  intentName?: string | null;
}

export interface ResolvedAiSummaryGenerationSettings {
  promptTemplate: string;
  selectedModel: AiSummaryModelConfig;
  modelSource: 'default' | 'auto-default' | 'intent' | 'override';
  triggerSource: SummaryTriggerSource;
}

interface SettingRow {
  value: string | null;
  updated_at: string | null;
}

interface LegacyConfigDocument {
  promptTemplate: string;
  defaultModelId: string;
  models: AiSummaryModelConfig[];
}

interface PartialLegacyConfigDocument {
  promptTemplate?: unknown;
  defaultModelId?: unknown;
  models?: unknown;
  promptTemplates?: unknown;
}

function getSettingRow(key: string): SettingRow | null {
  const row = getDb()
    .prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .get(key) as SettingRow | undefined;

  return row ?? null;
}

function getSettingValue(key: string): string | null {
  return getSettingRow(key)?.value?.trim() || null;
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function ensureSummaryTemplateIncludesSubtitle(template: string): string {
  const normalized = template.trim();
  if (!normalized) return DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE;
  if (normalized.includes('{{subtitle}}')) return normalized;

  return [
    normalized,
    '',
    '字幕内容：',
    '{{subtitle}}',
  ].join('\n');
}

function normalizeModelInput(
  raw: unknown,
  fallback: Partial<AiSummaryModelConfig> = {},
  index = 0,
): AiSummaryModelConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;

  const id = normalizeText(value.id, fallback.id || `model-${index + 1}`);
  const endpoint = normalizeText(
    value.endpoint,
    fallback.endpoint || DEFAULT_AI_SUMMARY_ENDPOINT,
  );
  const apiKey = normalizeText(value.apiKey, fallback.apiKey || '');
  const model = normalizeText(
    value.model,
    fallback.model || DEFAULT_AI_SUMMARY_MODEL,
  );
  const name = normalizeText(value.name, fallback.name || `模型 ${index + 1}`);

  return {
    id,
    name,
    endpoint,
    apiKey,
    model,
  };
}

function dedupeModels(models: AiSummaryModelConfig[]): AiSummaryModelConfig[] {
  const seen = new Map<string, number>();
  return models.map((model) => {
    const count = seen.get(model.id) || 0;
    seen.set(model.id, count + 1);
    if (count === 0) return model;
    return {
      ...model,
      id: `${model.id}-${count + 1}`,
    };
  });
}

function normalizePromptTemplates(
  raw: unknown,
  fallbackDefault: string,
  fallbackSubtitleApi: string,
  fallbackSubtitleSegment: string,
  fallbackChatObsidian: string,
  fallbackChatRoast: string,
): AiSummaryPromptTemplates {
  const value =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const defaultTemplate = normalizeText(
    value.default,
    fallbackDefault || DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
  );
  const subtitleApiTemplate = normalizeText(
    value.subtitleApi,
    fallbackSubtitleApi || DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
  );
  const subtitleSegmentTemplate = normalizeText(
    value.subtitleSegment,
    fallbackSubtitleSegment || DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
  );
  const chatObsidianTemplate = normalizeText(
    value.chatObsidian,
    fallbackChatObsidian || DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE,
  );
  const chatRoastTemplate = normalizeText(
    value.chatRoast,
    fallbackChatRoast || DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE,
  );

  return {
    default: ensureSummaryTemplateIncludesSubtitle(defaultTemplate),
    subtitleApi: subtitleApiTemplate,
    subtitleSegment: subtitleSegmentTemplate,
    chatObsidian: chatObsidianTemplate,
    chatRoast: chatRoastTemplate,
  };
}

function normalizeConfigDocument(
  doc: PartialLegacyConfigDocument | null | undefined,
  fallback?: LegacyConfigDocument,
): AiSummaryConfigDocument {
  const fallbackDoc: LegacyConfigDocument = fallback || {
    promptTemplate: DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
    defaultModelId: 'default',
    models: [
      {
        id: 'default',
        name: '默认模型',
        endpoint: DEFAULT_AI_SUMMARY_ENDPOINT,
        apiKey: '',
        model: DEFAULT_AI_SUMMARY_MODEL,
      },
    ],
  };

  const normalizedModels =
    Array.isArray(doc?.models) && doc.models.length > 0
      ? dedupeModels(
        doc.models
          .map((model, index) =>
            normalizeModelInput(
              model,
              fallbackDoc.models[index] || fallbackDoc.models[0],
              index,
            ),
          )
          .filter((model): model is AiSummaryModelConfig => Boolean(model)),
      )
      : fallbackDoc.models;

  const promptTemplates = normalizePromptTemplates(
    doc?.promptTemplates,
    normalizeText(
      doc?.promptTemplate,
      fallbackDoc.promptTemplate || DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
    ),
    DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
    DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
    DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE,
    DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE,
  );

  const defaultModelId = normalizeText(
    doc?.defaultModelId,
    fallbackDoc.defaultModelId || normalizedModels[0]?.id || 'default',
  );

  const resolvedDefaultModelId = normalizedModels.some(
    (model) => model.id === defaultModelId,
  )
    ? defaultModelId
    : normalizedModels[0]?.id || 'default';

  // autoDefaultModelId: for v2→v3 migration, default to defaultModelId if not set
  const autoDefaultModelId = normalizeText(
    (doc as Record<string, unknown>)?.autoDefaultModelId,
    resolvedDefaultModelId,
  );

  const sharedRequestsPerMinute = Math.max(
    1,
    Math.floor(
      Number((doc as Record<string, unknown>)?.sharedRequestsPerMinute) || 10,
    ),
  );
  const sharedRequestsPerDay = Math.max(
    1,
    Math.floor(
      Number((doc as Record<string, unknown>)?.sharedRequestsPerDay) || 1_000,
    ),
  );
  const sharedTokensPerMinute = Math.max(
    1,
    Math.floor(
      Number((doc as Record<string, unknown>)?.sharedTokensPerMinute) ||
      1_000_000,
    ),
  );
  const subtitleFallbackTokenReserve = Math.max(
    1,
    Math.floor(
      Number((doc as Record<string, unknown>)?.subtitleFallbackTokenReserve) ||
      120_000,
    ),
  );

  return {
    version: 5,
    promptTemplates,
    defaultModelId: resolvedDefaultModelId,
    autoDefaultModelId,
    sharedRequestsPerMinute,
    sharedRequestsPerDay,
    sharedTokensPerMinute,
    subtitleFallbackTokenReserve,
    models: normalizedModels.length > 0 ? normalizedModels : fallbackDoc.models,
  };
}

function readStoredConfigDocument(): PartialLegacyConfigDocument | null {
  const row = getSettingRow(AI_CONFIG_KEY);
  if (!row?.value) return null;

  try {
    const parsed = JSON.parse(row.value) as PartialLegacyConfigDocument;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function createLegacyConfigDocument(): LegacyConfigDocument {
  const endpoint =
    getSettingValue(AI_ENDPOINT_KEY) || DEFAULT_AI_SUMMARY_ENDPOINT;
  const apiKey = getSettingValue(AI_API_KEY_KEY) || '';
  const model = getSettingValue(AI_MODEL_KEY) || DEFAULT_AI_SUMMARY_MODEL;

  return {
    promptTemplate: DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
    defaultModelId: 'default',
    models: [
      {
        id: 'default',
        name: '默认模型',
        endpoint,
        apiKey,
        model,
      },
    ],
  };
}

function getLatestUpdatedAt(): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT MAX(updated_at) AS updated_at
      FROM app_settings
      WHERE key IN (?, ?, ?, ?)
    `,
    )
    .get(AI_CONFIG_KEY, AI_ENDPOINT_KEY, AI_API_KEY_KEY, AI_MODEL_KEY) as
    | { updated_at?: string | null }
    | undefined;

  return row?.updated_at ?? null;
}

function getIntentAutoModelId(intentName: string): string | null {
  if (!intentName) return null;
  const row = getDb()
    .prepare('SELECT auto_summary_model_id FROM intents WHERE name = ?')
    .get(intentName) as { auto_summary_model_id: string | null } | undefined;
  return row?.auto_summary_model_id ?? null;
}

function resolveSelectedModel(
  config: AiSummaryConfigDocument,
  options?: ResolveAiSummaryGenerationOptions,
): { model: AiSummaryModelConfig; source: 'default' | 'auto-default' | 'intent' | 'override' } {
  const triggerSource = options?.triggerSource ?? 'manual';

  // 1. Explicit override (highest priority)
  const overrideModelId = normalizeText(options?.modelIdOverride, '');
  if (overrideModelId) {
    const overrideModel = config.models.find(
      (model) => model.id === overrideModelId,
    );
    if (overrideModel) {
      return { model: overrideModel, source: 'override' };
    }
  }

  // 2. Manual trigger → use manual default model
  if (triggerSource === 'manual') {
    const selected =
      config.models.find((model) => model.id === config.defaultModelId) ||
      config.models[0];
    if (!selected) {
      return {
        model: {
          id: 'default',
          name: '默认模型',
          endpoint: DEFAULT_AI_SUMMARY_ENDPOINT,
          apiKey: '',
          model: DEFAULT_AI_SUMMARY_MODEL,
        },
        source: 'default',
      };
    }
    return { model: selected, source: 'default' };
  }

  // 3. Auto trigger → intent model > autoDefaultModelId > defaultModelId fallback
  if (options?.intentName) {
    const intentModelId = getIntentAutoModelId(options.intentName);
    if (intentModelId) {
      const m = config.models.find((model) => model.id === intentModelId);
      if (m) {
        return { model: m, source: 'intent' };
      }
    }
  }

  const autoDefaultModel = config.models.find(
    (model) => model.id === config.autoDefaultModelId,
  );
  if (autoDefaultModel) {
    return { model: autoDefaultModel, source: 'auto-default' };
  }

  // Final fallback to manual default
  const selected =
    config.models.find((model) => model.id === config.defaultModelId) ||
    config.models[0];
  if (!selected) {
    return {
      model: {
        id: 'default',
        name: '默认模型',
        endpoint: DEFAULT_AI_SUMMARY_ENDPOINT,
        apiKey: '',
        model: DEFAULT_AI_SUMMARY_MODEL,
      },
      source: 'default',
    };
  }
  return { model: selected, source: 'default' };
}

function resolvePromptTemplate(
  config: AiSummaryConfigDocument,
): { template: string } {
  return {
    template:
      config.promptTemplates.default || DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
  };
}

function hasLegacyFields(input: SetAiSummarySettingsInput): boolean {
  return Boolean(
    input.endpoint !== undefined ||
    input.apiKey !== undefined ||
    input.model !== undefined,
  );
}

function buildConfigFromExisting(
  existing: PartialLegacyConfigDocument,
  input: SetAiSummarySettingsInput,
): AiSummaryConfigDocument {
  let next = normalizeConfigDocument(existing, createLegacyConfigDocument());

  if (
    input.promptTemplate !== undefined ||
    input.subtitleApiPromptTemplate !== undefined ||
    (input.promptTemplates &&
      (Object.prototype.hasOwnProperty.call(input.promptTemplates, 'subtitleSegment') ||
        Object.prototype.hasOwnProperty.call(input.promptTemplates, 'chatObsidian') ||
        Object.prototype.hasOwnProperty.call(input.promptTemplates, 'chatRoast'))) ||
    input.promptTemplates !== undefined
  ) {
    const currentTemplates = next.promptTemplates;
    const mergedTemplates = input.promptTemplates || {};

    next = {
      ...next,
      promptTemplates: {
        default:
          input.promptTemplate !== undefined
            ? ensureSummaryTemplateIncludesSubtitle(
              normalizeText(
                input.promptTemplate,
                currentTemplates.default || DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
              ),
            )
            : ensureSummaryTemplateIncludesSubtitle(
              normalizeText(
                mergedTemplates.default,
                currentTemplates.default || DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE,
              ),
            ),
        subtitleApi:
          input.subtitleApiPromptTemplate !== undefined
            ? normalizeText(
              input.subtitleApiPromptTemplate,
              currentTemplates.subtitleApi ||
              DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
            )
            : normalizeText(
              mergedTemplates.subtitleApi,
              currentTemplates.subtitleApi ||
              DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
            ),
        subtitleSegment: normalizeText(
          mergedTemplates.subtitleSegment,
          currentTemplates.subtitleSegment ||
          DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
        ),
        chatObsidian: normalizeText(
          mergedTemplates.chatObsidian,
          currentTemplates.chatObsidian ||
          DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE,
        ),
        chatRoast: normalizeText(
          mergedTemplates.chatRoast,
          currentTemplates.chatRoast || DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE,
        ),
      },
    };
  }

  if (Array.isArray(input.models)) {
    const fallbackModels =
      next.models.length > 0
        ? next.models
        : createLegacyConfigDocument().models;
    const nextModels =
      input.models.length > 0
        ? dedupeModels(
          input.models
            .map((model, index) =>
              normalizeModelInput(
                model,
                fallbackModels[index] || fallbackModels[0],
                index,
              ),
            )
            .filter((model): model is AiSummaryModelConfig => Boolean(model)),
        )
        : fallbackModels;

    next = {
      ...next,
      models: nextModels.length > 0 ? nextModels : fallbackModels,
    };
  }

  if (hasLegacyFields(input)) {
    const targetId = next.models.some(
      (model) => model.id === next.defaultModelId,
    )
      ? next.defaultModelId
      : next.models[0]?.id || 'default';

    const nextModels =
      next.models.length > 0
        ? next.models.map((model) => {
          if (model.id !== targetId) return model;
          return {
            ...model,
            endpoint:
              input.endpoint !== undefined
                ? normalizeText(input.endpoint, model.endpoint)
                : model.endpoint,
            apiKey:
              input.apiKey !== undefined
                ? normalizeText(input.apiKey, model.apiKey)
                : model.apiKey,
            model:
              input.model !== undefined
                ? normalizeText(input.model, model.model)
                : model.model,
          };
        })
        : [
          {
            id: targetId,
            name: '默认模型',
            endpoint: normalizeText(
              input.endpoint,
              DEFAULT_AI_SUMMARY_ENDPOINT,
            ),
            apiKey: normalizeText(input.apiKey, ''),
            model: normalizeText(input.model, DEFAULT_AI_SUMMARY_MODEL),
          },
        ];

    next = {
      ...next,
      models: nextModels,
    };
  }

  if (input.defaultModelId !== undefined) {
    const nextDefaultModelId = normalizeText(
      input.defaultModelId,
      next.defaultModelId,
    );
    next = {
      ...next,
      defaultModelId: nextDefaultModelId || next.defaultModelId,
    };
  }

  if (input.autoDefaultModelId !== undefined) {
    const nextAutoDefaultModelId = normalizeText(
      input.autoDefaultModelId,
      next.autoDefaultModelId,
    );
    next = {
      ...next,
      autoDefaultModelId: nextAutoDefaultModelId || next.autoDefaultModelId,
    };
  }

  if (input.sharedRequestsPerMinute !== undefined) {
    next.sharedRequestsPerMinute = Math.max(
      1,
      Math.floor(input.sharedRequestsPerMinute || next.sharedRequestsPerMinute),
    );
  }

  if (input.sharedRequestsPerDay !== undefined) {
    next.sharedRequestsPerDay = Math.max(
      1,
      Math.floor(input.sharedRequestsPerDay || next.sharedRequestsPerDay),
    );
  }

  if (input.sharedTokensPerMinute !== undefined) {
    next.sharedTokensPerMinute = Math.max(
      1,
      Math.floor(input.sharedTokensPerMinute || next.sharedTokensPerMinute),
    );
  }

  if (input.subtitleFallbackTokenReserve !== undefined) {
    next.subtitleFallbackTokenReserve = Math.max(
      1,
      Math.floor(
        input.subtitleFallbackTokenReserve ||
        next.subtitleFallbackTokenReserve,
      ),
    );
  }

  if (next.models.length === 0) {
    next.models = createLegacyConfigDocument().models;
  }

  if (!next.models.some((model) => model.id === next.defaultModelId)) {
    next.defaultModelId = next.models[0]?.id || 'default';
  }

  if (!next.models.some((model) => model.id === next.autoDefaultModelId)) {
    next.autoDefaultModelId = next.defaultModelId;
  }

  if (!next.promptTemplates.default) {
    next.promptTemplates.default = DEFAULT_AI_SUMMARY_PROMPT_TEMPLATE;
  }
  if (!next.promptTemplates.subtitleApi) {
    next.promptTemplates.subtitleApi = DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE;
  }
  if (!next.promptTemplates.subtitleSegment) {
    next.promptTemplates.subtitleSegment =
      DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE;
  }
  if (!next.promptTemplates.chatObsidian) {
    next.promptTemplates.chatObsidian = DEFAULT_AI_CHAT_OBSIDIAN_PROMPT_TEMPLATE;
  }
  if (!next.promptTemplates.chatRoast) {
    next.promptTemplates.chatRoast = DEFAULT_AI_CHAT_ROAST_PROMPT_TEMPLATE;
  }

  return next;
}

function getNormalizedConfig(): AiSummaryConfigDocument {
  return normalizeConfigDocument(
    readStoredConfigDocument(),
    createLegacyConfigDocument(),
  );
}

export function resolveAiSummaryGenerationSettings(
  options?: ResolveAiSummaryGenerationOptions,
): ResolvedAiSummaryGenerationSettings {
  const config = getNormalizedConfig();
  const resolvedPrompt = resolvePromptTemplate(config);
  const resolvedModel = resolveSelectedModel(config, options);

  return {
    promptTemplate: resolvedPrompt.template,
    selectedModel: resolvedModel.model,
    modelSource: resolvedModel.source,
    triggerSource: options?.triggerSource ?? 'manual',
  };
}

export function getAiSummarySettings(): AiSummarySettings {
  const config = getNormalizedConfig();
  const selectedModel = resolveSelectedModel(config).model;

  return {
    endpoint: selectedModel.endpoint,
    apiKey: selectedModel.apiKey,
    model: selectedModel.model,
    modelId: selectedModel.id,
    modelName: selectedModel.name,
    promptTemplate: config.promptTemplates.default,
    subtitleApiPromptTemplate: config.promptTemplates.subtitleApi,
    subtitleSegmentPromptTemplate: config.promptTemplates.subtitleSegment,
    chatObsidianPromptTemplate: config.promptTemplates.chatObsidian,
    chatRoastPromptTemplate: config.promptTemplates.chatRoast,
    promptTemplates: config.promptTemplates,
    defaultModelId: config.defaultModelId || null,
    autoDefaultModelId: config.autoDefaultModelId || null,
    sharedRequestsPerMinute: config.sharedRequestsPerMinute,
    sharedRequestsPerDay: config.sharedRequestsPerDay,
    sharedTokensPerMinute: config.sharedTokensPerMinute,
    subtitleFallbackTokenReserve: config.subtitleFallbackTokenReserve,
    models: config.models,
    selectedModel,
    updatedAt: getLatestUpdatedAt(),
  };
}

export function setAiSummarySettings(input: SetAiSummarySettingsInput) {
  const db = getDb();
  const existingConfig = readStoredConfigDocument();
  const nextConfig = existingConfig
    ? buildConfigFromExisting(existingConfig, input)
    : buildConfigFromExisting({}, input);

  const selectedModel = resolveSelectedModel(nextConfig).model;

  const statement = db.prepare(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const transaction = db.transaction(() => {
    statement.run(AI_CONFIG_KEY, JSON.stringify(nextConfig));
    statement.run(AI_ENDPOINT_KEY, selectedModel.endpoint);
    statement.run(AI_API_KEY_KEY, selectedModel.apiKey);
    statement.run(AI_MODEL_KEY, selectedModel.model);
  });

  transaction();

  return getAiSummarySettings();
}
