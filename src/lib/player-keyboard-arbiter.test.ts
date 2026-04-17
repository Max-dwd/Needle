import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  isTypingContextTarget,
  resolvePlayerKeyboardAction,
} from './player-keyboard-arbiter';

const shortcutSettings = {
  enabled: true,
  bindings: DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  rateStep: 0.1,
  seekSeconds: 10,
};

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
        { isTypingContext: true, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
    expect(
      resolvePlayerKeyboardAction(
        { key: ' ', code: 'Space' },
        { isTypingContext: true, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
  });

  it('only keeps escape at app level in non-typing mode', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Escape' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'close-modal' });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
    expect(
      resolvePlayerKeyboardAction(
        { key: '`', code: 'Backquote' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
    expect(
      resolvePlayerKeyboardAction(
        { key: ' ', code: 'Space' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'play-pause' });
  });

  it('ignores modified and already-handled events', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab', metaKey: true },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'Tab', defaultPrevented: true },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'none' });
  });

  it('dispatches configured shortcut bindings', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'a' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'rate-toggle' });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'S' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'rate-step', delta: -0.1 });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'd' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'rate-step', delta: 0.1 });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'z' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'seek-step', seconds: -10 });
    expect(
      resolvePlayerKeyboardAction(
        { key: 'x' },
        { isTypingContext: false, settings: shortcutSettings },
      ),
    ).toEqual({ type: 'seek-step', seconds: 10 });
  });

  it('does not dispatch bindings when disabled', () => {
    expect(
      resolvePlayerKeyboardAction(
        { key: 'a' },
        {
          isTypingContext: false,
          settings: { ...shortcutSettings, enabled: false },
        },
      ),
    ).toEqual({ type: 'none' });
  });
});
