import { NextRequest, NextResponse } from 'next/server';
import {
  buildYouTubeMediaHeaders,
  invalidateYouTubePlaybackCache,
  resolveYouTubeStream,
} from '@/lib/youtube-playback';

export const runtime = 'nodejs';

const PASSTHROUGH_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

function copyProxyHeaders(source: Headers): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
  });

  for (const headerName of PASSTHROUGH_HEADERS) {
    const value = source.get(headerName);
    if (value) headers.set(headerName, value);
  }

  return headers;
}

async function fetchUpstreamMedia(
  videoId: string,
  url: string,
  request: NextRequest,
  method: 'GET' | 'HEAD',
): Promise<Response> {
  return fetch(url, {
    method,
    headers: buildYouTubeMediaHeaders(request.headers, videoId),
    cache: 'no-store',
  });
}

async function proxyYouTubeMedia(request: NextRequest, method: 'GET' | 'HEAD') {
  const videoId = request.nextUrl.searchParams.get('videoId')?.trim();

  if (!videoId) {
    return NextResponse.json(
      { error: 'Missing videoId parameter' },
      { status: 400 },
    );
  }

  const tryProxy = async (refresh: boolean): Promise<NextResponse> => {
    if (refresh) {
      invalidateYouTubePlaybackCache(videoId);
    }

    const stream = await resolveYouTubeStream(videoId, { refresh });
    const upstream = await fetchUpstreamMedia(
      videoId,
      stream.url,
      request,
      method,
    );

    if (
      !refresh &&
      (upstream.status === 403 ||
        upstream.status === 404 ||
        upstream.status === 410)
    ) {
      return tryProxy(true);
    }

    return new NextResponse(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: copyProxyHeaders(upstream.headers),
    });
  };

  return tryProxy(false);
}

export async function GET(request: NextRequest) {
  try {
    return await proxyYouTubeMedia(request, 'GET');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'YouTube 媒体代理失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function HEAD(request: NextRequest) {
  try {
    return await proxyYouTubeMedia(request, 'HEAD');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'YouTube 媒体代理失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
