'use client';

import { useT } from '@/contexts/LanguageContext';
import { useCallback, useEffect, useState } from 'react';
import type {
  BrowserKeepaliveStatus,
  PerformanceStatus,
  ShowToast,
} from './shared';
import type {
  FrontendPerformanceSettings,
  PerformanceMode,
} from '@/lib/frontend-performance';

interface PerformanceTabProps {
  showToast: ShowToast;
}

export default function PerformanceTab({ showToast }: PerformanceTabProps) {
  const [performance, setPerformance] = useState<PerformanceStatus | null>(null);
  const [performanceDraft, setPerformanceDraft] =
    useState<PerformanceStatus['profile']>('medium');
  const [keepalive, setKeepalive] = useState<BrowserKeepaliveStatus | null>(null);
  const [keepaliveDraft, setKeepaliveDraft] =
    useState<BrowserKeepaliveStatus['preset']>('balanced');
  const [loading, setLoading] = useState(true);
  const [performanceSaving, setPerformanceSaving] = useState(false);
  const [keepaliveSaving, setKeepaliveSaving] = useState(false);
  const [frontendSettings, setFrontendSettings] =
    useState<FrontendPerformanceSettings | null>(null);
  const [frontendDesktopDraft, setFrontendDesktopDraft] =
    useState<PerformanceMode>('full');
  const [frontendMobileDraft, setFrontendMobileDraft] =
    useState<PerformanceMode>('full');
  const [frontendSaving, setFrontendSaving] = useState(false);
  const t = useT();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [performanceRes, keepaliveRes, frontendRes] = await Promise.all([
        fetch('/api/settings/crawler-performance', { cache: 'no-store' }),
        fetch('/api/settings/browser-keepalive', { cache: 'no-store' }),
        fetch('/api/settings/frontend-performance', { cache: 'no-store' }),
      ]);
      if (!performanceRes.ok || !keepaliveRes.ok || !frontendRes.ok) {
        throw new Error('READ_FAILED');
      }
      const performanceData = (await performanceRes.json()) as PerformanceStatus;
      const keepaliveData = (await keepaliveRes.json()) as BrowserKeepaliveStatus;
      const frontendData =
        (await frontendRes.json()) as FrontendPerformanceSettings;
      setPerformance(performanceData);
      setPerformanceDraft(performanceData.profile);
      setKeepalive(keepaliveData);
      setKeepaliveDraft(keepaliveData.preset);
      setFrontendSettings(frontendData);
      setFrontendDesktopDraft(frontendData.desktop);
      setFrontendMobileDraft(frontendData.mobile);
    } catch {
      showToast(t.settings.performance.toastReadFailed, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePerformance = async () => {
    setPerformanceSaving(true);
    try {
      const res = await fetch('/api/settings/crawler-performance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: performanceDraft }),
      });
      const data = (await res.json()) as PerformanceStatus & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'SAVE_FAILED');
      }
      setPerformance(data);
      setPerformanceDraft(data.profile);
      showToast(`${t.settings.performance.toastPerformanceSwitched}${data.profileLabel}`); // omitted 档 to match i18n flexibly
    } catch (error) {
      const message = error instanceof Error && error.message !== 'SAVE_FAILED' ? error.message : t.settings.performance.toastSaveError;
      showToast(message, 'error');
    } finally {
      setPerformanceSaving(false);
    }
  };

  const saveKeepalive = async () => {
    setKeepaliveSaving(true);
    try {
      const res = await fetch('/api/settings/browser-keepalive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: keepaliveDraft }),
      });
      const data = (await res.json()) as BrowserKeepaliveStatus & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'SAVE_FAILED');
      }
      setKeepalive(data);
      setKeepaliveDraft(data.preset);
      window.dispatchEvent(
        new CustomEvent('browser-keepalive-preset-changed', {
          detail: {
            preset: data.preset,
            activeGraceMs: data.activeGraceMs,
          },
        }),
      );
      showToast(`${t.settings.performance.toastKeepaliveSwitched}${data.label}`); // omitted 模式 to match i18n flexibly
    } catch (error) {
      const message = error instanceof Error && error.message !== 'SAVE_FAILED' ? error.message : t.settings.performance.toastSaveError;
      showToast(message, 'error');
    } finally {
      setKeepaliveSaving(false);
    }
  };

  const saveFrontendPerformance = async () => {
    setFrontendSaving(true);
    try {
      const res = await fetch('/api/settings/frontend-performance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desktop: frontendDesktopDraft,
          mobile: frontendMobileDraft,
        }),
      });
      if (!res.ok) {
        throw new Error('SAVE_FAILED');
      }
      const data = (await res.json()) as FrontendPerformanceSettings;
      setFrontendSettings(data);
      setFrontendDesktopDraft(data.desktop);
      setFrontendMobileDraft(data.mobile);

      // Dispatch event to notify context
      window.dispatchEvent(
        new CustomEvent('frontend-performance-changed', { detail: data }),
      );

      showToast(t.settings.performance.toastFrontendUpdated);
    } catch (error) {
      showToast(t.settings.performance.toastSaveError, 'error');
    } finally {
      setFrontendSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.performance.crawlingPerformance}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.performanceProfile}</span>
              <span className="setting-description">
                {t.settings.performance.performanceProfileDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={performanceDraft}
                onChange={(e) =>
                  setPerformanceDraft(
                    e.target.value as PerformanceStatus['profile'],
                  )
                }
                disabled={loading || performanceSaving}
              >
                {performance?.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.realtimeLoad}</span>
              <span className="setting-description">
                {t.settings.performance.realtimeLoadDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <span style={{ fontSize: 13, color: '#666' }}>
                {performance
                  ? `${performance.eventLoopLagMs}ms / x${performance.throttleMultiplier}`
                  : '--'}
              </span>
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={savePerformance}
              disabled={loading || performanceSaving}
            >
              {performanceSaving ? t.settings.performance.saving : t.settings.performance.saveProfile}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.performance.browserKeepalive}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.keepaliveStrategy}</span>
              <span className="setting-description">
                {t.settings.performance.keepaliveStrategyDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={keepaliveDraft}
                onChange={(e) =>
                  setKeepaliveDraft(
                    e.target.value as BrowserKeepaliveStatus['preset'],
                  )
                }
                disabled={loading || keepaliveSaving}
              >
                {keepalive?.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.currentBehavior}</span>
              <span className="setting-description">
                {keepalive?.description ?? t.settings.performance.reading}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <span style={{ fontSize: 13, color: '#666' }}>
                {keepalive
                  ? `${keepalive.activeGraceLabel} / ${keepalive.browserPrewarm ? 'daemon + prewarm' : keepalive.daemonKeepalive ? 'daemon only' : 'disabled'}`
                  : '--'}
              </span>
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={saveKeepalive}
              disabled={loading || keepaliveSaving}
            >
              {keepaliveSaving ? t.settings.performance.saving : t.settings.performance.saveStrategy}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.performance.frontendPerformance}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.desktop}</span>
              <span className="setting-description">
                {t.settings.performance.desktopDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={frontendDesktopDraft}
                onChange={(e) =>
                  setFrontendDesktopDraft(e.target.value as PerformanceMode)
                }
                disabled={loading || frontendSaving}
              >
                <option value="full">{t.settings.performance.fullEffect}</option>
                <option value="reduced">{t.settings.performance.reducedEffect}</option>
              </select>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.performance.mobile}</span>
              <span className="setting-description">
                {t.settings.performance.mobileDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={frontendMobileDraft}
                onChange={(e) =>
                  setFrontendMobileDraft(e.target.value as PerformanceMode)
                }
                disabled={loading || frontendSaving}
              >
                <option value="full">{t.settings.performance.fullEffect}</option>
                <option value="reduced">{t.settings.performance.reducedEffect}</option>
              </select>
            </div>
          </div>
          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={saveFrontendPerformance}
              disabled={loading || frontendSaving}
            >
              {frontendSaving ? t.settings.performance.saving : t.settings.performance.saveFrontendSettings}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
