import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
const mockCreateBrowserBridge = vi.hoisted(() => vi.fn());
const mockGetVendoredCliInvocation = vi.hoisted(() => vi.fn());
const mockListBrowserSessions = vi.hoisted(() => vi.fn());
const mockListBrowserTabs = vi.hoisted(() => vi.fn());
const mockSelectBrowserTab = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('./browser-runtime', () => ({
  createBrowserBridge: mockCreateBrowserBridge,
  getVendoredCliInvocation: mockGetVendoredCliInvocation,
  listBrowserSessions: mockListBrowserSessions,
  listBrowserTabs: mockListBrowserTabs,
  selectBrowserTab: mockSelectBrowserTab,
}));

function mockExecJsonOnce(payload: unknown) {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void;
    callback(null, JSON.stringify(payload), '');
  });
}

describe('browser-session-manager', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockCreateBrowserBridge.mockReset();
    mockGetVendoredCliInvocation.mockReset();
    mockListBrowserSessions.mockReset();
    mockListBrowserTabs.mockReset();
    mockSelectBrowserTab.mockReset();

    delete process.env.FOLO_BROWSER_BACKGROUND_BOOTSTRAP;
    delete process.env.FOLO_BROWSER_METADATA_ISOLATION_SAFE;
    delete process.env.FOLO_BROWSER_METADATA_CONCURRENCY;
    delete process.env.FOLO_BROWSER_CLI_BIN;

    mockGetVendoredCliInvocation.mockReturnValue({
      file: 'browser-runtime/needle-browser-local',
      argsPrefix: [],
    });
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(null, '', '');
    });
    mockListBrowserSessions.mockResolvedValue([]);
    mockListBrowserTabs.mockResolvedValue([]);
    mockSelectBrowserTab.mockResolvedValue(undefined);
  });

  it('blocks background bootstrap when no reusable session exists', async () => {
    const { runBrowserCliJson } = await import('./browser-session-manager');

    await expect(
      runBrowserCliJson(['youtube', 'channel-videos', 'UC123'], {
        allowBrowserBootstrap: false,
      }),
    ).rejects.toThrow(/background bootstrap disabled/i);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('allows background CLI execution when a reusable session already exists', async () => {
    mockListBrowserSessions.mockResolvedValue([{ workspace: 'existing' }]);
    mockExecJsonOnce([{ ok: true }]);

    const { runBrowserCliJson } = await import('./browser-session-manager');

    await expect(
      runBrowserCliJson(['youtube', 'channel-videos', 'UC123'], {
        allowBrowserBootstrap: false,
      }),
    ).resolves.toEqual([{ ok: true }]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('reads transcript payloads from the output-file transport', async () => {
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const argv = args[1] as string[];
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      const outputIndex = argv.indexOf('--output-file');
      expect(outputIndex).toBeGreaterThan(-1);
      const outputFile = argv[outputIndex + 1];
      expect(typeof outputFile).toBe('string');
      fs.writeFileSync(
        outputFile as string,
        JSON.stringify([
          {
            start: '0.0',
            end: '1.5',
            text: 'Hello world',
          },
        ]),
        'utf8',
      );
      callback(null, '{"ok":true}\n', '');
    });

    const { runBrowserCliJson } = await import('./browser-session-manager');

    await expect(
      runBrowserCliJson([
        'youtube',
        'transcript',
        'https://www.youtube.com/watch?v=abc123def45',
        '--mode',
        'raw',
      ]),
    ).resolves.toEqual([
      {
        start: '0.0',
        end: '1.5',
        text: 'Hello world',
      },
    ]);
  });

  it('extracts the JSON payload when stdout contains noise around it', async () => {
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(
        null,
        '[bridge] reused session\n{"video_id":"video-a","title":"A"}\n',
        '',
      );
    });

    const { runBrowserCliJson } = await import('./browser-session-manager');

    await expect(
      runBrowserCliJson(['youtube', 'video-meta', 'video-a']),
    ).resolves.toEqual({
      video_id: 'video-a',
      title: 'A',
    });
  });

  it('surfaces CLI stderr for empty-result subtitle failures', async () => {
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      const error = Object.assign(new Error('Command failed'), {
        code: 66,
        stdout: '',
        stderr:
          'bilibili subtitle returned no data\n此视频没有发现外挂或智能字幕。\n',
      });
      callback(error, '', error.stderr);
    });

    const { runBrowserCliJson } = await import('./browser-session-manager');

    await expect(
      runBrowserCliJson(['bilibili', 'subtitle', 'BV1K1XBBDEgc']),
    ).rejects.toThrow(/此视频没有发现外挂或智能字幕/);
  });

  it('reuses an existing workspace session when opening a login page', async () => {
    mockListBrowserSessions.mockResolvedValue([
      { workspace: 'folo-youtube-subscriptions', windowId: 7 },
    ]);
    mockListBrowserTabs.mockResolvedValue([{ tabId: 12, active: true }]);

    const { openBrowserWorkspaceLoginPage } =
      await import('./browser-session-manager');

    await openBrowserWorkspaceLoginPage({
      workspace: 'folo-youtube-subscriptions',
      url: 'https://www.youtube.com/feed/channels',
      timeoutSeconds: 30,
    });

    expect(mockCreateBrowserBridge).not.toHaveBeenCalled();
    expect(mockSelectBrowserTab).toHaveBeenCalledWith({
      workspace: 'folo-youtube-subscriptions',
      tabId: 12,
    });
  });

  it('opens the requested login page inside the requested workspace when no session exists', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(),
    };
    const bridge = {
      connect: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateBrowserBridge.mockResolvedValue(bridge);

    const { openBrowserWorkspaceLoginPage } =
      await import('./browser-session-manager');

    await openBrowserWorkspaceLoginPage({
      workspace: 'folo-youtube-subscriptions',
      url: 'https://www.youtube.com/feed/channels',
      timeoutSeconds: 45,
      waitUntil: 'networkidle',
      settleMs: 2500,
    });

    expect(bridge.connect).toHaveBeenCalledWith({
      timeout: 45,
      workspace: 'folo-youtube-subscriptions',
    });
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.youtube.com/feed/channels',
      {
        waitUntil: 'networkidle',
        settleMs: 2500,
      },
    );
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in-flight login-page opens per workspace and respects cooldown', async () => {
    let releaseConnect!: () => void;
    const page = {
      goto: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          }),
      ),
      evaluate: vi.fn(),
    };
    const bridge = {
      connect: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateBrowserBridge.mockResolvedValue(bridge);

    const { openBrowserWorkspaceLoginPage } =
      await import('./browser-session-manager');

    const first = openBrowserWorkspaceLoginPage({
      workspace: 'folo-bilibili-following',
      url: 'https://www.bilibili.com/',
      timeoutSeconds: 30,
    });
    const second = openBrowserWorkspaceLoginPage({
      workspace: 'folo-bilibili-following',
      url: 'https://www.bilibili.com/',
      timeoutSeconds: 30,
    });

    await vi.waitFor(() => {
      expect(mockCreateBrowserBridge).toHaveBeenCalledTimes(1);
      expect(bridge.connect).toHaveBeenCalledTimes(1);
    });

    releaseConnect();
    await Promise.all([first, second]);

    await openBrowserWorkspaceLoginPage({
      workspace: 'folo-bilibili-following',
      url: 'https://www.bilibili.com/',
      timeoutSeconds: 30,
    });

    expect(mockCreateBrowserBridge).toHaveBeenCalledTimes(1);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
  });

  it('serializes workspace page operations by default', async () => {
    let releaseFirst!: () => void;
    const page = {
      goto: vi.fn(),
      evaluate: vi.fn(),
    };
    mockCreateBrowserBridge
      .mockResolvedValueOnce({
        connect: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        connect: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
      });

    const { withBrowserWorkspacePage } =
      await import('./browser-session-manager');

    const first = withBrowserWorkspacePage(
      {
        workspace: 'folo-youtube-subscriptions',
        timeoutSeconds: 30,
      },
      async () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve('first');
        }),
    );
    const second = withBrowserWorkspacePage(
      {
        workspace: 'folo-youtube-subscriptions',
        timeoutSeconds: 30,
      },
      async () => 'second',
    );

    await vi.waitFor(() => {
      expect(mockCreateBrowserBridge).toHaveBeenCalledTimes(1);
    });

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(mockCreateBrowserBridge).toHaveBeenCalledTimes(2);
  });

  it('limits metadata operations to the configured concurrency slots when isolation is safe', async () => {
    process.env.FOLO_BROWSER_METADATA_ISOLATION_SAFE = '1';
    process.env.FOLO_BROWSER_METADATA_CONCURRENCY = '2';

    const callbacks: Array<
      (error: Error | null, stdout?: string, stderr?: string) => void
    > = [];
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callbacks.push(callback);
    });

    const { runBrowserCliJson } = await import('./browser-session-manager');

    const first = runBrowserCliJson(['youtube', 'video-meta', 'video-a'], {
      strategy: 'metadata',
    });
    const second = runBrowserCliJson(['youtube', 'video-meta', 'video-b'], {
      strategy: 'metadata',
    });
    const third = runBrowserCliJson(['youtube', 'video-meta', 'video-c'], {
      strategy: 'metadata',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    callbacks[0]?.(null, JSON.stringify({ video_id: 'video-a' }), '');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockExecFile).toHaveBeenCalledTimes(3);

    callbacks[1]?.(null, JSON.stringify({ video_id: 'video-b' }), '');
    callbacks[2]?.(null, JSON.stringify({ video_id: 'video-c' }), '');

    await expect(first).resolves.toEqual({ video_id: 'video-a' });
    await expect(second).resolves.toEqual({ video_id: 'video-b' });
    await expect(third).resolves.toEqual({ video_id: 'video-c' });
  });
});
