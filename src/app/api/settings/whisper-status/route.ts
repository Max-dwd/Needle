import { NextResponse } from 'next/server';
import { getMlxWhisperStatus } from '@/lib/whisper-runtime';

export async function GET() {
  return NextResponse.json(await getMlxWhisperStatus(true));
}
