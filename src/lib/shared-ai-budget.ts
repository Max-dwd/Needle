import { getAiSummarySettings } from './ai-summary-settings';

export type SharedAiBudgetPriority =
  | 'manual-summary'
  | 'manual-subtitle'
  | 'auto-summary'
  | 'auto-subtitle';

export interface SharedAiBudgetRequest {
  priority: SharedAiBudgetPriority;
  estimatedTokens: number;
  label: string;
  onQueued?: (details: {
    queuePosition: number;
    waitMs: number;
    priority: SharedAiBudgetPriority;
  }) => void;
}

export interface SharedAiBudgetLease {
  release(actualTokens?: number): void;
}

interface BudgetUsageRecord {
  timestamp: number;
  requests: number;
  tokens: number;
}

interface BudgetReservation extends BudgetUsageRecord {
  id: number;
}

interface PendingBudgetRequest extends SharedAiBudgetRequest {
  id: number;
  createdAt: number;
  resolve: (lease: SharedAiBudgetLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  queuedNotified: boolean;
}

const WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const PRIORITY_ORDER: Record<SharedAiBudgetPriority, number> = {
  'manual-summary': 0,
  'manual-subtitle': 1,
  'auto-summary': 2,
  'auto-subtitle': 3,
};

function clampPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

class SharedAiBudgetScheduler {
  private nextId = 1;
  private usageHistory: BudgetUsageRecord[] = [];
  private reservations: BudgetReservation[] = [];
  private queue: PendingBudgetRequest[] = [];
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  async acquire(
    request: SharedAiBudgetRequest,
    signal?: AbortSignal,
  ): Promise<SharedAiBudgetLease> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      const safeResolve = (lease: SharedAiBudgetLease) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(lease);
      };

      const safeReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const pending: PendingBudgetRequest = {
        ...request,
        estimatedTokens: Math.max(1, Math.floor(request.estimatedTokens)),
        createdAt: Date.now(),
        id: this.nextId++,
        resolve: safeResolve,
        reject: safeReject,
        signal,
        queuedNotified: false,
      };

