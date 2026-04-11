import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrowserConnectError } from '../errors.js';
import { DEFAULT_DAEMON_PORT } from '../constants.js';
import { isDaemonRunning, isExtensionConnected } from './daemon-client.js';
import { Page } from './page.js';
const DAEMON_SPAWN_TIMEOUT_MS = 10_000;
export class BrowserBridge {
    stateValue = 'idle';
    page = null;
    daemonProc = null;
    get state() {
        return this.stateValue;
    }
    async connect(opts = {}) {
        if (this.stateValue === 'connected' && this.page)
            return this.page;
        if (this.stateValue === 'connecting')
            throw new Error('Already connecting');
        if (this.stateValue === 'closing')
            throw new Error('Session is closing');
        if (this.stateValue === 'closed')
            throw new Error('Session is closed');
        this.stateValue = 'connecting';
        try {
            await this.ensureDaemon(opts.timeout);
            this.page = new Page(opts.workspace);
            this.stateValue = 'connected';
            return this.page;
        }
        catch (error) {
            this.stateValue = 'idle';
            throw error;
        }
    }
    async close() {
        if (this.stateValue === 'closed')
            return;
        this.stateValue = 'closing';
        this.page = null;
        this.daemonProc = null;
        this.stateValue = 'closed';
    }
    async ensureDaemon(timeoutSeconds) {
        const effectiveSeconds = timeoutSeconds && timeoutSeconds > 0
            ? timeoutSeconds
            : Math.ceil(DAEMON_SPAWN_TIMEOUT_MS / 1000);
        const deadline = Date.now() + effectiveSeconds * 1000;
        if (await isExtensionConnected())
            return;
        if (await isDaemonRunning()) {
            throw new BrowserConnectError('Daemon is running but the Needle Browser Bridge extension is not connected.', 'Please install and enable the Needle Browser Bridge extension in Chrome.');
        }
        const dirname = path.dirname(fileURLToPath(import.meta.url));
        const parent = path.resolve(dirname, '..');
        const daemonTs = path.join(parent, 'daemon.ts');
        const daemonJs = path.join(parent, 'daemon.js');
        const isTs = fs.existsSync(daemonTs);
        const daemonPath = isTs ? daemonTs : daemonJs;
        if (process.env.FOLO_BROWSER_VERBOSE === '1') {
            console.error(`[needle-browser] Starting daemon (${isTs ? 'ts' : 'js'})...`);
        }
        const spawnArgs = isTs
            ? [process.execPath, '--import', 'tsx/esm', daemonPath]
            : [process.execPath, daemonPath];
        this.daemonProc = spawn(spawnArgs[0], spawnArgs.slice(1), {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env },
        });
        this.daemonProc.unref();
        const backoffs = [50, 100, 200, 400, 800, 1500, 3000];
        for (let index = 0; Date.now() < deadline; index += 1) {
            const waitMs = backoffs[Math.min(index, backoffs.length - 1)];
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            if (await isExtensionConnected())
                return;
        }
        if (await isDaemonRunning()) {
            throw new BrowserConnectError('Daemon is running but the Needle Browser Bridge extension is not connected.', 'Please install and enable the Needle Browser Bridge extension in Chrome.');
        }
        throw new BrowserConnectError('Failed to start Needle Browser daemon.', `Try running manually: node ${daemonPath}. Make sure port ${DEFAULT_DAEMON_PORT} is available.`);
    }
}
