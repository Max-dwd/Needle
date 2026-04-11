import { saveBase64ToFile } from '../utils.js';
import { sendCommand } from './daemon-client.js';
import { wrapForEval } from './utils.js';
function waitForDomStableJs(maxMs, stableMs) {
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
export class Page {
    workspace;
    constructor(workspace = 'default') {
        this.workspace = workspace;
    }
    tabId;
    lastUrl = null;
    workspaceOpts() {
        return { workspace: this.workspace };
    }
    commandOpts() {
        return {
            workspace: this.workspace,
            ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
        };
    }
    async goto(url, options) {
        const result = (await sendCommand('navigate', {
            url,
            ...this.commandOpts(),
        }));
        if (typeof result?.tabId === 'number') {
            this.tabId = result.tabId;
        }
        this.lastUrl = url;
        if (options?.waitUntil === 'none')
            return;
        await sendCommand('exec', {
            code: waitForDomStableJs(options?.settleMs ?? 1000, 250),
            ...this.commandOpts(),
        }).catch(() => { });
    }
    async evaluate(js) {
        return sendCommand('exec', {
            code: wrapForEval(js),
            ...this.commandOpts(),
        });
    }
    async getCookies(opts = {}) {
        const result = await sendCommand('cookies', {
            ...this.workspaceOpts(),
            ...opts,
        });
        return Array.isArray(result) ? result : [];
    }
    async tabs() {
        const result = await sendCommand('tabs', {
            op: 'list',
            ...this.workspaceOpts(),
        });
        return Array.isArray(result) ? result : [];
    }
    async closeTab(index) {
        await sendCommand('tabs', {
            op: 'close',
            ...this.workspaceOpts(),
            ...(index !== undefined ? { index } : {}),
        });
        this.tabId = undefined;
    }
    async newTab() {
        const result = (await sendCommand('tabs', {
            op: 'new',
            ...this.workspaceOpts(),
        }));
        if (typeof result?.tabId === 'number')
            this.tabId = result.tabId;
    }
    async selectTab(index) {
        const result = (await sendCommand('tabs', {
            op: 'select',
            index,
            ...this.workspaceOpts(),
        }));
        if (typeof result?.selected === 'number')
            this.tabId = result.selected;
    }
    async screenshot(options = {}) {
        const base64 = (await sendCommand('screenshot', {
            ...this.commandOpts(),
            format: options.format,
            quality: options.quality,
            fullPage: options.fullPage,
        }));
        if (options.path) {
            await saveBase64ToFile(base64, options.path);
        }
        return base64;
    }
    async setFileInput(files, selector) {
        await sendCommand('set-file-input', {
            files,
            selector,
            ...this.commandOpts(),
        });
    }
    async closeWindow() {
        await sendCommand('close-window', { ...this.workspaceOpts() }).catch(() => { });
    }
    async getCurrentUrl() {
        return this.lastUrl;
    }
}
