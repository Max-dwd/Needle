'use client';

import { useT } from '@/contexts/LanguageContext';
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
  const t = useT();

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
      showToast(t.settings.bilibili.toastReadFailed, 'error');
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
        showToast(data.message || t.settings.bilibili.toastSaveError, 'error');
        return;
      }
      setStatus(data);
      setSessdata('');
      showToast(t.settings.bilibili.toastSaveSuccess);
    } catch {
      showToast(t.settings.bilibili.toastSaveError, 'error');
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
      showToast(t.settings.bilibili.toastClearSuccess);
    } catch {
      showToast(t.settings.bilibili.toastClearError, 'error');
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
        showToast(t.settings.bilibili.toastToggleFailed, 'error');
        return;
      }
      setStatus(data);
      setBilibiliSummaryEnabled(Boolean(data.enabled ?? nextEnabled));
      showToast(nextEnabled ? t.settings.bilibili.toastToggleOn : t.settings.bilibili.toastToggleOff);
    } catch {
      showToast(t.settings.bilibili.toastToggleError, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.bilibili.bilibiliSummaryAuth}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.bilibili.enableBilibiliSummary}</span>
              <span className="setting-description">
                {t.settings.bilibili.enableBilibiliSummaryDesc}
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
              <span className="setting-label">{t.settings.bilibili.currentState}</span>
              <span className="setting-description">
                {t.settings.bilibili.currentStateDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <span
                className={`status-badge-premium status-${bilibiliSummaryEnabled ? status?.state || 'missing' : 'missing'}`}
              >
                {bilibiliSummaryEnabled
                  ? status?.message || t.settings.bilibili.notConfigured
                  : t.settings.bilibili.featureDisabled}
              </span>
              <button
                className="premium-button"
                onClick={() => void loadStatus()}
                disabled={loading || saving}
              >
                {loading ? t.settings.bilibili.checking : t.settings.bilibili.refresh}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div
              className="setting-info"
              style={{ opacity: bilibiliSummaryEnabled ? 1 : 0.5 }}
            >
              <span className="setting-label">{t.settings.bilibili.sessdata}</span>
              <span className="setting-description">
                {t.settings.bilibili.sessdataDesc}
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
              {saving ? t.settings.bilibili.saving : t.settings.bilibili.updateSessdata}
            </button>
            <button
              className="premium-button"
              onClick={clearSessdata}
              disabled={saving || !status?.hasStoredSessdata}
              style={{ marginLeft: 8 }}
            >
              {t.settings.bilibili.clear}
            </button>
          </div>
        </div>

        <div className="settings-note-box">
          <strong>{t.settings.bilibili.howToGet}</strong>
          <p>
            {t.settings.bilibili.howToGetStep}
          </p>
        </div>
      </div>
    </div>
  );
}
