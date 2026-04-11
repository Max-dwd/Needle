const DAEMON_PORT = 19825;
const DAEMON_HOST = "localhost";
const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;
const WS_RECONNECT_BASE_DELAY = 500;
const WS_RECONNECT_MAX_DELAY = 6e4;

const attached = /* @__PURE__ */ new Set();
const BLANK_PAGE$1 = "data:text/html,<html></html>";
function isDebuggableUrl$1(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === BLANK_PAGE$1;
}
async function ensureAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl$1(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? "unknown"}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot debug tab")) {
      throw error;
    }
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (attached.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
      });
      return;
    } catch {
      attached.delete(tabId);
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = message.includes("chrome-extension://") ? ". Tip: another Chrome extension may be interfering — try disabling other extensions" : "";
    if (message.includes("Another debugger is already attached")) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
      }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        throw new Error(`attach failed: ${message}${hint}`);
      }
    } else {
      throw new Error(`attach failed: ${message}${hint}`);
    }
  }
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
  }
}
async function evaluate(tabId, expression) {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true
    }
  );
  if (result.exceptionDetails) {
    const errorMessage = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
    throw new Error(errorMessage);
  }
  return result.result?.value;
}
const evaluateAsync = evaluate;
async function screenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand(
      { tabId },
      "Page.getLayoutMetrics"
    );
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: false,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          deviceScaleFactor: 1
        }
      );
    }
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== void 0) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Page.captureScreenshot",
      params
    );
    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {
      });
    }
  }
}
async function setFileInputFiles(tabId, files, selector) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  const doc = await chrome.debugger.sendCommand(
    { tabId },
    "DOM.getDocument"
  );
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "DOM.querySelector",
    {
      nodeId: doc.root.nodeId,
      selector: query
    }
  );
  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    files,
    nodeId: result.nodeId
  });
}
async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
  }
}
function registerListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl$1(info.url)) {
      await detach(tabId);
    }
  });
}

