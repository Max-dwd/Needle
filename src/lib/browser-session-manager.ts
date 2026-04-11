import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { BROWSER_METHOD_ID, getBrowserMethodLabel } from './browser-method';
import {
  createBrowserBridge,
  getVendoredCliInvocation,
  listBrowserSessions,
  listBrowserTabs,
  selectBrowserTab,
  type BrowserRuntimePageLike,
  type BrowserSessionInfo,
} from './browser-runtime';

const execFileAsync = promisify(execFile);
const BROWSER_DISPLAY_NAME = getBrowserMethodLabel(BROWSER_METHOD_ID);
const CONTROLLED_BROWSER_LABEL = '受控浏览器';
const JSON_FILE_TRANSPORT_COMMANDS = new Set([
  'youtube/transcript',
  'bilibili/subtitle',
]);

export type BrowserOperationStrategy = 'default' | 'metadata';

export interface BrowserRuntimeOperationOptions {
  allowBrowserBootstrap?: boolean;
  strategy?: BrowserOperationStrategy;
}

export interface BrowserWorkspacePageOptions
  extends BrowserRuntimeOperationOptions {
  workspace: string;
  timeout?: number;
  timeoutSeconds?: number;
}

export interface BrowserLoginPageOptions {
  workspace: string;
  url: string;
  timeout?: number;
  timeoutSeconds?: number;
  waitUntil?: string;
  settleMs?: number;
  cooldownMs?: number;
}

function envEnabled(...names: string[]): boolean {
  return names.some((name) => process.env[name] === '1');
}

function envNumber(fallback: number, ...names: string[]): number {
  for (const name of names) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

const BROWSER_LOGIN_OPEN_COOLDOWN_MS = 10_000;
const BROWSER_BACKGROUND_BOOTSTRAP_ALLOWED = envEnabled(
  'FOLO_BROWSER_BACKGROUND_BOOTSTRAP',
);
const BROWSER_METADATA_ISOLATION_SAFE = envEnabled(
  'FOLO_BROWSER_METADATA_ISOLATION_SAFE',
);
const BROWSER_METADATA_CONCURRENCY = Math.max(
  1,
  Math.min(
    BROWSER_METADATA_ISOLATION_SAFE
      ? envNumber(2, 'FOLO_BROWSER_METADATA_CONCURRENCY')
      : 1,
    4,
  ) || 1,
);

let browserOperationQueue: Promise<void> = Promise.resolve();
let browserMetadataActiveCount = 0;
const browserMetadataWaiters: Array<() => void> = [];
const loginPageInFlight = new Map<string, Promise<void>>();
const lastLoginPageAt = new Map<string, number>();

export async function listControlledBrowserSessions(): Promise<
  BrowserSessionInfo[]
> {
  return listBrowserSessions();
}

export async function hasControlledBrowserWorkspaceSession(
  workspace: string,
): Promise<boolean> {
  try {
    const sessions = await listControlledBrowserSessions();
    return sessions.some((item) => item.workspace === workspace);
  } catch {
    return false;
  }
}

export async function hasAnyControlledBrowserSession(): Promise<boolean> {
  try {
    const sessions = await listControlledBrowserSessions();
    return sessions.length > 0;
  } catch {
    return false;
  }
}

export async function runSerializedBrowserOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = browserOperationQueue.catch(() => {});
  let release = () => {};
  browserOperationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function acquireBrowserMetadataSlot(): Promise<() => void> {
  if (browserMetadataActiveCount < BROWSER_METADATA_CONCURRENCY) {
    browserMetadataActiveCount += 1;
    return () => {
      browserMetadataActiveCount = Math.max(0, browserMetadataActiveCount - 1);
      const next = browserMetadataWaiters.shift();
      if (next) next();
    };
  }

  await new Promise<void>((resolve) => {
    browserMetadataWaiters.push(resolve);
  });

  browserMetadataActiveCount += 1;
  return () => {
    browserMetadataActiveCount = Math.max(0, browserMetadataActiveCount - 1);
    const next = browserMetadataWaiters.shift();
    if (next) next();
  };
}

async function runBrowserMetadataOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const executeWithSlot = async () => {
    const release = await acquireBrowserMetadataSlot();
    try {
      return await operation();
    } finally {
      release();
    }
  };

  if (!BROWSER_METADATA_ISOLATION_SAFE) {
    return runSerializedBrowserOperation(executeWithSlot);
  }

  return executeWithSlot();
}

