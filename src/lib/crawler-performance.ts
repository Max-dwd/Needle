import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';

const CRAWLER_PERFORMANCE_KEY = 'crawler_performance_profile';
const MONITOR_SAMPLE_MS = 1000;

export type CrawlerPerformanceProfile = 'high' | 'medium' | 'low';
export type CrawlerPerformanceLoadState = 'normal' | 'busy' | 'strained';
export type CrawlerThrottleStage = 'feed' | 'subtitle' | 'summary';

interface ProfileConfig {
  label: string;
  baseDelayMs: Record<CrawlerThrottleStage, number>;
  busyLagMs: number;
  strainedLagMs: number;
  busyMultiplier: number;
  strainedMultiplier: number;
}

interface MonitorSnapshot {
  eventLoopLagMs: number;
  peakLagMs: number;
  sampledAt: string;
}

export interface CrawlerPerformanceStatus {
  profile: CrawlerPerformanceProfile;
  profileLabel: string;
  loadState: CrawlerPerformanceLoadState;
  loadStateLabel: string;
  eventLoopLagMs: number;
  peakLagMs: number;
  throttleMultiplier: number;
  updatedAt: string | null;
}

export interface CrawlerThrottleResult extends CrawlerPerformanceStatus {
  stage: CrawlerThrottleStage;
  delayMs: number;
}

const PROFILE_CONFIG: Record<CrawlerPerformanceProfile, ProfileConfig> = {
  high: {
    label: '高',
    baseDelayMs: {
      feed: 0,
      subtitle: 0,
      summary: 0,
    },
    busyLagMs: 140,
    strainedLagMs: 260,
    busyMultiplier: 2,
    strainedMultiplier: 4,
  },
  medium: {
    label: '中',
    baseDelayMs: {
      feed: 350,
      subtitle: 250,
      summary: 200,
    },
    busyLagMs: 110,
    strainedLagMs: 220,
    busyMultiplier: 2,
    strainedMultiplier: 3,
  },
  low: {
    label: '低',
    baseDelayMs: {
      feed: 1200,
      subtitle: 800,
      summary: 500,
    },
    busyLagMs: 90,
    strainedLagMs: 180,
    busyMultiplier: 2,
    strainedMultiplier: 3,
  },
};

let monitorStarted = false;
let monitorTimer: NodeJS.Timeout | null = null;
let monitorSnapshot: MonitorSnapshot = {
  eventLoopLagMs: 0,
  peakLagMs: 0,
  sampledAt: new Date().toISOString(),
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function startMonitor() {
  if (monitorStarted || typeof process === 'undefined') return;
  monitorStarted = true;

  let expected = Date.now() + MONITOR_SAMPLE_MS;
  monitorTimer = setInterval(() => {
    const now = Date.now();
    const rawLag = Math.max(0, now - expected);
    expected = now + MONITOR_SAMPLE_MS;

    const smoothedLag = Math.round(
      monitorSnapshot.eventLoopLagMs * 0.7 + rawLag * 0.3,
    );
    const peakLagMs = Math.max(
      rawLag,
      Math.round(monitorSnapshot.peakLagMs * 0.85),
    );

    monitorSnapshot = {
      eventLoopLagMs: smoothedLag,
      peakLagMs,
      sampledAt: new Date(now).toISOString(),
    };
  }, MONITOR_SAMPLE_MS);

  monitorTimer.unref?.();
}

function getProfileConfig(profile: CrawlerPerformanceProfile): ProfileConfig {
  return PROFILE_CONFIG[profile];
}

export function getCrawlerPerformanceProfile(): CrawlerPerformanceProfile {
  const raw = getAppSetting(CRAWLER_PERFORMANCE_KEY);
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw;
  }
  return 'medium';
}

export function setCrawlerPerformanceProfile(
  profile: CrawlerPerformanceProfile,
) {
  setAppSetting(CRAWLER_PERFORMANCE_KEY, profile);
}

