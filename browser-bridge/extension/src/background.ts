/**
 * Needle Browser Bridge service worker.
 *
 * Connects to the local browser daemon via WebSocket, receives commands, and
 * dispatches them to Chrome APIs (debugger/tabs/cookies). Every automation
 * workspace gets its own isolated Chrome window so background tasks never
 * touch the user's active browsing session.
 */

import type { Command, Result } from './protocol';
import {
  DAEMON_PING_URL,
  DAEMON_WS_URL,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
} from './protocol';
import * as executor from './cdp';

const BRIDGE_LOG_PREFIX = '[needle-browser-bridge]';
const BRIDGE_NAME = 'Needle Browser Bridge';
const BLANK_PAGE = 'data:text/html,<html></html>';
const WINDOW_IDLE_TIMEOUT = 30000;
const MAX_EAGER_ATTEMPTS = 6;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let initialized = false;

type AutomationSession = {
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
};

const automationSessions = new Map<string, AutomationSession>();

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const message = args
      .map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value),
      )
      .join(' ');
    ws.send(JSON.stringify({ type: 'log', level, msg: message, ts: Date.now() }));
  } catch {
    // Avoid recursive logging.
  }
}

console.log = (...args: unknown[]) => {
  originalLog(...args);
  forwardLog('info', args);
};
console.warn = (...args: unknown[]) => {
  originalWarn(...args);
  forwardLog('warn', args);
};
console.error = (...args: unknown[]) => {
  originalError(...args);
  forwardLog('error', args);
};

function getWorkspaceKey(workspace?: string): string {
  return workspace?.trim() || 'default';
}

function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE;
}

function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';

  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

async function connect(): Promise<void> {
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  try {
    const response = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      scheduleReconnect();
      return;
    }
  } catch {
    scheduleReconnect();
    return;
  }

  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`${BRIDGE_LOG_PREFIX} Connected to daemon`);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.send(
      JSON.stringify({
        type: 'hello',
        version: chrome.runtime.getManifest().version,
      }),
    );
  };

  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data as string) as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (error) {
      console.error(`${BRIDGE_LOG_PREFIX} Message handling error:`, error);
    }
  };

  ws.onclose = () => {
    console.log(`${BRIDGE_LOG_PREFIX} Disconnected from daemon`);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  reconnectAttempts += 1;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return;

  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
    WS_RECONNECT_MAX_DELAY,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function resetWindowIdleTimer(workspace: string): void {
  const session = automationSessions.get(workspace);
  if (!session) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current) return;

    try {
      await chrome.windows.remove(current.windowId);
      console.log(
        `${BRIDGE_LOG_PREFIX} Automation window ${current.windowId} (${workspace}) closed (idle timeout)`,
      );
    } catch {
      // Already gone.
    }

    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}

async function getAutomationWindow(workspace: string): Promise<number> {
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      automationSessions.delete(workspace);
    }
  }

  const win = await chrome.windows.create({
    url: BLANK_PAGE,
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
  });

  const session: AutomationSession = {
    windowId: win.id!,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  };

  automationSessions.set(workspace, session);
  console.log(
    `${BRIDGE_LOG_PREFIX} Created automation window ${session.windowId} (${workspace})`,
  );
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}

async function warmAutomationWorkspace(workspace: string): Promise<Result> {
  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  let blankTab = tabs.find((tab) => tab.id && tab.url === BLANK_PAGE);

  if (!blankTab?.id) {
    blankTab = await chrome.tabs.create({
      windowId,
      url: BLANK_PAGE,
      active: true,
    });
  }

  resetWindowIdleTimer(workspace);

  return {
    id: '',
    ok: true,
    data: {
      workspace,
      windowId,
      tabId: blankTab.id,
      warmed: true,
    },
  };
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(
        `${BRIDGE_LOG_PREFIX} Automation window closed (${workspace})`,
      );
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});

