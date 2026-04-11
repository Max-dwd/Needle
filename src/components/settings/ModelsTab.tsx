'use client';

import { useEffect, useState } from 'react';
import type { AiSummaryConfig, AiSummaryModelConfig, ShowToast } from './shared';
import { useAiSettings } from './shared';

interface ModelsTabProps {
  showToast: ShowToast;
}

export default function ModelsTab({ showToast }: ModelsTabProps) {
  const {
    config,
    loading,
    saving,
    testing,
    load,
    savePartial,
    testConnection,
  } = useAiSettings();

  useEffect(() => {
    void load().catch(() => showToast('无法读取 AI 总结设置', 'error'));
  }, [load, showToast]);

  if (loading && !config) {
    return null;
  }

  if (!config) {
    return null;
  }

  return (
    <ModelsTabForm
      key={config.updatedAt || 'models'}
      config={config}
      saving={saving}
      testing={testing}
      onSave={savePartial}
      onTest={testConnection}
      showToast={showToast}
    />
  );
}

interface ModelsTabFormProps {
  config: AiSummaryConfig;
  saving: boolean;
  testing: boolean;
  onSave: ReturnType<typeof useAiSettings>['savePartial'];
  onTest: ReturnType<typeof useAiSettings>['testConnection'];
  showToast: ShowToast;
}

