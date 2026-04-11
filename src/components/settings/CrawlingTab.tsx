'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CrawlRuntimePayload, ShowToast } from './shared';
import { crawlIntervalOptions } from './shared';

interface CrawlingTabProps {
  showToast: ShowToast;
}

export default function CrawlingTab({ showToast }: CrawlingTabProps) {
  const [crawlIntervalDraft, setCrawlIntervalDraft] = useState(2 * 60 * 60);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [intervalSaving, setIntervalSaving] = useState(false);
  const [schedulerSaving, setSchedulerSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const schedulerRes = await fetch('/api/crawl-runtime', { cache: 'no-store' });
      if (!schedulerRes.ok) {
        throw new Error('无法读取抓取设置');
      }
      const schedulerData = (await schedulerRes.json()) as CrawlRuntimePayload;
      setCrawlIntervalDraft(schedulerData.config.crawlInterval);
      setSchedulerEnabled(schedulerData.config.enabled);
    } catch {
      showToast('无法读取抓取设置', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScheduler = async () => {
    setSchedulerSaving(true);
    try {
      const action = schedulerEnabled ? 'stop' : 'start';
      const res = await fetch('/api/crawl-runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          crawlInterval: crawlIntervalDraft,
        }),
      });
      const data = (await res.json()) as CrawlRuntimePayload;
      if (!res.ok) {
        showToast('切换自动化抓取失败', 'error');
        return;
      }
      setSchedulerEnabled(data.config.enabled);
      setCrawlIntervalDraft(data.config.crawlInterval);
      showToast(action === 'start' ? '自动化抓取已开启' : '自动化抓取已关闭');
    } catch {
      showToast('切换自动化抓取失败，请稍后重试', 'error');
    } finally {
      setSchedulerSaving(false);
    }
  };

  const saveCrawlInterval = async () => {
    setIntervalSaving(true);
    try {
      const res = await fetch('/api/crawl-runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          crawlInterval: crawlIntervalDraft,
        }),
      });
      const data = (await res.json()) as CrawlRuntimePayload;
      if (!res.ok) {
        showToast('保存抓取间隔失败', 'error');
        return;
      }
      setCrawlIntervalDraft(data.config.crawlInterval);
      setSchedulerEnabled(data.config.enabled);
      showToast('抓取间隔已保存');
    } catch {
      showToast('保存抓取间隔失败，请稍后重试', 'error');
    } finally {
      setIntervalSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">自动化抓取</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">开启自动化抓取</span>
              <span className="setting-description">
                开启后会按设定间隔在后台自动抓取频道最新视频。当前后台抓取默认通过
                browser runtime 执行。
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={schedulerEnabled}
                  onChange={toggleScheduler}
                  disabled={loading || schedulerSaving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">抓取间隔</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">频道抓取频率</span>
              <span className="setting-description">
                自动抓取频道最新视频的时间间隔。
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={crawlIntervalDraft}
                onChange={(e) => setCrawlIntervalDraft(Number(e.target.value))}
                disabled={loading || intervalSaving}
              >
                {crawlIntervalOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
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
              onClick={saveCrawlInterval}
              disabled={loading || intervalSaving}
            >
              {intervalSaving ? '正在保存...' : '保存间隔'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
