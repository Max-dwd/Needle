'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AiSummaryConfig,
  ShowToast,
  SubtitleApiFallbackConfig,
  SubtitleApiFallbackRule,
  SubtitleBrowserFetchConfig,
  SubtitleWhisperAiConfig,
  SubtitlePipelineSettingsResponse,
} from './shared';
import {
  maxRetryOptions,
  maxWaitOptions,
  subtitleIntervalOptions,
  useAiSettings,
} from './shared';
import { useT } from '@/contexts/LanguageContext';
import { buildSubtitleBackoffFlow } from './subtitle-backoff-flow';

interface SubtitlesTabProps {
  showToast: ShowToast;
}

interface IntentOption {
  id: number;
  name: string;
}

interface ChannelOption {
  id: number;
  name: string | null;
  platform: 'youtube' | 'bilibili';
  channel_id: string;
}

const DEFAULT_API_FALLBACK_CONFIG: SubtitleApiFallbackConfig = {
  enabled: false,
  scope: 'global',
  globalMaxWaitSeconds: 0,
  globalModelId: '',
  customRules: [],
  updatedAt: null,
};

const DEFAULT_BROWSER_FETCH_CONFIG: SubtitleBrowserFetchConfig = {
  maxRetries: 2,
  updatedAt: null,
};

const DEFAULT_WHISPER_CONFIG: SubtitleWhisperAiConfig = {
  enabled: true,
  whisperModelId: 'mlx-community/whisper-base-mlx-q4',
  batch: {
    targetSeconds: 180,
    maxSeconds: 300,
    maxSegments: 60,
    silenceWindow: 30,
    minSeconds: 30,
  },
  hallucination: {
    noSpeechProbThreshold: 0.8,
    avgLogprobThreshold: -1.0,
  },
  updatedAt: null,
};

function formatWhisperChunkDuration(seconds: number): string {
  const safe = Math.max(30, Math.round(Number(seconds) || 180));
  if (safe % 60 === 0) return `${safe / 60} 分钟`;
  return `${safe} 秒`;
}

const SUBTITLE_BACKOFF_PLATFORMS = [
  { id: 'youtube' as const, label: 'YouTube' },
  { id: 'bilibili' as const, label: 'Bilibili' },
];

