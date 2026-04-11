import { NextRequest, NextResponse } from 'next/server';
import { resetFailedTask, getSummaryTask } from '@/lib/summary-tasks';

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    video_id?: string;
    platform?: string;
  };
  const { video_id, platform } = body;

  if (!video_id || !platform) {
    return NextResponse.json(
      { error: 'Missing video_id or platform' },
      { status: 400 },
    );
  }

  const task = getSummaryTask(video_id, platform as 'youtube' | 'bilibili');
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (task.status !== 'failed' && task.status !== 'skipped') {
    return NextResponse.json(
      { error: 'Only failed or skipped tasks can be retried' },
      { status: 409 },
    );
  }

  resetFailedTask(video_id, platform);
  return NextResponse.json({ ok: true });
}
