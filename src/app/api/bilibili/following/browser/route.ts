import { NextResponse } from 'next/server';
import { openBrowserBilibiliLoginPage } from '@/lib/browser-bilibili-source';
import { normalizeBrowserError } from '@/lib/browser-source-shared';

export async function POST() {
  try {
    await openBrowserBilibiliLoginPage();
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: normalizeBrowserError(error) },
      { status: 500 },
    );
  }
}
