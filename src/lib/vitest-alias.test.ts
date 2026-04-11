import { describe, expect, it } from 'vitest';

import { buildVideoUrl } from '@/lib/url-utils';

describe('Vitest path alias setup', () => {
  it('resolves @/ imports in test files', () => {
    expect(buildVideoUrl('youtube', 'abc123')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
  });
});
