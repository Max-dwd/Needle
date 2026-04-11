import { NextRequest, NextResponse } from 'next/server';
import {
  getPlayerKeyboardModeSettings,
  setPlayerKeyboardModeSettings,
} from '@/lib/player-keyboard-mode';

function createResponse() {
  return getPlayerKeyboardModeSettings();
}

export async function GET() {
  return NextResponse.json(createResponse());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    enabled?: boolean;
  } | null;

  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Invalid enabled flag' }, { status: 400 });
  }

  setPlayerKeyboardModeSettings(body.enabled);
  return NextResponse.json(createResponse());
}
