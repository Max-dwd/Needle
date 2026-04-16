export const PLAYER_KEYBOARD_ACTION_IDS = [
  'play-pause',
  'rate-toggle',
  'rate-decrement',
  'rate-increment',
  'seek-backward',
  'seek-forward',
] as const;

export type PlayerKeyboardActionId =
  (typeof PLAYER_KEYBOARD_ACTION_IDS)[number];

export interface PlayerKeyboardBinding {
  action: PlayerKeyboardActionId;
  key: string;
}

export const DEFAULT_PLAYER_KEYBOARD_BINDINGS: PlayerKeyboardBinding[] = [
  { action: 'play-pause', key: ' ' },
  { action: 'rate-toggle', key: 'a' },
  { action: 'rate-decrement', key: 's' },
  { action: 'rate-increment', key: 'd' },
  { action: 'seek-backward', key: 'z' },
  { action: 'seek-forward', key: 'x' },
];

export type PlayerKeyboardAction =
  | { type: 'none' }
  | { type: 'close-modal' }
  | { type: 'play-pause' }
  | { type: 'rate-toggle' }
  | { type: 'rate-step'; delta: number }
  | { type: 'seek-step'; seconds: number };

export interface KeyboardEventLike {
  key: string;
  code?: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface PlayerKeyboardShortcutSettings {
  enabled: boolean;
  bindings: PlayerKeyboardBinding[];
  rateStep: number;
  seekSeconds: number;
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

export function normalizeKeyboardKey(key: string): string {
  if (key === ' ' || key === 'Spacebar' || key === 'Space') return 'space';
  const trimmed = key.trim();
  return trimmed.toLowerCase();
}

function findBinding(
  event: KeyboardEventLike,
  bindings: PlayerKeyboardBinding[],
): PlayerKeyboardBinding | null {
  const eventKey = normalizeKeyboardKey(event.key);
  return (
    bindings.find(
      (binding) => normalizeKeyboardKey(binding.key) === eventKey,
    ) ?? null
  );
}

export function resolvePlayerKeyboardAction(
  event: KeyboardEventLike,
  options: {
    isTypingContext: boolean;
    settings?: PlayerKeyboardShortcutSettings | null;
  },
): PlayerKeyboardAction {
  if (options.isTypingContext) return { type: 'none' };
  if (event.defaultPrevented) return { type: 'none' };
  if (event.altKey || event.ctrlKey || event.metaKey) return { type: 'none' };

  if (event.key === 'Escape') {
    return { type: 'close-modal' };
  }

  const settings = options.settings;
  if (!settings?.enabled) return { type: 'none' };

  const binding = findBinding(event, settings.bindings);
  if (!binding) return { type: 'none' };

  switch (binding.action) {
    case 'play-pause':
      return { type: 'play-pause' };
    case 'rate-toggle':
      return { type: 'rate-toggle' };
    case 'rate-decrement':
      return { type: 'rate-step', delta: -settings.rateStep };
    case 'rate-increment':
      return { type: 'rate-step', delta: settings.rateStep };
    case 'seek-backward':
      return { type: 'seek-step', seconds: -settings.seekSeconds };
    case 'seek-forward':
      return { type: 'seek-step', seconds: settings.seekSeconds };
    default:
      return { type: 'none' };
  }
}