const BRIDGE_LOG_PREFIX = "[needle-browser-bridge]";
const BRIDGE_NAME = "Needle Browser Bridge";
const BLANK_PAGE = "data:text/html,<html></html>";
const WINDOW_IDLE_TIMEOUT = 3e4;
const MAX_EAGER_ATTEMPTS = 6;
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let initialized = false;
const automationSessions = /* @__PURE__ */ new Map();
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
function forwardLog(level, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const message = args.map(
      (value) => typeof value === "string" ? value : JSON.stringify(value)
    ).join(" ");
    ws.send(JSON.stringify({ type: "log", level, msg: message, ts: Date.now() }));
  } catch {
  }
}
console.log = (...args) => {
  originalLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  originalWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  originalError(...args);
  forwardLog("error", args);
};
function getWorkspaceKey(workspace) {
  return workspace?.trim() || "default";
}
function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === BLANK_PAGE;
}
function isSafeNavigationUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
function isTargetUrl(currentUrl, targetUrl) {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}
async function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }
  try {
    const response = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1e3)
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
        type: "hello",
        version: chrome.runtime.getManifest().version
      })
    );
  };
  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
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
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return;
  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1),
    WS_RECONNECT_MAX_DELAY
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}
function resetWindowIdleTimer(workspace) {
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
        `${BRIDGE_LOG_PREFIX} Automation window ${current.windowId} (${workspace}) closed (idle timeout)`
      );
    } catch {
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}
async function getAutomationWindow(workspace) {
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
    type: "normal"
  });
  const session = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT
  };
  automationSessions.set(workspace, session);
  console.log(
    `${BRIDGE_LOG_PREFIX} Created automation window ${session.windowId} (${workspace})`
  );
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}
async function warmAutomationWorkspace(workspace) {
  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  let blankTab = tabs.find((tab) => tab.id && tab.url === BLANK_PAGE);
  if (!blankTab?.id) {
    blankTab = await chrome.tabs.create({
      windowId,
      url: BLANK_PAGE,
      active: true
    });
  }
  resetWindowIdleTimer(workspace);
  return {
    id: "",
    ok: true,
    data: {
      workspace,
      windowId,
      tabId: blankTab.id,
      warmed: true
    }
  };
}
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(
        `${BRIDGE_LOG_PREFIX} Automation window closed (${workspace})`
      );
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});
function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  registerListeners();
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
  if (alarm.name === "keepalive") {
    void connect();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getStatus") {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null
    });
  }
  return false;
});
async function handleCommand(cmd) {
  const workspace = getWorkspaceKey(cmd.workspace);
  try {
    switch (cmd.action) {
      case "warmup": {
        const result = await warmAutomationWorkspace(workspace);
        return { ...result, id: cmd.id };
      }
      case "exec":
        resetWindowIdleTimer(workspace);
        return await handleExec(cmd, workspace);
      case "navigate":
        resetWindowIdleTimer(workspace);
        return await handleNavigate(cmd, workspace);
      case "tabs":
        resetWindowIdleTimer(workspace);
        return await handleTabs(cmd, workspace);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        resetWindowIdleTimer(workspace);
        return await handleScreenshot(cmd, workspace);
      case "close-window":
        resetWindowIdleTimer(workspace);
        return await handleCloseWindow(cmd, workspace);
      case "sessions":
        return await handleSessions(cmd);
      case "set-file-input":
        resetWindowIdleTimer(workspace);
        return await handleSetFileInput(cmd, workspace);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function resolveTabId(tabId, workspace) {
  if (tabId !== void 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      if (isDebuggableUrl(tab.url) && session && tab.windowId === session.windowId) {
        return tabId;
      }
      if (session && tab.windowId !== session.windowId) {
        console.warn(
          `${BRIDGE_LOG_PREFIX} Tab ${tabId} belongs to window ${tab.windowId}, not automation window ${session.windowId}, re-resolving`
        );
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(
          `${BRIDGE_LOG_PREFIX} Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`
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
        `${BRIDGE_LOG_PREFIX} data: URI was intercepted (${updated.url}), creating fresh tab`
      );
    } catch {
    }
  }
  const newTab = await chrome.tabs.create({
    windowId,
    url: BLANK_PAGE,
    active: true
  });
  if (!newTab.id) throw new Error("Failed to create tab in automation window");
  return newTab.id;
}
async function listAutomationTabs(workspace) {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}
async function listAutomationWebTabs(workspace) {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}
async function handleExec(cmd, workspace) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function handleNavigate(cmd, workspace) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return {
      id: cmd.id,
      ok: false,
      error: "Blocked URL scheme -- only http:// and https:// are allowed"
    };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;
  if (beforeTab.status === "complete" && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: {
        title: beforeTab.title,
        url: beforeTab.url,
        tabId,
        timedOut: false
      }
    };
  }
  await detach(tabId);
  await chrome.tabs.update(tabId, { url: targetUrl });
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let timeoutTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url) => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };
    const listener = (id, info, tab2) => {
      if (id !== tabId) return;
      if (info.status === "complete" && isNavigationDone(tab2.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === "complete" && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch {
      }
    }, 100);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `${BRIDGE_LOG_PREFIX} Navigate to ${targetUrl} timed out after 15s`
      );
      finish();
    }, 15e3);
  });
  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut }
  };
}
async function handleTabs(cmd, workspace) {
  switch (cmd.op) {
    case "list": {
      const tabs = await listAutomationWebTabs(workspace);
      const data = tabs.map((tab, index) => ({
        index,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new": {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return {
          id: cmd.id,
          ok: false,
          error: "Blocked URL scheme -- only http:// and https:// are allowed"
        };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: true
      });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      if (cmd.index !== void 0) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab index ${cmd.index} not found`
          };
        }
        await chrome.tabs.remove(target.id);
        await detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      await detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case "select": {
      if (cmd.index === void 0 && cmd.tabId === void 0) {
        return { id: cmd.id, ok: false, error: "Missing index or tabId" };
      }
      if (cmd.tabId !== void 0) {
        const session = automationSessions.get(workspace);
        let tab;
        try {
          tab = await chrome.tabs.get(cmd.tabId);
        } catch {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab ${cmd.tabId} no longer exists`
          };
        }
        if (!session || tab.windowId !== session.windowId) {
          return {
            id: cmd.id,
            ok: false,
            error: `Tab ${cmd.tabId} is not in the automation window`
          };
        }
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index];
      if (!target?.id) {
        return {
          id: cmd.id,
          ok: false,
          error: `Tab index ${cmd.index} not found`
        };
      }
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url) {
    return {
      id: cmd.id,
      ok: false,
      error: "Cookie scope required: provide domain or url to avoid dumping all cookies"
    };
  }
  const details = {};
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
    expirationDate: cookie.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd, workspace) {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage
    });
    return { id: cmd.id, ok: true, data };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function handleCloseWindow(cmd, workspace) {
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}
async function handleSetFileInput(cmd, workspace) {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: "Missing or empty files array" };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (error) {
    return {
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function handleSessions(cmd) {
  const now = Date.now();
  const data = await Promise.all(
    [...automationSessions.entries()].map(async ([workspace, session]) => ({
      workspace,
      windowId: session.windowId,
      tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
      idleMsRemaining: Math.max(0, session.idleDeadlineAt - now)
    }))
  );
  return { id: cmd.id, ok: true, data };
}
