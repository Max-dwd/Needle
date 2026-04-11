import { getDb } from './db';
import type { CrawlerRuntimeStatus, CrawlerScopeStatus } from '@/types';
import { appEvents } from './events';

const CRAWLER_PAUSE_KEY = 'crawler_pause_state';
const CRAWLER_RUNTIME_STATUS_KEY = 'crawler_runtime_status_v1';

export type CrawlerScope = 'feed' | 'subtitle';
export type CrawlerState = 'idle' | 'running' | 'cooldown' | 'error';
export type CrawlerScopeOwner = 'manual' | 'scheduler';

function createIdleStatus(): CrawlerScopeStatus {
  return {
    state: 'idle',
    isFallback: false,
    updatedAt: new Date().toISOString(),
  };
}

// Internal runtime state - includes subtitle for scope management
interface InternalRuntimeStatus {
  feed: CrawlerScopeStatus;
  subtitle: CrawlerScopeStatus;
}

let runtimeStatus: InternalRuntimeStatus = {
  feed: createIdleStatus(),
  subtitle: createIdleStatus(),
};

const lockKey = Symbol.for('folo-crawler-scope-locks');

function getScopeLocks(): Record<CrawlerScope, CrawlerScopeOwner | null> {
  const g = globalThis as typeof globalThis & {
    [lockKey]?: Record<CrawlerScope, CrawlerScopeOwner | null>;
  };
  if (!g[lockKey]) {
    g[lockKey] = {
      feed: null,
      subtitle: null,
    };
  }
  return g[lockKey]!;
}

function getCrawlerPauseState(): { paused: boolean; updatedAt?: string } {
  const row = getDb()
    .prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .get(CRAWLER_PAUSE_KEY) as
    | { value?: string | null; updated_at?: string | null }
    | undefined;

  return {
    paused: row?.value === '1',
    updatedAt: row?.updated_at ?? undefined,
  };
}

function sanitizeRuntimeStatus(input: unknown): InternalRuntimeStatus {
  if (!input || typeof input !== 'object') {
    return {
      feed: createIdleStatus(),
      subtitle: createIdleStatus(),
    };
  }

  const value = input as Record<string, unknown>;
  return {
    feed: sanitizeScopeStatus(value.feed),
    subtitle: sanitizeScopeStatus(value.subtitle),
  };
}

function loadRuntimeStatus(): InternalRuntimeStatus {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CRAWLER_RUNTIME_STATUS_KEY) as { value?: string | null } | undefined;

  if (!row?.value) {
    return runtimeStatus;
  }

  try {
    runtimeStatus = sanitizeRuntimeStatus(JSON.parse(row.value));
  } catch {
    runtimeStatus = {
      feed: createIdleStatus(),
      subtitle: createIdleStatus(),
    };
  }

  return runtimeStatus;
}

function persistRuntimeStatus(nextStatus: InternalRuntimeStatus) {
  runtimeStatus = nextStatus;
  getDb()
    .prepare(
      `
      INSERT INTO app_settings(key, value, updated_at)
      VALUES(?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(CRAWLER_RUNTIME_STATUS_KEY, JSON.stringify(nextStatus));
}

function sanitizeScopeStatus(input: unknown): CrawlerScopeStatus {
  if (!input || typeof input !== 'object') {
    return createIdleStatus();
  }

  const value = input as Record<string, unknown>;
  return {
    state:
      typeof value.state === 'string' ? (value.state as CrawlerState) : 'idle',
    platform:
      value.platform === 'youtube' || value.platform === 'bilibili'
        ? value.platform
        : undefined,
    preferredMethod:
      typeof value.preferredMethod === 'string'
        ? value.preferredMethod
        : undefined,
    activeMethod:
      typeof value.activeMethod === 'string' ? value.activeMethod : undefined,
    isFallback:
      typeof value.isFallback === 'boolean' ? value.isFallback : false,
    targetId: typeof value.targetId === 'string' ? value.targetId : undefined,
    targetLabel:
      typeof value.targetLabel === 'string' ? value.targetLabel : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    cooldownUntil:
      typeof value.cooldownUntil === 'string' ? value.cooldownUntil : undefined,
    updatedAt:
      typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    progress: typeof value.progress === 'number' ? value.progress : undefined,
    total: typeof value.total === 'number' ? value.total : undefined,
  };
}

export function getCrawlerRuntimeStatus(): CrawlerRuntimeStatus {
  const currentStatus = loadRuntimeStatus();
  const pauseState = getCrawlerPauseState();
  return {
    feed: sanitizeScopeStatus(currentStatus.feed),
    paused: pauseState.paused,
    pauseUpdatedAt: pauseState.updatedAt,
  };
}

function emitCrawlerStatusChanged() {
  appEvents.emit('crawler:status-changed', getCrawlerRuntimeStatus());
}

export function updateCrawlerScopeStatus(
  scope: CrawlerScope,
  patch: Partial<CrawlerScopeStatus>,
) {
  const currentStatus = loadRuntimeStatus();
  persistRuntimeStatus({
    ...currentStatus,
    [scope]: {
      ...currentStatus[scope],
      ...patch,
      updatedAt: new Date().toISOString(),
    },
  });
  emitCrawlerStatusChanged();
}

export function resetCrawlerScopeStatus(scope: CrawlerScope) {
  const currentStatus = loadRuntimeStatus();
  persistRuntimeStatus({
    ...currentStatus,
    [scope]: createIdleStatus(),
  });
  emitCrawlerStatusChanged();
}

export function setCrawlerPaused(paused: boolean) {
  getDb()
    .prepare(
      `
      INSERT INTO app_settings(key, value, updated_at)
      VALUES(?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(CRAWLER_PAUSE_KEY, paused ? '1' : '0');
  emitCrawlerStatusChanged();
}

export function isCrawlerPaused(): boolean {
  return getCrawlerRuntimeStatus().paused;
}

export async function waitIfCrawlerPaused(
  onWait?: () => void,
  shouldAbort?: () => boolean,
) {
  while (isCrawlerPaused()) {
    if (shouldAbort?.()) {
      return false;
    }
    onWait?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  return true;
}

export function getCrawlerScopeStatus(scope: CrawlerScope): CrawlerScopeStatus {
  return sanitizeScopeStatus(loadRuntimeStatus()[scope]);
}

export function isCrawlerScopeCoolingDown(scope: CrawlerScope): boolean {
  const status = getCrawlerScopeStatus(scope);
  if (status.state !== 'cooldown' || !status.cooldownUntil) return false;
  const until = Date.parse(status.cooldownUntil);
  return Number.isFinite(until) && until > Date.now();
}

export function getCrawlerScopeOwner(
  scope: CrawlerScope,
): CrawlerScopeOwner | null {
  return getScopeLocks()[scope];
}

export function tryAcquireCrawlerScope(
  scope: CrawlerScope,
  owner: CrawlerScopeOwner,
): boolean {
  const locks = getScopeLocks();
  if (locks[scope] && locks[scope] !== owner) {
    return false;
  }
  locks[scope] = owner;
  return true;
}

export function releaseCrawlerScope(
  scope: CrawlerScope,
  owner: CrawlerScopeOwner,
) {
  const locks = getScopeLocks();
  if (locks[scope] === owner) {
    locks[scope] = null;
  }
}
