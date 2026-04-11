'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ShowToast, ToastType } from '@/components/settings/shared';

interface Intent {
  id: number;
  name: string;
  auto_subtitle: number;
  auto_summary: number;
  sort_order: number;
  auto_summary_model_id: string | null;
  agent_prompt: string | null;
  agent_trigger: string | null;
  agent_schedule_time: string;
  agent_memory: string | null;
  created_at: string;
}

interface AiModel {
  id: string;
  name: string;
}

interface IntentManagementProps {
  showToast?: ShowToast;
}

export default function IntentManagement({
  showToast: externalShowToast,
}: IntentManagementProps) {
  const [intents, setIntents] = useState<Intent[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');
  const [aiModels, setAiModels] = useState<AiModel[]>([]);

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAutoSubtitle, setNewAutoSubtitle] = useState(false);
  const [newAutoSummary, setNewAutoSummary] = useState(false);
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Agent config
  const [agentExpandedId, setAgentExpandedId] = useState<number | null>(null);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentTrigger, setAgentTrigger] = useState('manual');
  const [agentScheduleTime, setAgentScheduleTime] = useState('09:00');
  const [agentMemory, setAgentMemory] = useState('');
  const [savingAgent, setSavingAgent] = useState(false);

  const showMessage = useCallback(
    (text: string, type: ToastType = 'success') => {
      if (externalShowToast) {
        externalShowToast(text, type);
        return;
      }
      setMessage(text);
      setMessageType(type);
      setTimeout(() => setMessage(null), 3000);
    },
    [externalShowToast],
  );

  const loadIntents = useCallback(async () => {
    setLoading(true);
    try {
      const [intentsRes, aiSettingsRes] = await Promise.all([
        fetch('/api/settings/intents', { cache: 'no-store' }),
        fetch('/api/settings/ai-summary', { cache: 'no-store' }),
      ]);
      if (!intentsRes.ok) throw new Error('加载失败');
      const [intentsData, aiSettingsData] = await Promise.all([
        intentsRes.json() as Promise<Intent[]>,
        aiSettingsRes.json() as Promise<{ models?: AiModel[] }>,
      ]);
      setIntents(intentsData);
      setAiModels(aiSettingsData.models || []);
    } catch {
      showMessage('无法加载意图列表', 'error');
    } finally {
      setLoading(false);
    }
  }, [showMessage]);

  useEffect(() => {
    void loadIntents();
  }, [loadIntents]);

  const handleToggle = async (
    intent: Intent,
    field: 'auto_subtitle' | 'auto_summary',
  ) => {
    const newValue = intent[field] === 1 ? 0 : 1;
    // Optimistic update
    setIntents((prev) =>
      prev.map((i) => (i.id === intent.id ? { ...i, [field]: newValue } : i)),
    );
    try {
      const res = await fetch(`/api/settings/intents/${intent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: newValue }),
      });
      if (!res.ok) {
        // Revert on failure
        setIntents((prev) =>
          prev.map((i) =>
            i.id === intent.id ? { ...i, [field]: intent[field] } : i,
          ),
        );
        const data = await res.json() as { error?: string };
        showMessage(data.error || '切换失败', 'error');
      }
    } catch {
      setIntents((prev) =>
        prev.map((i) =>
          i.id === intent.id ? { ...i, [field]: intent[field] } : i,
        ),
      );
      showMessage('切换失败', 'error');
    }
  };

  const handleModelChange = async (intent: Intent, modelId: string | null) => {
    // Optimistic update
    setIntents((prev) =>
      prev.map((i) =>
        i.id === intent.id
          ? { ...i, auto_summary_model_id: modelId }
          : i,
      ),
    );
    try {
      const res = await fetch(`/api/settings/intents/${intent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_summary_model_id: modelId }),
      });
      if (!res.ok) {
        // Revert on failure
        setIntents((prev) =>
          prev.map((i) =>
            i.id === intent.id
              ? { ...i, auto_summary_model_id: intent.auto_summary_model_id }
              : i,
          ),
        );
        const data = await res.json() as { error?: string };
        showMessage(data.error || '保存失败', 'error');
      }
    } catch {
      setIntents((prev) =>
        prev.map((i) =>
          i.id === intent.id
            ? { ...i, auto_summary_model_id: intent.auto_summary_model_id }
            : i,
        ),
      );
      showMessage('保存失败', 'error');
    }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/settings/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          auto_subtitle: newAutoSubtitle ? 1 : 0,
          auto_summary: newAutoSummary ? 1 : 0,
        }),
      });
      const data: Intent & { error?: string } = await res.json();
      if (!res.ok) {
        showMessage(data.error || '创建失败', 'error');
        return;
      }
      setIntents((prev) => {
        // Insert before 未分类
        const uncategorized = prev.find((i) => i.name === '未分类');
        if (uncategorized) {
          const idx = prev.indexOf(uncategorized);
          return [...prev.slice(0, idx), data, ...prev.slice(idx)];
        }
        return [...prev, data];
      });
      setNewName('');
      setNewAutoSubtitle(false);
      setNewAutoSummary(false);
      setShowAddForm(false);
      showMessage(`意图 "${data.name}" 已创建`);
    } catch {
      showMessage('创建失败', 'error');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (intent: Intent) => {
    setEditingId(intent.id);
    setEditName(intent.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleSaveEdit = async (intent: Intent) => {
    if (!editName.trim()) return;
    if (editName.trim() === intent.name) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/settings/intents/${intent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const data: Intent & { error?: string } = await res.json();
      if (!res.ok) {
        showMessage(data.error || '保存失败', 'error');
        return;
      }
      setIntents((prev) =>
        prev.map((i) => (i.id === intent.id ? data : i)),
      );
      cancelEdit();
      showMessage('意图名称已更新');
    } catch {
      showMessage('保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openDeleteConfirm = (intent: Intent) => {
    setDeletingId(intent.id);
    setDeleteConfirmName(intent.name);
  };

  const cancelDelete = () => {
    setDeletingId(null);
    setDeleteConfirmName('');
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/settings/intents/${deletingId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        showMessage(data.error || '删除失败', 'error');
        return;
      }
      setIntents((prev) => prev.filter((i) => i.id !== deletingId));
      showMessage(`意图 "${deleteConfirmName}" 已删除`);
      cancelDelete();
    } catch {
      showMessage('删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const toggleAgentPanel = (intent: Intent) => {
    if (agentExpandedId === intent.id) {
      setAgentExpandedId(null);
      return;
    }
    setAgentExpandedId(intent.id);
    setAgentPrompt(intent.agent_prompt || '');
    setAgentTrigger(intent.agent_trigger || 'manual');
    setAgentScheduleTime(intent.agent_schedule_time || '09:00');
    setAgentMemory(intent.agent_memory || '');
  };

  const handleSaveAgent = async (intentId: number) => {
    setSavingAgent(true);
    try {
      const res = await fetch(`/api/settings/intents/${intentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_prompt: agentPrompt || null,
          agent_trigger: agentTrigger || null,
          agent_schedule_time: agentScheduleTime || '09:00',
          agent_memory: agentMemory || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        showMessage(data.error || '保存失败', 'error');
        return;
      }
      const updated: Intent = await res.json();
      setIntents((prev) => prev.map((i) => (i.id === intentId ? updated : i)));
      showMessage('Agent 配置已保存');
    } catch {
      showMessage('保存失败', 'error');
    } finally {
      setSavingAgent(false);
    }
  };

  const handleReorder = async (intent: Intent, direction: 'up' | 'down') => {
    const currentIndex = intents.findIndex((i) => i.id === intent.id);
    if (currentIndex === -1) return;

    const newIntents = [...intents];
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    if (targetIndex < 0 || targetIndex >= newIntents.length) return;

    // Swap
    [newIntents[currentIndex], newIntents[targetIndex]] = [
      newIntents[targetIndex],
      newIntents[currentIndex],
    ];

    setIntents(newIntents);

    // Build ordered ids (excluding 未分类)
    const orderedIds = newIntents
      .filter((i) => i.name !== '未分类')
      .map((i) => i.id);

    try {
      const res = await fetch('/api/settings/intents/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: orderedIds }),
      });
      if (!res.ok) {
        showMessage('排序失败', 'error');
        // Reload to revert
        void loadIntents();
      }
    } catch {
      showMessage('排序失败', 'error');
      void loadIntents();
    }
  };

  // Determine sort control visibility
  const nonUncategorized = intents.filter((i) => i.name !== '未分类');
  const lastUserIntentId =
    nonUncategorized.length > 0
      ? nonUncategorized[nonUncategorized.length - 1].id
      : null;
  const firstIntentId = nonUncategorized.length > 0 ? nonUncategorized[0].id : null;

  return (
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
          意图列表
        </h2>
        {!showAddForm && (
          <button
            className="premium-button"
            onClick={() => setShowAddForm(true)}
            disabled={loading}
          >
            + 添加意图
          </button>
        )}
      </div>

      {showAddForm && (
        <div
          className="settings-card-group"
          style={{ marginBottom: 16, padding: '16px 20px' }}
        >
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 6,
                color: '#1a1a1a',
              }}
            >
              意图名称
            </label>
            <input
              className="premium-input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="请输入意图名称"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd();
                if (e.key === 'Escape') setShowAddForm(false);
              }}
              autoFocus
            />
          </div>
          <div
            style={{ display: 'flex', gap: 24, marginBottom: 16 }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={newAutoSubtitle}
                  onChange={(e) => setNewAutoSubtitle(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
              自动抓取字幕
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={newAutoSummary}
                  onChange={(e) => setNewAutoSummary(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
              自动生成摘要
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="premium-button primary"
              onClick={() => void handleAdd()}
              disabled={adding || !newName.trim()}
            >
              {adding ? '创建中...' : '确认创建'}
            </button>
            <button
              className="premium-button"
              onClick={() => {
                setShowAddForm(false);
                setNewName('');
                setNewAutoSubtitle(false);
                setNewAutoSummary(false);
              }}
              disabled={adding}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="settings-card-group">
        {loading ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#888',
              fontSize: 13,
            }}
          >
            加载中...
          </div>
        ) : intents.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#888',
              fontSize: 13,
            }}
          >
            暂无意图
          </div>
        ) : (
          <>
            {/* Table header */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 80px 120px 80px 80px',
                padding: '10px 20px',
                borderBottom: '1px solid oklch(0.922 0 0)',
                background: '#fafafa',
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                名称
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  textAlign: 'center',
                }}
              >
                字幕
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  textAlign: 'center',
                }}
              >
                摘要
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  textAlign: 'center',
                }}
              >
                自动模型
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  textAlign: 'center',
                }}
              >
                排序
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  textAlign: 'center',
                }}
              >
                操作
              </span>
            </div>

            {/* Table rows */}
            {intents.map((intent) => {
              const isUncategorized = intent.name === '未分类';
              const isEditing = editingId === intent.id;
              const isFirst = intent.id === firstIntentId;
              const isLastUser = intent.id === lastUserIntentId;
              const isAgentExpanded = agentExpandedId === intent.id;

              return (
                <div key={intent.id}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 80px 80px 120px 80px 80px',
                    padding: '14px 20px',
                    borderBottom: isAgentExpanded ? 'none' : '1px solid oklch(0.922 0 0)',
                    alignItems: 'center',
                    background: isUncategorized ? '#fafafa' : '#fff',
                  }}
                >
                  {/* Name column */}
                  <div style={{ minWidth: 0 }}>
                    {isEditing ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          className="premium-input"
                          style={{ maxWidth: 200 }}
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveEdit(intent);
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          autoFocus
                        />
                        <button
                          className="premium-button primary"
                          style={{ padding: '6px 10px', fontSize: 12 }}
                          onClick={() => void handleSaveEdit(intent)}
                          disabled={saving || !editName.trim()}
                        >
                          {saving ? '...' : '保存'}
                        </button>
                        <button
                          className="premium-button"
                          style={{ padding: '6px 10px', fontSize: 12 }}
                          onClick={cancelEdit}
                          disabled={saving}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: isUncategorized ? 500 : 600,
                          color: isUncategorized ? '#888' : '#1a1a1a',
                        }}
                      >
                        {intent.name}
                      </span>
                    )}
                  </div>

                  {/* Auto subtitle toggle */}
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <label className="premium-toggle">
                      <input
                        type="checkbox"
                        checked={intent.auto_subtitle === 1}
                        onChange={() => void handleToggle(intent, 'auto_subtitle')}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  {/* Auto summary toggle */}
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <label className="premium-toggle">
                      <input
                        type="checkbox"
                        checked={intent.auto_summary === 1}
                        onChange={() => void handleToggle(intent, 'auto_summary')}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  {/* Auto model selector */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                    }}
                  >
                    {intent.auto_summary === 1 ? (
                      <select
                        className="premium-select"
                        style={{
                          fontSize: 11,
                          padding: '2px 4px',
                          width: '100%',
                          maxWidth: 110,
                        }}
                        value={intent.auto_summary_model_id || ''}
                        onChange={(e) =>
                          void handleModelChange(
                            intent,
                            e.target.value || null,
                          )
                        }
                      >
                        <option value="">使用全局自动模型</option>
                        {aiModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ fontSize: 12, color: '#aaa' }}>—</span>
                    )}
                  </div>

                  {/* Sort controls */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      gap: 2,
                    }}
                  >
                    {!isUncategorized && (
                      <>
                        {!isFirst && (
                          <button
                            title="上移"
                            style={{
                              background: 'none',
                              border: '1px solid oklch(0.922 0 0)',
                              borderRadius: 6,
                              padding: '3px 7px',
                              fontSize: 12,
                              cursor: 'pointer',
                              lineHeight: 1,
                            }}
                            onClick={() => void handleReorder(intent, 'up')}
                          >
                            ↑
                          </button>
                        )}
                        {!isLastUser && (
                          <button
                            title="下移"
                            style={{
                              background: 'none',
                              border: '1px solid oklch(0.922 0 0)',
                              borderRadius: 6,
                              padding: '3px 7px',
                              fontSize: 12,
                              cursor: 'pointer',
                              lineHeight: 1,
                            }}
                            onClick={() => void handleReorder(intent, 'down')}
                          >
                            ↓
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    {!isUncategorized && (
                      <>
                        <button
                          title="Agent 配置"
                          style={{
                            background: isAgentExpanded ? 'oklch(0.95 0.02 250)' : intent.agent_prompt ? 'oklch(0.95 0.02 150)' : 'none',
                            border: isAgentExpanded ? '1px solid oklch(0.7 0.1 250)' : intent.agent_prompt ? '1px solid oklch(0.7 0.1 150)' : '1px solid oklch(0.922 0 0)',
                            borderRadius: 6,
                            padding: '3px 7px',
                            fontSize: 11,
                            cursor: 'pointer',
                            lineHeight: 1,
                            fontWeight: 600,
                          }}
                          onClick={() => toggleAgentPanel(intent)}
                        >
                          AI
                        </button>
                        <button
                          title="编辑名称"
                          style={{
                            background: 'none',
                            border: '1px solid oklch(0.922 0 0)',
                            borderRadius: 6,
                            padding: '3px 7px',
                            fontSize: 13,
                            cursor: 'pointer',
                            lineHeight: 1,
                          }}
                          onClick={() => startEdit(intent)}
                        >
                          ✎
                        </button>
                        <button
                          title="删除"
                          style={{
                            background: 'none',
                            border: '1px solid #fca5a5',
                            borderRadius: 6,
                            padding: '3px 7px',
                            fontSize: 13,
                            cursor: 'pointer',
                            color: '#ef4444',
                            lineHeight: 1,
                          }}
                          onClick={() => openDeleteConfirm(intent)}
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Agent config panel */}
                {isAgentExpanded && (
                  <div
                    style={{
                      padding: '16px 20px 20px',
                      background: 'oklch(0.98 0.005 250)',
                      borderBottom: '1px solid oklch(0.922 0 0)',
                    }}
                  >
                    <div style={{ marginBottom: 14 }}>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
                        Agent 指令
                      </label>
                      <textarea
                        className="premium-input"
                        style={{ width: '100%', minHeight: 80, resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
                        value={agentPrompt}
                        onChange={(e) => setAgentPrompt(e.target.value)}
                        placeholder="描述你希望 agent 完成的任务，例如：&#10;帮我总结该意图下今天的视频热点，整理不同看法..."
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 20, marginBottom: 14, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
                          触发方式
                        </label>
                        <select
                          className="premium-select"
                          style={{ width: '100%', fontSize: 13 }}
                          value={agentTrigger}
                          onChange={(e) => setAgentTrigger(e.target.value)}
                        >
                          <option value="manual">手动触发</option>
                          <option value="daily">每日自动</option>
                          <option value="on_new_videos">有新视频时</option>
                        </select>
                      </div>
                      {agentTrigger === 'daily' && (
                        <div style={{ width: 120 }}>
                          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
                            执行时间
                          </label>
                          <input
                            className="premium-input"
                            type="time"
                            style={{ width: '100%', fontSize: 13 }}
                            value={agentScheduleTime}
                            onChange={(e) => setAgentScheduleTime(e.target.value)}
                          />
                        </div>
                      )}
                    </div>

                    <div style={{ marginBottom: 14 }}>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
                        Agent 记忆
                        <span style={{ fontWeight: 400, color: '#999', marginLeft: 8 }}>
                          agent 会自动写入和更新，你也可以手动编辑
                        </span>
                      </label>
                      <textarea
                        className="premium-input"
                        style={{ width: '100%', minHeight: 60, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, color: '#666' }}
                        value={agentMemory}
                        onChange={(e) => setAgentMemory(e.target.value)}
                        placeholder="agent 尚未写入记忆"
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        className="premium-button"
                        onClick={() => setAgentExpandedId(null)}
                        disabled={savingAgent}
                      >
                        取消
                      </button>
                      <button
                        className="premium-button primary"
                        onClick={() => void handleSaveAgent(intent.id)}
                        disabled={savingAgent}
                      >
                        {savingAgent ? '保存中...' : '保存 Agent 配置'}
                      </button>
                    </div>
                  </div>
                )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deletingId !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 16,
              padding: 28,
              maxWidth: 400,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.16)',
            }}
          >
            <h3
              style={{
                fontSize: 17,
                fontWeight: 700,
                marginBottom: 12,
                color: '#1a1a1a',
              }}
            >
              删除意图
            </h3>
            <p style={{ fontSize: 14, color: '#444', marginBottom: 20, lineHeight: 1.6 }}>
              确定要删除意图{' '}
              <strong>&ldquo;{deleteConfirmName}&rdquo;</strong>{' '}
              吗？该意图下的所有频道将被归入{' '}
              <strong>未分类</strong>。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={cancelDelete}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="premium-button"
                style={{
                  background: '#ef4444',
                  color: '#fff',
                  borderColor: '#ef4444',
                }}
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast message */}
      {!externalShowToast && message && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            padding: '12px 20px',
            background: messageType === 'error' ? '#ef4444' : '#000',
            color: '#fff',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontSize: 13,
            zIndex: 1001,
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}
