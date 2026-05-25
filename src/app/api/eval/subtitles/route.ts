import { NextRequest, NextResponse } from 'next/server';
import { getDb, type Video } from '@/lib/db';
import {
  parseBilibiliVideoIdFromUrl,
  parseYoutubeVideoIdFromUrl,
} from '@/lib/browser-source-shared';
import {
  fetchBilibiliVideoDetail,
  fetchYouTubeVideoDetail,
} from '@/lib/fetcher';
import {
  fetchBrowserSubtitleForEval,
  fetchLlmAlignerSubtitleForEval,
  type EvalSubtitleVideo,
  type SubtitlePayload,
} from '@/lib/subtitles';

type EvalPlatform = 'youtube' | 'bilibili';

interface EvalSubtitleSuccess {
  ok: true;
  subtitle: {
    language: string;
    format: string;
    text: string;
    sourceMethod: string | null;
    segmentStyle: SubtitlePayload['segmentStyle'] | null;
    metadata: SubtitlePayload['metadata'];
    segments: Array<{
      start: number;
      end: number;
      text: string;
      speaker?: string;
    }>;
  };
}

interface EvalSubtitleFailure {
  ok: false;
  error: string;
}

function parseVideoUrl(url: string): {
  platform: EvalPlatform;
  videoId: string;
} {
  if (/youtu\.be|youtube\.com/i.test(url)) {
    const videoId = parseYoutubeVideoIdFromUrl(url);
    if (videoId) return { platform: 'youtube', videoId };
  }
  if (/bilibili\.com/i.test(url)) {
    const videoId = parseBilibiliVideoIdFromUrl(url);
    if (videoId) return { platform: 'bilibili', videoId };
  }
  throw new Error('Unsupported video URL');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSubtitle(payload: SubtitlePayload): EvalSubtitleSuccess {
  return {
    ok: true,
    subtitle: {
      language: payload.language,
      format: payload.format,
      text: payload.text,
      sourceMethod: payload.sourceMethod || null,
      segmentStyle: payload.segmentStyle || null,
      metadata: payload.metadata || {},
      segments: (payload.segments || [])
        .map((segment) => {
          const start = Number(segment.start);
          const end = Number(segment.end);
          const text = segment.text.trim();
          if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
            return null;
          }
          return {
            start,
            end: Math.max(end, start + 0.05),
            text,
            ...(segment.speaker ? { speaker: segment.speaker } : {}),
          };
        })
        .filter((segment): segment is NonNullable<typeof segment> =>
          Boolean(segment),
        ),
    },
  };
}

async function resolveEvalVideo(
  platform: EvalPlatform,
  videoId: string,
): Promise<EvalSubtitleVideo> {
  const existing = getDb()
    .prepare(
      `
      SELECT v.*, COALESCE(c.name, v.channel_name) AS channel_name
      FROM videos v
      LEFT JOIN channels c ON c.id = v.channel_id
      WHERE v.platform = ? AND v.video_id = ?
    `,
    )
    .get(platform, videoId) as Video | undefined;

  if (existing) return existing;

  const detail =
    platform === 'youtube'
      ? await fetchYouTubeVideoDetail(videoId)
      : await fetchBilibiliVideoDetail(videoId);

  const now = new Date().toISOString();
  return {
    id: 0,
    channel_id: 0,
    platform,
    video_id: videoId,
    title: detail?.title || videoId,
    thumbnail_url: detail?.thumbnail_url || null,
    published_at: detail?.published_at || null,
    duration: detail?.duration || null,
    is_read: 0,
    is_members_only: 0,
    access_status: null,
    availability_status: null,
    availability_reason: null,
    availability_checked_at: null,
    subtitle_path: null,
    subtitle_language: null,
    subtitle_format: null,
    subtitle_status: null,
    subtitle_error: null,
    subtitle_last_attempt_at: null,
    subtitle_retry_count: 0,
    subtitle_cooldown_until: null,
    members_only_checked_at: null,
    created_at: now,
    channel_name: detail?.channel_name || null,
  };
}

export async function POST(req: NextRequest) {
  let body: { url?: unknown; modelId?: unknown };
  try {
    body = (await req.json()) as { url?: unknown; modelId?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  let parsed: { platform: EvalPlatform; videoId: string };
  try {
    parsed = parseVideoUrl(url);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }

  const startedAt = new Date().toISOString();
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const video = await resolveEvalVideo(parsed.platform, parsed.videoId);

  const [browserResult, llmAlignerResult] = await Promise.allSettled([
    fetchBrowserSubtitleForEval(video),
    fetchLlmAlignerSubtitleForEval(video, {
      modelId: modelId || undefined,
    }),
  ]);

  const browser: EvalSubtitleSuccess | EvalSubtitleFailure =
    browserResult.status === 'fulfilled'
      ? normalizeSubtitle(browserResult.value)
      : { ok: false, error: errorMessage(browserResult.reason) };
  const llmAligner: EvalSubtitleSuccess | EvalSubtitleFailure =
    llmAlignerResult.status === 'fulfilled'
      ? normalizeSubtitle(llmAlignerResult.value)
      : { ok: false, error: errorMessage(llmAlignerResult.reason) };

  return NextResponse.json({
    video: {
      platform: parsed.platform,
      videoId: parsed.videoId,
      url,
      title: video.title || parsed.videoId,
      channelName: video.channel_name || null,
      duration: video.duration || null,
      thumbnailUrl: video.thumbnail_url || null,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    browser,
    llmAligner,
  });
}
