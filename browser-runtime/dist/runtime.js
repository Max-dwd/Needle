import { BrowserBridge } from './browser/index.js';
import { TimeoutError } from './errors.js';
function parseEnvTimeout(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export const DEFAULT_BROWSER_CONNECT_TIMEOUT = parseEnvTimeout('FOLO_BROWSER_CONNECT_TIMEOUT', 30);
export const DEFAULT_BROWSER_COMMAND_TIMEOUT = parseEnvTimeout('FOLO_BROWSER_COMMAND_TIMEOUT', 60);
export function getBrowserFactory() {
    return BrowserBridge;
}
export function withTimeoutMs(promise, timeoutMs, makeError = 'Operation timed out') {
    const rejectWith = typeof makeError === 'string' ? () => new Error(makeError) : makeError;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(rejectWith()), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
export async function runWithTimeout(promise, opts) {
    const label = opts.label ?? 'Operation';
    return withTimeoutMs(promise, opts.timeout * 1000, () => new TimeoutError(label, opts.timeout, opts.hint));
}
export async function browserSession(BrowserFactory, fn, opts = {}) {
    const browser = new BrowserFactory();
    try {
        const page = await browser.connect({
            timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT,
            workspace: opts.workspace,
        });
        return await fn(page);
    }
    finally {
        await browser.close().catch(() => { });
    }
}
