import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserKeepaliveController,
  shouldEnableBrowserKeepalive,
} from './browser-keepalive-client';

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void, delayMs: number) => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout> | null) => {
        if (timer === null) return;
        timers.delete(timer as unknown as number);
      },
    },
    advanceBy(ms: number) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
          ran = true;
        }
      }
    },
  };
}

describe('browser keepalive client controller', () => {
  it('throttles activity to one keepalive request every 20 seconds', async () => {
    const { clock, advanceBy } = createClock();
    const sendKeepalive = vi.fn().mockResolvedValue(undefined);
    const controller = createBrowserKeepaliveController({
      config: { preset: 'balanced', activeGraceMs: 2 * 60 * 1000 },
      sendKeepalive,
      clock,
    });

    controller.notifyActivity();
    await Promise.resolve();
    controller.notifyActivity();
    await Promise.resolve();
    expect(sendKeepalive).toHaveBeenCalledTimes(1);

    advanceBy(19_999);
    await Promise.resolve();
    expect(sendKeepalive).toHaveBeenCalledTimes(1);

    advanceBy(1);
    await Promise.resolve();
    expect(sendKeepalive).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it('stops scheduling immediately when the document becomes hidden', async () => {
    const { clock, advanceBy } = createClock();
    const sendKeepalive = vi.fn().mockResolvedValue(undefined);
    const controller = createBrowserKeepaliveController({
      config: { preset: 'balanced', activeGraceMs: 2 * 60 * 1000 },
      sendKeepalive,
      clock,
    });

    controller.notifyActivity();
    await Promise.resolve();
    controller.setVisible(false);

    advanceBy(60_000);
    await Promise.resolve();
    expect(sendKeepalive).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('resumes after the page becomes visible and the next activity arrives', async () => {
    const { clock, advanceBy } = createClock();
    const sendKeepalive = vi.fn().mockResolvedValue(undefined);
    const controller = createBrowserKeepaliveController({
      config: { preset: 'aggressive', activeGraceMs: 5 * 60 * 1000 },
      sendKeepalive,
      clock,
    });

    controller.notifyActivity();
    await Promise.resolve();
    controller.setVisible(false);
    advanceBy(30_000);
    controller.setVisible(true);
    controller.notifyActivity();
    await Promise.resolve();

    expect(sendKeepalive).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('disables scheduling when preset is off', () => {
    expect(
      shouldEnableBrowserKeepalive({ preset: 'off', activeGraceMs: 0 }),
    ).toBe(false);
    expect(
      shouldEnableBrowserKeepalive({
        preset: 'balanced',
        activeGraceMs: 2 * 60 * 1000,
      }),
    ).toBe(true);
  });
});