function initialize(): void {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
  executor.registerListeners();
  void connect();
  console.log(`${BRIDGE_LOG_PREFIX} ${BRIDGE_NAME} initialized`);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    void connect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'getStatus') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
    });
  }
  return false;
});

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = getWorkspaceKey(cmd.workspace);

  try {
    switch (cmd.action) {
      case 'warmup': {
        const result = await warmAutomationWorkspace(workspace);
        return { ...result, id: cmd.id };
      }
      case 'exec':
        resetWindowIdleTimer(workspace);
        return await handleExec(cmd, workspace);
      case 'navigate':
        resetWindowIdleTimer(workspace);
        return await handleNavigate(cmd, workspace);
      case 'tabs':
        resetWindowIdleTimer(workspace);
        return await handleTabs(cmd, workspace);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        resetWindowIdleTimer(workspace);
        return await handleScreenshot(cmd, workspace);
      case 'close-window':
        resetWindowIdleTimer(workspace);
        return await handleCloseWindow(cmd, workspace);
      case 'sessions':
        return await handleSessions(cmd);
      case 'set-file-input':
        resetWindowIdleTimer(workspace);
        return await handleSetFileInput(cmd, workspace);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTabId(
  tabId: number | undefined,
  workspace: string,
): Promise<number> {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      if (isDebuggableUrl(tab.url) && session && tab.windowId === session.windowId) {
        return tabId;
      }
      if (session && tab.windowId !== session.windowId) {
        console.warn(
          `${BRIDGE_LOG_PREFIX} Tab ${tabId} belongs to window ${tab.windowId}, not automation window ${session.windowId}, re-resolving`,
        );
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(
          `${BRIDGE_LOG_PREFIX} Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`,
        );
      }
    } catch {
      console.warn(`${BRIDGE_LOG_PREFIX} Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find((tab) => tab.id && isDebuggableUrl(tab.url));
  if (debuggableTab?.id) return debuggableTab.id;

  const reuseTab = tabs.find((tab) => tab.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
      console.warn(
        `${BRIDGE_LOG_PREFIX} data: URI was intercepted (${updated.url}), creating fresh tab`,
      );
    } catch {
      // Tab was closed during navigation.
    }
  }

  const newTab = await chrome.tabs.create({
    windowId,
    url: BLANK_PAGE,
    active: true,
  });
  if (!newTab.id) throw new Error('Failed to create tab in automation window');
  return newTab.id;
}

async function listAutomationTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const session = automationSessions.get(workspace);
  if (!session) return [];

  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}

async function listAutomationWebTabs(
  workspace: string,
): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

async function handleExec(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };

  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleNavigate(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return {
      id: cmd.id,
      ok: false,
      error: 'Blocked URL scheme -- only http:// and https:// are allowed',
    };
  }

  const tabId = await resolveTabId(cmd.tabId, workspace);
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: {
        title: beforeTab.title,
        url: beforeTab.url,
        tabId,
        timedOut: false,
      },
    };
  }

  await executor.detach(tabId);
  await chrome.tabs.update(tabId, { url: targetUrl });

  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url: string | undefined): boolean => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };

    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (
          currentTab.status === 'complete' &&
          isNavigationDone(currentTab.url)
        ) {
          finish();
        }
      } catch {
        // Tab gone.
      }
    }, 100);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `${BRIDGE_LOG_PREFIX} Navigate to ${targetUrl} timed out after 15s`,
      );
      finish();
    }, 15000);
  });

  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd: Command, workspace: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(workspace);
      const data = tabs.map((tab, index) => ({
        index,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
      }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return {
          id: cmd.id,
          ok: false,
          error: 'Blocked URL scheme -- only http:// and https:// are allowed',
        };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: true,
      });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab index ${cmd.index} not found`,
          };
        }
        await chrome.tabs.remove(target.id);
        await executor.detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      await executor.detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.tabId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      }
      if (cmd.tabId !== undefined) {
        const session = automationSessions.get(workspace);
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.get(cmd.tabId);
        } catch {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab ${cmd.tabId} no longer exists`,
          };
        }
        if (!session || tab.windowId !== session.windowId) {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab ${cmd.tabId} is not in the automation window`,
          };
        }
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index!];
      if (!target?.id) {
        return {
          id: cmd.id,
          ok: false,
          error: `Tab index ${cmd.index} not found`,
        };
      }
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return {
      id: cmd.id,
      ok: false,
      error: 'Cookie scope required: provide domain or url to avoid dumping all cookies',
    };
  }

  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;

  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(
  cmd: Command,
  workspace: string,
): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, workspace);

  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleCloseWindow(
  cmd: Command,
  workspace: string,
): Promise<Result> {
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
      // Window may already be closed.
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}

async function handleSetFileInput(
  cmd: Command,
  workspace: string,
): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }

  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleSessions(cmd: Command): Promise<Result> {
  const now = Date.now();
  const data = await Promise.all(
    [...automationSessions.entries()].map(async ([workspace, session]) => ({
      workspace,
      windowId: session.windowId,
      tabCount: (
        await chrome.tabs.query({ windowId: session.windowId })
      ).filter((tab) => isDebuggableUrl(tab.url)).length,
      idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
    })),
  );
  return { id: cmd.id, ok: true, data };
}

export const __test__ = {
  connect,
  scheduleReconnect,
  warmAutomationWorkspace,
  handleNavigate,
  isTargetUrl,
  handleTabs,
  handleSessions,
  hasReconnectTimer: () => reconnectTimer !== null,
  getAutomationWindowId: (workspace: string = 'default') =>
    automationSessions.get(workspace)?.windowId ?? null,
  setAutomationWindowId: (workspace: string, windowId: number | null) => {
    if (windowId === null) {
      const session = automationSessions.get(workspace);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      return;
    }
    automationSessions.set(workspace, {
      windowId,
      idleTimer: null,
      idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
    });
  },
};
