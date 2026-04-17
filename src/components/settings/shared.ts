'use client';

import { useCallback, useState } from 'react';
import type { UnavailableVideoBehavior } from '@/types';

export interface AiSummaryModelConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  apiKeyMasked?: string | null;
  hasApiKey?: boolean;
  model: string;
}

export interface AiSummaryConfig {
  hasApiKey?: boolean;
  apiKeyMasked?: string | null;
  endpoint: string;
  apiKey: string;
  model: string;
  promptTemplate?: string;
  subtitleApiPromptTemplate?: string;
  subtitleSegmentPromptTemplate?: string;
  defaultModelId?: string | null;
  autoDefaultModelId?: string | null;
  sharedRequestsPerMinute?: number;
  sharedRequestsPerDay?: number;
  sharedTokensPerMinute?: number;
  subtitleFallbackTokenReserve?: number;
  models?: AiSummaryModelConfig[];
  promptTemplates?: {
    default: string;
    subtitleApi: string;
    subtitleSegment: string;
    chatObsidian: string;
    chatRoast: string;
  };
  updatedAt: string | null;
  defaults: {
    endpoint: string;
    model: string;
    promptTemplate: string;
    subtitleApiPromptTemplate: string;
    subtitleSegmentPromptTemplate: string;
    chatObsidianPromptTemplate: string;
    chatRoastPromptTemplate: string;
  };
}

export interface AuthStatus {
  state: 'valid' | 'missing' | 'invalid' | 'error';
  message: string;
  enabled: boolean;
  hasStoredSessdata: boolean;
  maskedSessdata: string | null;
  updatedAt: string | null;
}

export interface PerformanceOption {
  value: 'high' | 'medium' | 'low';
  label: string;
  description: string;
}

export interface PerformanceStatus {
  profile: 'high' | 'medium' | 'low';
  profileLabel: string;
  loadState: 'normal' | 'busy' | 'strained';
  loadStateLabel: string;
  eventLoopLagMs: number;
  peakLagMs: number;
  throttleMultiplier: number;
  updatedAt: string | null;
  options: PerformanceOption[];
}

export interface BrowserKeepaliveOption {
  value: 'off' | 'balanced' | 'aggressive';
  label: string;
  description: string;
}

export interface BrowserKeepaliveStatus {
  preset: 'off' | 'balanced' | 'aggressive';
  label: string;
  description: string;
  activeGraceMs: number;
  activeGraceLabel: string;
  daemonKeepalive: boolean;
  browserPrewarm: boolean;
  updatedAt: string | null;
  options: BrowserKeepaliveOption[];
}

export interface CrawlRuntimeConfig {
  enabled: boolean;
  crawlInterval: number;
  subtitleInterval: number;
}

export interface CrawlRuntimeStatus {
  running: boolean;
  state: 'idle' | 'running' | 'waiting';
  currentTask: 'crawl' | null;
  lastCrawl: string | null;
  nextCrawl: string | null;
  todayStats: {
    videos: number;
    subtitles: number;
    summaries: number;
  };
  message?: string | null;
  updatedAt: string;
}

export interface CrawlRuntimePayload {
  config: CrawlRuntimeConfig;
  status: CrawlRuntimeStatus;
}

export type PlayerKeyboardActionId =
  | 'play-pause'
  | 'rate-toggle'
  | 'rate-decrement'
  | 'rate-increment'
  | 'seek-backward'
  | 'seek-forward'
  | 'toggle-summary-follow'
  | 'toggle-mute';



export interface PlayerKeyboardBinding {
  action: PlayerKeyboardActionId;
  key: string;
}

export interface PlayerKeyboardModeSettings {
  enabled: boolean;
  bindings: PlayerKeyboardBinding[];
  rateTogglePreset: number;
  rateStep: number;
  seekSeconds: number;
  rateMin: number;
  rateMax: number;
}

export interface HomeIntentShortcutSettings {
  enabled: boolean;
}

export interface ErrorHandlingSettings {
  hideUnavailableVideos: boolean;
  unavailableVideoBehavior: UnavailableVideoBehavior;
  updatedAt: string | null;
  counts: {
    unavailable: number;
    abandoned: number;
  };
}

export interface TrackedErrorVideo {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  channel_name: string;
  channel_channel_id?: string;
  avatar_url: string | null;
  availability_status: 'unavailable' | 'abandoned';
  availability_reason: string | null;
  availability_checked_at: string | null;
  created_at: string;
}

