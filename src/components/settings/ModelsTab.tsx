'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';
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
  const t = useT();

  useEffect(() => {
    void load().catch(() => showToast(t.settings.models.toastReadFailed, 'error'));
  }, [load, showToast, t]);

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
  const t = useT();
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
        name: t.settings.models.newModel,
        endpoint: '',
        apiKey: '',
        model: '',
        isMultimodal: false,
        protocol: 'openai-chat',
      },
    ]);
  };

  const handleRemoveModel = (index: number) => {
    setModels((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleUpdateModel = <K extends keyof AiSummaryModelConfig>(
    index: number,
    field: K,
    value: AiSummaryModelConfig[K],
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
      showToast(t.settings.models.toastSaveSuccess);
    } catch (error) {
      const message = error instanceof Error && error.message !== 'SAVE_FAILED' ? error.message : t.settings.models.toastSaveError;
      showToast(message, 'error');
    }
  };

  const handleTest = async () => {
    try {
      await onTest(buildPayload());
      showToast(t.settings.models.toastTestSuccess);
    } catch (error) {
      showToast(
        error instanceof Error
          ? `${t.settings.models.toastTestFailed}${error.message}`
          : t.settings.models.toastTestNetworkError,
        'error',
      );
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.models.defaultApiConfig}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.models.apiEndpoint}</span>
              <span className="setting-description">{t.settings.models.apiEndpointDesc}</span>
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
              <span className="setting-label">{t.settings.models.apiKey}</span>
              <span className="setting-description">{t.settings.models.apiKeyDesc}</span>
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
                {showApiKey ? t.settings.models.hide : t.settings.models.show}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.models.defaultModelName}</span>
              <span className="setting-description">
                {t.settings.models.defaultModelNameDesc}
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
              {testing ? t.settings.models.testing : t.settings.models.testConnection}
            </button>
            <button
              className="premium-button primary"
              onClick={handleSave}
              disabled={saving || testing}
            >
              {saving ? t.settings.models.saving : t.settings.models.saveConfig}
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
            {t.settings.models.multiModelManagement}
          </h2>
          <button className="premium-button" onClick={handleAddModel}>
            {t.settings.models.addModel}
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
              {t.settings.models.noModels}
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
                    {t.settings.models.delete}
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
                    placeholder={t.settings.models.endpointPlaceholder}
                    value={item.endpoint}
                    onChange={(e) =>
                      handleUpdateModel(index, 'endpoint', e.target.value)
                    }
                  />
                  <input
                    className="premium-input"
                    placeholder={t.settings.models.modelNamePlaceholder}
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: '#374151',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={item.isMultimodal !== false}
                      onChange={(e) =>
                        handleUpdateModel(
                          index,
                          'isMultimodal',
                          e.target.checked,
                        )
                      }
                    />
                    {t.settings.models.multimodal}
                  </label>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: '#374151',
                      opacity: item.isMultimodal === false ? 0.5 : 1,
                    }}
                  >
                    {t.settings.models.protocol}
                    <select
                      className="premium-input"
                      style={{ padding: '4px 8px' }}
                      value={item.protocol || 'gemini'}
                      disabled={item.isMultimodal === false}
                      onChange={(e) =>
                        handleUpdateModel(
                          index,
                          'protocol',
                          e.target.value as AiSummaryModelConfig['protocol'],
                        )
                      }
                    >
                      <option value="gemini">Gemini</option>
                      <option value="openai-chat">OpenAI 兼容</option>
                      <option value="anthropic-messages">Anthropic 兼容</option>
                    </select>
                  </label>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title" style={{ marginBottom: 16 }}>
          {t.settings.models.sharedBudget}
        </h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.models.rpm}</span>
              <span className="setting-description">
                {t.settings.models.rpmDesc}
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
              <span className="setting-label">{t.settings.models.rpd}</span>
              <span className="setting-description">
                {t.settings.models.rpdDesc}
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
              <span className="setting-label">{t.settings.models.tpm}</span>
              <span className="setting-description">
                {t.settings.models.tpmDesc}
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
              <span className="setting-label">{t.settings.models.subtitleFallbackReserve}</span>
              <span className="setting-description">
                {t.settings.models.subtitleFallbackReserveDesc}
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