      const onAbort = () => {
        const index = this.queue.findIndex((item) => item.id === pending.id);
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.scheduleNextCheck();
        }
        safeReject(createAbortError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      this.queue.push(pending);
      this.processQueue();
    });
  }

  canAcquire(request: Pick<SharedAiBudgetRequest, 'estimatedTokens'>): boolean {
    const now = Date.now();
    this.prune(now);
    const { rpm, rpd, tpm } = this.getLimits();
    const { requestCount, tokenCount } = this.getCurrentUsage(WINDOW_MS, now);
    const { requestCount: dailyRequestCount } = this.getCurrentUsage(
      DAY_WINDOW_MS,
      now,
    );
    const estimatedTokens = Math.max(1, Math.floor(request.estimatedTokens));
    return (
      requestCount + 1 <= rpm &&
      dailyRequestCount + 1 <= rpd &&
      tokenCount + estimatedTokens <= tpm
    );
  }

  private getLimits() {
    const settings = getAiSummarySettings();
    return {
      rpm: clampPositiveInteger(settings.sharedRequestsPerMinute, 10),
      rpd: clampPositiveInteger(settings.sharedRequestsPerDay, 1_000),
      tpm: clampPositiveInteger(settings.sharedTokensPerMinute, 1_000_000),
    };
  }

  private prune(now = Date.now()) {
    const minTs = now - DAY_WINDOW_MS;
    this.usageHistory = this.usageHistory.filter(
      (item) => item.timestamp > minTs,
    );
    this.reservations = this.reservations.filter(
      (item) => item.timestamp > minTs,
    );
  }

  private getCurrentUsage(windowMs = WINDOW_MS, now = Date.now()) {
    const minTs = now - windowMs;
    const records = [...this.usageHistory, ...this.reservations].filter(
      (item) => item.timestamp > minTs,
    );
    const requestCount = records.reduce((sum, item) => sum + item.requests, 0);
    const tokenCount = records.reduce((sum, item) => sum + item.tokens, 0);
    return { requestCount, tokenCount };
  }

  private estimateWaitMs(now = Date.now()): number {
    const { rpm, rpd, tpm } = this.getLimits();
    const minuteWaitMs = this.estimateWindowWaitMs({
      now,
      windowMs: WINDOW_MS,
      requestLimit: rpm,
      tokenLimit: tpm,
    });
    const dailyWaitMs = this.estimateWindowWaitMs({
      now,
      windowMs: DAY_WINDOW_MS,
      requestLimit: rpd,
    });
    return Math.max(minuteWaitMs, dailyWaitMs);
  }

  private estimateWindowWaitMs({
    now,
    windowMs,
    requestLimit,
    tokenLimit,
  }: {
    now: number;
    windowMs: number;
    requestLimit?: number;
    tokenLimit?: number;
  }): number {
    const records = [...this.usageHistory, ...this.reservations].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    let requests = records.reduce((sum, item) => sum + item.requests, 0);
    let tokens = records.reduce((sum, item) => sum + item.tokens, 0);
    const hasRequestCapacity =
      requestLimit === undefined ? true : requests < requestLimit;
    const hasTokenCapacity =
      tokenLimit === undefined ? true : tokens < tokenLimit;
    if (hasRequestCapacity && hasTokenCapacity) return 0;

    for (const item of records) {
      requests -= item.requests;
      tokens -= item.tokens;
      const nextHasRequestCapacity =
        requestLimit === undefined ? true : requests < requestLimit;
      const nextHasTokenCapacity =
        tokenLimit === undefined ? true : tokens < tokenLimit;
      if (nextHasRequestCapacity && nextHasTokenCapacity) {
        return Math.max(0, item.timestamp + windowMs - now);
      }
    }

    return windowMs;
  }

  private scheduleNextCheck() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const waitMs = Math.max(50, this.estimateWaitMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.processQueue();
    }, waitMs);
  }

  private processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = Date.now();
      this.prune(now);

      this.queue.sort((a, b) => {
        const priorityDiff =
          PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.createdAt - b.createdAt;
      });

      const { rpm, rpd, tpm } = this.getLimits();
      let grantedAny = false;

      for (let index = 0; index < this.queue.length; ) {
        const pending = this.queue[index];
        const { requestCount, tokenCount } = this.getCurrentUsage(
          WINDOW_MS,
          now,
        );
        const { requestCount: dailyRequestCount } = this.getCurrentUsage(
          DAY_WINDOW_MS,
          now,
        );
        const canRun =
          requestCount + 1 <= rpm &&
          dailyRequestCount + 1 <= rpd &&
          tokenCount + pending.estimatedTokens <= tpm;

        if (!canRun) {
          if (!pending.queuedNotified) {
            pending.onQueued?.({
              queuePosition: index + 1,
              waitMs: this.estimateWaitMs(now),
              priority: pending.priority,
            });
            pending.queuedNotified = true;
          }
          index += 1;
          continue;
        }

        grantedAny = true;
        this.queue.splice(index, 1);
        const reservation: BudgetReservation = {
          id: pending.id,
          timestamp: now,
          requests: 1,
          tokens: pending.estimatedTokens,
        };
        this.reservations.push(reservation);
        pending.resolve({
          release: (actualTokens?: number) => {
            this.releaseReservation(
              reservation.id,
              reservation.timestamp,
              pending.estimatedTokens,
              actualTokens,
            );
          },
        });
      }

      if (!grantedAny) {
        this.scheduleNextCheck();
      } else if (this.queue.length > 0) {
        this.scheduleNextCheck();
      }
    } finally {
      this.processing = false;
    }
  }

  private releaseReservation(
    id: number,
    timestamp: number,
    estimatedTokens: number,
    actualTokens?: number,
  ) {
    this.prune();
    this.reservations = this.reservations.filter((item) => item.id !== id);
    this.usageHistory.push({
      timestamp,
      requests: 1,
      tokens: Math.max(1, Math.floor(actualTokens || estimatedTokens)),
    });
    this.processQueue();
  }
}

const globalKey = Symbol.for('folo.shared-ai-budget');

function getScheduler(): SharedAiBudgetScheduler {
  const target = globalThis as typeof globalThis & {
    [globalKey]?: SharedAiBudgetScheduler;
  };
  if (!target[globalKey]) {
    target[globalKey] = new SharedAiBudgetScheduler();
  }
  return target[globalKey]!;
}

export async function acquireSharedAiBudget(
  request: SharedAiBudgetRequest,
  signal?: AbortSignal,
): Promise<SharedAiBudgetLease> {
  return getScheduler().acquire(request, signal);
}

export function hasAvailableAiBudget(
  request: Pick<SharedAiBudgetRequest, 'estimatedTokens'>,
): boolean {
  return getScheduler().canAcquire(request);
}

export function estimateTextTokens(
  value: string,
  outputReserve = 8_000,
): number {
  const inputTokens = Math.ceil((value || '').length / 4);
  return Math.max(1, inputTokens + outputReserve);
}

function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}
