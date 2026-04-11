/**
 * AsyncPool — adaptive concurrent job pool with priority queue, rate limiting,
 * and event loop pressure integration.
 *
 * Features:
 * - Configurable concurrency with adaptive auto-adjustment
 * - 2-level priority queue (0=manual/higher, 1=auto/lower)
 * - Sliding-window rate limiting
 * - Pause / resume / drain controls
 * - Integration hook for crawler-performance event loop pressure detection
 * - Structured logging and SSE events via appEvents
 *
 * Singleton instances via globalThis[Symbol.for('folo:pool:<name>')].
 */

import { log } from './logger';
import { appEvents } from './events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsyncPoolConfig {
  /** Human-readable pool name (used in logs/events) */
  name: string;
  /** Initial concurrency level */
  initialConcurrency: number;
  /** Minimum concurrency (lower bound for auto-adjustment) */
  minConcurrency: number;
  /** Maximum concurrency (upper bound for auto-adjustment) */
  maxConcurrency: number;
  /** How often to run the adaptive adjustment algorithm (ms). Default 30s. */
  adjustIntervalMs?: number;
  /** Optional sliding-window rate limit */
  rateLimit?: {
    requestsPerWindow: number;
    windowMs: number;
  };
}

/** Result returned by a job executor function */
export interface JobResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

/** A queued job entry */
interface QueuedJob<T> {
  data: T;
  /** Lower number = higher priority. 0 manual, 1 auto-first, 2 auto-retry. */
  priority: number;
  executor: (data: T, signal?: AbortSignal) => Promise<JobResult>;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  addedAt: number; // Date.now() timestamp for ordering within same priority
}

export interface PoolStatus {
  name: string;
  currentConcurrency: number;
  queueDepth: number;
  activeJobs: number;
  successRate: number; // 0-1, based on last adjustIntervalMs window
  avgResponseMs: number; // average job duration in the last window
  rateLimitHits: number; // rate limit rejections in the last window
  failureRate: number; // 0-1, jobs that threw or returned success=false
  state: PoolState;
  loadMultiplier: number; // current throttle multiplier from crawler-performance
  adjustedMaxConcurrency: number; // maxConcurrency * loadMultiplier
}

type PoolState = 'running' | 'paused' | 'draining';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long to pause adjustment after a rate-limit hit (ms) */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Expected response time threshold for "fast" detection (ms) */
const FAST_RESPONSE_THRESHOLD_MS = 5_000;

// ---------------------------------------------------------------------------
// SlidingWindowRateLimiter
// ---------------------------------------------------------------------------

class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  /** Timestamps of recent requests (oldest first) */
  private timestamps: number[] = [];

  constructor(requestsPerWindow: number, windowMs: number) {
    this.maxRequests = requestsPerWindow;
    this.windowMs = windowMs;
  }

  /**
   * Check if a new request is allowed. If not immediately allowed, returns
   * the number of ms to wait before retrying.
   * Returns null if allowed, or the wait time if rate-limited.
   */
  check(): number | null {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }

    if (this.timestamps.length < this.maxRequests) {
      return null; // allowed
    }

    // How long until the oldest request leaves the window?
    const oldest = this.timestamps[0];
    return Math.max(0, oldest + this.windowMs - now);
  }

  /** Record a new request */
  record(): void {
    this.timestamps.push(Date.now());
  }

  /** Returns true if currently at capacity */
  isAtCapacity(): boolean {
    return this.check() !== null;
  }
}

// ---------------------------------------------------------------------------
// AdaptiveMetrics
// ---------------------------------------------------------------------------

class AdaptiveMetrics {
  private requests = 0;
  private failures = 0;
  private totalDurationMs = 0;
  private rateLimitHits = 0;
  /** Timestamps of individual job completions for avgResponseMs */
  private durationHistory: number[] = [];

  record(result: JobResult): void {
    this.requests++;
    if (!result.success) this.failures++;
    this.totalDurationMs += result.durationMs;
    this.durationHistory.push(result.durationMs);

    // Keep history bounded (last 100 jobs)
    if (this.durationHistory.length > 100) {
      this.durationHistory.shift();
    }
  }

  recordRateLimitHit(): void {
    this.rateLimitHits++;
  }

