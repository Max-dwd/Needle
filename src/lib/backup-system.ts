import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const cwd = process.cwd();
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(cwd, 'data'));
const backupRoot = path.join(dataRoot, 'backups');
const backupScriptPath = path.join(cwd, 'scripts', 'backup.mjs');
const restoreScriptPath = path.join(cwd, 'scripts', 'restore.mjs');

export interface BackupArchiveInfo {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

export function getBackupRoot(): string {
  return backupRoot;
}

function createTimestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function createBackupOutputPath(date = new Date()): string {
  return path.join(
    backupRoot,
    `needle-backup-${createTimestampSlug(date)}.tar.gz`,
  );
}

export function listBackupArchives(): BackupArchiveInfo[] {
  if (!fs.existsSync(backupRoot)) {
    return [];
  }

  return fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
    .map((entry) => {
      const filePath = path.join(backupRoot, entry.name);
      const stat = fs.statSync(filePath);
      return {
        fileName: entry.name,
        filePath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function getLatestBackupArchive(): BackupArchiveInfo | null {
  return listBackupArchives()[0] ?? null;
}

interface RunBackupOptions {
  outputPath: string;
  includeEnv?: boolean;
  includeSummaryMd?: boolean;
}

export async function runBackupScript(options: RunBackupOptions): Promise<void> {
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

  const args = [backupScriptPath, '--output', options.outputPath];
  if (options.includeEnv) {
    args.push('--include-env');
  }
  if (options.includeSummaryMd) {
    args.push('--include-summary-md');
  }

  await execFileAsync(process.execPath, args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
}

interface RunRestoreOptions {
  backupFilePath: string;
  mode: 'full' | 'db-only' | 'files-only';
}

export async function runRestoreScript(options: RunRestoreOptions): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      restoreScriptPath,
      options.backupFilePath,
      '--mode',
      options.mode,
      '--yes',
    ],
    {
      cwd,
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    },
  );
}
