'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus, ShowToast } from './shared';

interface BilibiliSummaryTabProps {
  showToast: ShowToast;
}

export default function BilibiliSummaryTab({
  showToast,
}: BilibiliSummaryTabProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [bilibiliSummaryEnabled, setBilibiliSummaryEnabled] = useState(true);
  const [sessdata, setSessdata] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/bilibili-auth', {
        cache: 'no-store',
      });
      const data = (await res.json()) as AuthStatus;
      setStatus(data);
      setBilibiliSummaryEnabled(Boolean(data.enabled ?? true));
    } catch {
      showToast('无法读取当前 B 站登录态状态', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const saveSessdata = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/bilibili-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessdata }),
      });
      const data = (await res.json()) as AuthStatus & { message?: string };
      if (!res.ok) {
        setStatus(data);
        showToast(data.message || '保存失败', 'error');
        return;
      }
      setStatus(data);
      setSessdata('');
      showToast('SESSDATA 已保存并通过校验');
    } catch {
      showToast('保存失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  };

  const clearSessdata = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/bilibili-auth', {
        method: 'DELETE',
      });
      const data = (await res.json()) as AuthStatus;
      setStatus(data);
      setSessdata('');
      showToast('已清除已保存的 SESSDATA');
    } catch {
      showToast('清除失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleBilibiliSummary = async () => {
    const nextEnabled = !bilibiliSummaryEnabled;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/bilibili-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await res.json()) as AuthStatus;
      if (!res.ok) {
        showToast('切换 B 站 AI 总结开关失败', 'error');
        return;
      }
      setStatus(data);
      setBilibiliSummaryEnabled(Boolean(data.enabled ?? nextEnabled));
      showToast(nextEnabled ? 'B 站 AI 总结已开启' : 'B 站 AI 总结已关闭');
    } catch {
      showToast('切换 B 站 AI 总结开关失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">B 站 AI 总结登录态</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">启用 B 站 AI 总结</span>
              <span className="setting-description">
                关闭后不再携带 SESSDATA 请求 B 站 AI 总结接口。
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={bilibiliSummaryEnabled}
                  onChange={toggleBilibiliSummary}
                  disabled={saving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div className="setting-row">
            <div
              className="setting-info"
              style={{ opacity: bilibiliSummaryEnabled ? 1 : 0.5 }}
            >
              <span className="setting-label">当前状态</span>
              <span className="setting-description">
                用于访问 B 站 AI 总结 API 的 SESSDATA 状态。
              </span>
            </div>
            <div className="setting-control-wrapper">
              <span
                className={`status-badge-premium status-${bilibiliSummaryEnabled ? status?.state || 'missing' : 'missing'}`}
              >
                {bilibiliSummaryEnabled
                  ? status?.message || '未配置 SESSDATA'
                  : '功能已关闭'}
              </span>
              <button
                className="premium-button"
                onClick={() => void loadStatus()}
                disabled={loading || saving}
              >
                {loading ? '正在检查...' : '刷新'}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div
              className="setting-info"
              style={{ opacity: bilibiliSummaryEnabled ? 1 : 0.5 }}
            >
              <span className="setting-label">SESSDATA</span>
              <span className="setting-description">
                从浏览器 Cookie 中获取的值。
              </span>
            </div>
            <div
              className="setting-control-wrapper"
              style={{ width: '100%', maxWidth: 300 }}
            >
              <input
                type="password"
                className="premium-input"
                value={sessdata}
                onChange={(e) => setSessdata(e.target.value)}
                placeholder={status?.maskedSessdata || 'SESSDATA'}
                disabled={saving || !bilibiliSummaryEnabled}
              />
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={saveSessdata}
              disabled={saving || !bilibiliSummaryEnabled || !sessdata.trim()}
            >
              {saving ? '保存中...' : '更新 SESSDATA'}
            </button>
            <button
              className="premium-button"
              onClick={clearSessdata}
              disabled={saving || !status?.hasStoredSessdata}
              style={{ marginLeft: 8 }}
            >
              清除
            </button>
          </div>
        </div>

        <div className="settings-note-box">
          <strong>如何获取：</strong>
          <p>
            1. 打开浏览器登录 B 站；2. 开发者工具 → Application → Cookies；3.
            找到 SESSDATA 并复制值。
          </p>
        </div>
      </div>
    </div>
  );
}
