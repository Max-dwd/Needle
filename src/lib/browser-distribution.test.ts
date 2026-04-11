import { describe, expect, it } from 'vitest';
import {
  getBundledBrowserDistributionInfo,
  getBundledBrowserExtensionRoot,
} from './browser-distribution';

describe('browser distribution', () => {
  it('prefers the first-class Needle browser extension package', () => {
    const result = getBundledBrowserExtensionRoot();

    expect(result.source).toBe('bundled');
    expect(result.root).toContain('/browser-bridge/extension');
  });

  it('reports the first-class runtime and extension metadata', () => {
    const result = getBundledBrowserDistributionInfo();

    expect(result.browserName).toBe('Needle Browser');
    expect(result.bridgeName).toBe('Needle Browser Bridge');
    expect(result.runtimeRoot).toContain('/browser-runtime');
    expect(result.runtimeCommand).toContain(
      '/browser-runtime/needle-browser-local',
    );
    expect(result.extensionRoot).toContain('/browser-bridge/extension');
    expect(result.extensionManifestPath).toContain(
      '/browser-bridge/extension/manifest.json',
    );
    expect(result.extensionName).toBe('Needle Browser Bridge');
    expect(result.extensionVersion).toBeTruthy();
  });
});