  getRateLimitHits(): number {
    return this.rateLimitHits;
  }

  getSuccessRate(): number {
    if (this.requests === 0) return 1;
    return (this.requests - this.failures) / this.requests;
  }

  getFailureRate(): number {
    if (this.requests === 0) return 0;
    return this.failures / this.requests;
  }

  getAvgResponseMs(): number {
    if (this.requests === 0) return 0;
    return this.totalDurationMs / this.requests;
  }

  /** Number of recent jobs for avgResponseMs calculation */
  getRecentJobCount(): number {
    return this.durationHistory.length;
  }

  /** Rolling average of recent job durations */
  getRecentAvgResponseMs(): number {
    if (this.durationHistory.length === 0) return 0;
    const sum = this.durationHistory.reduce((a, b) => a + b, 0);
    return sum / this.durationHistory.length;
  }

  reset(): void {
    this.requests = 0;
    this.failures = 0;
    this.totalDurationMs = 0;
    this.rateLimitHits = 0;
    this.durationHistory = [];
  }
}

// ---------------------------------------------------------------------------
// AsyncPool
// ---------------------------------------------------------------------------

export class AsyncPool<T> {
  readonly name: string;
  readonly config: AsyncPoolConfig;

  private _concurrency: number;
  private _minConcurrency: number;
  private _maxConcurrency: number;
  private _adjustIntervalMs: number;

  /** Priority buckets: lower number = higher priority */
  private _queue: Map<number, QueuedJob<T>[]> = new Map([
    [0, []],
    [1, []],
    [2, []],
  ]);

  private _activeJobs = new Set<{
    job: QueuedJob<T>;
    abortController: AbortController;
    startedAt: number;
  }>();

  private _state: PoolState = 'running';
  private _drainResolve?: () => void;

  /** Rate limiter (null if no rate limit configured) */
  private _rateLimiter: SlidingWindowRateLimiter | null = null;

  /** Metrics for adaptive algorithm */
  private _metrics = new AdaptiveMetrics();

  /** Timer handle for adaptive adjustment */
  private _adjustTimer: NodeJS.Timeout | null = null;

  /** Cooldown after rate limit hit (prevents rapid adjustment) */
  private _rateLimitCooldownUntil = 0;

  /** Throttle multiplier from crawler-performance integration (0-1) */
  private _loadMultiplier = 1;

  /** Timer handle for rate-limit waiting */
  private _rateLimitTimer: NodeJS.Timeout | null = null;

