import { NextResponse } from 'next/server';
import {
  getAiSummarySettings,
  resolveAiSummaryGenerationSettings,
} from '@/lib/ai-summary-settings';
import { buildChatPrompt, createChatStream } from '@/lib/ai-chat-client';
import { readSubtitlePayload } from '@/lib/ai-summary-client';
import { getDb, type Video } from '@/lib/db';
import { buildVideoUrl } from '@/lib/url-utils';
import type { ChatRequest, ChatMode } from '@/types';

interface LoadedVideo extends Video {
  channel_name: string | null;
}

function loadVideo(id: string) {
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return {
      error: NextResponse.json({ error: 'Invalid video id' }, { status: 400 }),
    };
  }

  const db = getDb();
  const video = db
    .prepare(
      `
        SELECT v.*, c.name AS channel_name
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        WHERE v.id = ?
        LIMIT 1
      `,
    )
    .get(videoId) as LoadedVideo | undefined;

  if (!video) {
    return {
      error: NextResponse.json({ error: 'Video not found' }, { status: 404 }),
    };
  }

  return { video };
}

function parseChatRequest(body: unknown) {
  if (!body || typeof body !== 'object') {
    return {
      error: NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 },
      ),
    };
  }

  const payload = body as Partial<ChatRequest>;
  const mode = payload.mode;
  const prompt =
    typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  const rangeStart = Number(payload.rangeStart);
  const rangeEnd = Number(payload.rangeEnd);
  const modelId =
    typeof payload.modelId === 'string' && payload.modelId.trim()
      ? payload.modelId.trim()
      : null;

  if (mode !== 'obsidian' && mode !== 'roast') {
    return {
      error: NextResponse.json(
        { error: 'Invalid chat mode' },
        { status: 400 },
      ),
    };
  }

  if (!prompt) {
    return {
      error: NextResponse.json(
        { error: 'Prompt is required' },
        { status: 400 },
      ),
    };
  }

  if (
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd <= rangeStart
  ) {
    return {
      error: NextResponse.json(
        { error: 'Invalid time range' },
        { status: 400 },
      ),
    };
  }

  return {
    payload: {
      mode,
      prompt,
      rangeStart,
      rangeEnd,
      modelId,
    } as {
      mode: ChatMode;
      prompt: string;
      rangeStart: number;
      rangeEnd: number;
      modelId: string | null;
    },
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoResult = loadVideo(id);
  if (videoResult.error) return videoResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const requestResult = parseChatRequest(body);
  if (requestResult.error) return requestResult.error;

  const video = videoResult.video!;
  const payload = requestResult.payload!;
  const subtitle = readSubtitlePayload(video.platform, video.video_id);

  if (!subtitle?.segments?.length) {
    return NextResponse.json(
      {
        error: '没有字幕数据，无法进行视频问答',
      },
      { status: 400 },
    );
  }

  const filteredSegments = subtitle.segments.filter(
    (segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.start >= payload.rangeStart &&
      segment.start < payload.rangeEnd &&
      typeof segment.text === 'string' &&
      segment.text.trim().length > 0,
  );

  if (filteredSegments.length === 0) {
    return NextResponse.json(
      {
        error: '选定时间范围内没有可用字幕片段',
      },
      { status: 400 },
    );
  }

  const aiSettings = resolveAiSummaryGenerationSettings({
    modelIdOverride: payload.modelId,
    triggerSource: 'manual',
  });

  const selectedModel = aiSettings.selectedModel;
  const { promptTemplates } = getAiSummarySettings();

  const prompt = buildChatPrompt(
    payload.mode,
    payload.prompt,
    filteredSegments,
    {
      title: video.title?.trim() || video.video_id,
      channel: video.channel_name?.trim() || '未知频道',
      platform: video.platform,
      url: buildVideoUrl(video.platform, video.video_id),
      generatedAt: new Date().toISOString(),
    },
    {
      chatObsidian: promptTemplates.chatObsidian,
      chatRoast: promptTemplates.chatRoast,
    },
  );

  return new NextResponse(
    createChatStream(prompt, selectedModel, request.signal),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}
