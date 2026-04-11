import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const runtimeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

const FIRST_CLASS_BROWSER_RUNTIME_ROOT = path.resolve(
  process.cwd(),
  'browser-runtime',
);
const BUNDLED_BROWSER_BRIDGE_ROOT = path.resolve(
  process.cwd(),
  'browser-bridge',
  'extension',
);
const FIRST_CLASS_BROWSER_MAIN = path.join(
  FIRST_CLASS_BROWSER_RUNTIME_ROOT,
  'dist',
  'main.js',
);
const FIRST_CLASS_BROWSER_INDEX = path.join(
  FIRST_CLASS_BROWSER_RUNTIME_ROOT,
  'dist',
  'browser',
  'index.js',
);
const FIRST_CLASS_DAEMON_CLIENT = path.join(
  FIRST_CLASS_BROWSER_RUNTIME_ROOT,
  'dist',
  'browser',
  'daemon-client.js',
);

export interface BrowserRuntimePageLike {
  goto: (
    url: string,
    options?: { waitUntil?: string; settleMs?: number },
  ) => Promise<void>;
  evaluate: (js: string) => Promise<unknown>;
}

export interface BrowserRuntimeBridgeLike {
  connect: (opts?: {
    timeout?: number;
    workspace?: string;
  }) => Promise<BrowserRuntimePageLike>;
  close: () => Promise<void>;
}

export interface BrowserRuntimeSessionInfo {
  workspace?: string;
  windowId?: number;
  [key: string]: unknown;
}

export interface BrowserRuntimeTabInfo {
  index?: number;
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  [key: string]: unknown;
}

export type BrowserSessionInfo = BrowserRuntimeSessionInfo;

export interface VendoredCliInvocation {
  file: string;
  argsPrefix: string[];
}

export type BrowserRuntimeCommandAction =
  | 'exec'
  | 'navigate'
  | 'tabs'
  | 'cookies'
  | 'screenshot'
  | 'close-window'
  | 'sessions'
  | 'set-file-input'
  | 'warmup';

