import { NextResponse } from 'next/server';
import {
  getVideoErrorHandlingSettings,
  setVideoErrorHandlingSettings,
} from '@/lib/video-error-handling';
import type { UnavailableVideoBehavior } from '@/types';

export async function GET() {
  return NextResponse.json(getVideoErrorHandlingSettings());
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      hideUnavailableVideos?: boolean;
      unavailableVideoBehavior?: UnavailableVideoBehavior;
    };

    if (
      body.hideUnavailableVideos !== undefined &&
      typeof body.hideUnavailableVideos !== 'boolean'
    ) {
      return NextResponse.json(
        { error: 'hideUnavailableVideos must be a boolean' },
        { status: 400 },
      );
    }

    if (
      body.unavailableVideoBehavior !== undefined &&
      body.unavailableVideoBehavior !== 'keep' &&
      body.unavailableVideoBehavior !== 'abandon'
    ) {
      return NextResponse.json(
        { error: 'unavailableVideoBehavior must be keep or abandon' },
        { status: 400 },
      );
    }

    return NextResponse.json(setVideoErrorHandlingSettings(body));
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
