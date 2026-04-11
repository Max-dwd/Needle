import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('browser daemon client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses the browser protocol header when checking daemon status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ extensionConnected: true }),
    });
    global.fetch = fetchMock as typeof fetch;

    const mod = await import('./daemon-client.js');
    await expect(mod.isDaemonRunning()).resolves.toBe(true);
    await expect(mod.isExtensionConnected()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: { 'X-Folo-Browser': '1' },
      }),
    );
  });
});
