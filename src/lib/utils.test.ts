import { describe, expect, it } from 'vitest';

import { cn, generateSlug } from '@/lib/utils';

describe('cn', () => {
  it('returns a single class unchanged', () => {
    expect(cn('rounded')).toBe('rounded');
  });

  it('merges multiple class inputs into one string', () => {
    expect(cn('px-4', 'py-2', 'font-medium')).toBe('px-4 py-2 font-medium');
  });

  it('supports conditional and falsy class values', () => {
    expect(
      cn('base', false && 'hidden', undefined, { active: true, muted: false }),
    ).toBe('base active');
  });

  it('deduplicates conflicting Tailwind utility classes', () => {
    expect(cn('px-2 text-sm', 'px-4', 'text-lg')).toBe('px-4 text-lg');
  });
});

describe('generateSlug', () => {
  it('normalizes mixed input into a slug', () => {
    expect(generateSlug('Deep Research 101')).toBe('deep-research-101');
  });

  it('preserves chinese characters and trims separators', () => {
    expect(generateSlug('  学习探索 / notes  ')).toBe('学习探索-notes');
  });
});
