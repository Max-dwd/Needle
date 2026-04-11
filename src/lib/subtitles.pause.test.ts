import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWaitIfCrawlerPaused = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
);

vi.mock('./crawler-status', () => ({
  waitIfCrawlerPaused: mockWaitIfCrawlerPaused,
  updateCrawlerScopeStatus: vi.fn(),
  resetCrawlerScopeStatus: vi.fn(),
}));

import { waitForCrawlerResumeIfNeeded } from './subtitles';

describe('subtitle pause handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for crawler resume when pause should be respected', async () => {
    await waitForCrawlerResumeIfNeeded(true);

    expect(mockWaitIfCrawlerPaused).toHaveBeenCalledTimes(1);
  });

  it('skips pause waiting for manual subtitle requests', async () => {
    await waitForCrawlerResumeIfNeeded(false);

    expect(mockWaitIfCrawlerPaused).not.toHaveBeenCalled();
  });
});
