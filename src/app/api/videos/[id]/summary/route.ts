import { NextResponse } from 'next/server';
import { getDb, type Video } from '@/lib/db';
import {
  readStoredVideoSummary,
  readStoredVideoSummaryHistory,
  readStoredVideoSummaryVersion,
} from '@/lib/video-summary';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }

  const db = getDb();
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as
    | Video
    | undefined;
  if (!video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const version = url.searchParams.get('version');
  const includeHistory = url.searchParams.get('history') === '1';

  if (includeHistory) {
    const history = readStoredVideoSummaryHistory(video);
    return NextResponse.json(
      {
        ...(history.current || {}),
        history,
        previous: history.previous,
      },
      {
        headers: {
          'Cache-Control':
            'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      },
    );
  }

  if (version === 'previous') {
    const previousSummary = readStoredVideoSummaryVersion(video, 'previous');
    if (!previousSummary) {
      return NextResponse.json(
        {
          error: 'Previous summary unavailable',
          details: 'No previous summary markdown found for this video',
        },
        {
          status: 200,
          headers: {
            'Cache-Control':
              'no-store, no-cache, must-revalidate, proxy-revalidate',
          },
        },
      );
    }
    return NextResponse.json(previousSummary, {
      headers: {
        'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    });
  }

  const summary = readStoredVideoSummary(video);
  if (!summary) {
    return NextResponse.json(
      {
        error: 'Summary unavailable',
        details: 'No summary markdown found for this video',
      },
      {
        status: 200,
        headers: {
          'Cache-Control':
            'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      },
    );
  }

  return NextResponse.json(summary, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    },
  });
}
