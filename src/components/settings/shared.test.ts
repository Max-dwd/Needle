import { describe, expect, it } from 'vitest';
import {
  crawlIntervalOptions,
  normalizeSettingsTab,
  settingsNavItems,
} from './shared';

describe('crawlIntervalOptions', () => {
  it('includes a 15 minute option at the front', () => {
    expect(crawlIntervalOptions[0]).toEqual({
      value: 15 * 60,
      label: '15分钟',
    });
  });

  it('keeps the expected crawl interval values', () => {
    expect(crawlIntervalOptions.map((option) => option.value)).toEqual([
      15 * 60,
      30 * 60,
      60 * 60,
      2 * 60 * 60,
      4 * 60 * 60,
      8 * 60 * 60,
      12 * 60 * 60,
      24 * 60 * 60,
    ]);
  });
});

describe('settings navigation', () => {
  it('includes the performance tab', () => {
    expect(settingsNavItems.some((item) => item.id === 'performance')).toBe(
      true,
    );
  });

  it('falls back unknown tabs to crawling', () => {
    expect(normalizeSettingsTab('unknown')).toBe('crawling');
  });
});
