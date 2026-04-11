'use client';

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [performanceRes, keepaliveRes, frontendRes] = await Promise.all([
        fetch('/api/settings/crawler-performance', { cache: 'no-store' }),
        fetch('/api/settings/browser-keepalive', { cache: 'no-store' }),
        fetch('/api/settings/frontend-performance', { cache: 'no-store' }),
      ]);
      if (!performanceRes.ok || !keepaliveRes.ok || !frontendRes.ok) {
        throw new Error('无法读取性能设置');
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
      showToast('无法读取性能设置', 'error');
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
        showToast(data.error || '保存失败', 'error');
        return;
      }
      setPerformance(data);
      setPerformanceDraft(data.profile);
      showToast(`后台抓取性能已切换为${data.profileLabel}档`);
    } catch {
      showToast('保存失败，请稍后重试', 'error');
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
        showToast(data.error || '保存失败', 'error');
        return;
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
      showToast(`浏览器保温已切换为${data.label}模式`);
    } catch {
      showToast('保存失败，请稍后重试', 'error');
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
        showToast('保存失败', 'error');
        return;
      }
      const data = (await res.json()) as FrontendPerformanceSettings;
      setFrontendSettings(data);
      setFrontendDesktopDraft(data.desktop);
      setFrontendMobileDraft(data.mobile);

      // Dispatch event to notify context
      window.dispatchEvent(
        new CustomEvent('frontend-performance-changed', { detail: data }),
      );

      showToast('前端性能设置已更新');
    } catch {
      showToast('保存失败，请稍后重试', 'error');
    } finally {
      setFrontendSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">后台抓取性能</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">性能档位</span>
              <span className="setting-description">
                选择后台爬取的资源占用级别。
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
              <span className="setting-label">实时负载</span>
              <span className="setting-description">
                当前事件循环延迟及降频状态。
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
              {performanceSaving ? '正在保存...' : '保存档位'}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">浏览器保温</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">保温策略</span>
              <span className="setting-description">
                控制 daemon 与受控浏览器工作区的预热强度。
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
              <span className="setting-label">当前行为</span>
              <span className="setting-description">
                {keepalive?.description ?? '读取中'}
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
              {keepaliveSaving ? '正在保存...' : '保存策略'}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">前端性能</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">桌面端</span>
              <span className="setting-description">
                控制桌面浏览器的视觉特效与动画。
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
                <option value="full">完全</option>
                <option value="reduced">降低效果</option>
              </select>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">移动端</span>
              <span className="setting-description">
                控制移动端（手机/平板）的视觉特效与动画。
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
                <option value="full">完全</option>
                <option value="reduced">降低效果</option>
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
              {frontendSaving ? '正在保存...' : '保存前端设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
