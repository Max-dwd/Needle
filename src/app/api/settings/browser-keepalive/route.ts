import { NextRequest, NextResponse } from 'next/server';
import {
  getBrowserKeepalivePreset,
  getBrowserKeepaliveStatus,
  setBrowserKeepalivePreset,
} from '@/lib/browser-keepalive';

export async function GET() {
  return NextResponse.json(getBrowserKeepaliveStatus());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    preset?: string;
  } | null;
  const preset = body?.preset;

  if (preset !== 'off' && preset !== 'balanced' && preset !== 'aggressive') {
    return NextResponse.json({ error: 'Invalid preset' }, { status: 400 });
  }

  if (preset !== getBrowserKeepalivePreset()) {
    setBrowserKeepalivePreset(preset);
  }

  return NextResponse.json(getBrowserKeepaliveStatus());
}
