import { NextRequest, NextResponse } from 'next/server';
import { getBilibiliSessdata } from '@/lib/bilibili-auth';
import {
  buildBilibiliMediaHeaders,
  invalidateBilibiliPlaybackCache,
  resolveBilibiliPlayback,
} from '@/lib/bilibili-playback';

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

function parseCid(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseQn(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

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
  url: string,
  request: NextRequest,
  method: 'GET' | 'HEAD',
): Promise<Response> {
  return fetch(url, {
    method,
    headers: buildBilibiliMediaHeaders(
      request.headers,
      getBilibiliSessdata().trim() || undefined,
    ),
    cache: 'no-store',
  });
}

async function proxyBilibiliMedia(
  request: NextRequest,
  method: 'GET' | 'HEAD',
) {
  const searchParams = request.nextUrl.searchParams;
  const bvid = searchParams.get('bvid')?.trim();
  const cid = parseCid(searchParams.get('cid'));
  const qn = parseQn(searchParams.get('qn'));

  if (!bvid || !cid) {
    return NextResponse.json(
      { error: 'Missing bvid or cid parameter' },
      { status: 400 },
    );
  }

  const tryProxy = async (refresh: boolean): Promise<NextResponse> => {
    if (refresh) {
      invalidateBilibiliPlaybackCache(bvid, cid, qn);
    }

    const playback = await resolveBilibiliPlayback(bvid, cid, qn);
    const candidates = [playback.directUrl, ...playback.backupUrls];
    let lastFailure: Response | null = null;

    for (const candidate of candidates) {
      const upstream = await fetchUpstreamMedia(candidate, request, method);
      if (upstream.ok || upstream.status === 416) {
        return new NextResponse(method === 'HEAD' ? null : upstream.body, {
          status: upstream.status,
          headers: copyProxyHeaders(upstream.headers),
        });
      }

      lastFailure = upstream;
      if (
        upstream.status !== 403 &&
        upstream.status !== 404 &&
        upstream.status !== 410
      ) {
        return new NextResponse(method === 'HEAD' ? null : upstream.body, {
          status: upstream.status,
          headers: copyProxyHeaders(upstream.headers),
        });
      }
    }

    if (lastFailure) {
      return new NextResponse(method === 'HEAD' ? null : lastFailure.body, {
        status: lastFailure.status,
        headers: copyProxyHeaders(lastFailure.headers),
      });
    }

    return NextResponse.json(
      { error: 'Unable to fetch Bilibili media stream' },
      { status: 502 },
    );
  };

  const firstAttempt = await tryProxy(false);
  if (
    firstAttempt.status !== 403 &&
    firstAttempt.status !== 404 &&
    firstAttempt.status !== 410
  ) {
    return firstAttempt;
  }

  return tryProxy(true);
}

export async function GET(request: NextRequest) {
  try {
    return await proxyBilibiliMedia(request, 'GET');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'B站媒体代理失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function HEAD(request: NextRequest) {
  try {
    return await proxyBilibiliMedia(request, 'HEAD');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'B站媒体代理失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
