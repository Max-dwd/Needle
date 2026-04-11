'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';
import type { AiSummaryConfig, ShowToast } from './shared';
import { useAiSettings } from './shared';

interface SummaryTabProps {
  showToast: ShowToast;
}

export default function SummaryTab({ showToast }: SummaryTabProps) {
  const { config, loading, saving, load, savePartial } = useAiSettings();
  const t = useT();

  useEffect(() => {
    void load().catch(() => showToast(t.settings.summary.toastReadFailed, 'error'));
  }, [load, showToast, t]);

  if (loading && !config) {
    return null;
  }

  if (!config) {
    return null;
  }

  return (
    <SummaryTabForm
      key={config.updatedAt || 'summary'}
      config={config}
      saving={saving}
      onSave={savePartial}
      showToast={showToast}
    />
  );
}

interface SummaryTabFormProps {
  config: AiSummaryConfig;
  saving: boolean;
  onSave: ReturnType<typeof useAiSettings>['savePartial'];
  showToast: ShowToast;
}

function SummaryTabForm({
  config,
  saving,
  onSave,
  showToast,
}: SummaryTabFormProps) {
  const t = useT();
  const [promptTemplate, setPromptTemplate] = useState(
    config.promptTemplates?.default ||
      config.promptTemplate ||
      config.defaults.promptTemplate ||
      '',
  );
  const [chatObsidianPromptTemplate, setChatObsidianPromptTemplate] = useState(
    config.promptTemplates?.chatObsidian || config.defaults.chatObsidianPromptTemplate || '',
  );
  const [chatRoastPromptTemplate, setChatRoastPromptTemplate] = useState(
    config.promptTemplates?.chatRoast || config.defaults.chatRoastPromptTemplate || '',
  );
  const [defaultModelId, setDefaultModelId] = useState<string | null>(
    config.defaultModelId || null,
  );
  const [autoDefaultModelId, setAutoDefaultModelId] = useState<string | null>(
    config.autoDefaultModelId || null,
  );

  const restoreDefaultPromptTemplate = () => {
    setPromptTemplate(config?.defaults.promptTemplate || '');
    showToast(t.settings.summary.toastRestoreDefault);
  };

  const restoreDefaultObsidianPrompt = () => {
    setChatObsidianPromptTemplate(config?.defaults.chatObsidianPromptTemplate || '');
    showToast(t.settings.summary.toastRestoreDefaultObsidian);
  };

  const restoreDefaultRoastPrompt = () => {
    setChatRoastPromptTemplate(config?.defaults.chatRoastPromptTemplate || '');
    showToast(t.settings.summary.toastRestoreDefaultRoast);
  };

  const handleSave = async () => {
    try {
      await onSave({
        promptTemplate,
        promptTemplates: { 
            default: promptTemplate,
            chatObsidian: chatObsidianPromptTemplate,
            chatRoast: chatRoastPromptTemplate
        },
        defaultModelId,
        autoDefaultModelId,
      });
      showToast(t.settings.summary.toastSaveSuccess);
    } catch (error) {
      const message = error instanceof Error && error.message !== 'SAVE_FAILED' ? error.message : t.settings.summary.toastSaveError;
      showToast(message, 'error');
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.summary.summaryTemplateSection}</h2>
        <div className="settings-card-group">
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.summary.defaultSummary}</span>
              <span className="setting-description">
                {t.settings.summary.defaultSummaryDesc}
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
              rows={8}
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder={config?.defaults.promptTemplate}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={restoreDefaultPromptTemplate}
                disabled={
                  saving ||
                  promptTemplate === (config?.defaults.promptTemplate || '')
                }
              >
                {t.settings.summary.restoreDefault}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.summary.qaTemplateSection}</h2>
        <div className="settings-card-group">
          {/* Obsidian Mode */}
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.summary.obsidianMode}</span>
              <span className="setting-description">
                {t.settings.summary.obsidianModeDesc}
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
              value={chatObsidianPromptTemplate}
              onChange={(e) => setChatObsidianPromptTemplate(e.target.value)}
              placeholder={config?.defaults.chatObsidianPromptTemplate}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={restoreDefaultObsidianPrompt}
                disabled={
                  saving ||
                  chatObsidianPromptTemplate === (config?.defaults.chatObsidianPromptTemplate || '')
                }
              >
                {t.settings.summary.restoreDefault}
              </button>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '0 20px' }} />

          {/* Roast Mode */}
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.summary.roastMode}</span>
              <span className="setting-description">
                {t.settings.summary.roastModeDesc}
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
              value={chatRoastPromptTemplate}
              onChange={(e) => setChatRoastPromptTemplate(e.target.value)}
              placeholder={config?.defaults.chatRoastPromptTemplate}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={restoreDefaultRoastPrompt}
                disabled={
                  saving ||
                  chatRoastPromptTemplate === (config?.defaults.chatRoastPromptTemplate || '')
                }
              >
                {t.settings.summary.restoreDefault}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.summary.defaultModelSection}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.summary.manualModel}</span>
              <span className="setting-description">
                {t.settings.summary.manualModelDesc}
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <select
                className="premium-select"
                value={defaultModelId || ''}
                onChange={(e) => setDefaultModelId(e.target.value || null)}
                style={{ width: '100%' }}
                disabled={saving}
              >
                <option value="">{t.settings.summary.selectModel}</option>
                {(config?.models || []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.summary.autoModel}</span>
              <span className="setting-description">
                {t.settings.summary.autoModelDesc}
              </span>
            </div>
            <div className="setting-control-wrapper" style={{ width: 240 }}>
              <select
                className="premium-select"
                value={autoDefaultModelId || ''}
                onChange={(e) => setAutoDefaultModelId(e.target.value || null)}
                style={{ width: '100%' }}
                disabled={saving}
              >
                <option value="">{t.settings.summary.selectModel}</option>
                {(config?.models || []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t.settings.summary.saving : t.settings.summary.saveConfig}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
