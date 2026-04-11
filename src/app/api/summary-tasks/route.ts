import { NextRequest, NextResponse } from 'next/server';
import { listSummaryTasks } from '@/lib/summary-tasks';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get('status') || undefined;
  const limit = Number(searchParams.get('limit')) || 50;
  const offset = Number(searchParams.get('offset')) || 0;

  const tasks = listSummaryTasks({ status, limit, offset });

  const db = getDb();
  const tasksWithTitle = tasks.map((task) => {
    const video = db
      .prepare('SELECT title FROM videos WHERE video_id = ? AND platform = ?')
      .get(task.video_id, task.platform) as { title: string } | undefined;
    return { ...task, title: video?.title || null };
  });

  return NextResponse.json({ tasks: tasksWithTitle });
}
