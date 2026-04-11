'use client';

import { useEffect, useState } from 'react';
import type { AiSummaryConfig, ShowToast } from './shared';
import { useAiSettings } from './shared';

interface SummaryTabProps {
  showToast: ShowToast;
}

export default function SummaryTab({ showToast }: SummaryTabProps) {
  const { config, loading, saving, load, savePartial } = useAiSettings();

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
    showToast('已恢复默认预览总结模板，请保存配置以生效');
  };

  const restoreDefaultObsidianPrompt = () => {
    setChatObsidianPromptTemplate(config?.defaults.chatObsidianPromptTemplate || '');
    showToast('已恢复默认笔记模式模板，请保存配置以生效');
  };

  const restoreDefaultRoastPrompt = () => {
    setChatRoastPromptTemplate(config?.defaults.chatRoastPromptTemplate || '');
    showToast('已恢复默认吐槽模式模板，请保存配置以生效');
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
      showToast('设置已保存');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '保存失败，请稍后重试',
        'error',
      );
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">摘要 Prompt 模板</h2>
        <div className="settings-card-group">
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">视频摘要 (默认)</span>
              <span className="setting-description">
                自定义视频预览页摘要生成的系统指令。
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
                恢复默认
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">视频问答 Prompt 模板</h2>
        <div className="settings-card-group">
          {/* Obsidian Mode */}
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">笔记模式 (Obsidian)</span>
              <span className="setting-description">
                选定片段后，生成结构化 Markdown 笔记的指令。
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
                恢复默认
              </button>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '0 20px' }} />

          {/* Roast Mode */}
          <div className="setting-row" style={{ borderBottom: 'none' }}>
            <div className="setting-info">
              <span className="setting-label">吐槽模式 (Roast)</span>
              <span className="setting-description">
                选定片段后，生成犀利评论卡片原型的指令。
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
                恢复默认
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">默认模型设置</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">手动总结模型</span>
              <span className="setting-description">
                点击视频「生成总结」按钮时使用的模型。
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
                <option value="">-- 选择模型 --</option>
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
              <span className="setting-label">自动总结模型</span>
              <span className="setting-description">
                自动化触发总结时使用的默认模型。
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
                <option value="">-- 选择模型 --</option>
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
              {saving ? '正在保存...' : '保存配置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
