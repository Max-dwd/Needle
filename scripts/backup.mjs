#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { create as createTar } from 'tar';

const cwd = process.cwd();
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(cwd, 'data'));
const DB_PATH = path.resolve(
  process.env.DATABASE_PATH || path.join(DATA_ROOT, 'folo.db'),
);
const SUBTITLE_ROOT = path.resolve(
  process.env.SUBTITLE_ROOT || path.join(DATA_ROOT, 'subtitles'),
);
const SUMMARY_ROOT = path.resolve(
  process.env.SUMMARY_ROOT || path.join(DATA_ROOT, 'summaries'),
);
const SUMMARY_MD_ROOT = path.resolve(
  process.env.SUMMARY_MD_ROOT || path.join(DATA_ROOT, 'summary-md'),
);
const ENV_LOCAL_PATH = path.resolve(cwd, '.env.local');
const DEFAULT_BACKUP_DIR = path.join(DATA_ROOT, 'backups');
const BACKUP_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const options = {
    output: null,
    includeEnv: false,
    includeSummaryMd: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--output requires a file path');
      }
      options.output = next;
      i += 1;
      continue;
    }
    if (arg === '--include-env') {
      options.includeEnv = true;
      continue;
    }
    if (arg === '--include-summary-md') {
      options.includeSummaryMd = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/backup.mjs [--output <path>] [--include-env] [--include-summary-md]

Options:
  --output <path>         Custom output path for the .tar.gz archive
  --include-env           Include .env.local in the backup archive
  --include-summary-md    Include data/summary-md in the backup archive
  -h, --help              Show this help message
`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadPackageVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
  );
  return packageJson.version || '0.0.0';
}

function getTimestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function statPath(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, fileCount: 0, sizeBytes: 0 };
  }

  const stat = fs.statSync(filePath);
  if (stat.isFile()) {
    return { exists: true, fileCount: 1, sizeBytes: stat.size };
  }

  if (!stat.isDirectory()) {
    return { exists: true, fileCount: 0, sizeBytes: 0 };
  }

  let fileCount = 0;
  let sizeBytes = 0;
  const stack = [filePath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        fileCount += 1;
        sizeBytes += fs.statSync(entryPath).size;
      }
    }
  }

  return { exists: true, fileCount, sizeBytes };
}

function copyDirIfExists(sourceDir, targetDir) {
  ensureDir(targetDir);
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function getDatabaseStats(db) {
  const existingTables = new Set(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.name),
  );

  const trackedTables = [
    'channels',
    'videos',
    'app_settings',
    'intents',
    'summary_tasks',
  ];

  const rowCounts = {};
  for (const tableName of trackedTables) {
    rowCounts[tableName] = existingTables.has(tableName)
      ? db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count
      : null;
  }

  const journalMode = db.pragma('journal_mode', { simple: true });
  return { journalMode, rowCounts };
}

async function createDatabaseBackup(targetPath) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database file not found: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH, { fileMustExist: true });
  try {
    await db.backup(targetPath);
    return getDatabaseStats(db);
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const backupDate = new Date();
  const timestampSlug = getTimestampSlug(backupDate);
  const defaultOutputPath = path.join(
    DEFAULT_BACKUP_DIR,
    `needle-backup-${timestampSlug}.tar.gz`,
  );
  const outputPath = path.resolve(options.output || defaultOutputPath);
  ensureDir(path.dirname(outputPath));

  const tempRoot = createTempDir('folo-backup-');
  const stagingRoot = path.join(tempRoot, 'payload');
  const stagingDataRoot = path.join(stagingRoot, 'data');
  const stagingDbPath = path.join(stagingDataRoot, 'folo.db');
  const stagingSubtitleRoot = path.join(stagingDataRoot, 'subtitles');
  const stagingSummaryRoot = path.join(stagingDataRoot, 'summaries');
  const stagingSummaryMdRoot = path.join(stagingDataRoot, 'summary-md');
  const manifestPath = path.join(stagingRoot, 'manifest.json');

  try {
    ensureDir(stagingDataRoot);
    const dbStats = await createDatabaseBackup(stagingDbPath);
    copyDirIfExists(SUBTITLE_ROOT, stagingSubtitleRoot);
    copyDirIfExists(SUMMARY_ROOT, stagingSummaryRoot);
    if (options.includeSummaryMd) {
      copyDirIfExists(SUMMARY_MD_ROOT, stagingSummaryMdRoot);
    }
    if (options.includeEnv && fs.existsSync(ENV_LOCAL_PATH)) {
      fs.copyFileSync(ENV_LOCAL_PATH, path.join(stagingRoot, '.env.local'));
    }

    const manifest = {
      backupSchemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: loadPackageVersion(),
      createdAt: backupDate.toISOString(),
      createdBy: {
        script: 'scripts/backup.mjs',
        nodeVersion: process.version,
      },
      includes: {
        database: true,
        subtitles: true,
        summaries: true,
        summaryMd: options.includeSummaryMd,
        envLocal: options.includeEnv && fs.existsSync(ENV_LOCAL_PATH),
      },
      entries: {
        database: {
          path: 'data/folo.db',
          sizeBytes: statPath(stagingDbPath).sizeBytes,
          journalMode: dbStats.journalMode,
          rowCounts: dbStats.rowCounts,
        },
        subtitles: {
          path: 'data/subtitles',
          ...statPath(stagingSubtitleRoot),
        },
        summaries: {
          path: 'data/summaries',
          ...statPath(stagingSummaryRoot),
        },
        summaryMd: options.includeSummaryMd
          ? {
              path: 'data/summary-md',
              ...statPath(stagingSummaryMdRoot),
            }
          : null,
        envLocal:
          options.includeEnv && fs.existsSync(path.join(stagingRoot, '.env.local'))
            ? {
                path: '.env.local',
                ...statPath(path.join(stagingRoot, '.env.local')),
              }
            : null,
      },
    };

    fs.writeFileSync(`${manifestPath}`, `${JSON.stringify(manifest, null, 2)}\n`);

    const archiveEntries = ['manifest.json', 'data'];
    if (manifest.includes.envLocal) {
      archiveEntries.push('.env.local');
    }

    await createTar(
      {
        cwd: stagingRoot,
        file: outputPath,
        gzip: true,
        portable: true,
      },
      archiveEntries,
    );

    const archiveSize = fs.statSync(outputPath).size;
    console.log(`Backup created: ${outputPath}`);
    console.log(`Archive size: ${formatBytes(archiveSize)}`);
    console.log(`Database rows: ${JSON.stringify(manifest.entries.database.rowCounts)}`);
    console.log(
      `Files: subtitles=${manifest.entries.subtitles.fileCount}, summaries=${manifest.entries.summaries.fileCount}, summary-md=${manifest.entries.summaryMd?.fileCount ?? 0}`,
    );
    if (manifest.includes.envLocal) {
      console.log('Included .env.local');
    }
  } finally {
    removeDir(tempRoot);
  }
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
