import { NextResponse } from 'next/server';
import { getDb, type Video } from '@/lib/db';
import {
  generateSummaryViaApi,
  generateSummaryStream,
  hasSubtitleData,
  hasSummaryFile,
  backupSummaryFile,
} from '@/lib/ai-summary-client';
import {
  claimSummaryTaskProcessing,
  updateTaskStatus,
} from '@/lib/summary-tasks';
import { readStoredVideoSummary } from '@/lib/video-summary';
import { appEvents } from '@/lib/events';
import { log } from '@/lib/logger';

const SUMMARY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function createRequestAbortSignal(
  requestSignal: AbortSignal,
  options?: { respectClientAbort?: boolean },
): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(SUMMARY_REQUEST_TIMEOUT_MS)];

  if (options?.respectClientAbort !== false) {
    signals.unshift(requestSignal);
  }

  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function validateAndLoadVideo(id: string) {
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return {
      error: NextResponse.json({ error: 'Invalid video id' }, { status: 400 }),
    };
  }

  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as
    | Video
    | undefined;
  if (!video) {
    return {
      error: NextResponse.json({ error: 'Video not found' }, { status: 404 }),
    };
  }

  if (!hasSubtitleData(video.video_id, video.platform)) {
    log.error(
      'summary',
      'failure',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
        error: 'no subtitle',
      },
    );
    return {
      error: NextResponse.json(
        {
          error: '没有字幕数据，无法生成总结',
          details: 'No subtitle data available for this video',
        },
        { status: 400 },
      ),
    };
  }

  return { video };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = validateAndLoadVideo(id);
  if (result.error) return result.error;
  const video = result.video!;

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const stream = url.searchParams.get('stream') === '1';
  const modelIdOverride =
    url.searchParams.get('modelId')?.trim() ||
    url.searchParams.get('model')?.trim() ||
    null;

  // If summary already exists and not forcing, return it
  if (!force && hasSummaryFile(video.video_id, video.platform)) {
    const existing = readStoredVideoSummary(video);
    if (existing) {
      log.info(
        'summary',
        'skip',
        {
          source: 'manual',
          platform: video.platform,
          method: 'api',
          target: video.video_id,
          reason: 'already-exists',
        },
      );
      if (stream) {
        // For stream mode, send the existing content as a single chunk then done
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ delta: existing.markdown, done: false })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  done: true,
                  already_existed: true,
                  metadata: existing.metadata,
                })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new NextResponse(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      return NextResponse.json({ ...existing, already_existed: true });
    }
  }

  // Concurrency guard
  const claimedTask = claimSummaryTaskProcessing(
    video.video_id,
    video.platform,
    'api',
  );
  if (!claimedTask) {
    log.warn(
      'summary',
      'skip',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
        reason: 'already-processing',
      },
    );
    return NextResponse.json(
      { error: '总结正在生成中，请稍候' },
      { status: 409 },
    );
  }

  // Backup existing summary if force-regenerating
  if (force) {
    backupSummaryFile(video.video_id, video.platform);
    log.info(
      'summary',
      'start',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
        force: true,
      },
    );
  } else {
    log.info(
      'summary',
      'start',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
      },
    );
  }

  appEvents.emit('summary:start', {
    videoId: video.video_id,
    platform: video.platform,
  });

  if (stream) {
    return handleStreamGenerate(video, modelIdOverride, request.signal);
  }
  return handleNonStreamGenerate(video, modelIdOverride, request.signal);
}

function handleStreamGenerate(
  video: Video,
  modelIdOverride: string | null,
  requestSignal: AbortSignal,
) {
  // Keep the server-side generation running even if the player closes mid-stream.
  // The SSE response can be canceled independently from the actual summary job.
  const abortSignal = createRequestAbortSignal(requestSignal, {
    respectClientAbort: false,
  });
  const encoder = new TextEncoder();
  let streamClosed = false;

  const body = new ReadableStream({
    async start(controller) {
      const sendDelta = (data: Record<string, unknown>) => {
        if (streamClosed) return false;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
          return true;
        } catch {
          streamClosed = true;
          return false;
        }
      };

      const sendTerminal = (data: Record<string, unknown>) => {
        if (streamClosed) return false;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
          return true;
        } catch {
          streamClosed = true;
          return false;
        }
      };

      try {
        const gen = generateSummaryStream(
          video.video_id,
          video.platform as 'youtube' | 'bilibili',
          { modelIdOverride, abortSignal },
        );
        let result = await gen.next();
        while (!result.done) {
          sendDelta({ delta: result.value, done: false });
          result = await gen.next();
        }

        updateTaskStatus(video.video_id, video.platform, 'completed', {
          method: 'api',
        });
        log.info(
          'summary',
          'success',
          {
            source: 'manual',
            platform: video.platform,
            method: 'api',
            target: video.video_id,
          },
        );
        appEvents.emit('summary:complete', {
          videoId: video.video_id,
          platform: video.platform,
          preview: (typeof result.value === 'string' ? result.value : '').slice(
            0,
            200,
          ),
        });
        const summary = readStoredVideoSummary(video);
        sendTerminal({ done: true, metadata: summary?.metadata ?? {} });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        updateTaskStatus(video.video_id, video.platform, 'failed', {
          error: msg,
        });
        log.error(
          'summary',
          'failure',
          {
            source: 'manual',
            platform: video.platform,
            method: 'api',
            target: video.video_id,
            error: msg,
          },
        );
        appEvents.emit('summary:error', {
          videoId: video.video_id,
          error: msg,
        });
        if (!streamClosed) {
          sendTerminal({ error: msg, done: true });
        }
      } finally {
        if (!streamClosed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      streamClosed = true;
    },
  });

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function handleNonStreamGenerate(
  video: Video,
  modelIdOverride: string | null,
  requestSignal: AbortSignal,
) {
  const abortSignal = createRequestAbortSignal(requestSignal);
  try {
    const { markdown } = await generateSummaryViaApi(
      video.video_id,
      video.platform,
      {
        modelIdOverride,
        abortSignal,
      },
    );

    updateTaskStatus(video.video_id, video.platform, 'completed', {
      method: 'api',
    });
    log.info(
      'summary',
      'success',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
        chars: markdown.length,
      },
    );
    appEvents.emit('summary:complete', {
      videoId: video.video_id,
      platform: video.platform,
      preview: markdown.slice(0, 200),
    });

    const summary = readStoredVideoSummary(video);
    return NextResponse.json(
      summary || {
        video_id: video.video_id,
        platform: video.platform,
        format: 'markdown',
        metadata: {},
        markdown,
      },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    updateTaskStatus(video.video_id, video.platform, 'failed', { error: msg });
    log.error(
      'summary',
      'failure',
      {
        source: 'manual',
        platform: video.platform,
        method: 'api',
        target: video.video_id,
        error: msg,
      },
    );
    appEvents.emit('summary:error', { videoId: video.video_id, error: msg });
    return NextResponse.json(
      {
        error: '总结生成失败',
        details: msg,
      },
      { status: 500 },
    );
  }
}
