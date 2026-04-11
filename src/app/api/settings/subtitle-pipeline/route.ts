import { NextRequest, NextResponse } from 'next/server';
import { getPositiveIntAppSetting, setAppSetting } from '@/lib/app-settings';
import { getAllSubtitleBackoffStates } from '@/lib/subtitle-backoff';
import {
  getSubtitleApiFallbackConfig,
  setSubtitleApiFallbackConfig,
} from '@/lib/subtitle-api-fallback-settings';
import {
  getSubtitleBrowserFetchConfig,
  setSubtitleBrowserFetchConfig,
} from '@/lib/subtitle-browser-fetch-settings';

const SUBTITLE_INTERVAL_SETTING_KEY = 'scheduler_subtitle_interval';

export async function GET() {
  return NextResponse.json({
    apiFallback: getSubtitleApiFallbackConfig(),
    browserFetch: getSubtitleBrowserFetchConfig(),
    subtitleInterval: getPositiveIntAppSetting(
      SUBTITLE_INTERVAL_SETTING_KEY,
      10,
    ),
    backoff: getAllSubtitleBackoffStates(),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const payload =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : null;

  try {
    if (typeof payload?.subtitleInterval === 'number') {
      setAppSetting(
        SUBTITLE_INTERVAL_SETTING_KEY,
        String(Math.max(0, Math.floor(payload.subtitleInterval))),
      );
    }

    return NextResponse.json({
      apiFallback:
        payload && 'apiFallback' in payload
          ? setSubtitleApiFallbackConfig(payload.apiFallback)
          : getSubtitleApiFallbackConfig(),
      browserFetch:
        payload && 'browserFetch' in payload
          ? setSubtitleBrowserFetchConfig(payload.browserFetch)
          : getSubtitleBrowserFetchConfig(),
      subtitleInterval:
        typeof payload?.subtitleInterval === 'number'
          ? Math.max(0, Math.floor(payload.subtitleInterval))
          : getPositiveIntAppSetting(SUBTITLE_INTERVAL_SETTING_KEY, 10),
      backoff: getAllSubtitleBackoffStates(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : '保存字幕链路配置失败',
      },
      { status: 400 },
    );
  }
}
