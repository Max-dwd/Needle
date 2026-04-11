import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createBrowserBridgeMock,
  sendBrowserCommandMock,
  getAppSettingMock,
  getAppSettingUpdatedAtMock,
  setAppSettingMock,
} = vi.hoisted(() => ({
  createBrowserBridgeMock: vi.fn(),
  sendBrowserCommandMock: vi.fn(),
  getAppSettingMock: vi.fn(),
  getAppSettingUpdatedAtMock: vi.fn(),
  setAppSettingMock: vi.fn(),
}));

vi.mock('./browser-runtime', () => ({
  createBrowserBridge: createBrowserBridgeMock,
  sendBrowserCommand: sendBrowserCommandMock,
}));

vi.mock('./app-settings', () => ({
  getAppSetting: getAppSettingMock,
  getAppSettingUpdatedAt: getAppSettingUpdatedAtMock,
  setAppSetting: setAppSettingMock,
}));

describe('browser-keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createBrowserBridgeMock.mockResolvedValue({
      connect: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    });
    getAppSettingUpdatedAtMock.mockReturnValue('2026-03-30T00:00:00.000Z');
  });

  it('defaults existing and new users to the balanced preset', async () => {
    getAppSettingMock.mockReturnValue(null);
    const { getBrowserKeepaliveStatus } = await import('./browser-keepalive');

    expect(getBrowserKeepaliveStatus()).toEqual(
      expect.objectContaining({
        preset: 'balanced',
        activeGraceLabel: '2 min',
        daemonKeepalive: true,
        browserPrewarm: false,
      }),
    );
  });

  it('no-ops when the preset is off', async () => {
    getAppSettingMock.mockReturnValue('off');
    const { runBrowserKeepalive } = await import('./browser-keepalive');

    await expect(runBrowserKeepalive()).resolves.toEqual({
      preset: 'off',
      warmedWorkspaces: [],
    });
    expect(createBrowserBridgeMock).not.toHaveBeenCalled();
    expect(sendBrowserCommandMock).not.toHaveBeenCalled();
  });

  it('balanced keepalive ensures daemon availability without creating windows', async () => {
    getAppSettingMock.mockReturnValue('balanced');
    const { runBrowserKeepalive } = await import('./browser-keepalive');

    await expect(runBrowserKeepalive()).resolves.toEqual({
      preset: 'balanced',
      warmedWorkspaces: [],
    });
    expect(createBrowserBridgeMock).toHaveBeenCalledTimes(1);
    expect(sendBrowserCommandMock).not.toHaveBeenCalled();
  });

  it('aggressive keepalive warms both configured workspaces', async () => {
    getAppSettingMock.mockReturnValue('aggressive');
    const { runBrowserKeepalive } = await import('./browser-keepalive');

    await expect(runBrowserKeepalive()).resolves.toEqual({
      preset: 'aggressive',
      warmedWorkspaces: [
        'folo-youtube-subscriptions',
        'folo-bilibili-following',
      ],
    });
    expect(sendBrowserCommandMock).toHaveBeenCalledTimes(2);
    expect(sendBrowserCommandMock).toHaveBeenNthCalledWith(1, 'warmup', {
      workspace: 'folo-youtube-subscriptions',
    });
    expect(sendBrowserCommandMock).toHaveBeenNthCalledWith(2, 'warmup', {
      workspace: 'folo-bilibili-following',
    });
  });
});
