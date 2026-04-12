#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import readline from 'readline/promises';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { extract as extractTar } from 'tar';

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
const BACKUP_SCHEMA_VERSION = 1;
const VALID_MODES = new Set(['full', 'db-only', 'files-only']);
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    backupFile: null,
    mode: 'full',
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--mode requires a value');
      }
      options.mode = next;
      i += 1;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.backupFile) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.backupFile = arg;
  }

  if (!VALID_MODES.has(options.mode)) {
    throw new Error(`Invalid restore mode: ${options.mode}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/restore.mjs <backup-file.tar.gz> [--mode full|db-only|files-only] [--yes]

Options:
  --mode <mode>   Restore mode: full (default), db-only, files-only
  -y, --yes       Skip confirmation prompt
  -h, --help      Show this help message

Notes:
  Run restore while the app is stopped. This script replaces local data files.
`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
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

function getMajor(version) {
  const major = Number.parseInt(String(version || '').split('.')[0] || '0', 10);
  return Number.isNaN(major) ? 0 : major;
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

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Backup manifest is missing or invalid');
  }

  if (manifest.backupSchemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported backup schema version: ${manifest.backupSchemaVersion}`,
    );
  }

  const warnings = [];
  const currentVersion = loadPackageVersion();
  const backupMajor = getMajor(manifest.appVersion);
  const currentMajor = getMajor(currentVersion);
  if (backupMajor !== currentMajor) {
    warnings.push(
      `Backup app version ${manifest.appVersion} differs from current app version ${currentVersion}`,
    );
  }

  return warnings;
}

async function confirmRestore({ options, manifest, warnings }) {
  if (options.yes) {
    return;
  }

  console.log(`Restore mode: ${options.mode}`);
  console.log(`Backup created at: ${manifest.createdAt}`);
  console.log(`Backup app version: ${manifest.appVersion}`);
  console.log(
    `Archive contents: db=${manifest.includes.database}, subtitles=${manifest.includes.subtitles}, summaries=${manifest.includes.summaries}, summary-md=${manifest.includes.summaryMd}, env=${manifest.includes.envLocal}`,
  );
  console.log(`Target data root: ${DATA_ROOT}`);
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }
  console.warn(
    'This will overwrite local data. Stop the app before continuing if it is running.',
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Continue restore? Type "yes" to proceed: ');
    if (answer.trim().toLowerCase() !== 'yes') {
      throw new Error('Restore aborted by user');
    }
  } finally {
    rl.close();
  }
}

async function createCurrentDatabaseBackup() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }

  const backupPath = `${DB_PATH}.bak`;
  removePath(backupPath);
  removePath(`${backupPath}-wal`);
  removePath(`${backupPath}-shm`);

  const db = new Database(DB_PATH, { fileMustExist: true });
  try {
    await db.backup(backupPath);
    return backupPath;
  } finally {
    db.close();
  }
}

function replaceFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  removePath(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
}

function replaceDirectory(sourceDir, targetDir) {
  ensureDir(path.dirname(targetDir));
  removePath(targetDir);
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

async function runDatabaseMigrations() {
  const dbModulePath = pathToFileURL(path.join(cwd, 'src/lib/db.ts')).href;
  const script = `
    process.env.DATABASE_PATH = ${JSON.stringify(DB_PATH)};
    import(${JSON.stringify(dbModulePath)})
      .then(({ getDb }) => {
        const db = getDb();
        try {
          db.prepare('SELECT COUNT(*) AS count FROM sqlite_master').get();
        } finally {
          db.close();
        }
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  `;

  // Use tsx to handle .ts files and tsconfig paths
  await execFileAsync('npx', [
    'tsx',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '-e',
    script,
  ]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.backupFile) {
    throw new Error('Backup file path is required');
  }

  const backupFile = path.resolve(options.backupFile);
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  const tempRoot = createTempDir('folo-restore-');
  const extractRoot = path.join(tempRoot, 'payload');
  const manifestPath = path.join(extractRoot, 'manifest.json');

  try {
    ensureDir(extractRoot);
    await extractTar({
      cwd: extractRoot,
      file: backupFile,
      strict: true,
    });

    if (!fs.existsSync(manifestPath)) {
      throw new Error('Backup archive does not contain manifest.json');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const warnings = validateManifest(manifest);
    await confirmRestore({ options, manifest, warnings });

    const extractedDbPath = path.join(extractRoot, 'data', 'folo.db');
    const extractedSubtitleRoot = path.join(extractRoot, 'data', 'subtitles');
    const extractedSummaryRoot = path.join(extractRoot, 'data', 'summaries');
    const extractedSummaryMdRoot = path.join(extractRoot, 'data', 'summary-md');
    const extractedEnvPath = path.join(extractRoot, '.env.local');

    let currentDbBackupPath = null;
    if (options.mode !== 'files-only' && fs.existsSync(extractedDbPath)) {
      currentDbBackupPath = await createCurrentDatabaseBackup();
      removePath(DB_PATH);
      removePath(`${DB_PATH}-wal`);
      removePath(`${DB_PATH}-shm`);
      replaceFile(extractedDbPath, DB_PATH);
    }

    if (options.mode !== 'db-only') {
      replaceDirectory(extractedSubtitleRoot, SUBTITLE_ROOT);
      replaceDirectory(extractedSummaryRoot, SUMMARY_ROOT);
      if (fs.existsSync(extractedSummaryMdRoot)) {
        replaceDirectory(extractedSummaryMdRoot, SUMMARY_MD_ROOT);
      }
      if (options.mode === 'full' && fs.existsSync(extractedEnvPath)) {
        replaceFile(extractedEnvPath, ENV_LOCAL_PATH);
      }
    }

    if (options.mode !== 'files-only') {
      await runDatabaseMigrations();
    }

    console.log(`Restore completed from: ${backupFile}`);
    console.log(`Mode: ${options.mode}`);
    if (currentDbBackupPath) {
      console.log(`Previous database backup: ${currentDbBackupPath}`);
    }
    if (options.mode !== 'db-only') {
      const subtitleStats = statPath(SUBTITLE_ROOT);
      const summaryStats = statPath(SUMMARY_ROOT);
      const summaryMdStats = statPath(SUMMARY_MD_ROOT);
      console.log(
        `Restored files: subtitles=${subtitleStats.fileCount}, summaries=${summaryStats.fileCount}, summary-md=${summaryMdStats.fileCount}`,
      );
      console.log(
        `Restored size: subtitles=${formatBytes(subtitleStats.sizeBytes)}, summaries=${formatBytes(summaryStats.sizeBytes)}, summary-md=${formatBytes(summaryMdStats.sizeBytes)}`,
      );
    }
  } finally {
    removePath(tempRoot);
  }
}

main().catch((error) => {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
});
