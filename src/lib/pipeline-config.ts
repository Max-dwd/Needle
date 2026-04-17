import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';
import { BROWSER_METHOD_ID, isBrowserMethodId } from './browser-method';

export const CRAWL_PIPELINE_CONFIG_KEY = 'crawl_pipeline_config';
export const SUBTITLE_PIPELINE_CONFIG_KEY = 'subtitle_pipeline_config';

interface PipelineSourceDefinition {
  id: string;
  label: string;
  description: string;
}

interface PipelinePlatformDefinition {
  platform: string;
  label: string;
  description: string;
  sources: PipelineSourceDefinition[];
}

interface StoredPipelineSource {
  id: string;
  enabled: boolean;
}

interface StoredPipelinePlatform {
  platform: string;
  sources: StoredPipelineSource[];
}

interface StoredPipelineConfig {
  platforms: StoredPipelinePlatform[];
}

export interface PipelineSourceConfig extends PipelineSourceDefinition {
  enabled: boolean;
}

export interface PipelinePlatformConfig {
  platform: string;
  label: string;
  description: string;
  sources: PipelineSourceConfig[];
}

export interface PipelineConfig {
  platforms: PipelinePlatformConfig[];
  updatedAt: string | null;
}

export type CrawlPipelinePlatform = 'youtube' | 'bilibili';
export type SubtitlePipelinePlatform = 'youtube' | 'bilibili';

export type CrawlPipelineSourceId = 'browser';

export type SubtitlePipelineSourceId = 'browser' | 'whisper-ai' | 'gemini';

const CRAWL_PIPELINE_DEFINITIONS: PipelinePlatformDefinition[] = [
  {
    platform: 'youtube',
    label: 'YouTube',
    description: '通过 Needle Browser 在受控浏览器中抓取频道视频列表。',
    sources: [
      {
        id: 'browser',
        label: 'Needle Browser',
        description: '当前唯一抓取源，直接读取频道页注入数据。',
      },
    ],
  },
  {
    platform: 'bilibili',
    label: 'Bilibili',
    description: '通过 Needle Browser 在受控浏览器中抓取 UP 主视频列表。',
    sources: [
      {
        id: 'browser',
        label: 'Needle Browser',
        description: '当前唯一抓取源，直接读取浏览器上下文中的视频列表。',
      },
    ],
  },
];

const SUBTITLE_PIPELINE_DEFINITIONS: PipelinePlatformDefinition[] = [
  {
    platform: 'youtube',
    label: 'YouTube',
    description:
      '字幕提取优先走 Needle Browser，失败时可回退到 AI 多模态 API。',
    sources: [
      {
        id: 'browser',
        label: 'Needle Browser',
        description: '当前默认主链路，优先提取现成字幕。',
      },
      {
        id: 'whisper-ai',
        label: 'Whisper + AI 校对',
        description: '本地 Whisper 提供时间戳，多模态 AI 听音频校对文本。',
      },
      {
        id: 'gemini',
        label: 'AI 多模态 API',
        description: 'AI 提取 fallback，适合无字幕或字幕失效场景。',
      },
    ],
  },
  {
    platform: 'bilibili',
    label: 'Bilibili',
    description:
      '字幕提取优先走 Needle Browser，失败时可回退到 AI 多模态 API。',
    sources: [
      {
        id: 'browser',
        label: 'Needle Browser',
        description: '当前默认主链路，优先拉取现成字幕。',
      },
      {
        id: 'whisper-ai',
        label: 'Whisper + AI 校对',
        description: '本地 Whisper 提供时间戳，多模态 AI 听音频校对文本。',
      },
      {
        id: 'gemini',
        label: 'AI 多模态 API',
        description: 'AI 字幕补全或提取兜底。',
      },
    ],
  },
];