async function assertBrowserBootstrapAllowed(
  allowBrowserBootstrap = true,
): Promise<void> {
  if (allowBrowserBootstrap || BROWSER_BACKGROUND_BOOTSTRAP_ALLOWED) {
    return;
  }

  if (await hasAnyControlledBrowserSession()) {
    return;
  }

  throw new Error(
    `${BROWSER_DISPLAY_NAME} background bootstrap disabled: no reusable ${CONTROLLED_BROWSER_LABEL} session`,
  );
}

export async function runBrowserRuntimeOperation<T>(
  operation: () => Promise<T>,
  options?: BrowserRuntimeOperationOptions,
): Promise<T> {
  const execute = async () => {
    await assertBrowserBootstrapAllowed(options?.allowBrowserBootstrap);
    return operation();
  };

  if (options?.strategy === 'metadata') {
    return runBrowserMetadataOperation(execute);
  }

  return runSerializedBrowserOperation(execute);
}

function pickBrowserCliInvocation(): { file: string; argsPrefix: string[] } {
  const envOverride = process.env.FOLO_BROWSER_CLI_BIN;

  if (envOverride?.trim()) {
    return {
      file: envOverride,
      argsPrefix: [],
    };
  }

  return getVendoredCliInvocation();
}

function readExecErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStderr =
    'stderr' in error
      ? (error.stderr as Buffer | string | undefined)
      : undefined;
  const maybeStdout =
    'stdout' in error
      ? (error.stdout as Buffer | string | undefined)
      : undefined;
  const stderr =
    typeof maybeStderr === 'string'
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString('utf8')
        : '';
  const stdout =
    typeof maybeStdout === 'string'
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString('utf8')
        : '';
  return stderr.trim() || stdout.trim() || error.message;
}

function readExecStdout(
  result: { stdout?: string | Buffer } | string | Buffer,
): string {
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  if (!result || typeof result !== 'object' || !('stdout' in result)) {
    return '';
  }
  const stdout = result.stdout;
  if (typeof stdout === 'string') return stdout;
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
  return '';
}

function shouldUseJsonFileTransport(args: string[]): boolean {
  const site = (args[0] || '').trim().toLowerCase();
  const command = (args[1] || '').trim().toLowerCase();
  return JSON_FILE_TRANSPORT_COMMANDS.has(`${site}/${command}`);
}

function createJsonOutputTransport(): {
  filePath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-browser-json-'));
  return {
    filePath: path.join(dir, 'result.json'),
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readJsonOutputFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim() ? content : '';
  } catch {
    return '';
  }
}

