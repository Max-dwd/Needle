import type { BrowserCookie, IPage, ScreenshotOptions } from '../types.js';
import { saveBase64ToFile } from '../utils.js';
import { sendCommand } from './daemon-client.js';
import { wrapForEval } from './utils.js';

function waitForDomStableJs(maxMs: number, stableMs: number): string {
  return `(() => new Promise((resolve) => {
    const startedAt = Date.now();
    let lastMutationAt = Date.now();
    const done = () => {
      observer.disconnect();
      resolve(true);
    };
    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const tick = () => {
      const now = Date.now();
      if (now - lastMutationAt >= ${Math.max(50, stableMs)}) return done();
      if (now - startedAt >= ${Math.max(100, maxMs)}) return done();
      setTimeout(tick, 50);
    };
    tick();
  }))`;
}

export class Page implements IPage {
  constructor(private readonly workspace: string = 'default') {}

  private tabId: number | undefined;
  private lastUrl: string | null = null;

  private workspaceOpts(): { workspace: string } {
    return { workspace: this.workspace };
  }

  private commandOpts(): Record<string, unknown> {
    return {
      workspace: this.workspace,
      ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
    };
  }

  async goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'none' | 'domcontentloaded' | 'networkidle';
      settleMs?: number;
    },
  ): Promise<void> {
    const result = (await sendCommand('navigate', {
      url,
      ...this.commandOpts(),
    })) as { tabId?: number };

    if (typeof result?.tabId === 'number') {
      this.tabId = result.tabId;
    }
    this.lastUrl = url;

    if (options?.waitUntil === 'none') return;

    await sendCommand('exec', {
      code: waitForDomStableJs(options?.settleMs ?? 1000, 250),
      ...this.commandOpts(),
    }).catch(() => {});
  }

  async evaluate(js: string): Promise<unknown> {
    return sendCommand('exec', {
      code: wrapForEval(js),
      ...this.commandOpts(),
    });
  }

  async getCookies(
    opts: { domain?: string; url?: string } = {},
  ): Promise<BrowserCookie[]> {
    const result = await sendCommand('cookies', {
      ...this.workspaceOpts(),
      ...opts,
    });
    return Array.isArray(result) ? (result as BrowserCookie[]) : [];
  }

  async tabs(): Promise<unknown[]> {
    const result = await sendCommand('tabs', {
      op: 'list',
      ...this.workspaceOpts(),
    });
    return Array.isArray(result) ? result : [];
  }

  async closeTab(index?: number): Promise<void> {
    await sendCommand('tabs', {
      op: 'close',
      ...this.workspaceOpts(),
      ...(index !== undefined ? { index } : {}),
    });
    this.tabId = undefined;
  }

  async newTab(): Promise<void> {
    const result = (await sendCommand('tabs', {
      op: 'new',
      ...this.workspaceOpts(),
    })) as { tabId?: number };
    if (typeof result?.tabId === 'number') this.tabId = result.tabId;
  }

  async selectTab(index: number): Promise<void> {
    const result = (await sendCommand('tabs', {
      op: 'select',
      index,
      ...this.workspaceOpts(),
    })) as { selected?: number };
    if (typeof result?.selected === 'number') this.tabId = result.selected;
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const base64 = (await sendCommand('screenshot', {
      ...this.commandOpts(),
      format: options.format,
      quality: options.quality,
      fullPage: options.fullPage,
    })) as string;

    if (options.path) {
      await saveBase64ToFile(base64, options.path);
    }

    return base64;
  }

  async setFileInput(files: string[], selector?: string): Promise<void> {
    await sendCommand('set-file-input', {
      files,
      selector,
      ...this.commandOpts(),
    });
  }

  async closeWindow(): Promise<void> {
    await sendCommand('close-window', { ...this.workspaceOpts() }).catch(
      () => {},
    );
  }

  async getCurrentUrl(): Promise<string | null> {
    return this.lastUrl;
  }
}
