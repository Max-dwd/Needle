import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __forcedAlignerRuntimeTestUtils,
  getForcedAlignerStatus,
  runForcedAligner,
} from './forced-aligner-runtime';

const {
  getForcedAlignerRemoteUrl,
  getForcedAlignerRuntime,
  parseAlignerJson,
} = __forcedAlignerRuntimeTestUtils;

afterEach(() => {
  delete process.env.FORCED_ALIGNER_RUNTIME;
  delete process.env.FORCED_ALIGNER_REMOTE_URL;
  vi.unstubAllGlobals();
});

describe('forced-aligner runtime JSON parsing', () => {
  it('extracts normalized AlignedWord entries from a words array', () => {
    expect(
      parseAlignerJson(
        JSON.stringify({
          words: [
            { text: '你好', start: 0.1, end: 0.8, prob: 0.97 },
            { text: '', start: 1, end: 2 },
            { text: 'world', start: 2, end: 1.5 },
            { text: 'hi', start: 5.1, end: 5.6 },
          ],
          warnings: ['low confidence'],
        }),
      ),
    ).toEqual({
      words: [
        { text: '你好', start: 0.1, end: 0.8, prob: 0.97 },
        { text: 'hi', start: 5.1, end: 5.6, prob: undefined },
      ],
      warnings: ['low confidence'],
    });
  });

  it('accepts alternate key names (tokens + probability)', () => {
    expect(
      parseAlignerJson(
        JSON.stringify({
          tokens: [
            { text: 'foo', start: 0, end: 0.5, probability: 0.8 },
            { text: 'bar', start: 0.5, end: 1.2, confidence: 0.6 },
          ],
        }),
      ),
    ).toEqual({
      words: [
        { text: 'foo', start: 0, end: 0.5, prob: 0.8 },
        { text: 'bar', start: 0.5, end: 1.2, prob: 0.6 },
      ],
      warnings: undefined,
    });
  });

  it('normalizes runtime environment settings', () => {
    process.env.FORCED_ALIGNER_RUNTIME = ' remote ';
    process.env.FORCED_ALIGNER_REMOTE_URL = 'http://host.docker.internal:8766/';

    expect(getForcedAlignerRuntime()).toBe('remote');
    expect(getForcedAlignerRemoteUrl()).toBe(
      'http://host.docker.internal:8766',
    );

    process.env.FORCED_ALIGNER_RUNTIME = 'bogus';
    expect(getForcedAlignerRuntime()).toBe('local');
  });

  it('posts audio and transcript to the remote sidecar runtime', async () => {
    process.env.FORCED_ALIGNER_RUNTIME = 'remote';
    process.env.FORCED_ALIGNER_REMOTE_URL = 'http://host.docker.internal:8766/';

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'needle-aligner-'));
    const audioPath = path.join(tempDir, 'chunk.wav');
    const textPath = path.join(tempDir, 'transcript.txt');
    fs.writeFileSync(audioPath, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(textPath, 'hello world', 'utf8');

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        audioFilename: 'chunk.wav',
        audioBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        text: 'hello world',
        modelId: 'test-model',
      });
      return new Response(
        JSON.stringify({
          words: [{ text: 'hello', start: 0, end: 0.5 }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runForcedAligner(audioPath, textPath, { modelId: 'test-model' }),
    ).resolves.toEqual({
      words: [{ text: 'hello', start: 0, end: 0.5, prob: undefined }],
      warnings: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://host.docker.internal:8766/align',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('checks remote sidecar status when configured', async () => {
    process.env.FORCED_ALIGNER_RUNTIME = 'remote';
    process.env.FORCED_ALIGNER_REMOTE_URL = 'http://host.docker.internal:8766/';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          available: true,
          binPath: '/Users/max/Needle/scripts/mlx_forced_aligner_wrapper.py',
          version: 'sidecar-test',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getForcedAlignerStatus(true)).resolves.toMatchObject({
      available: true,
      runtime: 'remote',
      binPath: '/Users/max/Needle/scripts/mlx_forced_aligner_wrapper.py',
      remoteUrl: 'http://host.docker.internal:8766',
      version: 'sidecar-test',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://host.docker.internal:8766/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