function extractBalancedJson(raw: string, start: number): string | null {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (start < 0 || start >= text.length) return null;
  if (text[start] !== '{' && text[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseBrowserRuntimeJson(raw: string): unknown {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error('empty response');
  }

  const candidates = new Set<string>([trimmed]);
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char !== '{' && char !== '[') continue;
    const extracted = extractBalancedJson(trimmed, index);
    if (extracted) {
      candidates.add(extracted);
    }
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function readExecFailureMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const maybeStderr =
    'stderr' in error
      ? (error.stderr as Buffer | string | undefined)
      : undefined;
  const maybeStdout =
    'stdout' in error
      ? (error.stdout as Buffer | string | undefined)
      : undefined;
  const stderr =
    typeof maybeStderr === 'string'
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString('utf8')
        : '';
  const stdout =
    typeof maybeStdout === 'string'
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString('utf8')
        : '';
  const message = stderr.trim() || stdout.trim();
  return message || null;
}

export async function runBrowserCliJson(
  args: string[],
  options?: (BrowserRuntimeOperationOptions & { signal?: AbortSignal }) | undefined,
): Promise<unknown> {
  return runBrowserRuntimeOperation(async () => {
    const invocation = pickBrowserCliInvocation();
    const outputTransport = shouldUseJsonFileTransport(args)
      ? createJsonOutputTransport()
      : null;
    try {
      const execResult = await execFileAsync(
        invocation.file,
        [
          ...invocation.argsPrefix,
          ...args,
          ...(outputTransport
            ? ['--output-file', outputTransport.filePath]
            : []),
          '-f',
          'json',
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          signal: options?.signal ?? AbortSignal.timeout(120000),
          env: {
            ...process.env,
            PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
              .filter(Boolean)
              .join(':'),
          },
        } as Parameters<typeof execFileAsync>[2],
      );

      const payload =
        (outputTransport && readJsonOutputFile(outputTransport.filePath)) ||
        readExecStdout(execResult);
      return parseBrowserRuntimeJson(payload);
    } catch (error) {
      // Propagate abort/timeout errors so callers can distinguish cancellation
      // from real failures (Node wraps AbortSignal errors with code ABORT_ERR).
      if (
        error instanceof DOMException && error.name === 'AbortError' ||
        (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
      ) {
        throw error;
      }
      const execFailureMessage = readExecFailureMessage(error);
      if (execFailureMessage) {
        throw new Error(execFailureMessage);
      }
      throw new Error(
        `browser runtime returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      outputTransport?.cleanup();
    }
  }, options);
}

export async function withBrowserWorkspacePage<T>(
  options: BrowserWorkspacePageOptions,
  operation: (page: BrowserRuntimePageLike) => Promise<T>,
): Promise<T> {
  return runBrowserRuntimeOperation(async () => {
    const bridge = await createBrowserBridge();

    try {
      const page = await bridge.connect({
        timeout: options.timeoutSeconds ?? options.timeout ?? 30,
        workspace: options.workspace,
      });
      return await operation(page);
    } finally {
      await bridge.close().catch(() => {});
    }
  }, options);
}

export async function focusControlledBrowserWindow(
  workspace: string,
): Promise<void> {
  try {
    const tabs = await listBrowserTabs(workspace);
    const activeTab = tabs.find((tab) => tab.active && tab.tabId);
    if (activeTab?.tabId) {
      await selectBrowserTab({
        workspace,
        tabId: activeTab.tabId,
      });
    } else if (tabs.length > 0) {
      await selectBrowserTab({
        workspace,
        index: 0,
      });
    }
  } catch {
    // Best-effort only. Native focus fallback below handles the common case.
  }

  if (process.platform !== 'darwin') return;

  try {
    const sessions = await listControlledBrowserSessions();
    const session = sessions.find(
      (item) =>
        item.workspace === workspace && typeof item.windowId === 'number',
    );
    const windowId = session?.windowId;

    if (typeof windowId === 'number' && Number.isFinite(windowId)) {
      await execFileAsync(
        'osascript',
        [
          '-e',
          `tell application "Google Chrome"
activate
try
set index of (first window whose id is ${Math.trunc(windowId)}) to 1
end try
end tell`,
        ],
        {
          stdio: 'ignore',
        } as Parameters<typeof execFileAsync>[2],
      );
      return;
    }
  } catch {
    // Fall back to simply activating Chrome below.
  }

  try {
    await execFileAsync(
      'osascript',
      ['-e', 'tell application "Google Chrome" to activate'],
      {
        stdio: 'ignore',
      } as Parameters<typeof execFileAsync>[2],
    );
  } catch {
    // Browser navigation already happened even if focus fails.
  }
}

export async function openControlledBrowserLoginPage(
  options: BrowserLoginPageOptions,
): Promise<void> {
  const existingTask = loginPageInFlight.get(options.workspace);
  if (existingTask) {
    return existingTask;
  }

  const task = runSerializedBrowserOperation(async () => {
    const now = Date.now();
    const lastAt = lastLoginPageAt.get(options.workspace) ?? 0;

    if (now - lastAt < (options.cooldownMs ?? BROWSER_LOGIN_OPEN_COOLDOWN_MS)) {
      await focusControlledBrowserWindow(options.workspace);
      return;
    }

    if (await hasControlledBrowserWorkspaceSession(options.workspace)) {
      lastLoginPageAt.set(options.workspace, now);
      await focusControlledBrowserWindow(options.workspace);
      return;
    }

    const bridge = await createBrowserBridge();

    try {
      const page = await bridge.connect({
        timeout: options.timeoutSeconds ?? options.timeout ?? 30,
        workspace: options.workspace,
      });
      await page.goto(options.url, {
        waitUntil: options.waitUntil ?? 'domcontentloaded',
        settleMs: options.settleMs ?? 1500,
      });
      lastLoginPageAt.set(options.workspace, Date.now());
      await focusControlledBrowserWindow(options.workspace);
    } finally {
      await bridge.close().catch(() => {});
    }
  });

  // Register immediately so concurrent callers see the in-flight task
  // before the promise settles (fixes race between task creation and set).
  loginPageInFlight.set(options.workspace, task);
  try {
    await task;
  } finally {
    if (loginPageInFlight.get(options.workspace) === task) {
      loginPageInFlight.delete(options.workspace);
    }
  }
}

export async function openBrowserWorkspaceLoginPage(
  options: BrowserLoginPageOptions,
): Promise<void> {
  return openControlledBrowserLoginPage(options);
}
