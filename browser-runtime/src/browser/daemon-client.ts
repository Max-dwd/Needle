import { DEFAULT_DAEMON_PORT } from '../constants.js';
import type { BrowserSessionInfo } from '../types.js';
import { sleep } from '../utils.js';

const DAEMON_PORT = Number.parseInt(
  process.env.FOLO_BROWSER_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT),
  10,
);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

let idCounter = 0;

function generateId(): string {
  return `folo_cmd_${Date.now()}_${++idCounter}`;
}

export interface DaemonCommand {
  id: string;
  action:
    | 'exec'
    | 'navigate'
    | 'tabs'
    | 'cookies'
    | 'screenshot'
    | 'close-window'
    | 'sessions'
    | 'set-file-input'
    | 'warmup';
  tabId?: number;
  code?: string;
  workspace?: string;
  url?: string;
  op?: string;
  index?: number;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  files?: string[];
  selector?: string;
}

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${DAEMON_URL}/status`, {
      headers: { 'X-Folo-Browser': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

export async function isExtensionConnected(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${DAEMON_URL}/status`, {
      headers: { 'X-Folo-Browser': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = (await response.json()) as { extensionConnected?: boolean };
    return !!data.extensionConnected;
  } catch {
    return false;
  }
}

export async function sendCommand(
  action: DaemonCommand['action'],
  params: Omit<DaemonCommand, 'id' | 'action'> = {},
): Promise<unknown> {
  const maxRetries = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const command: DaemonCommand = { id: generateId(), action, ...params };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(`${DAEMON_URL}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Folo-Browser': '1',
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const result = (await response.json()) as DaemonResult;
      if (!result.ok) {
        const message = result.error ?? 'Daemon command failed';
        const transient =
          message.includes('Extension disconnected') ||
          message.includes('Extension not connected') ||
          message.includes('attach failed') ||
          message.includes('no longer exists');
        if (transient && attempt < maxRetries) {
          await sleep(1500);
          continue;
        }
        throw new Error(message);
      }

      return result.data;
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        (error instanceof Error && error.name === 'AbortError');
      if (retryable && attempt < maxRetries) {
        await sleep(500);
        continue;
      }
      throw error;
    }
  }

  throw new Error('sendCommand: max retries exhausted');
}

export async function listSessions(): Promise<BrowserSessionInfo[]> {
  const result = await sendCommand('sessions');
  return Array.isArray(result) ? result : [];
}
