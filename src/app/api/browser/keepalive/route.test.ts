import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runBrowserKeepaliveMock } = vi.hoisted(() => ({
  runBrowserKeepaliveMock: vi.fn(),
}));

vi.mock('@/lib/browser-keepalive', () => ({
  runBrowserKeepalive: runBrowserKeepaliveMock,
}));

import { POST } from './route';

describe('POST /api/browser/keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when preset is off', async () => {
    runBrowserKeepaliveMock.mockResolvedValue({
      preset: 'off',
      warmedWorkspaces: [],
    });

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      preset: 'off',
      warmedWorkspaces: [],
    });
  });

  it('keeps only the daemon warm for the balanced preset', async () => {
    runBrowserKeepaliveMock.mockResolvedValue({
      preset: 'balanced',
      warmedWorkspaces: [],
    });

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      preset: 'balanced',
      warmedWorkspaces: [],
    });
  });

  it('warms both long-lived workspaces for the aggressive preset', async () => {
    runBrowserKeepaliveMock.mockResolvedValue({
      preset: 'aggressive',
      warmedWorkspaces: [
        'folo-youtube-subscriptions',
        'folo-bilibili-following',
      ],
    });

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      preset: 'aggressive',
      warmedWorkspaces: [
        'folo-youtube-subscriptions',
        'folo-bilibili-following',
      ],
    });
  });
});
