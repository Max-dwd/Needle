'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AiSummaryConfig,
  ShowToast,
  SubtitleApiFallbackConfig,
  SubtitleApiFallbackRule,
  SubtitleBrowserFetchConfig,
  SubtitlePipelineSettingsResponse,
} from './shared';
import {
  maxRetryOptions,
  maxWaitOptions,
  subtitleIntervalOptions,
  useAiSettings,
} from './shared';
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
  customRules: [],
  updatedAt: null,
};

const DEFAULT_BROWSER_FETCH_CONFIG: SubtitleBrowserFetchConfig = {
  maxRetries: 2,
  updatedAt: null,
};

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

  useEffect(() => {
    void load().catch(() => showToast('无法读取 AI 总结设置', 'error'));
  }, [load, showToast]);

  useEffect(() => {
    const loadPipeline = async () => {
      setPipelineLoading(true);
      try {
        const [pipelineRes, intentsRes, channelsRes] = await Promise.all([
          fetch('/api/settings/subtitle-pipeline', { cache: 'no-store' }),
          fetch('/api/settings/intents', { cache: 'no-store' }),
          fetch('/api/channels', { cache: 'no-store' }),
        ]);
        if (!pipelineRes.ok) throw new Error('无法读取字幕链路配置');
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
        showToast('无法读取字幕链路配置', 'error');
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

  const models = config.models || [];
  const apiFallback = pipelineConfig.apiFallback || DEFAULT_API_FALLBACK_CONFIG;
  const browserFetch =
    pipelineConfig.browserFetch || DEFAULT_BROWSER_FETCH_CONFIG;
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
    subtitleInterval?: number;
  }) => {
    onPipelineConfigChange({
      ...pipelineConfig,
      ...next,
      apiFallback: { ...apiFallback, ...(next.apiFallback || {}) },
      browserFetch: { ...browserFetch, ...(next.browserFetch || {}) },
    });
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
      showToast('字幕设置已保存');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '保存失败，请稍后重试',
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
          apiFallback: {
            enabled: apiFallback.enabled,
            scope: apiFallback.scope,
            globalMaxWaitSeconds: apiFallback.globalMaxWaitSeconds,
            customRules: apiFallback.customRules,
          },
        }),
      });
      const data = (await res.json()) as SubtitlePipelineSettingsResponse & {
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error || '保存字幕链路失败', 'error');
        return;
      }
      onPipelineConfigChange(data);
      showToast('字幕链路配置已保存');
    } catch {
      showToast('保存字幕链路失败，请稍后重试', 'error');
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
          apiFallback: DEFAULT_API_FALLBACK_CONFIG,
        }),
      });
      const data = (await res.json()) as SubtitlePipelineSettingsResponse & {
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error || '重置字幕链路失败', 'error');
        return;
      }
      onPipelineConfigChange(data);
      showToast('字幕链路已恢复默认配置');
    } catch {
      showToast('重置字幕链路失败，请稍后重试', 'error');
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
    const defaultModel = models[0];
    if (!defaultModel || (!defaultIntent && !defaultChannel)) {
      showToast('请先配置模型，并至少存在一个意图或频道', 'error');
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
    showToast('已恢复字幕 API 默认模板，请保存配置以生效');
  };

  const restoreDefaultSubtitleSegmentPromptTemplate = () => {
    setSubtitleSegmentPromptTemplate(
      config.defaults.subtitleSegmentPromptTemplate || '',
    );
    showToast('已恢复分块字幕补充模板，请保存配置以生效');
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">浏览器字幕抓取</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">基础抓取间隔</span>
              <span className="setting-description">
                所有 browser 字幕任务共享同一个串行队列，但 YouTube / Bilibili
                会分别累积退避倍数和等待间隔。
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
              <span className="setting-label">最大重试次数</span>
              <span className="setting-description">
                browser
                单次失败后会重新入队，不会阻塞后续视频。这里配置每个视频最多追加多少次
                browser 重试。
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
              <span className="setting-label">当前退避状态</span>
              <span className="setting-description">
                连续 temporary-error
                会按平台单独放大间隔；对应平台成功一次后自动重置。
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
                    连续错误 {pipelineConfig.backoff[id].consecutiveErrors}
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
        <h2 className="settings-group-title">API 提取字幕</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">启用 API fallback</span>
              <span className="setting-description">
                高价值视频等待超时且 AI budget 可用时可提前逃逸到
                API；重试全部用完后也会走 API 兜底。
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
              <span className="setting-label">生效范围</span>
              <span className="setting-description">
                全局对所有视频生效；自定义只对列表中命中的频道或意图生效。
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
              <option value="global">全局</option>
              <option value="custom">自定义</option>
            </select>
          </div>

          {apiFallback.scope === 'global' ? (
            <>
              <div className="setting-row">
                <div className="setting-info">
                  <span className="setting-label">最大等待时间</span>
                  <span className="setting-description">
                    累计等待超过这个阈值后，如果 AI budget
                    有余量，就会提前逃逸到 API。
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
            </>
          ) : (
            <>
              <div className="setting-row" style={{ borderBottom: 'none' }}>
                <div className="setting-info">
                  <span className="setting-label">自定义规则</span>
                  <span className="setting-description">
                    只有命中的意图或频道，才会启用 API
                    逃逸与兜底。每条规则可独立配置最大等待时间和模型。
                  </span>
                </div>
                <button
                  className="premium-button"
                  type="button"
                  onClick={addRule}
                  disabled={pipelineSaving || !apiFallback.enabled}
                >
                  添加规则
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
                    <span>类型</span>
                    <span>对象</span>
                    <HeaderHelp
                      label="逃逸等待"
                      description="累计等待超过这个时间后，如果 AI budget 有余量，就允许直接改走 API。"
                    />
                    <span>模型</span>
                    <span>操作</span>
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
                    还没有自定义规则。未加入列表的频道和意图，默认不会使用 API
                    提取字幕。
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
                        <option value="intent">意图</option>
                        <option value="channel">频道</option>
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
                        {models.map((model) => (
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
                        删除
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
              恢复默认
            </button>
            <button
              className="premium-button primary"
              onClick={savePipelineConfig}
              disabled={pipelineSaving}
            >
              {pipelineSaving ? '正在保存...' : '保存链路'}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">字幕 Prompt 模板</h2>
        <div className="settings-card-group">
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">字幕 API Prompt 模板</span>
              <span className="setting-description">
                用于 API 提取字幕时的提示词。
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
                恢复默认
              </button>
            </div>
          </div>

          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">分块字幕补充 Prompt</span>
              <span className="setting-description">
                仅在长视频按片段抓字幕时追加到主模板后面。
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
                恢复默认
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
              {saving ? '正在保存...' : '保存配置'}
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