export interface BrowserRuntimeCommandParams {
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

function hasBrowserRuntimeBundle(root: string): boolean {
  return (
    fs.existsSync(path.join(root, 'package.json')) &&
    (fs.existsSync(path.join(root, 'needle-browser-local')) ||
      fs.existsSync(path.join(root, 'folo-browser-local')) ||
      fs.existsSync(path.join(root, 'dist', 'main.js'))) &&
    fs.existsSync(path.join(root, 'dist', 'browser', 'index.js')) &&
    fs.existsSync(path.join(root, 'dist', 'browser', 'daemon-client.js'))
  );
}

function hasBrowserBridgeBundle(root: string): boolean {
  return (
    fs.existsSync(path.join(root, 'manifest.json')) &&
    fs.existsSync(path.join(root, 'dist', 'background.js'))
  );
}

export function resolveBundledBrowserRuntimeRoot(): string {
  if (hasBrowserRuntimeBundle(FIRST_CLASS_BROWSER_RUNTIME_ROOT)) {
    return FIRST_CLASS_BROWSER_RUNTIME_ROOT;
  }

  throw new Error(
    'first-class Needle browser runtime bundle not found; run `npm run browser:runtime:build` to generate browser-runtime/dist',
  );
}

export function resolveBundledBrowserBridgeDir(): string {
  const envOverride = process.env.FOLO_BROWSER_EXTENSION_DIR;

  if (envOverride?.trim()) {
    const resolved = path.resolve(envOverride);
    if (hasBrowserBridgeBundle(resolved)) {
      return resolved;
    }
  }

  if (hasBrowserBridgeBundle(BUNDLED_BROWSER_BRIDGE_ROOT)) {
    return BUNDLED_BROWSER_BRIDGE_ROOT;
  }

  throw new Error(
    'first-class Needle browser bridge bundle not found; run `npm run browser:bridge:build` to generate browser-bridge/extension/dist/background.js',
  );
}

export function getBundledBrowserBridgeManifestPath(): string {
  return path.join(resolveBundledBrowserBridgeDir(), 'manifest.json');
}

export function getVendoredCliInvocation(): VendoredCliInvocation {
  const runtimeRoot = resolveBundledBrowserRuntimeRoot();
  const localBin = path.join(runtimeRoot, 'needle-browser-local');
  const legacyLocalBin = path.join(runtimeRoot, 'folo-browser-local');
  const mainJs = path.join(runtimeRoot, 'dist', 'main.js');

  if (fs.existsSync(localBin)) {
    return {
      file: localBin,
      argsPrefix: [],
    };
  }

  if (fs.existsSync(legacyLocalBin)) {
    return {
      file: legacyLocalBin,
      argsPrefix: [],
    };
  }

  if (fs.existsSync(mainJs)) {
    return {
      file: process.execPath,
      argsPrefix: [mainJs],
    };
  }

  throw new Error(
    'first-class Needle browser runtime bundle not found; run `npm run browser:runtime:build`',
  );
}

export async function loadVendoredBrowserBridge(): Promise<{
  BrowserBridge: new () => BrowserRuntimeBridgeLike;
}> {
  const browserIndex = path.join(
    resolveBundledBrowserRuntimeRoot(),
    'dist',
    'browser',
    'index.js',
  );

  return runtimeImport(pathToFileURL(browserIndex).href) as Promise<{
    BrowserBridge: new () => BrowserRuntimeBridgeLike;
  }>;
}

export async function loadVendoredDaemonClient(): Promise<{
  sendCommand: (
    action: BrowserRuntimeCommandAction,
    params?: BrowserRuntimeCommandParams,
  ) => Promise<unknown>;
  listSessions: () => Promise<BrowserRuntimeSessionInfo[]>;
  isDaemonRunning?: () => Promise<boolean>;
  isExtensionConnected?: () => Promise<boolean>;
}> {
  const daemonClient = path.join(
    resolveBundledBrowserRuntimeRoot(),
    'dist',
    'browser',
    'daemon-client.js',
  );

  return runtimeImport(pathToFileURL(daemonClient).href) as Promise<{
    sendCommand: (
      action: BrowserRuntimeCommandAction,
      params?: BrowserRuntimeCommandParams,
    ) => Promise<unknown>;
    listSessions: () => Promise<BrowserRuntimeSessionInfo[]>;
    isDaemonRunning?: () => Promise<boolean>;
    isExtensionConnected?: () => Promise<boolean>;
  }>;
}

export async function loadBrowserBridgeModule(): Promise<{
  BrowserBridge: new () => BrowserRuntimeBridgeLike;
}> {
  return loadVendoredBrowserBridge();
}

export async function createBrowserBridge(): Promise<BrowserRuntimeBridgeLike> {
  const { BrowserBridge } = await loadBrowserBridgeModule();
  return new BrowserBridge();
}

export async function listBrowserSessions(): Promise<
  BrowserRuntimeSessionInfo[]
> {
  const { listSessions } = await loadVendoredDaemonClient();
  return listSessions();
}

export async function sendBrowserCommand(
  action: BrowserRuntimeCommandAction,
  params: BrowserRuntimeCommandParams = {},
): Promise<unknown> {
  const { sendCommand } = await loadVendoredDaemonClient();
  return sendCommand(action, params);
}

export async function listBrowserTabs(
  workspace: string,
): Promise<BrowserRuntimeTabInfo[]> {
  const result = await sendBrowserCommand('tabs', {
    op: 'list',
    workspace,
  });
  return Array.isArray(result) ? (result as BrowserRuntimeTabInfo[]) : [];
}

export async function selectBrowserTab(options: {
  workspace: string;
  index?: number;
  tabId?: number;
}): Promise<void> {
  await sendBrowserCommand('tabs', {
    op: 'select',
    workspace: options.workspace,
    index: options.index,
    tabId: options.tabId,
  });
}
