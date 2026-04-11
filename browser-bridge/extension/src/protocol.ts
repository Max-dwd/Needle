/**
 * Needle Browser Bridge protocol shared by the local daemon and Chrome extension.
 */

export type Action =
  | 'exec'
  | 'navigate'
  | 'tabs'
  | 'cookies'
  | 'screenshot'
  | 'close-window'
  | 'sessions'
  | 'set-file-input'
  | 'warmup';

export interface Command {
  id: string;
  action: Action;
  tabId?: number;
  code?: string;
  workspace?: string;
  url?: string;
  op?: 'list' | 'new' | 'close' | 'select';
  index?: number;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  files?: string[];
  selector?: string;
}

export interface Result {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const DAEMON_PORT = 19825;
export const DAEMON_HOST = 'localhost';
export const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
export const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;
export const WS_RECONNECT_BASE_DELAY = 500;
export const WS_RECONNECT_MAX_DELAY = 60000;
export const DAEMON_IDLE_TIMEOUT = 5 * 60 * 1000;
