import { NextResponse } from 'next/server';
import { runBrowserKeepalive } from '@/lib/browser-keepalive';

export async function POST() {
  try {
    const result = await runBrowserKeepalive();
    return NextResponse.json({
      ok: true,
      preset: result.preset,
      warmedWorkspaces: result.warmedWorkspaces,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'browser keepalive failed',
      },
      { status: 500 },
    );
  }
}
