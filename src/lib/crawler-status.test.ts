import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appEvents } from '@/lib/events';

const { getDb } = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb,
}));

import {
  getCrawlerRuntimeStatus,
  resetCrawlerScopeStatus,
  setCrawlerPaused,
  updateCrawlerScopeStatus,
} from '@/lib/crawler-status';

describe('crawler-status events', () => {
  let pausedValue = '0';
  let runtimeValue: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    pausedValue = '0';
    runtimeValue = null;
    getDb.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        get: vi.fn((key: string) => {
          if (key === 'crawler_pause_state') {
            return {
              value: pausedValue,
              updated_at: '2026-03-29T00:00:00.000Z',
            };
          }
          if (key === 'crawler_runtime_status_v1') {
            return runtimeValue ? { value: runtimeValue } : undefined;
          }
          return undefined;
        }),
        run: vi.fn((key: string, value: string) => {
          if (!sql.includes('INSERT INTO app_settings')) {
            return;
          }
          if (key === 'crawler_pause_state') {
            pausedValue = value;
          }
          if (key === 'crawler_runtime_status_v1') {
            runtimeValue = value;
          }
        }),
      })),
    });
    resetCrawlerScopeStatus('feed');
  });

  afterEach(() => {
    appEvents.removeAllListeners('crawler:status-changed');
  });

  it('emits crawler status when feed progress changes', () => {
    const handler = vi.fn();
    appEvents.on('crawler:status-changed', handler);

    updateCrawlerScopeStatus('feed', {
      state: 'running',
      targetLabel: 'Test Channel',
      progress: 2,
      total: 5,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      feed: expect.objectContaining({
        state: 'running',
        targetLabel: 'Test Channel',
        progress: 2,
        total: 5,
      }),
      paused: false,
    });
  });

  it('emits crawler status when pause state changes', () => {
    const handler = vi.fn();
    appEvents.on('crawler:status-changed', handler);

    setCrawlerPaused(true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(getCrawlerRuntimeStatus().paused).toBe(true);
  });
});
