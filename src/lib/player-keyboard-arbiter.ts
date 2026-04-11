export type PlayerKeyboardAction =
  | 'none'
  | 'close-modal';

export interface KeyboardEventLike {
  key: string;
  code?: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
}

export function isTypingContextTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;

  const element = target as ElementLike;
  if (element.isContentEditable === true) return true;

  const tagName =
    typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';

  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

export function resolvePlayerKeyboardAction(
  event: KeyboardEventLike,
  options: {
    isTypingContext: boolean;
  },
): PlayerKeyboardAction {
  if (options.isTypingContext) return 'none';
  if (event.defaultPrevented) return 'none';
  if (event.altKey || event.ctrlKey || event.metaKey) return 'none';

  if (event.key === 'Escape') {
    return 'close-modal';
  }

  return 'none';
}