function getLoadState(
  config: ProfileConfig,
  lagMs: number,
): {
  loadState: CrawlerPerformanceLoadState;
  loadStateLabel: string;
  throttleMultiplier: number;
} {
  if (lagMs >= config.strainedLagMs) {
    return {
      loadState: 'strained',
      loadStateLabel: '明显卡顿，已进一步降频',
      throttleMultiplier: config.strainedMultiplier,
    };
  }

  if (lagMs >= config.busyLagMs) {
    return {
      loadState: 'busy',
      loadStateLabel: '检测到负载升高，已自动降频',
      throttleMultiplier: config.busyMultiplier,
    };
  }

  return {
    loadState: 'normal',
    loadStateLabel: '运行平稳',
    throttleMultiplier: 1,
  };
}

export function getCrawlerPerformanceStatus(): CrawlerPerformanceStatus {
  startMonitor();

  const profile = getCrawlerPerformanceProfile();
  const config = getProfileConfig(profile);
  const loadInfo = getLoadState(config, monitorSnapshot.eventLoopLagMs);

  return {
    profile,
    profileLabel: config.label,
    loadState: loadInfo.loadState,
    loadStateLabel: loadInfo.loadStateLabel,
    eventLoopLagMs: monitorSnapshot.eventLoopLagMs,
    peakLagMs: monitorSnapshot.peakLagMs,
    throttleMultiplier: loadInfo.throttleMultiplier,
    updatedAt: getAppSettingUpdatedAt(CRAWLER_PERFORMANCE_KEY),
  };
}

export function getCrawlerPerformanceSummary(
  status: CrawlerPerformanceStatus,
): string {
  const lag = `${status.eventLoopLagMs}ms`;
  if (status.loadState === 'normal') {
    return `性能档位 ${status.profileLabel}，当前平稳（事件循环延迟 ${lag}）`;
  }
  return `性能档位 ${status.profileLabel}，${status.loadStateLabel}（事件循环延迟 ${lag}，倍率 x${status.throttleMultiplier}）`;
}

// ---------------------------------------------------------------------------
// Pool throttle integration
// ---------------------------------------------------------------------------

/**
 * Notifies all known pools about throttle signal.
 * When load state is busy/strained, pools reduce their concurrency.
 */
async function notifyPoolsOfThrottle(loadMultiplier: number): Promise<void> {
  try {
    const { getPool } = await import('./async-pool');
    // Notify all known pools about the throttle signal
    const poolNames = ['enrichment', 'subtitle', 'summary', 'feed-crawl'];
    for (const name of poolNames) {
      const pool = getPool(name);
      if (pool) {
        pool.setLoadMultiplier(loadMultiplier);
      }
    }
  } catch {
    // Pools may not be initialized yet, ignore
  }
}

export async function throttleCrawlerStage(
  stage: CrawlerThrottleStage,
): Promise<CrawlerThrottleResult> {
  const status = getCrawlerPerformanceStatus();
  const config = getProfileConfig(status.profile);
  const baseDelayMs = config.baseDelayMs[stage];
  const adaptiveExtraMs =
    status.loadState === 'normal'
      ? 0
      : Math.min(
          Math.round(
            status.eventLoopLagMs * (status.loadState === 'strained' ? 4 : 2),
          ),
          2000,
        );
  const delayMs = Math.round(
    baseDelayMs * status.throttleMultiplier + adaptiveExtraMs,
  );

  // When load state is busy/strained, notify all pools to reduce concurrency
  // The throttleMultiplier from crawler-performance (e.g., 2 for busy, 4 for strained)
  // needs to be inverted: we want to REDUCE concurrency, so we use 1/multiplier
  if (status.loadState !== 'normal' && status.throttleMultiplier > 1) {
    const poolLoadMultiplier = 1 / status.throttleMultiplier;
    await notifyPoolsOfThrottle(poolLoadMultiplier);
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  return {
    ...status,
    stage,
    delayMs,
  };
}
