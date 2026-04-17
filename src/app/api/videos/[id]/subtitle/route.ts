import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  ensureSubtitleForVideo,
  readStoredSubtitle,
  type SubtitleFetchOptions,
} from '@/lib/subtitles';

function parseOptionalPositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleSubtitleRequest(req, context, false, false);
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return handleSubtitleRequest(req, context, true, true);
}

async function handleSubtitleRequest(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
  force: boolean,
  canFetch: boolean,
) {
  const { id } = await context.params;
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }

  const source = req.nextUrl.searchParams.get('source')?.trim();
  const preferredMethod =
    req.nextUrl.searchParams.get('preferredMethod')?.trim() || undefined;
  const apiModelId =
    req.nextUrl.searchParams.get('modelId')?.trim() || undefined;
  const runAsync = req.nextUrl.searchParams.get('async') === '1';
  const aid = parseOptionalPositiveInt(req.nextUrl.searchParams.get('aid'));
  const cid = parseOptionalPositiveInt(req.nextUrl.searchParams.get('cid'));
  const requestOptions: SubtitleFetchOptions = {
    requestSource: source === 'player' ? 'player' : 'default',
    preferredMethod,
    allowBrowser:
      source === 'player' && preferredMethod?.toLowerCase() === 'gemini'
        ? false
        : undefined,
    bilibiliContext: aid || cid ? { aid, cid } : undefined,
    apiModelId,
    force,
    respectPause: false,
  };
  const existing = getDb()
    .prepare('SELECT * FROM videos WHERE id = ?')
    .get(videoId) as
    | {
        subtitle_status: string | null;
        subtitle_error: string | null;
        subtitle_cooldown_until: string | null;
        subtitle_path: string | null;
      }
    | undefined;

  if (!existing) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  if (canFetch && force && runAsync) {
    if (existing.subtitle_status !== 'fetching') {
      void ensureSubtitleForVideo(videoId, requestOptions).catch(() => {});
    }

    return NextResponse.json(
      {
        accepted: true,
        status:
          existing.subtitle_status === 'fetching' ? 'fetching' : 'pending',
        previousStatus: existing.subtitle_status || null,
        error: null,
        cooldownUntil: existing.subtitle_cooldown_until || null,
      },
      { status: 202 },
    );
  }

  if (!canFetch) {
    const subtitle = readStoredSubtitle(existing);
    if (!subtitle) {
      return NextResponse.json(
        {
          status: existing.subtitle_status || 'missing',
          error: existing.subtitle_error || null,
          cooldownUntil: existing.subtitle_cooldown_until || null,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      status: existing.subtitle_status || 'fetched',
      language: subtitle.language,
      format: subtitle.format,
      text: subtitle.text,
      segments: subtitle.segments || [],
      sourceMethod: subtitle.sourceMethod,
      segmentStyle: subtitle.segmentStyle,
      metadata: subtitle.metadata || {},
      cooldownUntil: existing.subtitle_cooldown_until || null,
    });
  }

  const video = await ensureSubtitleForVideo(videoId, requestOptions);
  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const subtitle = readStoredSubtitle(video);
  if (!subtitle) {
    return NextResponse.json(
      {
        status: video.subtitle_status || 'missing',
        error: video.subtitle_error || null,
        cooldownUntil: video.subtitle_cooldown_until || null,
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    status: video.subtitle_status || 'fetched',
    language: subtitle.language,
    format: subtitle.format,
    text: subtitle.text,
    segments: subtitle.segments || [],
    sourceMethod: subtitle.sourceMethod,
    segmentStyle: subtitle.segmentStyle,
    metadata: subtitle.metadata || {},
    cooldownUntil: video.subtitle_cooldown_until || null,
  });
}
