import fs from 'fs';
import path from 'path';
import {
  getBundledBrowserBridgeManifestPath,
  getVendoredCliInvocation,
  resolveBundledBrowserRuntimeRoot,
  resolveBundledBrowserBridgeDir,
} from './browser-runtime';

const FIRST_CLASS_BROWSER_EXTENSION_ROOT = path.resolve(
  process.cwd(),
  'browser-bridge',
  'extension',
);
export interface BrowserDistributionInfo {
  browserName: string;
  bridgeName: string;
  runtimeRoot: string;
  runtimeCommand: string;
  runtimeArgsPrefix: string[];
  extensionRoot: string;
  extensionManifestPath: string;
  extensionName: string;
  extensionVersion: string;
  extensionSource: 'bundled' | 'override';
}

function readManifest(manifestPath: string): {
  name?: unknown;
  version?: unknown;
} {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as {
    name?: unknown;
    version?: unknown;
  };
}

function normalizeBridgeManifestName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^Needle Browser Bridge$/i.test(trimmed)) {
    return 'Needle Browser Bridge';
  }
  return trimmed;
}

export function getBundledBrowserExtensionRoot(): {
  root: string;
  source: 'bundled' | 'override';
} {
  const root = resolveBundledBrowserBridgeDir();
  return {
    root,
    source:
      path.resolve(root) === FIRST_CLASS_BROWSER_EXTENSION_ROOT
        ? 'bundled'
        : 'override',
  };
}

export function getBundledBrowserDistributionInfo(): BrowserDistributionInfo {
  const runtimeInvocation = getVendoredCliInvocation();
  const runtimeRoot = resolveBundledBrowserRuntimeRoot();
  const { root: extensionRoot, source } = getBundledBrowserExtensionRoot();
  const extensionManifestPath = getBundledBrowserBridgeManifestPath();
  const manifest = readManifest(extensionManifestPath);

  return {
    browserName: 'Needle Browser',
    bridgeName: 'Needle Browser Bridge',
    runtimeRoot,
    runtimeCommand: runtimeInvocation.file,
    runtimeArgsPrefix: runtimeInvocation.argsPrefix,
    extensionRoot,
    extensionManifestPath,
    extensionName:
      normalizeBridgeManifestName(manifest.name) ?? 'Needle Browser Bridge',
    extensionVersion:
      typeof manifest.version === 'string' && manifest.version.trim()
        ? manifest.version.trim()
        : 'unknown',
    extensionSource: source,
  };
}
