#!/usr/bin/env tsx
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_ROOT = path.join(REPO_ROOT, 'eval');
const DATA_ROOT = path.join(EVAL_ROOT, 'data');
const RUNS_ROOT = path.join(EVAL_ROOT, 'runs');

interface EvalCaseSummary {
  id: string;
  tier?: string;
  difficulty?: string;
  platform?: string;
  videoId?: string;
  title?: string | null;
  duration?: string | null;
  segmentCount?: number;
  goldenJsonPath?: string;
  metadataPath?: string;
  audioPath?: string | null;
}

interface EvalRunSummary {
  id: string;
  runId: string;
  path: string;
  status: 'completed' | 'failed' | 'unknown';
  pipeline: string;
  caseId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  quality?: unknown;
  qualityGateResult?: unknown;
  summary?: unknown;
  phaseTiming?: unknown;
  error?: string;
}

function parseArgs(argv: string[]): { port: number; host: string } {
  let port = Number(process.env.EVAL_UI_PORT || 4173);
  let host = process.env.EVAL_UI_HOST || '127.0.0.1';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--port':
      case '-p':
        port = Number(next());
        break;
      case '--host':
        host = next();
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return { port, host };
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:ui

Options:
  --port <port>   Port to listen on (default: EVAL_UI_PORT or 4173)
  --host <host>   Host to bind (default: EVAL_UI_HOST or 127.0.0.1)
`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function relativeToRepo(filePath: string): string {
  return path.relative(REPO_ROOT, filePath) || '.';
}

function safeRunId(value: string | null): string | null {
  if (!value) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) return null;
  return value;
}

function readCases(): EvalCaseSummary[] {
  const manifestPath = path.join(DATA_ROOT, 'manifest.json');
  const manifest = readJsonFile<{ cases?: EvalCaseSummary[] }>(manifestPath);
  return Array.isArray(manifest?.cases) ? manifest.cases : [];
}

function summarizeRun(runDir: string): EvalRunSummary | null {
  const runJsonPath = path.join(runDir, 'run.json');
  const metricsPath = path.join(runDir, 'metrics.json');
  const errorPath = path.join(runDir, 'error.json');
  const runJson = readJsonFile<Record<string, unknown>>(runJsonPath);
  const metrics = readJsonFile<Record<string, unknown>>(metricsPath);
  const error = readJsonFile<{ error?: string }>(errorPath);
  const source = runJson || metrics;
  if (!source && !error) return null;

  const runId = path.basename(runDir);
  const caseRecord = source?.case as Record<string, unknown> | null | undefined;
  const status =
    source?.status === 'completed' || source?.status === 'failed'
      ? source.status
      : error
        ? 'failed'
        : 'unknown';

  return {
    id: typeof source?.id === 'string' ? source.id : runId,
    runId,
    path: relativeToRepo(runDir),
    status,
    pipeline:
      typeof source?.pipeline === 'string' ? source.pipeline : 'llm-aligner',
    caseId:
      typeof caseRecord?.id === 'string'
        ? caseRecord.id
        : typeof metrics?.id === 'string'
          ? metrics.id
          : null,
    startedAt: typeof source?.startedAt === 'string' ? source.startedAt : null,
    completedAt:
      typeof source?.completedAt === 'string' ? source.completedAt : null,
    durationMs:
      typeof source?.durationMs === 'number' ? source.durationMs : null,
    quality: source?.quality || metrics?.quality,
    qualityGateResult: source?.qualityGateResult || metrics?.qualityGateResult,
    summary: source?.summary || metrics?.summary,
    phaseTiming: source?.phaseTiming || metrics?.phaseTiming,
    error:
      typeof source?.error === 'string'
        ? source.error
        : typeof error?.error === 'string'
          ? error.error
          : undefined,
  };
}

function listRuns(): EvalRunSummary[] {
  if (!fs.existsSync(RUNS_ROOT)) return [];
  return fs
    .readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => summarizeRun(path.join(RUNS_ROOT, entry.name)))
    .filter((entry): entry is EvalRunSummary => Boolean(entry))
    .sort((left, right) =>
      String(right.completedAt || right.runId).localeCompare(
        String(left.completedAt || left.runId),
      ),
    );
}

function readSelectedRun(runId: string | null) {
  const safe = safeRunId(runId);
  if (!safe) return null;
  const runDir = path.join(RUNS_ROOT, safe);
  if (!runDir.startsWith(RUNS_ROOT) || !fs.existsSync(runDir)) return null;
  return {
    run: summarizeRun(runDir),
    metrics: readJsonFile(path.join(runDir, 'metrics.json')),
    subtitle: readJsonFile(path.join(runDir, 'subtitle.json')),
    alignment: readJsonFile(path.join(runDir, 'alignment.json')),
    error: readJsonFile(path.join(runDir, 'error.json')),
  };
}

function buildArtifactPayload(url: URL) {
  const runs = listRuns();
  const requestedRunId = url.searchParams.get('run');
  const selectedRunId = safeRunId(requestedRunId) || runs[0]?.runId || null;
  return {
    dataset: {
      root: relativeToRepo(DATA_ROOT),
      manifestPath: relativeToRepo(path.join(DATA_ROOT, 'manifest.json')),
      cases: readCases(),
    },
    runs,
    selected: readSelectedRun(selectedRunId),
  };
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(reqPath: string, res: http.ServerResponse) {
  const pathName = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.resolve(__dirname, `.${pathName}`);
  if (!filePath.startsWith(__dirname)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
  res.writeHead(200, { 'content-type': mimeType });
  fs.createReadStream(filePath).pipe(res);
}

async function main() {
  const { port, host } = parseArgs(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      if (url.pathname === '/api/artifacts') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        sendJson(res, 200, buildArtifactPayload(url));
        return;
      }
      serveStatic(url.pathname, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, host, () => {
    console.log(`Needle eval UI: http://${host}:${port}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
