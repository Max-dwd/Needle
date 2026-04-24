import { NextResponse } from 'next/server';
import { getForcedAlignerStatus } from '@/lib/forced-aligner-runtime';

export async function GET() {
  return NextResponse.json(await getForcedAlignerStatus(true));
}
