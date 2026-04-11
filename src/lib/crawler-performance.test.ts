import { describe, expect, it } from 'vitest';

import type { CrawlerPerformanceStatus } from '@/lib/crawler-performance';
import { getCrawlerPerformanceSummary } from '@/lib/crawler-performance';

function createStatus(
  overrides: Partial<CrawlerPerformanceStatus>,
): CrawlerPerformanceStatus {
  return {
    profile: 'medium',
    profileLabel: '中',
    loadState: 'normal',
    loadStateLabel: '运行平稳',
    eventLoopLagMs: 42,
    peakLagMs: 42,
    throttleMultiplier: 1,
    updatedAt: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

describe('getCrawlerPerformanceSummary', () => {
  it('summarizes normal load state', () => {
    expect(getCrawlerPerformanceSummary(createStatus({}))).toBe(
      '性能档位 中，当前平稳（事件循环延迟 42ms）',
    );
  });

  it('summarizes busy load state with throttle multiplier', () => {
    expect(
      getCrawlerPerformanceSummary(
        createStatus({
          loadState: 'busy',
          loadStateLabel: '检测到负载升高，已自动降频',
          eventLoopLagMs: 150,
          throttleMultiplier: 2,
        }),
      ),
    ).toBe(
      '性能档位 中，检测到负载升高，已自动降频（事件循环延迟 150ms，倍率 x2）',
    );
  });

  it('summarizes strained load state with stronger throttling', () => {
    expect(
      getCrawlerPerformanceSummary(
        createStatus({
          profile: 'low',
          profileLabel: '低',
          loadState: 'strained',
          loadStateLabel: '明显卡顿，已进一步降频',
          eventLoopLagMs: 280,
          throttleMultiplier: 3,
        }),
      ),
    ).toBe(
      '性能档位 低，明显卡顿，已进一步降频（事件循环延迟 280ms，倍率 x3）',
    );
  });
});