export default function SubtitlesTab({ showToast }: SubtitlesTabProps) {
  const { config, loading, saving, load, savePartial } = useAiSettings();
  const [pipelineConfig, setPipelineConfig] =
    useState<SubtitlePipelineSettingsResponse | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(true);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [intents, setIntents] = useState<IntentOption[]>([]);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const t = useT();

  useEffect(() => {
    void load().catch(() => showToast(t.settings.subtitles.toastReadSettingsFailed, 'error'));
  }, [load, showToast, t]);

  useEffect(() => {
    const loadPipeline = async () => {
      setPipelineLoading(true);
      try {
        const [pipelineRes, intentsRes, channelsRes] = await Promise.all([
          fetch('/api/settings/subtitle-pipeline', { cache: 'no-store' }),
          fetch('/api/settings/intents', { cache: 'no-store' }),
          fetch('/api/channels', { cache: 'no-store' }),
        ]);
        if (!pipelineRes.ok) throw new Error(t.settings.subtitles.toastReadPipelineFailed);
        setPipelineConfig(
          (await pipelineRes.json()) as SubtitlePipelineSettingsResponse,
        );
        setIntents(
          intentsRes.ok ? ((await intentsRes.json()) as IntentOption[]) : [],
        );
        setChannels(
          channelsRes.ok ? ((await channelsRes.json()) as ChannelOption[]) : [],
        );
      } catch {
        showToast(t.settings.subtitles.toastReadPipelineFailed, 'error');
      } finally {
        setPipelineLoading(false);
      }
    };

    void loadPipeline();
  }, [showToast]);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/sse');

      es.addEventListener('pipeline-status', (event) => {
        try {
          const data = JSON.parse(event.data) as {
            subtitle?: {
              throttle?: {
                platforms?: SubtitlePipelineSettingsResponse['backoff'];
              };
            };
          };
          const platforms = data.subtitle?.throttle?.platforms;
          if (!platforms) {
            return;
          }

          setPipelineConfig((current) => {
            if (!current) return current;
            if (JSON.stringify(current.backoff) === JSON.stringify(platforms)) {
              return current;
            }
            return {
              ...current,
              backoff: platforms,
            };
          });
        } catch {
          // ignore malformed SSE payloads
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (closed || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 2000);
      };
    };

    connect();

    return () => {
      closed = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  if ((loading && !config) || (pipelineLoading && !pipelineConfig)) return null;
  if (!config || !pipelineConfig) return null;

  return (
      <SubtitlesTabForm
      key={[
        config.updatedAt || 'subtitles',
        pipelineConfig.apiFallback.updatedAt || 'fallback',
        pipelineConfig.browserFetch.updatedAt || 'browser',
        pipelineConfig.whisperAi.updatedAt || 'whisper',
        pipelineConfig.subtitleInterval,
        pipelineConfig.backoff.youtube.multiplier,
        pipelineConfig.backoff.bilibili.multiplier,
      ].join(':')}
      config={config}
      saving={saving}
      onSave={savePartial}
      pipelineConfig={pipelineConfig}
      pipelineSaving={pipelineSaving}
      onPipelineConfigChange={setPipelineConfig}
      onPipelineSavingChange={setPipelineSaving}
      intents={intents}
      channels={channels}
      showToast={showToast}
    />
  );
}

interface SubtitlesTabFormProps {
  config: AiSummaryConfig;
  saving: boolean;
  onSave: ReturnType<typeof useAiSettings>['savePartial'];
  pipelineConfig: SubtitlePipelineSettingsResponse;
  pipelineSaving: boolean;
  onPipelineConfigChange: (config: SubtitlePipelineSettingsResponse) => void;
  onPipelineSavingChange: (saving: boolean) => void;
  intents: IntentOption[];
  channels: ChannelOption[];
  showToast: ShowToast;
}

function SubtitlesTabForm({
  config,
  saving,
  onSave,
  pipelineConfig,
  pipelineSaving,
  onPipelineConfigChange,
  onPipelineSavingChange,
  intents,
  channels,
  showToast,
}: SubtitlesTabFormProps) {
  const [subtitleApiPromptTemplate, setSubtitleApiPromptTemplate] = useState(
    config.subtitleApiPromptTemplate ||
      config.promptTemplates?.subtitleApi ||
      config.defaults.subtitleApiPromptTemplate ||
      '',
  );
  const [subtitleSegmentPromptTemplate, setSubtitleSegmentPromptTemplate] =
    useState(
      config.subtitleSegmentPromptTemplate ||
        config.promptTemplates?.subtitleSegment ||
        config.defaults.subtitleSegmentPromptTemplate ||
        '',
    );
  const t = useT();

  const models = useMemo(() => config.models || [], [config.models]);
  const multimodalModels = useMemo(
    () => models.filter((model) => model.isMultimodal !== false),
    [models],
  );
  const apiFallback = pipelineConfig.apiFallback || DEFAULT_API_FALLBACK_CONFIG;
  const browserFetch =
    pipelineConfig.browserFetch || DEFAULT_BROWSER_FETCH_CONFIG;
  const whisperAi = pipelineConfig.whisperAi || DEFAULT_WHISPER_CONFIG;
  const [checkingWhisper, setCheckingWhisper] = useState(false);
  const backoffFlows = useMemo(
    () =>
      Object.fromEntries(
        SUBTITLE_BACKOFF_PLATFORMS.map(({ id }) => [
          id,
          buildSubtitleBackoffFlow(
            pipelineConfig.subtitleInterval,
            pipelineConfig.backoff[id].multiplier,
            Math.max(1, browserFetch.maxRetries),
          ),
        ]),
      ) as Record<
        'youtube' | 'bilibili',
        ReturnType<typeof buildSubtitleBackoffFlow>
      >,
    [
      pipelineConfig.subtitleInterval,
      pipelineConfig.backoff,
      browserFetch.maxRetries,
    ],
  );

  const channelOptions = useMemo(
    () =>
      [...channels].sort((a, b) =>
        getChannelLabel(a).localeCompare(getChannelLabel(b), 'zh-CN'),
      ),
    [channels],
  );

  const updatePipeline = (next: {
    apiFallback?: Partial<SubtitleApiFallbackConfig>;
    browserFetch?: Partial<SubtitleBrowserFetchConfig>;
    whisperAi?: Partial<SubtitleWhisperAiConfig>;
    subtitleInterval?: number;
  }) => {
    onPipelineConfigChange({
      ...pipelineConfig,
      ...next,
      apiFallback: { ...apiFallback, ...(next.apiFallback || {}) },
      browserFetch: { ...browserFetch, ...(next.browserFetch || {}) },
      whisperAi: { ...whisperAi, ...(next.whisperAi || {}) },
    });
  };

  const updateWhisperAi = (next: Partial<SubtitleWhisperAiConfig>) => {
    updatePipeline({ whisperAi: next });
  };

  const updateApiFallback = (next: Partial<SubtitleApiFallbackConfig>) => {
    updatePipeline({ apiFallback: next });
  };

  const savePrompts = async () => {
    try {
      await onSave({
        subtitleApiPromptTemplate,
        subtitleSegmentPromptTemplate,
        promptTemplates: {
          subtitleApi: subtitleApiPromptTemplate,
          subtitleSegment: subtitleSegmentPromptTemplate,
        },
      });
      showToast(t.settings.subtitles.toastSaveSettingsSuccess);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t.settings.subtitles.toastSaveSettingsError,
        'error',
      );
    }
  };

  const savePipelineConfig = async () => {
    onPipelineSavingChange(true);
    try {
      const res = await fetch('/api/settings/subtitle-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitleInterval: pipelineConfig.subtitleInterval,
          browserFetch: {
            maxRetries: browserFetch.maxRetries,
          },
          whisperAi: {
            enabled: whisperAi.enabled,
            whisperModelId: whisperAi.whisperModelId,
            batch: whisperAi.batch,
            hallucination: whisperAi.hallucination,
          },
          apiFallback: {
            enabled: apiFallback.enabled,
            scope: apiFallback.scope,
            globalMaxWaitSeconds: apiFallback.globalMaxWaitSeconds,
            globalModelId: apiFallback.globalModelId,
            customRules: apiFallback.customRules,
          },
        }),
      });
      const data = (await res.json()) as SubtitlePipelineSettingsResponse & {
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error || t.settings.subtitles.toastSavePipelineError, 'error');
        return;
      }
      onPipelineConfigChange(data);
      showToast(t.settings.subtitles.toastSavePipelineSuccess);
    } catch {
      showToast(t.settings.subtitles.toastSavePipelineError, 'error');
    } finally {
      onPipelineSavingChange(false);
    }
  };

  const resetPipelineDefaults = async () => {
    onPipelineSavingChange(true);
    try {
      const res = await fetch('/api/settings/subtitle-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitleInterval: 10,
          browserFetch: DEFAULT_BROWSER_FETCH_CONFIG,
          whisperAi: DEFAULT_WHISPER_CONFIG,
          apiFallback: DEFAULT_API_FALLBACK_CONFIG,
        }),
      });
      const data = (await res.json()) as SubtitlePipelineSettingsResponse & {
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error || t.settings.subtitles.toastResetPipelineFailed, 'error');
        return;
      }
      onPipelineConfigChange(data);
      showToast(t.settings.subtitles.toastResetPipelineSuccess);
    } catch {
      showToast(t.settings.subtitles.toastResetPipelineError, 'error');
    } finally {
      onPipelineSavingChange(false);
    }
  };

  const updateRule = (
    ruleId: string,
    next: Partial<SubtitleApiFallbackRule>,
  ) => {
    updateApiFallback({
      customRules: apiFallback.customRules.map((rule) =>
        rule.id === ruleId ? { ...rule, ...next } : rule,
      ),
    });
  };

  const removeRule = (ruleId: string) => {
    updateApiFallback({
      customRules: apiFallback.customRules.filter((rule) => rule.id !== ruleId),
    });
  };

  const addRule = () => {
    const defaultIntent = intents[0];
    const defaultChannel = channelOptions[0];
    const defaultModel = multimodalModels[0];
    if (!defaultModel || (!defaultIntent && !defaultChannel)) {
      showToast(t.settings.subtitles.addRuleErrorModel, 'error');
      return;
    }

    const targetType = defaultIntent ? 'intent' : 'channel';
    updateApiFallback({
      customRules: [
        ...apiFallback.customRules,
        {
          id: `rule-${Date.now()}`,
          targetType,
          targetId:
            targetType === 'intent'
              ? String(defaultIntent.id)
              : String(defaultChannel?.id || ''),
          targetLabel:
            targetType === 'intent'
              ? defaultIntent.name
              : getChannelLabel(defaultChannel),
          maxWaitSeconds: 0,
          modelId: defaultModel.id,
        },
      ],
    });
  };

  const handleRuleTargetTypeChange = (
    rule: SubtitleApiFallbackRule,
    targetType: 'intent' | 'channel',
  ) => {
    if (targetType === 'intent') {
      const nextIntent = intents[0];
      updateRule(rule.id, {
        targetType,
        targetId: nextIntent ? String(nextIntent.id) : '',
        targetLabel: nextIntent?.name || '',
      });
      return;
    }

    const nextChannel = channelOptions[0];
    updateRule(rule.id, {
      targetType,
      targetId: nextChannel ? String(nextChannel.id) : '',
      targetLabel: nextChannel ? getChannelLabel(nextChannel) : '',
    });
  };

  const restoreDefaultSubtitleApiPromptTemplate = () => {
    setSubtitleApiPromptTemplate(
      config.defaults.subtitleApiPromptTemplate || '',
    );
    showToast(t.settings.subtitles.toastRestoreApiPrompt);
  };

  const restoreDefaultSubtitleSegmentPromptTemplate = () => {
    setSubtitleSegmentPromptTemplate(
      config.defaults.subtitleSegmentPromptTemplate || '',
    );
    showToast(t.settings.subtitles.toastRestoreSegmentPrompt);
  };

  const checkWhisperStatus = async () => {
    setCheckingWhisper(true);
    try {
      const res = await fetch('/api/settings/whisper-status');
      const data = await res.json();
      if (data.available) {
        showToast(
          `${t.settings.subtitles.toastCheckWhisperSuccess} (v${data.version || '?'})`,
          'success',
        );
      } else {
        showToast(
          `${t.settings.subtitles.toastCheckWhisperError}: ${data.error || 'not found'}`,
          'error',
        );
      }
    } catch {
      showToast(t.settings.subtitles.toastCheckWhisperError, 'error');
    } finally {
      setCheckingWhisper(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.subtitles.browserFetch}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.baseInterval}</span>
              <span className="setting-description">
                {t.settings.subtitles.baseIntervalDesc}
              </span>
            </div>
            <select
              className="premium-select"
              value={pipelineConfig.subtitleInterval}
              onChange={(event) =>
                updatePipeline({
                  subtitleInterval: Number(event.target.value) || 0,
                })
              }
              disabled={pipelineSaving}
            >
              {subtitleIntervalOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.maxRetries}</span>
              <span className="setting-description">
                {t.settings.subtitles.maxRetriesDesc}
              </span>
            </div>
            <select
              className="premium-select"
              value={browserFetch.maxRetries}
              onChange={(event) =>
                updatePipeline({
                  browserFetch: {
                    maxRetries: Number(event.target.value) || 0,
                  },
                })
              }
              disabled={pipelineSaving}
            >
              {maxRetryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.currentBackoff}</span>
              <span className="setting-description">
                {t.settings.subtitles.currentBackoffDesc}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 10,
              }}
            >
              {SUBTITLE_BACKOFF_PLATFORMS.map(({ id, label }) => (
                <div
                  key={id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      color: '#6b7280',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label} · ×{pipelineConfig.backoff[id].multiplier} ·
                    {t.settings.subtitles.consecutiveErrors} {pipelineConfig.backoff[id].consecutiveErrors}
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      gap: 6,
                      fontSize: 12,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {backoffFlows[id].map((step, index) => (
                      <span
                        key={`${id}-${step.label}-${index}`}
                        style={{
                          color: step.color,
                          fontWeight: step.isCurrent ? 700 : 500,
                        }}
                      >
                        {step.label}
                        {index < backoffFlows[id].length - 1 && (
                          <span style={{ color: '#94a3b8' }}>{' -> '}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.subtitles.whisperAi}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.enableWhisperAi}</span>
              <span className="setting-description">
                {t.settings.subtitles.enableWhisperAiDesc}
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={whisperAi.enabled}
                onChange={(event) =>
                  updateWhisperAi({ enabled: event.target.checked })
                }
                disabled={pipelineSaving}
              />
              <span className="slider" />
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.checkWhisperStatus}</span>
            </div>
            <button
              className="premium-button"
              type="button"
              onClick={checkWhisperStatus}
              disabled={checkingWhisper || pipelineSaving}
            >
              {checkingWhisper
                ? t.settings.subtitles.whisperChecking
                : t.settings.subtitles.checkWhisperStatus}
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.whisperTargetSeconds}</span>
              <span className="setting-description">
                {t.settings.subtitles.whisperTargetSecondsDesc} (
                {formatWhisperChunkDuration(whisperAi.batch.targetSeconds)})
              </span>
            </div>
            <input
              type="range"
              min="60"
              max="1200"
              step="60"
              value={whisperAi.batch.targetSeconds}
              onChange={(e) =>
                updateWhisperAi({
                  batch: {
                    ...whisperAi.batch,
                    targetSeconds: Number(e.target.value),
                  },
                })
              }
              disabled={pipelineSaving || !whisperAi.enabled}
              style={{ width: '150px' }}
            />
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.whisperModelId}</span>
              <span className="setting-description">
                {t.settings.subtitles.whisperModelIdDesc}
              </span>
            </div>
            <select
              className="premium-select"
              value={whisperAi.whisperModelId}
              onChange={(event) =>
                updateWhisperAi({ whisperModelId: event.target.value })
              }
              disabled={pipelineSaving || !whisperAi.enabled}
            >
              <option value="mlx-community/whisper-tiny-mlx-q4">tiny-q4 (极速)</option>
              <option value="mlx-community/whisper-base-mlx-q4">base-q4 (平衡)</option>
              <option value="mlx-community/whisper-small-mlx-q4">small-q4 (精准)</option>
              <option value="mlx-community/whisper-turbo">turbo (极速精准)</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span className="setting-label">{t.settings.subtitles.whisperPrompt}</span>
                  <span className="setting-description">
                    {t.settings.subtitles.whisperPromptDesc}
                  </span>
                </div>
              </div>
              <textarea
                className="premium-textarea"
                value={[
                  '你是精准字幕校对助手。',
                  '视频标题:{title}',
                  '频道:{channel_name}',
                  '描述摘要:{description}',
                  '规则:',
                  '1. 你会收到音频片段和每个 segment 的 whisper_text 初稿。',
                  '2. 听音频,对照 whisper_text 校正错字、漏字、专有名词和标点。',
                  '3. 不要盲从 whisper_text；如果音频和初稿冲突,以音频为准。',
                  '4. 严格保留 segment 数量和 id 一对一,不合并/不拆分/不新增。',
                  '5. 静音/音乐/无人声段将 drop 设为 true,text 可留空。',
                  '6. 出现专有名词优先参考视频标题和描述。',
                  '7. 音频前后各有 0.5 秒边界余量,不在任何 segment 范围内,忽略即可。',
                  '8. 只输出 JSON,不要任何解释。',
                  '输出 JSON 结构: {"corrections":[{"id":1,"text":"校正后的文本","drop":false}]}',
                ].join('\n')}
                disabled
                rows={11}
                style={{ marginTop: '12px', fontSize: '13px', fontFamily: 'monospace' }}
              />
            </div>
          </div>

        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.subtitles.apiFetch}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.enableApiFallback}</span>
              <span className="setting-description">
                {t.settings.subtitles.enableApiFallbackDesc}
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={apiFallback.enabled}
                onChange={(event) =>
                  updateApiFallback({ enabled: event.target.checked })
                }
                disabled={pipelineSaving}
              />
              <span className="slider" />
            </label>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.scope}</span>
              <span className="setting-description">
                {t.settings.subtitles.scopeDesc}
              </span>
            </div>
            <select
              className="premium-select"
              value={apiFallback.scope}
              onChange={(event) =>
                updateApiFallback({
                  scope: event.target.value === 'custom' ? 'custom' : 'global',
                })
              }
              disabled={pipelineSaving || !apiFallback.enabled}
            >
              <option value="global">{t.settings.subtitles.global}</option>
              <option value="custom">{t.settings.subtitles.custom}</option>
            </select>
          </div>

          {apiFallback.scope === 'global' ? (
            <>
              <div className="setting-row">
                <div className="setting-info">
                  <span className="setting-label">{t.settings.subtitles.maxWait}</span>
                  <span className="setting-description">
                    {t.settings.subtitles.maxWaitDesc}
                  </span>
                </div>
                <select
                  className="premium-select"
                  value={apiFallback.globalMaxWaitSeconds}
                  onChange={(event) =>
                    updateApiFallback({
                      globalMaxWaitSeconds: Number(event.target.value) || 0,
                    })
                  }
                  disabled={pipelineSaving || !apiFallback.enabled}
                >
                  {maxWaitOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="setting-info">
                  <span className="setting-label">{t.settings.subtitles.apiModel}</span>
                  <span className="setting-description">
                    {t.settings.subtitles.apiModelDesc}
                  </span>
                </div>
                <select
                  className="premium-select"
                  value={apiFallback.globalModelId || ''}
                  onChange={(event) =>
                    updateApiFallback({ globalModelId: event.target.value })
                  }
                  disabled={
                    pipelineSaving ||
                    !apiFallback.enabled ||
                    multimodalModels.length === 0
                  }
                >
                  {multimodalModels.length === 0 ? (
                    <option value="">{t.settings.subtitles.noMultimodalModels}</option>
                  ) : null}
                  {multimodalModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="setting-row" style={{ borderBottom: 'none' }}>
                <div className="setting-info">
                  <span className="setting-label">{t.settings.subtitles.customRules}</span>
                  <span className="setting-description">
                    {t.settings.subtitles.customRulesDesc}
                  </span>
                </div>
                <button
                  className="premium-button"
                  type="button"
                  onClick={addRule}
                  disabled={pipelineSaving || !apiFallback.enabled}
                >
                  {t.settings.subtitles.addRule}
                </button>
              </div>
              <div
                style={{
                  padding: '0 20px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                {apiFallback.customRules.length > 0 ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        '96px minmax(0, 1fr) 120px 140px auto',
                      gap: 10,
                      padding: '0 2px',
                      fontSize: 12,
                      color: '#6b7280',
                    }}
                  >
                    <span>{t.settings.subtitles.type}</span>
                    <span>{t.settings.subtitles.target}</span>
                    <HeaderHelp
                      label={t.settings.subtitles.escapeWait}
                      description={t.settings.subtitles.escapeWaitDesc}
                    />
                    <span>{t.settings.subtitles.model}</span>
                    <span>{t.settings.subtitles.actions}</span>
                  </div>
                ) : null}
                {apiFallback.customRules.length === 0 ? (
                  <div
                    style={{
                      border: '1px dashed #d1d5db',
                      borderRadius: 14,
                      padding: '16px 18px',
                      fontSize: 13,
                      color: '#6b7280',
                      background: '#fafafa',
                    }}
                  >
                    {t.settings.subtitles.noRules}
                  </div>
                ) : (
                  apiFallback.customRules.map((rule) => (
                    <div
                      key={rule.id}
                      style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 14,
                        padding: 14,
                        background: '#fff',
                        display: 'grid',
                        gridTemplateColumns:
                          '96px minmax(0, 1fr) 120px 140px auto',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <select
                        className="premium-select"
                        value={rule.targetType}
                        onChange={(event) =>
                          handleRuleTargetTypeChange(
                            rule,
                            event.target.value === 'channel'
                              ? 'channel'
                              : 'intent',
                          )
                        }
                        disabled={pipelineSaving || !apiFallback.enabled}
                      >
                        <option value="intent">{t.settings.subtitles.intent}</option>
                        <option value="channel">{t.settings.subtitles.channel}</option>
                      </select>

                      <select
                        className="premium-select"
                        value={rule.targetId}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          if (rule.targetType === 'intent') {
                            const nextIntent = intents.find(
                              (item) => String(item.id) === nextId,
                            );
                            updateRule(rule.id, {
                              targetId: nextId,
                              targetLabel: nextIntent?.name || '',
                            });
                            return;
                          }
                          const nextChannel = channelOptions.find(
                            (item) => String(item.id) === nextId,
                          );
                          updateRule(rule.id, {
                            targetId: nextId,
                            targetLabel: nextChannel
                              ? getChannelLabel(nextChannel)
                              : '',
                          });
                        }}
                        disabled={pipelineSaving || !apiFallback.enabled}
                      >
                        {(rule.targetType === 'intent'
                          ? intents
                          : channelOptions
                        ).map((item) => (
                          <option key={item.id} value={item.id}>
                            {'name' in item ? item.name : getChannelLabel(item)}
                          </option>
                        ))}
                      </select>

                      <select
                        className="premium-select"
                        value={rule.maxWaitSeconds}
                        onChange={(event) =>
                          updateRule(rule.id, {
                            maxWaitSeconds: Number(event.target.value) || 0,
                          })
                        }
                        disabled={pipelineSaving || !apiFallback.enabled}
                      >
                        {maxWaitOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>

                      <select
                        className="premium-select"
                        value={rule.modelId}
                        onChange={(event) =>
                          updateRule(rule.id, { modelId: event.target.value })
                        }
                        disabled={pipelineSaving || !apiFallback.enabled}
                      >
                        {!multimodalModels.some(
                          (model) => model.id === rule.modelId,
                        ) ? (
                          <option value={rule.modelId} disabled>
                            {models.find((model) => model.id === rule.modelId)
                              ?.name || t.settings.subtitles.noMultimodalModels}
                          </option>
                        ) : null}
                        {multimodalModels.length === 0 ? (
                          <option value="" disabled>
                            {t.settings.subtitles.noMultimodalModels}
                          </option>
                        ) : null}
                        {multimodalModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </select>

                      <button
                        className="premium-button"
                        type="button"
                        onClick={() => removeRule(rule.id)}
                        disabled={pipelineSaving || !apiFallback.enabled}
                      >
                        {t.settings.subtitles.delete}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button"
              onClick={resetPipelineDefaults}
              disabled={pipelineSaving}
              style={{ marginRight: 8 }}
            >
              {t.settings.subtitles.restoreDefault}
            </button>
            <button
              className="premium-button primary"
              onClick={savePipelineConfig}
              disabled={pipelineSaving}
            >
              {pipelineSaving ? t.settings.subtitles.savingPipeline : t.settings.subtitles.savePipeline}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.subtitles.promptTemplate}</h2>
        <div className="settings-card-group">
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.apiPrompt}</span>
              <span className="setting-description">
                {t.settings.subtitles.apiPromptDesc}
              </span>
            </div>
          </div>
          <div
            style={{
              padding: '0 20px 20px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <textarea
              className="premium-textarea"
              rows={6}
              value={subtitleApiPromptTemplate}
              onChange={(e) => setSubtitleApiPromptTemplate(e.target.value)}
              placeholder={config.defaults.subtitleApiPromptTemplate}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={restoreDefaultSubtitleApiPromptTemplate}
                disabled={
                  saving ||
                  subtitleApiPromptTemplate ===
                    (config.defaults.subtitleApiPromptTemplate || '')
                }
              >
                {t.settings.subtitles.restoreDefault}
              </button>
            </div>
          </div>

          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.subtitles.segmentPrompt}</span>
              <span className="setting-description">
                {t.settings.subtitles.segmentPromptDesc}
              </span>
            </div>
          </div>
          <div
            style={{
              padding: '0 20px 20px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <textarea
              className="premium-textarea"
              rows={5}
              value={subtitleSegmentPromptTemplate}
              onChange={(e) => setSubtitleSegmentPromptTemplate(e.target.value)}
              placeholder={config.defaults.subtitleSegmentPromptTemplate}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={restoreDefaultSubtitleSegmentPromptTemplate}
                disabled={
                  saving ||
                  subtitleSegmentPromptTemplate ===
                    (config.defaults.subtitleSegmentPromptTemplate || '')
                }
              >
                {t.settings.subtitles.restoreDefault}
              </button>
            </div>
          </div>

          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={savePrompts}
              disabled={saving}
            >
              {saving ? t.settings.subtitles.savingSettings : t.settings.subtitles.saveSettings}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getChannelLabel(channel?: ChannelOption | null): string {
  if (!channel) return '';
  const name = (channel.name || '').trim();
  const platformLabel = channel.platform === 'youtube' ? 'YouTube' : 'Bilibili';
  return name
    ? `${name} · ${platformLabel}`
    : `${channel.channel_id} · ${platformLabel}`;
}

function HeaderHelp({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span>{label}</span>
      <span
        title={description}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '1px solid #d1d5db',
          color: '#6b7280',
          fontSize: 10,
          lineHeight: 1,
          cursor: 'help',
          flexShrink: 0,
        }}
      >
        ?
      </span>
    </span>
  );
}
