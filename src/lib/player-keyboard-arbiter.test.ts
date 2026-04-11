import { describe, expect, it } from 'vitest';
import {
  isTypingContextTarget,
  resolvePlayerKeyboardAction,
} from './player-keyboard-arbiter';

describe('isTypingContextTarget', () => {
  it('detects form fields and contentEditable targets', () => {
    expect(isTypingContextTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingContextTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingContextTarget({ tagName: 'select' })).toBe(true);
    expect(isTypingContextTarget({ isContentEditable: true })).toBe(true);
  });

  it('ignores non-input targets', () => {
    expect(isTypingContextTarget(null)).toBe(false);
    expect(isTypingContextTarget({ tagName: 'div' })).toBe(false);
  });
});

describe('resolvePlayerKeyboardAction', () => {
  it('lets all keys pass through while typing', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Escape' },
        { isTypingContext: true },
      ),
    ).toBe('none');
    expect(
      resolvePlayerKeyboardAction(
        { key: ' ', code: 'Space' },
        { isTypingContext: true },
      ),
    ).toBe('none');
  });

  it('only keeps escape at app level in non-typing mode', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Escape' },
        { isTypingContext: false },
      ),
    ).toBe('close-modal');
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab' },
        { isTypingContext: false },
      ),
    ).toBe('none');
    expect(
      resolvePlayerKeyboardAction(
        { key: '`', code: 'Backquote' },
        { isTypingContext: false },
      ),
    ).toBe('none');
    expect(
      resolvePlayerKeyboardAction(
        { key: ' ', code: 'Space' },
        { isTypingContext: false },
      ),
    ).toBe('none');
  });

  it('ignores modified and already-handled events', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab', metaKey: true },
        { isTypingContext: false },
      ),
    ).toBe('none');
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab', defaultPrevented: true },
        { isTypingContext: false },
      ),
    ).toBe('none');
  });
});
