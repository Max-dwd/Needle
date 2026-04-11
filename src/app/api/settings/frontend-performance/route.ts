import { NextResponse } from 'next/server';
import {
  getFrontendPerformanceSettings,
  setFrontendPerformanceSettings,
  type PerformanceMode,
} from '@/lib/frontend-performance';

export async function GET() {
  const settings = getFrontendPerformanceSettings();
  return NextResponse.json(settings);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      desktop?: PerformanceMode;
      mobile?: PerformanceMode;
    };

    setFrontendPerformanceSettings(body);
    
    return NextResponse.json({
      ...getFrontendPerformanceSettings(),
      success: true 
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}
