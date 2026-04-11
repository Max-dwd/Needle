import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  hasSubtitleDataMock,
  hasSummaryFileMock,
  readStoredVideoSummaryMock,
  claimSummaryTaskProcessingMock,
  updateTaskStatusMock,
  generateSummaryStreamMock,
  generateSummaryViaApiMock,
  backupSummaryFileMock,
} = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const hasSubtitleDataMock = vi.fn();
  const hasSummaryFileMock = vi.fn();
  const readStoredVideoSummaryMock = vi.fn();
  const claimSummaryTaskProcessingMock = vi.fn();
  const updateTaskStatusMock = vi.fn();
  const generateSummaryStreamMock = vi.fn();
  const generateSummaryViaApiMock = vi.fn();
  const backupSummaryFileMock = vi.fn();

  return {
    getDbMock,
    hasSubtitleDataMock,
    hasSummaryFileMock,
    readStoredVideoSummaryMock,
    claimSummaryTaskProcessingMock,
    updateTaskStatusMock,
    generateSummaryStreamMock,
    generateSummaryViaApiMock,
    backupSummaryFileMock,
  };
});

vi.mock('@/lib/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/ai-summary-client', () => ({
  generateSummaryViaApi: generateSummaryViaApiMock,
  generateSummaryStream: generateSummaryStreamMock,
  hasSubtitleData: hasSubtitleDataMock,
  hasSummaryFile: hasSummaryFileMock,
  backupSummaryFile: backupSummaryFileMock,
}));

vi.mock('@/lib/summary-tasks', () => ({
  claimSummaryTaskProcessing: claimSummaryTaskProcessingMock,
  updateTaskStatus: updateTaskStatusMock,
}));

vi.mock('@/lib/video-summary', () => ({
  readStoredVideoSummary: readStoredVideoSummaryMock,
}));

import { POST } from './route';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) } as {
    params: Promise<{ id: string }>;
  };
}

describe('POST /api/videos/[id]/summary/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasSubtitleDataMock.mockReturnValue(true);
    hasSummaryFileMock.mockReturnValue(false);
    readStoredVideoSummaryMock.mockReturnValue(null);
    backupSummaryFileMock.mockImplementation(() => {});
    generateSummaryViaApiMock.mockResolvedValue({
      markdown: '# summary',
      outputPath: '/tmp/summary.md',
      model: {
        id: 'model-1',
        name: 'Test Model',
        endpoint: 'http://example.com/v1',
        model: 'test-model',
      },
    });
    getDbMock.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 1,
          video_id: 'BV1',
          platform: 'youtube',
          title: 'Test Video',
          channel_id: 1,
        }),
      }),
    });
    claimSummaryTaskProcessingMock.mockReturnValue({
      id: 101,
      video_id: 'BV1',
      platform: 'youtube',
      status: 'processing',
    });
    updateTaskStatusMock.mockImplementation(() => {});
  });

  it('keeps generating after the response stream is canceled', async () => {
    const gate = createDeferred<void>();
    const completed = createDeferred<void>();
    const controller = new AbortController();

    generateSummaryStreamMock.mockImplementation(async function* () {
      yield '第一段';
      await gate.promise;
      yield '第二段';
      return '最终总结';
    });

    updateTaskStatusMock.mockImplementation((_videoId, _platform, status) => {
      if (status === 'completed') {
        completed.resolve();
      }
    });

    const req = new Request(
      'http://localhost/api/videos/1/summary/generate?stream=1',
      { method: 'POST', signal: controller.signal },
    );
    const response = await POST(req as never, makeParams('1'));

    const forwardedAbortSignal = generateSummaryStreamMock.mock.calls[0]?.[2]
      ?.abortSignal as AbortSignal;

    expect(generateSummaryStreamMock).toHaveBeenCalledWith(
      'BV1',
      'youtube',
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(forwardedAbortSignal).not.toBe(req.signal);
    expect(forwardedAbortSignal.aborted).toBe(false);

    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const firstChunk = await reader!.read();
    const decoded = new TextDecoder().decode(firstChunk.value);
    expect(decoded).toContain('第一段');

    controller.abort();
    expect(forwardedAbortSignal.aborted).toBe(true);

    await reader!.cancel();
    gate.resolve();

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for completion')), 1000);
    });

    await Promise.race([completed.promise, timeout]);

    expect(updateTaskStatusMock).toHaveBeenCalledWith('BV1', 'youtube', 'completed', {
      method: 'api',
    });
    expect(updateTaskStatusMock).not.toHaveBeenCalledWith(
      'BV1',
      'youtube',
      'failed',
      expect.anything(),
    );
  });

  it('forwards request.signal to non-stream summary generation', async () => {
    const controller = new AbortController();
    const req = new Request('http://localhost/api/videos/1/summary/generate', {
      method: 'POST',
      signal: controller.signal,
    });

    const response = await POST(req as never, makeParams('1'));

    const forwardedAbortSignal = generateSummaryViaApiMock.mock.calls[0]?.[2]
      ?.abortSignal as AbortSignal;

    expect(response.status).toBe(200);
    expect(generateSummaryViaApiMock).toHaveBeenCalledWith(
      'BV1',
      'youtube',
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(forwardedAbortSignal).not.toBe(req.signal);
    expect(forwardedAbortSignal.aborted).toBe(false);

    controller.abort();

    expect(forwardedAbortSignal.aborted).toBe(true);
  });
});
