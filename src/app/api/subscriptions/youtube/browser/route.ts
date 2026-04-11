import { NextResponse } from 'next/server';
import { openBrowserYoutubeLoginPage } from '@/lib/browser-youtube-source';
import { normalizeBrowserError } from '@/lib/browser-source-shared';

export async function POST() {
  try {
    await openBrowserYoutubeLoginPage();
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: normalizeBrowserError(error) },
      { status: 500 },
    );
  }
}
