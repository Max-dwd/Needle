'use client';

import { useCallback, useEffect, useState } from 'react';
import { LogViewer } from '@/components/LogPanel';
import { useT } from '@/contexts/LanguageContext';
import type { CrawlRuntimePayload } from './shared';

export default function LogsTab() {
  const t = useT();
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
        <h2 className="settings-group-title">{t.settings.logs.todayStats}</h2>
        <div className="settings-note-box">
          {todayStats
            ? `${t.settings.logs.videos} ${todayStats.videos} / ${t.settings.logs.subtitles} ${todayStats.subtitles} / ${t.settings.logs.summaries} ${todayStats.summaries}`
            : '--'}
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.logs.systemLogs}</h2>
        <div className="settings-note-box">
          {t.settings.logs.systemLogsDesc}
        </div>
        <div style={{ marginTop: 16 }}>
          <LogViewer active embedded showCloseButton={false} />
        </div>
      </div>
    </div>
  );
}
