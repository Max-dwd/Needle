import { NextResponse } from 'next/server';
import { getBundledBrowserDistributionInfo } from '@/lib/browser-distribution';

export async function GET() {
  try {
    return NextResponse.json(getBundledBrowserDistributionInfo());
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : '无法读取浏览器桥接信息',
      },
      { status: 500 },
    );
  }
}
