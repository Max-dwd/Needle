/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission. It can attach to any
 * http/https tab, plus the extension's internal blank page used for workspace
 * bootstrapping.
 */

const attached = new Set<number>();

const BLANK_PAGE = 'data:text/html,<html></html>';

function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE;
}

async function ensureAttached(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot debug tab')) {
      throw error;
    }
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      });
      return;
    } catch {
      attached.delete(tabId);
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = message.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';

    if (message.includes('Another debugger is already attached')) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // ignore
      }
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch {
        throw new Error(`attach failed: ${message}${hint}`);
      }
    } else {
      throw new Error(`attach failed: ${message}${hint}`);
    }
  }

  attached.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages do not require explicit enable.
  }
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  await ensureAttached(tabId);

  const result = (await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
  )) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errorMessage =
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Eval error';
    throw new Error(errorMessage);
  }

  return result.result?.value;
}

export const evaluateAsync = evaluate;

export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';

  if (options.fullPage) {
    const metrics = (await chrome.debugger.sendCommand(
      { tabId },
      'Page.getLayoutMetrics',
    )) as {
      contentSize?: { width: number; height: number };
      cssContentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setDeviceMetricsOverride',
        {
          mobile: false,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          deviceScaleFactor: 1,
        },
      );
    }
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = (await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      params,
    )) as { data: string };

    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger
        .sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride')
        .catch(() => {});
    }
  }
}

export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');

  const doc = (await chrome.debugger.sendCommand(
    { tabId },
    'DOM.getDocument',
  )) as {
    root: { nodeId: number };
  };

  const query = selector || 'input[type="file"]';
  const result = (await chrome.debugger.sendCommand(
    { tabId },
    'DOM.querySelector',
    {
      nodeId: doc.root.nodeId,
      selector: query,
    },
  )) as { nodeId: number };

  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    files,
    nodeId: result.nodeId,
  });
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
}
