import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import {
  getLatestBackupArchive,
  runRestoreScript,
} from '@/lib/backup-system';
import { getAutoPipelineStatus, clearSubtitleQueue } from '@/lib/auto-pipeline';
import {
  getSchedulerSnapshot,
  startScheduler,
  stopScheduler,
} from '@/lib/scheduler';
import {
  clearSummaryQueue,
  getQueueState,
  requestQueueStop,
} from '@/lib/summary-queue';
import { closeDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RestoreMode = 'full' | 'db-only' | 'files-only';

function isRestoreMode(value: unknown): value is RestoreMode {
  return value === 'full' || value === 'db-only' || value === 'files-only';
}

function getRestoreReadiness() {
  const scheduler = getSchedulerSnapshot();
  const pipeline = getAutoPipelineStatus();
  const queue = getQueueState();
  const busyReasons: string[] = [];

  if (scheduler.status.currentTask) {
    busyReasons.push('后台抓取任务仍在运行');
  }
  if (pipeline.summary.processing || queue.running) {
    busyReasons.push('摘要队列仍在处理任务');
  }

  return {
    canRestore: busyReasons.length === 0,
    busyReasons,
    schedulerEnabled: scheduler.config.enabled,
    schedulerState: scheduler.status.state,
    subtitleQueueLength: pipeline.subtitle.queueLength,
    subtitleProcessing: pipeline.subtitle.processing,
    summaryQueueLength: pipeline.summary.queueLength,
    summaryProcessing: pipeline.summary.processing,
  };
}

export async function GET() {
  return NextResponse.json(
    {
      latestBackup: getLatestBackupArchive(),
      readiness: getRestoreReadiness(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function POST(request: NextRequest) {
  const readiness = getRestoreReadiness();
  if (!readiness.canRestore) {
    return NextResponse.json(
      {
        error: readiness.busyReasons.join('；'),
        readiness,
      },
      { status: 409 },
    );
  }

  const formData = await request.formData();
  const uploaded = formData.get('file');
  const modeRaw = formData.get('mode');
  const mode: RestoreMode = isRestoreMode(modeRaw) ? modeRaw : 'full';

  if (!(uploaded instanceof File) || uploaded.size <= 0) {
    return NextResponse.json({ error: '请上传备份包' }, { status: 400 });
  }

  if (!uploaded.name.endsWith('.tar.gz')) {
    return NextResponse.json(
      { error: '仅支持 .tar.gz 备份包' },
      { status: 400 },
    );
  }

  const schedulerSnapshot = getSchedulerSnapshot();
  const schedulerWasEnabled = schedulerSnapshot.config.enabled;
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'folo-upload-restore-'),
  );
  const uploadedPath = path.join(tempDir, uploaded.name);

  try {
    const bytes = new Uint8Array(await uploaded.arrayBuffer());
    await fs.promises.writeFile(uploadedPath, bytes);

    if (schedulerWasEnabled) {
      stopScheduler({ persist: false });
    }

    clearSubtitleQueue();
    requestQueueStop();
    clearSummaryQueue();

    if (mode !== 'files-only') {
      closeDb();
    }

    await runRestoreScript({
      backupFilePath: uploadedPath,
      mode,
    });

    if (schedulerWasEnabled) {
      startScheduler({
        crawlInterval: schedulerSnapshot.config.crawlInterval,
        subtitleInterval: schedulerSnapshot.config.subtitleInterval,
      });
    }

    return NextResponse.json({
      ok: true,
      mode,
      schedulerRestarted: schedulerWasEnabled,
      latestBackup: getLatestBackupArchive(),
      readiness: getRestoreReadiness(),
    });
  } catch (error) {
    if (schedulerWasEnabled) {
      startScheduler({
        crawlInterval: schedulerSnapshot.config.crawlInterval,
        subtitleInterval: schedulerSnapshot.config.subtitleInterval,
      });
    }

    const message = error instanceof Error ? error.message : '还原失败';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
