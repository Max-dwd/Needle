import { NextResponse } from 'next/server';
import { getSummaryTaskStats } from '@/lib/summary-tasks';

export async function GET() {
  const stats = getSummaryTaskStats();
  return NextResponse.json(stats);
}
