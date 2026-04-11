'use client';

import { useEffect, useRef, useState } from 'react';
import type { BrowserKeepaliveStatus } from './settings/shared';
import {
  createBrowserKeepaliveController,
  shouldEnableBrowserKeepalive,
} from '@/lib/browser-keepalive-client';

const PRESET_EVENT = 'browser-keepalive-preset-changed';

type KeepalivePayload = Pick<
  BrowserKeepaliveStatus,
  'preset' | 'activeGraceMs'
>;

export default function BrowserKeepalive() {
  const controllerRef = useRef<ReturnType<
    typeof createBrowserKeepaliveController
  > | null>(null);
  const [config, setConfig] = useState<KeepalivePayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch('/api/settings/browser-keepalive', {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = (await response.json()) as BrowserKeepaliveStatus;
        if (!cancelled) {
          setConfig({
            preset: data.preset,
            activeGraceMs: data.activeGraceMs,
          });
        }
      } catch {
        // Best-effort only.
      }
    };

    void load();

    const handlePresetChange = (event: Event) => {
      const detail = (event as CustomEvent<KeepalivePayload>).detail;
      if (!detail) return;
      setConfig(detail);
    };

    window.addEventListener(PRESET_EVENT, handlePresetChange as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(
        PRESET_EVENT,
        handlePresetChange as EventListener,
      );
    };
  }, []);

  useEffect(() => {
    if (!config) return;

    if (!controllerRef.current) {
      controllerRef.current = createBrowserKeepaliveController({
        config,
        sendKeepalive: async () => {
          await fetch('/api/browser/keepalive', { method: 'POST' });
        },
      });
    } else {
      controllerRef.current.updateConfig(config);
    }

    controllerRef.current.setVisible(document.visibilityState === 'visible');
  }, [config]);

  useEffect(() => {
    if (!config || !shouldEnableBrowserKeepalive(config)) return;
    const controller = controllerRef.current;
    if (!controller) return;

    const onActivity = () => {
      controller.notifyActivity();
    };
    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      controller.setVisible(visible);
      if (visible) {
        controller.notifyActivity();
      }
    };

    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity);
    window.addEventListener('focus', onActivity);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('focus', onActivity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [config]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  return null;
}
