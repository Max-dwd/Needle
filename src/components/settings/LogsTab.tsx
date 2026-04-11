'use client';

import { useCallback, useEffect, useState } from 'react';
import { LogViewer } from '@/components/LogPanel';
import type { CrawlRuntimePayload } from './shared';

export default function LogsTab() {
  const [todayStats, setTodayStats] = useState<CrawlRuntimePayload['status']['todayStats'] | null>(
    null,
  );

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/crawl-runtime', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as CrawlRuntimePayload;
      setTodayStats(data.status.todayStats);
    } catch {
      // Ignore stats load failures in logs view.
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadStats();
    }, 30000);
    return () => clearInterval(timer);
  }, [loadStats]);

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">今日统计</h2>
        <div className="settings-note-box">
          {todayStats
            ? `视频 ${todayStats.videos} / 字幕 ${todayStats.subtitles} / 摘要 ${todayStats.summaries}`
            : '--'}
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">系统日志</h2>
        <div className="settings-note-box">
          日志自动轮询刷新，支持概览和详情查看。抓取今日统计也汇总在这里，方便集中排查。
        </div>
        <div style={{ marginTop: 16 }}>
          <LogViewer active embedded showCloseButton={false} />
        </div>
      </div>
    </div>
  );
}
