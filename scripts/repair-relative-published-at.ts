import { closeDb, getDb } from '../src/lib/db';
import {
  ensureEnrichmentQueue,
  enrichVideo,
  getEnrichmentQueue,
} from '../src/lib/enrichment-queue';

interface CandidateRow {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  channel_name: string | null;
  title: string | null;
  published_at: string | null;
  created_at: string;
}

interface CliOptions {
  dryRun: boolean;
  limit: number | null;
}

const RELATIVE_PUBLISHED_AT_SQL = `
  v.published_at IS NOT NULL
  AND TRIM(v.published_at) <> ''
  AND (
    v.availability_status IS NULL
    OR v.availability_status NOT IN ('unavailable', 'abandoned')
  )
  AND (
    v.published_at = 'just now'
    OR v.published_at = '刚刚'
    OR v.published_at LIKE '%ago'
    OR v.published_at LIKE '%前'
  )
`;

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--limit') {
      const next = argv[i + 1];
      const value = Number(next);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --limit value: ${next ?? '(missing)'}`);
      }
      limit = Math.floor(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, limit };
}

function listCandidates(limit: number | null): CandidateRow[] {
  const db = getDb();
  const args: Array<number> = [];
  const limitClause = limit ? 'LIMIT ?' : '';
  if (limit) {
    args.push(limit);
  }

  return db
    .prepare(
      `
        SELECT
          v.id,
          v.video_id,
          v.platform,
          c.name AS channel_name,
          v.title,
          v.published_at,
          v.created_at
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        WHERE ${RELATIVE_PUBLISHED_AT_SQL}
        ORDER BY v.created_at DESC, v.id DESC
        ${limitClause}
      `,
    )
    .all(...args) as CandidateRow[];
}

function listRemaining(ids: number[]): CandidateRow[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');

  return db
    .prepare(
      `
        SELECT
          v.id,
          v.video_id,
          v.platform,
          c.name AS channel_name,
          v.title,
          v.published_at,
          v.created_at
        FROM videos v
        LEFT JOIN channels c ON c.id = v.channel_id
        WHERE v.id IN (${placeholders})
          AND ${RELATIVE_PUBLISHED_AT_SQL}
        ORDER BY v.created_at DESC, v.id DESC
      `,
    )
    .all(...ids) as CandidateRow[];
}

function printSample(rows: CandidateRow[], label: string): void {
  const sample = rows.slice(0, 10).map((row) => ({
    id: row.id,
    platform: row.platform,
    video_id: row.video_id,
    channel: row.channel_name ?? '',
    published_at: row.published_at ?? '',
    title: row.title ?? '',
  }));

  console.log(`${label}: ${rows.length}`);
  if (sample.length > 0) {
    console.table(sample);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = listCandidates(options.limit);

  printSample(candidates, 'Relative published_at candidates');

  if (candidates.length === 0) {
    return;
  }

  if (options.dryRun) {
    console.log('Dry run only. No repair requests were enqueued.');
    return;
  }

  ensureEnrichmentQueue();
  const pool = getEnrichmentQueue();

  for (const [index, row] of candidates.entries()) {
    await enrichVideo(row.id);
    if ((index + 1) % 25 === 0 || index === candidates.length - 1) {
      console.log(`Enqueued ${index + 1}/${candidates.length} repair jobs`);
    }
  }

  await pool.drain();

  const remaining = listRemaining(candidates.map((row) => row.id));
  const repairedCount = candidates.length - remaining.length;

  console.log(
    `Repair complete. repaired=${repairedCount} remaining=${remaining.length}`,
  );
  if (remaining.length > 0) {
    printSample(remaining, 'Remaining relative published_at rows');
  }

  pool.destroy();
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