  constructor(config: AsyncPoolConfig) {
    this.name = config.name;
    this.config = config;
    this._concurrency = config.initialConcurrency;
    this._minConcurrency = config.minConcurrency;
    this._maxConcurrency = config.maxConcurrency;
    this._adjustIntervalMs = config.adjustIntervalMs ?? 30_000;

    if (config.rateLimit) {
      this._rateLimiter = new SlidingWindowRateLimiter(
        config.rateLimit.requestsPerWindow,
        config.rateLimit.windowMs,
      );
    }

    // Start adaptive adjustment timer
    this._startAdjustTimer();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a job.
   * @param data - Job payload passed to the executor
   * @param priority - lower number means higher priority. Default 1.
   * @returns Promise resolving to JobResult
   */
  enqueue(
    data: T,
    priority: number = 1,
    executor: (data: T, signal?: AbortSignal) => Promise<JobResult>,
  ): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      const job: QueuedJob<T> = {
        data,
        priority: priority === 2 ? 2 : priority <= 0 ? 0 : 1,
        executor,
        resolve,
        reject,
        addedAt: Date.now(),
      };

      this._queue.get(job.priority)!.push(job);

      // Emit queued event
      appEvents.emit('pool:status-changed', this.getStatus());

      // Try to start it immediately if conditions are met
      this._tryStartNext();
    });
  }

  /**
   * Returns current pool status with live metrics.
   */
  getStatus(): PoolStatus {
    return {
      name: this.name,
      currentConcurrency: this._concurrency,
      queueDepth: this._getQueueDepth(),
      activeJobs: this._activeJobs.size,
      successRate: this._metrics.getSuccessRate(),
      avgResponseMs: this._metrics.getRecentAvgResponseMs(),
      rateLimitHits: this._metrics.getRateLimitHits(),
      failureRate: this._metrics.getFailureRate(),
      state: this._state,
      loadMultiplier: this._loadMultiplier,
      adjustedMaxConcurrency: this._getAdjustedMax(),
    };
  }

  /**
   * Pause dequeuing. In-flight jobs continue to completion.
   * Calling pause() on an already-paused pool is a no-op.
   */
  pause(): void {
    if (this._state === 'paused') return;
    this._state = 'paused';
    log.info('system', 'pool_pause', { pool: this.name });
    appEvents.emit('pool:status-changed', this.getStatus());
  }

  /**
   * Resume dequeuing. Does NOT auto-start queued jobs — they will be
   * started by subsequent enqueue calls or by calling drain() which
   * triggers a flush.
   */
  resume(): void {
    if (this._state !== 'paused') return;
    this._state = 'running';
    log.info('system', 'pool_resume', { pool: this.name });
    appEvents.emit('pool:status-changed', this.getStatus());
    this._tryStartNext();
  }

  /**
   * Clear queued jobs that have not started yet.
   * In-flight jobs are not affected.
   * Returns the number of removed queued jobs.
   */
  clearQueued(
    predicate?: (data: T) => boolean,
    reason = 'queue cleared',
  ): number {
    let cleared = 0;

    for (const priority of [0, 1, 2] as const) {
      const bucket = this._queue.get(priority)!;
      for (let index = bucket.length - 1; index >= 0; index -= 1) {
        const job = bucket[index];
        if (predicate && !predicate(job.data)) continue;
        bucket.splice(index, 1);
        job.reject(new Error(reason));
        cleared += 1;
      }
    }

    if (cleared > 0) {
      log.info('system', 'pool_clear_queued', { pool: this.name, cleared });
      appEvents.emit('pool:status-changed', this.getStatus());
      this._checkDrainComplete();
    }

    return cleared;
  }

  /**
   * Abort active jobs that are already running.
   * Returns the number of jobs signaled for abort.
   */
  abortActive(
    predicate?: (data: T) => boolean,
    reason = 'job aborted',
  ): number {
    let aborted = 0;

    for (const active of this._activeJobs) {
      if (predicate && !predicate(active.job.data)) continue;
      active.abortController.abort(new Error(reason));
      aborted += 1;
    }

    if (aborted > 0) {
      log.info('system', 'pool_abort_active', {
        pool: this.name,
        aborted,
        reason,
      });
      appEvents.emit('pool:status-changed', this.getStatus());
    }

    return aborted;
  }

  /**
   * Drains the pool: waits for all queued and in-flight jobs to complete.
   * While draining, the pool is paused (no new jobs can be enqueued).
   * Returns a Promise that resolves when everything is done.
   */
  drain(): Promise<void> {
    if (this._drainResolve) {
      return Promise.resolve(); // already draining
    }

    const queueEmpty =
      this._getQueueDepth() === 0 && this._activeJobs.size === 0;
    if (queueEmpty) {
      return Promise.resolve();
    }

    this._state = 'draining';

    log.info('system', 'pool_drain_start', {
      pool: this.name,
      queueDepth: this._getQueueDepth(),
      activeJobs: this._activeJobs.size,
    });

    appEvents.emit('pool:status-changed', this.getStatus());

    return new Promise<void>((resolve) => {
      // Store a resolver — state transition and event emission handled by _checkDrainComplete
      this._drainResolve = () => {
        this._drainResolve = undefined;
        resolve();
      };
    });
  }

  /**
   * Integration hook for crawler-performance.ts.
   * Called when the event loop is under pressure.
   * @param loadMultiplier - 0-1 throttle factor (e.g. 0.5 = cut concurrency in half)
   */
  setLoadMultiplier(loadMultiplier: number): void {
    const clamped = Math.max(0.1, Math.min(1, loadMultiplier));
    if (clamped === this._loadMultiplier) return;
    this._loadMultiplier = clamped;

    log.info('system', 'pool_load_multiplier', {
      pool: this.name,
      loadMultiplier: clamped,
      adjustedMaxConcurrency: this._getAdjustedMax(),
    });

    appEvents.emit('pool:status-changed', this.getStatus());

    // After load multiplier changes, try to start more/fewer jobs
    // if we were previously blocked by the concurrency cap
    this._tryStartNext();
  }

  /**
   * Clean up timers and resources. Pool can no longer be used after destroy().
   */
  destroy(): void {
    if (this._adjustTimer) {
      clearInterval(this._adjustTimer);
      this._adjustTimer = null;
    }
    if (this._rateLimitTimer) {
      clearTimeout(this._rateLimitTimer);
      this._rateLimitTimer = null;
    }

    // Abort all active jobs
    for (const active of this._activeJobs) {
      active.abortController.abort();
    }
    this._activeJobs.clear();

    // Clear queue
    this._queue.get(0)!.length = 0;
    this._queue.get(1)!.length = 0;
    this._queue.get(2)!.length = 0;

    log.info('system', 'pool_destroyed', { pool: this.name });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _getQueueDepth(): number {
    return (
      (this._queue.get(0)?.length ?? 0) +
      (this._queue.get(1)?.length ?? 0) +
      (this._queue.get(2)?.length ?? 0)
    );
  }

  private _getAdjustedMax(): number {
    return Math.max(
      this._minConcurrency,
      Math.floor(this._maxConcurrency * this._loadMultiplier),
    );
  }

  private _getEffectiveConcurrency(): number {
    return Math.min(this._concurrency, this._getAdjustedMax());
  }

  /** Check if drain should complete */
  private _checkDrainComplete(): void {
    if (!this._drainResolve) return; // not draining
    if (this._state !== 'draining') return; // already completed

    // When draining, we wait for in-flight jobs to finish, then start the next queued job.
    // Only fire the drain resolver when BOTH activeJobs=0 AND queue is empty.
    if (this._activeJobs.size > 0) return; // still waiting for in-flight jobs

    // activeJobs is 0 here
    if (this._getQueueDepth() > 0) {
      // Queue still has jobs — start the next one while staying in 'draining' state.
      // We transition to 'running' temporarily to allow _tryStartNext to start it.
      this._state = 'running';
      this._tryStartNext(); // starts the next job
      // Immediately go back to draining
      this._state = 'draining';
    } else {
      // Queue empty and no active jobs — drain is complete
      const resolver = this._drainResolve;
      this._drainResolve = undefined;
      this._state = 'running';
      resolver(); // transitions state and resolves drain Promise
    }
  }

  private _startAdjustTimer(): void {
    this._adjustTimer = setInterval(() => {
      this._adaptiveAdjust();
    }, this._adjustIntervalMs);
    // Unref so the timer doesn't keep the process alive
    this._adjustTimer.unref?.();
  }

  /**
   * Dequeue the next job from the highest-available priority bucket.
   * Returns null if all buckets are empty.
   */
  private _dequeueNext(): QueuedJob<T> | null {
    for (const priority of [0, 1, 2]) {
      const bucket = this._queue.get(priority)!;
      if (bucket.length > 0) {
        // Find the job with the earliest addedAt (FIFO within same priority) — O(n)
        let earliestIdx = 0;
        let earliestAt = bucket[0].addedAt;
        for (let i = 1; i < bucket.length; i++) {
          if (bucket[i].addedAt < earliestAt) {
            earliestAt = bucket[i].addedAt;
            earliestIdx = i;
          }
        }
        return bucket.splice(earliestIdx, 1)[0];
      }
    }
    return null;
  }

  /**
   * Check rate limiter. Returns null if allowed, or schedules a wait and returns false.
   * Does NOT record rate limit hits during cooldown — cooldown acts as a "pause"
   * on rate limit decisions, not as accumulated penalty.
   */
  private _checkRateLimit(): boolean {
    if (!this._rateLimiter) return true;

    const waitMs = this._rateLimiter.check();
    if (waitMs === null) {
      return true; // allowed
    }

    // During cooldown, don't record rate limit hits — just let the job wait
    // for the rate limit window to clear naturally. Cooldown prevents
    // repeated adjustment decisions, but doesn't extend the rate limit window.
    const now = Date.now();
    if (now < this._rateLimitCooldownUntil) {
      // Schedule a retry after the wait period (let the window clear)
      if (this._rateLimitTimer) {
        clearTimeout(this._rateLimitTimer);
      }
      this._rateLimitTimer = setTimeout(() => {
        this._rateLimitTimer = null;
        this._tryStartNext(); // retry after wait
      }, waitMs);
      return false;
    }

    // Rate limited (and not in cooldown) — record the hit
    if (this._rateLimitTimer) {
      clearTimeout(this._rateLimitTimer);
    }

    this._metrics.recordRateLimitHit();

    this._rateLimitTimer = setTimeout(() => {
      this._rateLimitTimer = null;
      this._tryStartNext(); // retry
    }, waitMs);

    return false;
  }

  private _tryStartNext(): void {
    // Don't start if paused or draining
    if (this._state !== 'running') return;

    // Loop and start up to (effectiveConcurrency - activeCount) jobs
    while (this._activeJobs.size < this._getEffectiveConcurrency()) {
      // Check rate limit
      if (!this._checkRateLimit()) return;

      // Dequeue next job
      const job = this._dequeueNext();
      if (!job) return; // queue empty

      this._startJob(job);
    }
  }

  private _startJob(job: QueuedJob<T>): void {
    const abortController = new AbortController();
    const startedAt = Date.now();

    const activeEntry = { job, abortController, startedAt };
    this._activeJobs.add(activeEntry);

    // Record in rate limiter
    this._rateLimiter?.record();

    // Notify status change
    appEvents.emit('pool:status-changed', this.getStatus());

    // Run the job
    job
      .executor(job.data, abortController.signal)
      .then((result) => {
        const durationMs = Date.now() - startedAt;
        const finalResult: JobResult = { ...result, durationMs };

        this._metrics.record(finalResult);
        this._activeJobs.delete(activeEntry);

        job.resolve(finalResult);
        this._onJobDone();
      })
      .catch((err: unknown) => {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);

        this._metrics.record({
          success: false,
          durationMs,
          error: message,
        });
        this._activeJobs.delete(activeEntry);

        // Handle abort gracefully — resolve (not reject) so drain() completes
        const isAbort =
          err instanceof DOMException && err.name === 'AbortError';

        if (isAbort) {
          job.resolve({ success: false, durationMs, error: 'aborted' });
        } else if (err instanceof Error) {
          job.reject(err);
        } else {
          job.reject(new Error(message));
        }
        this._onJobDone();
      });
  }

  private _onJobDone(): void {
    // Check if drain should complete (starts next queued job if draining, or fires resolver if done)
    this._checkDrainComplete();
    // Always try to start the next job (drain handles its own state)
    this._tryStartNext();
  }

  /**
   * Adaptive concurrency adjustment algorithm.
   *
   * Runs every adjustIntervalMs:
   * - rateLimitHits > 0  → shrink by 2 (with 60s adjustment cooldown)
   * - failureRate > 50%  → shrink by 1
   * - failureRate < 10% && fast responses → grow by 1
   * - else               → hold
   *
   * Bounds: [minConcurrency, adjustedMaxConcurrency]
   */
  private _adaptiveAdjust(): void {
    const now = Date.now();

    // Skip if in cooldown after a rate limit hit
    if (now < this._rateLimitCooldownUntil) {
      return;
    }

    // Note: We do NOT reset metrics at the start of this function.
    // Metrics accumulate between adjustment intervals and are evaluated here.
    // Reset happens AFTER evaluation (see below), so we can make decisions
    // based on the full observation window before starting fresh.

    // If no jobs have run in this window, don't make any changes.
    // This prevents spurious adjustments when the pool is idle.
    if (this._metrics.getRecentJobCount() === 0) {
      return;
    }

    const effectiveMax = this._getAdjustedMax();
    const prevConcurrency = this._concurrency;

    let newConcurrency = prevConcurrency;

    if (this._metrics.getRateLimitHits() > 0) {
      // Rate limit hit → shrink by 2
      newConcurrency = Math.max(this._minConcurrency, prevConcurrency - 2);
      this._rateLimitCooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;

      log.info('system', 'pool_adjust', {
        pool: this.name,
        reason: 'rate_limit',
        prev_concurrency: prevConcurrency,
        new_concurrency: newConcurrency,
        success_rate: this._metrics.getSuccessRate().toFixed(3),
        avg_response_ms: Math.round(this._metrics.getRecentAvgResponseMs()),
        queue_depth: this._getQueueDepth(),
      });
    } else if (this._metrics.getFailureRate() > 0.5) {
      // High failure rate → shrink by 1
      newConcurrency = Math.max(this._minConcurrency, prevConcurrency - 1);

      log.info('system', 'pool_adjust', {
        pool: this.name,
        reason: 'high_failure_rate',
        prev_concurrency: prevConcurrency,
        new_concurrency: newConcurrency,
        success_rate: this._metrics.getSuccessRate().toFixed(3),
        avg_response_ms: Math.round(this._metrics.getRecentAvgResponseMs()),
        queue_depth: this._getQueueDepth(),
      });
    } else if (
      this._metrics.getFailureRate() < 0.1 &&
      this._metrics.getRecentAvgResponseMs() < FAST_RESPONSE_THRESHOLD_MS &&
      prevConcurrency < effectiveMax
    ) {
      // Healthy metrics → grow by 1
      newConcurrency = Math.min(effectiveMax, prevConcurrency + 1);

      log.info('system', 'pool_adjust', {
        pool: this.name,
        reason: 'healthy',
        prev_concurrency: prevConcurrency,
        new_concurrency: newConcurrency,
        success_rate: this._metrics.getSuccessRate().toFixed(3),
        avg_response_ms: Math.round(this._metrics.getRecentAvgResponseMs()),
        queue_depth: this._getQueueDepth(),
      });
    }
    // else: hold

    // Reset metrics at the END of the interval, after evaluation.
    // This ensures each adjustment decision is based on the full observation
    // window before metrics are cleared for the next window.
    this._metrics.reset();

    // Apply change and emit event
    if (newConcurrency !== prevConcurrency) {
      this._concurrency = newConcurrency;

      appEvents.emit('pool:status-changed', this.getStatus());

      // Try to start more jobs if we just grew
      this._tryStartNext();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

const POOL_REGISTRY_KEY = Symbol.for('folo:pool:registry');

interface PoolRegistry {
  pools: Map<string, AsyncPool<unknown>>;
}

function getPoolRegistry(): PoolRegistry {
  const g = globalThis as Record<symbol, PoolRegistry>;
  if (!g[POOL_REGISTRY_KEY]) {
    g[POOL_REGISTRY_KEY] = { pools: new Map() };
  }
  return g[POOL_REGISTRY_KEY];
}

/**
 * Get (or create) a named AsyncPool singleton.
 * Use this instead of `new AsyncPool(...)` directly to survive HMR.
 *
 * @example
 * const pool = getOrCreatePool('enrichment', {
 *   name: 'enrichment',
 *   initialConcurrency: 3,
 *   minConcurrency: 1,
 *   maxConcurrency: 6,
 *   rateLimit: { requestsPerWindow: 10, windowMs: 5000 },
 * });
 */
export function getOrCreatePool<T>(
  name: string,
  config: AsyncPoolConfig,
): AsyncPool<T> {
  const registry = getPoolRegistry();

  if (!registry.pools.has(name)) {
    const pool = new AsyncPool<T>(config);
    registry.pools.set(name, pool as AsyncPool<unknown>);
    log.info('system', 'pool_created', {
      pool: name,
      initialConcurrency: config.initialConcurrency,
      minConcurrency: config.minConcurrency,
      maxConcurrency: config.maxConcurrency,
      rateLimit: config.rateLimit ?? null,
    });
  }

  return registry.pools.get(name) as AsyncPool<T>;
}

/**
 * Get a named pool (must already exist, throws if not found).
 */
export function getPool(name: string): AsyncPool<unknown> | undefined {
  return getPoolRegistry().pools.get(name);
}

/**
 * Get status of all registered pools.
 */
export function getAllPoolStatus(): Record<string, PoolStatus> {
  const registry = getPoolRegistry();
  const result: Record<string, PoolStatus> = {};
  for (const [name, pool] of registry.pools) {
    result[name] = pool.getStatus();
  }
  return result;
}
