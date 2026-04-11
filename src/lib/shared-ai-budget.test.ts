import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAiSummarySettings = vi.hoisted(() => vi.fn());

vi.mock('./ai-summary-settings', () => ({
  getAiSummarySettings: mockGetAiSummarySettings,
}));

import { acquireSharedAiBudget, hasAvailableAiBudget } from './shared-ai-budget';

const schedulerKey = Symbol.for('folo.shared-ai-budget');
type SchedulerState = {
  queue: unknown[];
  processQueue: () => void;
};

function getSchedulerState(): SchedulerState | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[schedulerKey] as
    | SchedulerState
    | undefined;
}

describe('shared ai budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T10:00:00.000Z'));
    mockGetAiSummarySettings.mockReturnValue({
      sharedRequestsPerMinute: 10,
      sharedRequestsPerDay: 1,
      sharedTokensPerMinute: 1_000_000,
    });
    delete (globalThis as Record<PropertyKey, unknown>)[schedulerKey];
  });

  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[schedulerKey];
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('enforces daily request limits across a rolling 24-hour window', async () => {
    const lease = await acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 100,
      label: 'first-request',
    });

    lease.release(120);

    expect(hasAvailableAiBudget({ estimatedTokens: 100 })).toBe(false);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    expect(hasAvailableAiBudget({ estimatedTokens: 100 })).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireSharedAiBudget(
        {
          priority: 'manual-summary',
          estimatedTokens: 100,
          label: 'pre-aborted-request',
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });

    expect(getSchedulerState()?.queue ?? []).toHaveLength(0);

    const lease = await acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 100,
      label: 'follow-up-request',
    });
    lease.release(100);
  });

  it('removes queued requests and rejects when the signal aborts during waiting', async () => {
    mockGetAiSummarySettings.mockReturnValue({
      sharedRequestsPerMinute: 10,
      sharedRequestsPerDay: 10,
      sharedTokensPerMinute: 100,
    });

    const activeLease = await acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 100,
      label: 'active-request',
    });

    const controller = new AbortController();
    const queuedRequest = acquireSharedAiBudget(
      {
        priority: 'manual-summary',
        estimatedTokens: 50,
        label: 'queued-request',
      },
      controller.signal,
    );

    expect(getSchedulerState()?.queue).toHaveLength(1);

    controller.abort();

    await expect(queuedRequest).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    });
    expect(getSchedulerState()?.queue).toHaveLength(0);

    activeLease.release(1);

    const followUpLease = await acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 50,
      label: 'follow-up-request',
    });
    followUpLease.release(1);
  });

  it('calls onQueued at most once per queued request', async () => {
    mockGetAiSummarySettings.mockReturnValue({
      sharedRequestsPerMinute: 10,
      sharedRequestsPerDay: 10,
      sharedTokensPerMinute: 100,
    });

    const activeLease = await acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 100,
      label: 'active-request',
    });
    const onQueued = vi.fn();

    const queuedRequest = acquireSharedAiBudget({
      priority: 'manual-summary',
      estimatedTokens: 50,
      label: 'queued-request',
      onQueued,
    });

    expect(onQueued).toHaveBeenCalledTimes(1);

    const scheduler = getSchedulerState();
    scheduler?.processQueue();
    scheduler?.processQueue();

    expect(onQueued).toHaveBeenCalledTimes(1);

    activeLease.release(1);
    const queuedLease = await queuedRequest;
    queuedLease.release(1);
  });
});