export interface PipelineSourceConfig {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface PipelinePlatformConfig {
  platform: string;
  label: string;
  description: string;
  sources: PipelineSourceConfig[];
}

export interface PipelineConfigResponse {
  platforms: PipelinePlatformConfig[];
  updatedAt: string | null;
}

export type SubtitleApiFallbackScope = 'global' | 'custom';
export type SubtitleApiFallbackTargetType = 'intent' | 'channel';

export interface SubtitleApiFallbackRule {
  id: string;
  targetType: SubtitleApiFallbackTargetType;
  targetId: string;
  targetLabel: string;
  maxWaitSeconds: number;
  modelId: string;
}

export interface SubtitleApiFallbackConfig {
  enabled: boolean;
  scope: SubtitleApiFallbackScope;
  globalMaxWaitSeconds: number;
  customRules: SubtitleApiFallbackRule[];
  updatedAt: string | null;
}

export interface SubtitleBrowserFetchConfig {
  maxRetries: number;
  updatedAt: string | null;
}

export interface SubtitleBackoffPlatformState {
  multiplier: number;
  consecutiveErrors: number;
  lastErrorAt?: string | null;
}

export interface SubtitlePipelineSettingsResponse {
  apiFallback: SubtitleApiFallbackConfig;
  browserFetch: SubtitleBrowserFetchConfig;
  subtitleInterval: number;
  backoff: Record<'youtube' | 'bilibili', SubtitleBackoffPlatformState>;
}

export interface BrowserDistributionInfo {
  browserName: string;
  bridgeName: string;
  runtimeRoot: string;
  runtimeCommand: string;
  runtimeArgsPrefix: string[];
  extensionRoot: string;
  extensionManifestPath: string;
  extensionName: string;
  extensionVersion: string;
  extensionSource: 'bundled' | 'override';
}

export type ToastType = 'success' | 'error';

export type ShowToast = (message: string, type?: ToastType) => void;

export const crawlIntervalOptions = [
  { value: 15 * 60, label: '15分钟' },
  { value: 30 * 60, label: '30分钟' },
  { value: 60 * 60, label: '1小时' },
  { value: 2 * 60 * 60, label: '2小时' },
  { value: 4 * 60 * 60, label: '4小时' },
  { value: 8 * 60 * 60, label: '8小时' },
  { value: 12 * 60 * 60, label: '12小时' },
  { value: 24 * 60 * 60, label: '24小时' },
] as const;

export const subtitleIntervalOptions = [
  { value: 0, label: '即时' },
  { value: 10, label: '10秒' },
  { value: 30, label: '30秒' },
  { value: 60, label: '1分钟' },
  { value: 5 * 60, label: '5分钟' },
  { value: 10 * 60, label: '10分钟' },
  { value: 15 * 60, label: '15分钟' },
  { value: 20 * 60, label: '20分钟' },
  { value: 30 * 60, label: '30分钟' },
  { value: 60 * 60, label: '1小时' },
  { value: 2 * 60 * 60, label: '2小时' },
] as const;

export const maxRetryOptions = [
  { value: 0, label: '不重试' },
  { value: 1, label: '1 次' },
  { value: 2, label: '2 次' },
  { value: 3, label: '3 次' },
  { value: 4, label: '4 次' },
  { value: 5, label: '5 次' },
  { value: 6, label: '6 次' },
  { value: 7, label: '7 次' },
  { value: 8, label: '8 次' },
  { value: 9, label: '9 次' },
  { value: 10, label: '10 次' },
  { value: 12, label: '12 次' },
  { value: 15, label: '15 次' },
  { value: 20, label: '20 次' },
] as const;

export const maxWaitOptions = [
  { value: 0, label: '不提前逃逸' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
  { value: 7200, label: '2 小时' },
] as const;

export const settingsNavItems = [
  { id: 'performance', label: '性能', icon: '⚡' },
  { id: 'crawling', label: '抓取', icon: '🕸️' },
  { id: 'subtitles', label: '字幕', icon: '📝' },
  { id: 'summary', label: '总结', icon: '🧠' },
  { id: 'models', label: '模型', icon: '✨' },
  { id: 'errors', label: '错误处理', icon: '🚨' },
  { id: 'backup', label: '备份', icon: '💾' },
  { id: 'logs', label: '日志', icon: '📋' },
  { id: 'intents', label: '意图', icon: '🎯' },
  { id: 'bilibili', label: 'B站 AI 总结', icon: '🅱' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'research', label: '研究意图', icon: '🔬' },
] as const;

export type SettingsTabId = (typeof settingsNavItems)[number]['id'];

const legacyTabMap: Record<string, SettingsTabId> = {
  general: 'crawling',
  scheduler: 'crawling',
  performance: 'performance',
  ai: 'models',
  'bilibili-summary': 'bilibili',
};

export function isSettingsTabId(value: string | null): value is SettingsTabId {
  return Boolean(value && settingsNavItems.some((item) => item.id === value));
}

export function normalizeSettingsTab(value: string | null): SettingsTabId {
  if (isSettingsTabId(value)) return value;
  if (value && legacyTabMap[value]) return legacyTabMap[value];
  return 'crawling';
}

export type AiSettingsPayload = Partial<{
  endpoint: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  subtitleApiPromptTemplate: string;
  subtitleSegmentPromptTemplate: string;
  promptTemplates: {
    default?: string;
    subtitleApi?: string;
    subtitleSegment?: string;
    chatObsidian?: string;
    chatRoast?: string;
  };
  defaultModelId: string | null;
  autoDefaultModelId: string | null;
  sharedRequestsPerMinute: number;
  sharedRequestsPerDay: number;
  sharedTokensPerMinute: number;
  subtitleFallbackTokenReserve: number;
  models: AiSummaryModelConfig[];
}>;

export function useAiSettings() {
  const [config, setConfig] = useState<AiSummaryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/ai-summary', {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('READ_FAILED');
      }
      const data = (await res.json()) as AiSummaryConfig;
      setConfig(data);
      return data;
    } finally {
      setLoading(false);
    }
  }, []);

  const savePartial = useCallback(async (payload: AiSettingsPayload) => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/ai-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as AiSummaryConfig & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'SAVE_FAILED');
      }
      setConfig(data);
      return data;
    } finally {
      setSaving(false);
    }
  }, []);

  const testConnection = useCallback(
    async (payload?: AiSettingsPayload) => {
      setTesting(true);
      try {
        if (payload) {
          await savePartial(payload);
        }
        const res = await fetch('/api/settings/ai-summary/test', {
          method: 'POST',
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error || '未知错误');
        }
      } finally {
        setTesting(false);
      }
    },
    [savePartial],
  );

  return {
    config,
    loading,
    saving,
    testing,
    load,
    savePartial,
    testConnection,
    setConfig,
  };
}
