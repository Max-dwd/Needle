import { describe, expect, it } from 'vitest';

import { buildSubtitleBackoffFlow } from './subtitle-backoff-flow';

describe('buildSubtitleBackoffFlow', () => {
  it('renders the first three exponential stages using compact units', () => {
    expect(buildSubtitleBackoffFlow(10, 1, 3).map((step) => step.label)).toEqual([
      '10s',
      '20s',
      '40s',
    ]);
  });

  it('highlights the first stage in green when there is no backoff', () => {
    const flow = buildSubtitleBackoffFlow(10 * 60, 1, 3);

    expect(flow[0]).toMatchObject({
      label: '10min',
      color: '#16a34a',
      isCurrent: true,
    });
    expect(flow[1]).toMatchObject({
      label: '20min',
      color: '#94a3b8',
      isCurrent: false,
    });
    expect(flow[2]).toMatchObject({
      label: '40min',
      color: '#94a3b8',
      isCurrent: false,
    });
  });

  it('marks later stages as yellow for active backoff multipliers', () => {
    const flow = buildSubtitleBackoffFlow(10, 4, 3);

    expect(flow[0]).toMatchObject({
      label: '10s',
      color: '#94a3b8',
      isCurrent: false,
    });
    expect(flow[1]).toMatchObject({
      label: '20s',
      color: '#94a3b8',
      isCurrent: false,
    });
    expect(flow[2]).toMatchObject({
      label: '40s',
      color: '#f59e0b',
      isCurrent: true,
    });
  });

  it('extends the flow to match the configured retry count', () => {
    expect(
      buildSubtitleBackoffFlow(10, 1, 5).map((step) => step.label),
    ).toEqual(['10s', '20s', '40s', '1min 20s', '2min 40s']);
  });

  it('formats day-scale intervals with d and h units', () => {
    expect(
      buildSubtitleBackoffFlow(12 * 60 * 60, 1, 3).map((step) => step.label),
    ).toEqual(['12h', '1d', '2d']);
  });
});
