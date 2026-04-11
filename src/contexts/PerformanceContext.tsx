'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import type {
  FrontendPerformanceSettings,
  PerformanceMode,
} from '@/lib/frontend-performance';

interface PerformanceContextValue {
  settings: FrontendPerformanceSettings | null;
  isReduced: boolean;
}

const PerformanceContext = createContext<PerformanceContextValue>({
  settings: null,
  isReduced: false,
});

export function PerformanceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [settings, setSettings] = useState<FrontendPerformanceSettings | null>(
    null,
  );
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Detect mobile using the same threshold as src/app/page.tsx (900px)
    const checkMobile = () => {
      setIsMobile(
        window.innerWidth <= 900 ||
          /Android|iPhone|iPad/i.test(navigator.userAgent),
      );
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);

    // Initial load
    fetch('/api/settings/frontend-performance')
      .then((res) => res.json())
      .then((data) => setSettings(data))
      .catch((err) => console.error('Failed to load performance settings', err));

    // Listen for updates from settings page
    const handleUpdate = (e: any) => {
      setSettings(e.detail);
    };
    window.addEventListener(
      'frontend-performance-changed' as any,
      handleUpdate as any,
    );

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener(
        'frontend-performance-changed' as any,
        handleUpdate as any,
      );
    };
  }, []);

  const currentMode: PerformanceMode = settings
    ? isMobile
      ? settings.mobile
      : settings.desktop
    : 'full';

  const isReduced = currentMode === 'reduced';

  useEffect(() => {
    document.documentElement.classList.toggle('performance-reduced', isReduced);
  }, [isReduced]);

  return (
    <PerformanceContext.Provider value={{ settings, isReduced }}>
      {children}
    </PerformanceContext.Provider>
  );
}

export function usePerformance() {
  return useContext(PerformanceContext);
}
