import { BrowserBridge } from './browser/index.js';
import type { IBrowserFactory, IPage } from './types.js';
import { TimeoutError } from './errors.js';

function parseEnvTimeout(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_BROWSER_CONNECT_TIMEOUT = parseEnvTimeout(
  'FOLO_BROWSER_CONNECT_TIMEOUT',
  30,
);
export const DEFAULT_BROWSER_COMMAND_TIMEOUT = parseEnvTimeout(
  'FOLO_BROWSER_COMMAND_TIMEOUT',
  60,
);

export function getBrowserFactory(): new () => IBrowserFactory {
  return BrowserBridge;
}

export function withTimeoutMs<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: string | (() => Error) = 'Operation timed out',
): Promise<T> {
  const rejectWith =
    typeof makeError === 'string' ? () => new Error(makeError) : makeError;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(rejectWith()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runWithTimeout<T>(
  promise: Promise<T>,
  opts: { timeout: number; label?: string; hint?: string },
): Promise<T> {
  const label = opts.label ?? 'Operation';
  return withTimeoutMs(
    promise,
    opts.timeout * 1000,
    () => new TimeoutError(label, opts.timeout, opts.hint),
  );
}

export async function browserSession<T>(
  BrowserFactory: new () => IBrowserFactory,
  fn: (page: IPage) => Promise<T>,
  opts: { workspace?: string } = {},
): Promise<T> {
  const browser = new BrowserFactory();
  try {
    const page = await browser.connect({
      timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT,
      workspace: opts.workspace,
    });
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}
