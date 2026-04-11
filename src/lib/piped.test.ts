import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULT_PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://api.piped.yt',
  'https://pipedapi.adminforge.de',
];

const PUBLIC_INSTANCES_SOURCE =
  'https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md';

const INSTANCE_BLOCKLIST_DURATION_MS = 5 * 60 * 1000;

function toUrlString(input: RequestInfo | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isPipedApiCall(url: string): boolean {
  return !url.startsWith(PUBLIC_INSTANCES_SOURCE);
}

function createCommentsResponse(
  comments: Array<{ commentId: string }>,
): Response & { json: () => Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ comments }),
  } as unknown as Response & { json: () => Promise<unknown> };
}

describe('getPipedComments', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('blocks a failed instance and retries it only after the blocklist window passes', async () => {
    const callLog: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL | Request) => {
        const url = toUrlString(input);
        callLog.push(extractHost(url));

        if (url.includes('pipedapi.kavin.rocks')) {
          return { ok: false, status: 500 } as Response;
        }

        if (
          url.includes('video-c') &&
          url.includes('pipedapi.leptons.xyz')
        ) {
          return { ok: false, status: 500 } as Response;
        }

        return createCommentsResponse([{ commentId: 'comment-1' }]);
      }) as typeof fetch,
    );

    const { getPipedComments } = await import('@/lib/piped');

    const firstResult = await getPipedComments('video-a', 1);
    expect(firstResult.instance).not.toBe('https://pipedapi.kavin.rocks');
    expect(firstResult.data).toEqual([{ commentId: 'comment-1' }]);

    callLog.length = 0;
    await getPipedComments('video-b', 1);
    expect(callLog).not.toContain('pipedapi.kavin.rocks');

    vi.advanceTimersByTime(INSTANCE_BLOCKLIST_DURATION_MS + 1);

    callLog.length = 0;
    await getPipedComments('video-c', 1);
    expect(callLog).toContain('pipedapi.kavin.rocks');
  });

  it('tries at most three non-blocked instances when requests fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL | Request) => {
        const url = toUrlString(input);
        if (url.startsWith(PUBLIC_INSTANCES_SOURCE)) {
          return { ok: false, status: 404 } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }) as typeof fetch,
    );

    const { getPipedComments } = await import('@/lib/piped');
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(getPipedComments('video-fail', 1)).rejects.toThrow();

    const pipedApiCalls = fetchMock.mock.calls.filter(([input]) =>
      isPipedApiCall(toUrlString(input)),
    );

    expect(pipedApiCalls).toHaveLength(3);
    expect(pipedApiCalls.length).toBeLessThan(DEFAULT_PIPED_INSTANCES.length);
  });

  it('fast-fails without extra HTTP requests once all instances are blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL | Request) => {
        const url = toUrlString(input);
        if (url.startsWith(PUBLIC_INSTANCES_SOURCE)) {
          return { ok: false, status: 404 } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }) as typeof fetch,
    );

    const { getPipedComments } = await import('@/lib/piped');
    const fetchMock = vi.mocked(globalThis.fetch);

    await expect(getPipedComments('video-1', 1)).rejects.toThrow();
    await expect(getPipedComments('video-2', 1)).rejects.toThrow();

    const callsBeforeFastFail = fetchMock.mock.calls.length;

    await expect(getPipedComments('video-3', 1)).rejects.toThrow(
      'All Piped instances are temporarily blocked',
    );

    expect(fetchMock.mock.calls.length - callsBeforeFastFail).toBe(0);
  });

  it('limits the returned comments to the requested count across pages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL | Request) => {
        const url = toUrlString(input);

        if (url.startsWith(PUBLIC_INSTANCES_SOURCE)) {
          return { ok: false, status: 404 } as Response;
        }

        if (url.includes('/nextpage/comments/')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                comments: [{ commentId: 'comment-3' }, { commentId: 'comment-4' }],
              }),
          } as unknown as Response & { json: () => Promise<unknown> };
        }

        if (url.includes('/comments/')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                comments: [{ commentId: 'comment-1' }, { commentId: 'comment-2' }],
                nextpage: 'page-2',
              }),
          } as unknown as Response & { json: () => Promise<unknown> };
        }

        return createCommentsResponse([]);
      }) as typeof fetch,
    );

    const { getPipedComments } = await import('@/lib/piped');

    const result = await getPipedComments('video-limit', 3);

    expect(result.data).toEqual([
      { commentId: 'comment-1' },
      { commentId: 'comment-2' },
      { commentId: 'comment-3' },
    ]);
  });
});