function parseStoredConfig(raw: string | null): StoredPipelineConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPipelineConfig;
    if (!Array.isArray(parsed?.platforms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizePlatformConfig(
  definition: PipelinePlatformDefinition,
  storedPlatform: StoredPipelinePlatform | undefined,
): PipelinePlatformConfig {
  const storedOrder = Array.isArray(storedPlatform?.sources)
    ? storedPlatform.sources.map((source) => ({
        ...source,
        id: normalizeSourceId(source.id),
      }))
    : [];
  const sourceMap = new Map(
    definition.sources.map((source) => [source.id, source] as const),
  );
  const storedEnabledMap = new Map(
    storedOrder
      .filter(
        (source): source is StoredPipelineSource =>
          Boolean(source?.id) && typeof source.enabled === 'boolean',
      )
      .map((source) => [source.id, source.enabled] as const),
  );

  const orderedIds = storedOrder
    .map((source) => source.id)
    .filter((id, index, ids) => sourceMap.has(id) && ids.indexOf(id) === index);
  const definitionIds = definition.sources.map((source) => source.id);
  for (const id of definitionIds) {
    if (orderedIds.includes(id)) continue;
    const definitionIndex = definitionIds.indexOf(id);
    const previousKnownIds = definitionIds
      .slice(0, definitionIndex)
      .filter((candidate) => orderedIds.includes(candidate));
    const previousKnownId = previousKnownIds[previousKnownIds.length - 1];
    if (previousKnownId) {
      orderedIds.splice(orderedIds.lastIndexOf(previousKnownId) + 1, 0, id);
      continue;
    }
    const nextKnownId = definitionIds
      .slice(definitionIndex + 1)
      .find((candidate) => orderedIds.includes(candidate));
    if (nextKnownId) {
      orderedIds.splice(orderedIds.indexOf(nextKnownId), 0, id);
      continue;
    }
    orderedIds.push(id);
  }

  return {
    platform: definition.platform,
    label: definition.label,
    description: definition.description,
    sources: orderedIds
      .map((id) => sourceMap.get(id))
      .filter((source): source is PipelineSourceDefinition => Boolean(source))
      .map((source) => ({
        ...source,
        enabled: storedEnabledMap.get(source.id) ?? true,
      })),
  };
}

function buildPipelineConfig(
  key: string,
  definitions: PipelinePlatformDefinition[],
): PipelineConfig {
  const stored = parseStoredConfig(getAppSetting(key));

  return {
    platforms: definitions.map((definition) =>
      normalizePlatformConfig(
        definition,
        stored?.platforms.find(
          (platform) => platform.platform === definition.platform,
        ),
      ),
    ),
    updatedAt: getAppSettingUpdatedAt(key),
  };
}

function serializePipelineConfig(config: PipelineConfig): string {
  return JSON.stringify({
    platforms: config.platforms.map((platform) => ({
      platform: platform.platform,
      sources: platform.sources.map((source) => ({
        id: normalizeSourceId(source.id),
        enabled: source.enabled,
      })),
    })),
  } satisfies StoredPipelineConfig);
}

function validateAndNormalizeIncomingConfig(
  input: unknown,
  definitions: PipelinePlatformDefinition[],
): PipelineConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('配置格式无效');
  }

  const platforms = (input as { platforms?: unknown }).platforms;
  if (!Array.isArray(platforms)) {
    throw new Error('缺少平台配置');
  }

  const platformMap = new Map(
    platforms
      .filter(
        (platform): platform is StoredPipelinePlatform =>
          Boolean(platform) &&
          typeof platform === 'object' &&
          typeof (platform as { platform?: unknown }).platform === 'string' &&
          Array.isArray((platform as { sources?: unknown }).sources),
      )
      .map(
        (platform) =>
          [
            platform.platform,
            {
              ...platform,
              sources: platform.sources.map((source) => ({
                ...source,
                id: normalizeSourceId(source.id),
              })),
            },
          ] as const,
      ),
  );

  return {
    platforms: definitions.map((definition) =>
      normalizePlatformConfig(definition, platformMap.get(definition.platform)),
    ),
    updatedAt: null,
  };
}

function setPipelineConfig(
  key: string,
  input: unknown,
  definitions: PipelinePlatformDefinition[],
): PipelineConfig {
  const normalized = validateAndNormalizeIncomingConfig(input, definitions);
  setAppSetting(key, serializePipelineConfig(normalized));
  return buildPipelineConfig(key, definitions);
}

export function getCrawlPipelineConfig(): PipelineConfig {
  return buildPipelineConfig(
    CRAWL_PIPELINE_CONFIG_KEY,
    CRAWL_PIPELINE_DEFINITIONS,
  );
}

export function setCrawlPipelineConfig(input: unknown): PipelineConfig {
  return setPipelineConfig(
    CRAWL_PIPELINE_CONFIG_KEY,
    input,
    CRAWL_PIPELINE_DEFINITIONS,
  );
}

export function getSubtitlePipelineConfig(): PipelineConfig {
  return buildPipelineConfig(
    SUBTITLE_PIPELINE_CONFIG_KEY,
    SUBTITLE_PIPELINE_DEFINITIONS,
  );
}

export function setSubtitlePipelineConfig(input: unknown): PipelineConfig {
  return setPipelineConfig(
    SUBTITLE_PIPELINE_CONFIG_KEY,
    input,
    SUBTITLE_PIPELINE_DEFINITIONS,
  );
}

function getEnabledSourceIds<T extends string>(
  config: PipelineConfig,
  platform: string,
): T[] {
  const platformConfig = config.platforms.find(
    (item) => item.platform === platform,
  );
  return (platformConfig?.sources || [])
    .filter((source) => source.enabled)
    .map((source) => source.id as T);
}

function normalizeSourceId(id: string): string {
  return isBrowserMethodId(id) ? BROWSER_METHOD_ID : id;
}

export function getCrawlPipelineSourceOrder(
  platform: CrawlPipelinePlatform,
): CrawlPipelineSourceId[] {
  return getEnabledSourceIds<CrawlPipelineSourceId>(
    getCrawlPipelineConfig(),
    platform,
  );
}

export function getSubtitlePipelineSourceOrder(
  platform: SubtitlePipelinePlatform,
): SubtitlePipelineSourceId[] {
  return getEnabledSourceIds<SubtitlePipelineSourceId>(
    getSubtitlePipelineConfig(),
    platform,
  );
}

export function getPreferredCrawlMethod(
  platform: CrawlPipelinePlatform,
): CrawlPipelineSourceId | null {
  return getCrawlPipelineSourceOrder(platform)[0] || null;
}

export function getPreferredSubtitleMethod(
  platform: SubtitlePipelinePlatform,
): SubtitlePipelineSourceId | null {
  return getSubtitlePipelineSourceOrder(platform)[0] || null;
}
