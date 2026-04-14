'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AppearanceTab from './AppearanceTab';
import BackupTab from './BackupTab';
import BilibiliSummaryTab from './BilibiliSummaryTab';
import CrawlingTab from './CrawlingTab';
import ErrorHandlingTab from './ErrorHandlingTab';
import IntentTab from './IntentTab';
import LogsTab from './LogsTab';
import ModelsTab from './ModelsTab';
import PerformanceTab from './PerformanceTab';
import SubtitlesTab from './SubtitlesTab';
import SummaryTab from './SummaryTab';
import ResearchIntentManagement from '../ResearchIntentManagement';
import { useT } from '@/contexts/LanguageContext';
import {
  normalizeSettingsTab,
  settingsNavItems,
  type SettingsTabId,
  type ToastType,
} from './shared';

export default function SettingsShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(
    null,
  );
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedTab = searchParams.get('tab');
  const activeTab: SettingsTabId = normalizeSettingsTab(requestedTab);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    setToast({ message, type });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (requestedTab !== activeTab) {
      router.replace(`/settings?tab=${activeTab}`, { scroll: false });
    }
  }, [activeTab, requestedTab, router]);

  const handleTabChange = (tabId: SettingsTabId) => {
    router.replace(`/settings?tab=${tabId}`, { scroll: false });
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'performance':
        return <PerformanceTab showToast={showToast} />;
      case 'crawling':
        return <CrawlingTab showToast={showToast} />;
      case 'subtitles':
        return <SubtitlesTab showToast={showToast} />;
      case 'summary':
        return <SummaryTab showToast={showToast} />;
      case 'models':
        return <ModelsTab showToast={showToast} />;
      case 'errors':
        return <ErrorHandlingTab showToast={showToast} />;
      case 'backup':
        return <BackupTab showToast={showToast} />;
      case 'logs':
        return <LogsTab />;
      case 'intents':
        return <IntentTab showToast={showToast} />;
      case 'bilibili':
        return <BilibiliSummaryTab showToast={showToast} />;
      case 'appearance':
        return <AppearanceTab showToast={showToast} />;
      case 'research':
        return <ResearchIntentManagement showToast={showToast} />;
      default:
        return null;
    }
  };

  return (
    <div className="settings-page-wrapper">
      <aside className="settings-sidebar">
        <div className="sidebar-brand">
          <Link href="/" className="back-to-app">
            <span>←</span>
            <span>{t.common.backToApp}</span>
          </Link>
        </div>
        <nav className="settings-nav">
          {settingsNavItems.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => handleTabChange(item.id)}
            >
              <span className="settings-nav-icon">{item.icon}</span>
              <span>{t.settings.nav[item.id as keyof typeof t.settings.nav]}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="settings-main-content">
        <div className="settings-section-container">
          <h1 className="settings-large-title">
            {t.settings.nav[activeTab as keyof typeof t.settings.nav]}
          </h1>
          {renderTab()}
        </div>
      </main>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            padding: '12px 20px',
            background: toast.type === 'error' ? '#ef4444' : '#000',
            color: '#fff',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontSize: 13,
            zIndex: 1000,
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
