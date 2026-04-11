import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('browser-runtime browser bridge discovery', () => {
  const originalEnv = {
    FOLO_BROWSER_EXTENSION_DIR: process.env.FOLO_BROWSER_EXTENSION_DIR,
  };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.FOLO_BROWSER_EXTENSION_DIR;
  });

  afterEach(() => {
    process.env.FOLO_BROWSER_EXTENSION_DIR =
      originalEnv.FOLO_BROWSER_EXTENSION_DIR;
  });

  it('uses a valid env override when provided', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-bridge-'));
    fs.mkdirSync(path.join(tempRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(tempRoot, 'dist', 'background.js'), '');

    process.env.FOLO_BROWSER_EXTENSION_DIR = tempRoot;

    const {
      resolveBundledBrowserBridgeDir,
      getBundledBrowserBridgeManifestPath,
    } = await import('./browser-runtime');

    expect(resolveBundledBrowserBridgeDir()).toBe(tempRoot);
    expect(getBundledBrowserBridgeManifestPath()).toBe(
      path.join(tempRoot, 'manifest.json'),
    );
  });

  it('prefers the first-class Needle browser bridge package by default', async () => {
    const {
      resolveBundledBrowserBridgeDir,
      getBundledBrowserBridgeManifestPath,
    } = await import('./browser-runtime');

    const root = resolveBundledBrowserBridgeDir();
    expect(root).toBe(
      path.resolve(process.cwd(), 'browser-bridge', 'extension'),
    );
    expect(getBundledBrowserBridgeManifestPath()).toBe(
      path.join(root, 'manifest.json'),
    );
  });

  it('prefers the first-class Needle browser runtime package by default', async () => {
    const { resolveBundledBrowserRuntimeRoot, getVendoredCliInvocation } =
      await import('./browser-runtime');

    const runtimeRoot = resolveBundledBrowserRuntimeRoot();
    expect(runtimeRoot).toBe(path.resolve(process.cwd(), 'browser-runtime'));

    const invocation = getVendoredCliInvocation();
    expect(invocation.file).toContain('/browser-runtime/needle-browser-local');
    expect(invocation.argsPrefix).toEqual([]);
  });

  it('fails explicitly when the first-class bundle is missing and no override exists', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const mockedFs = {
        ...actual,
        existsSync(targetPath: string) {
          if (
            targetPath.includes(
              path.join('browser-bridge', 'extension', 'manifest.json'),
            ) ||
            targetPath.includes(
              path.join('browser-bridge', 'extension', 'dist', 'background.js'),
            )
          ) {
            return false;
          }
          return actual.existsSync(targetPath);
        },
      };

      return {
        ...mockedFs,
        default: mockedFs,
      };
    });

    const { resolveBundledBrowserBridgeDir } =
      await import('./browser-runtime');

    expect(() => resolveBundledBrowserBridgeDir()).toThrow(
      /first-class Needle browser bridge bundle not found/i,
    );
  });

  it('fails explicitly when the first-class runtime bundle is missing', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const mockedFs = {
        ...actual,
        existsSync(targetPath: string) {
          if (
            targetPath.includes(path.join('browser-runtime', 'package.json')) ||
            targetPath.includes(
              path.join('browser-runtime', 'needle-browser-local'),
            ) ||
            targetPath.includes(
              path.join('browser-runtime', 'dist', 'main.js'),
            ) ||
            targetPath.includes(
              path.join('browser-runtime', 'dist', 'browser', 'index.js'),
            ) ||
            targetPath.includes(
              path.join(
                'browser-runtime',
                'dist',
                'browser',
                'daemon-client.js',
              ),
            )
          ) {
            return false;
          }
          return actual.existsSync(targetPath);
        },
      };

      return {
        ...mockedFs,
        default: mockedFs,
      };
    });

    const { resolveBundledBrowserRuntimeRoot } =
      await import('./browser-runtime');

    expect(() => resolveBundledBrowserRuntimeRoot()).toThrow(
      /first-class Needle browser runtime bundle not found/i,
    );
  });
});