function ModelsTabForm({
  config,
  saving,
  testing,
  onSave,
  onTest,
  showToast,
}: ModelsTabFormProps) {
  const [endpoint, setEndpoint] = useState(config.endpoint || '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.model || '');
  const [models, setModels] = useState<AiSummaryModelConfig[]>(config.models || []);
  const [sharedRpm, setSharedRpm] = useState(
    config.sharedRequestsPerMinute || 10,
  );
  const [sharedRpd, setSharedRpd] = useState(
    config.sharedRequestsPerDay || 1000,
  );
  const [sharedTpm, setSharedTpm] = useState(
    config.sharedTokensPerMinute || 1000000,
  );
  const [subtitleFallbackTokenReserve, setSubtitleFallbackTokenReserve] =
    useState(config.subtitleFallbackTokenReserve || 120000);
  const [showApiKey, setShowApiKey] = useState(false);

  const handleAddModel = () => {
    setModels((current) => [
      ...current,
      {
        id: Math.random().toString(36).slice(2),
        name: '新模型',
        endpoint: '',
        apiKey: '',
        model: '',
      },
    ]);
  };

  const handleRemoveModel = (index: number) => {
    setModels((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleUpdateModel = (
    index: number,
    field: keyof AiSummaryModelConfig,
    value: string,
  ) => {
    setModels((current) =>
      current.map((item, currentIndex) =>
        currentIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const buildPayload = () => {
    const targetModelId = config?.defaultModelId || models[0]?.id || null;
    const mergedModels = models.map((item) => {
      if (!targetModelId || item.id !== targetModelId) {
        return item;
      }
      return {
        ...item,
        endpoint,
        apiKey: apiKey || item.apiKey,
        model,
      };
    });

    return {
      endpoint,
      apiKey,
      model,
      models: mergedModels,
      sharedRequestsPerMinute: sharedRpm,
      sharedRequestsPerDay: sharedRpd,
      sharedTokensPerMinute: sharedTpm,
      subtitleFallbackTokenReserve,
    };
  };

  const handleSave = async () => {
    try {
      await onSave(buildPayload());
      showToast('模型配置已保存');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '保存失败，请稍后重试',
        'error',
      );
    }
  };

  const handleTest = async () => {
    try {
      await onTest(buildPayload());
      showToast('连接测试成功！模型响应正常。');
    } catch (error) {
      showToast(
        error instanceof Error
          ? `连接测试失败：${error.message}`
          : '连接测试失败，请检查网络',
        'error',
      );
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">默认 AI 接口配置</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">API Endpoint</span>
              <span className="setting-description">AI 服务商的接口地址。</span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 400 }}>
              <input
                type="text"
                className="premium-input"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={config?.defaults.endpoint || 'https://api.openai.com/v1'}
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">API Key</span>
              <span className="setting-description">用于身份验证的密钥。</span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 400 }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                className="premium-input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.apiKeyMasked || 'sk-...'}
              />
              <button
                className="premium-button"
                onClick={() => setShowApiKey((current) => !current)}
                type="button"
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">默认模型名</span>
              <span className="setting-description">
                当前手动总结默认模型对应的模型名称。
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 400 }}>
              <input
                type="text"
                className="premium-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={config?.defaults.model || 'gpt-4o-mini'}
              />
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button"
              onClick={handleTest}
              disabled={saving || testing}
              style={{ marginRight: 8 }}
            >
              {testing ? '测试中...' : '测试连接'}
            </button>
            <button
              className="premium-button primary"
              onClick={handleSave}
              disabled={saving || testing}
            >
              {saving ? '正在保存...' : '保存配置'}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 className="settings-group-title" style={{ margin: 0 }}>
            多模型管理
          </h2>
          <button className="premium-button" onClick={handleAddModel}>
            + 添加模型
          </button>
        </div>
        <div className="settings-card-group">
          {models.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: 'center',
                color: '#888',
                fontSize: 13,
              }}
            >
              尚未添加备选模型。
            </div>
          ) : (
            models.map((item, index) => (
              <div
                key={item.id || index}
                className="setting-row"
                style={{
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <input
                    className="premium-input"
                    style={{
                      fontWeight: 600,
                      border: 'none',
                      background: 'transparent',
                      paddingLeft: 0,
                      fontSize: 15,
                    }}
                    value={item.name}
                    onChange={(e) =>
                      handleUpdateModel(index, 'name', e.target.value)
                    }
                  />
                  <button
                    className="premium-button"
                    style={{ color: '#ef4444' }}
                    onClick={() => handleRemoveModel(index)}
                  >
                    删除
                  </button>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 12,
                  }}
                >
                  <input
                    className="premium-input"
                    placeholder="Endpoint"
                    value={item.endpoint}
                    onChange={(e) =>
                      handleUpdateModel(index, 'endpoint', e.target.value)
                    }
                  />
                  <input
                    className="premium-input"
                    placeholder="Model Name"
                    value={item.model}
                    onChange={(e) =>
                      handleUpdateModel(index, 'model', e.target.value)
                    }
                  />
                </div>
                <input
                  className="premium-input"
                  type="password"
                  placeholder={item.apiKeyMasked || 'API Key'}
                  value={item.apiKey}
                  onChange={(e) =>
                    handleUpdateModel(index, 'apiKey', e.target.value)
                  }
                />
              </div>
            ))
          )}
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title" style={{ marginBottom: 16 }}>
          共享预算
        </h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">每分钟请求上限</span>
              <span className="setting-description">
                总结和字幕 fallback 共享的 RPM。
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <input
                type="number"
                min={1}
                className="premium-input"
                value={sharedRpm}
                onChange={(e) =>
                  setSharedRpm(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">每日请求上限</span>
              <span className="setting-description">
                总结和字幕 fallback 共享的近 24 小时 RPD。
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <input
                type="number"
                min={1}
                className="premium-input"
                value={sharedRpd}
                onChange={(e) =>
                  setSharedRpd(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">每分钟 Token 上限</span>
              <span className="setting-description">
                总结和字幕 fallback 共享的 TPM。
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <input
                type="number"
                min={1}
                className="premium-input"
                value={sharedTpm}
                onChange={(e) =>
                  setSharedTpm(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">字幕 fallback 预留 Token</span>
              <span className="setting-description">
                字幕转录先按保守值占用预算，返回 usage 后自动校正。
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <input
                type="number"
                min={1}
                className="premium-input"
                value={subtitleFallbackTokenReserve}
                onChange={(e) =>
                  setSubtitleFallbackTokenReserve(
                    Math.max(1, Number(e.target.value) || 1),
                  )
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
