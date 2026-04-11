import type { BrowserKeepalivePreset } from './browser-keepalive';

export interface BrowserKeepaliveClientConfig {
  preset: BrowserKeepalivePreset;
  activeGraceMs: number;
}

export interface BrowserKeepaliveClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | null): void;
}

export interface BrowserKeepaliveControllerOptions {
  config: BrowserKeepaliveClientConfig;
  sendKeepalive: () => Promise<void>;
  clock?: BrowserKeepaliveClock;
  cadenceMs?: number;
}

const DEFAULT_CADENCE_MS = 20_000;

function defaultClock(): BrowserKeepaliveClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => {
      if (timer) clearTimeout(timer);
    },
  };
}

export function shouldEnableBrowserKeepalive(
  config: BrowserKeepaliveClientConfig | null,
): boolean {
  return Boolean(config && config.preset !== 'off' && config.activeGraceMs > 0);
}

export function createBrowserKeepaliveController(
  options: BrowserKeepaliveControllerOptions,
) {
  const clock = options.clock ?? defaultClock();
  const cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;

  let config = options.config;
  let visible = true;
  let lastActivityAt = 0;
  let lastSentAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const clearTimer = () => {
    clock.clearTimeout(timer);
    timer = null;
  };

  const isWithinGraceWindow = (now: number) => {
    if (!shouldEnableBrowserKeepalive(config) || !visible) return false;
    return now - lastActivityAt <= config.activeGraceMs;
  };

  const scheduleNext = () => {
    clearTimer();
    const now = clock.now();
    if (!isWithinGraceWindow(now)) return;
    const sinceLastSent = lastSentAt === null ? cadenceMs : now - lastSentAt;
    const untilCadence = Math.max(0, cadenceMs - sinceLastSent);
    const untilGraceEnds = Math.max(0, config.activeGraceMs - (now - lastActivityAt));
    const delayMs = Math.min(untilCadence, untilGraceEnds);
    timer = clock.setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    const now = clock.now();
    if (!isWithinGraceWindow(now)) {
      clearTimer();
      return;
    }
    if (lastSentAt !== null && now - lastSentAt < cadenceMs) {
      scheduleNext();
      return;
    }
    if (!inFlight) {
      lastSentAt = now;
      inFlight = options.sendKeepalive().finally(() => {
        inFlight = null;
      });
    }
    await inFlight.catch(() => {});
    scheduleNext();
  };

  return {
    notifyActivity() {
      if (!shouldEnableBrowserKeepalive(config)) return;
      lastActivityAt = clock.now();
      if (!visible) return;
      if (lastSentAt === null || clock.now() - lastSentAt >= cadenceMs) {
        void tick();
        return;
      }
      scheduleNext();
    },
    setVisible(nextVisible: boolean) {
      visible = nextVisible;
      if (!visible) {
        clearTimer();
        return;
      }
      if (lastActivityAt > 0) {
        scheduleNext();
      }
    },
    updateConfig(nextConfig: BrowserKeepaliveClientConfig) {
      config = nextConfig;
      if (!shouldEnableBrowserKeepalive(config)) {
        clearTimer();
      } else if (visible && lastActivityAt > 0) {
        scheduleNext();
      }
    },
    dispose() {
      clearTimer();
    },
  };
}
