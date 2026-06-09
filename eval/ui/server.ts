#!/usr/bin/env tsx
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_ROOT = path.join(REPO_ROOT, 'eval');
const DATA_ROOT = path.join(EVAL_ROOT, 'data');
const RUNS_ROOT = path.join(EVAL_ROOT, 'runs');
const CONFIG_PATH = path.resolve(
  REPO_ROOT,
  process.env.EVAL_CONFIG || path.join('eval', 'config.local.yaml'),
);
const ADHOC_CONFIG_PATH = path.join(EVAL_ROOT, 'config.adhoc.yaml');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const BUILD_SCRIPT = path.join(EVAL_ROOT, 'build-golden-dataset.ts');
const RUN_SCRIPT = path.join(EVAL_ROOT, 'run-llm-aligner-eval.ts');
const GEMINI_SCRIPT = path.join(EVAL_ROOT, 'run-gemini-fallback-eval.ts');
const SUPPORTED_PIPELINES = new Set(['llm-aligner', 'gemini-fallback']);
const MAX_LOG_LINES = 4000;

function normalizePipeline(value: unknown): string {
  return typeof value === 'string' && SUPPORTED_PIPELINES.has(value)
    ? value
    : 'llm-aligner';
}

// Build the run step for a pipeline + case selection. The two CLIs differ:
// llm-aligner takes a single --case (or none = all config targets);
// gemini-fallback takes repeated --case and writes wherever --output-root says,
// so we point it at eval/runs/ to keep all runs visible in one dashboard.
function buildRunStep(
  pipeline: string,
  label: string,
  configRel: string,
  caseIds: string[],
): JobStep {
  if (pipeline === 'gemini-fallback') {
    return {
      label,
      script: GEMINI_SCRIPT,
      args: [
        '--config',
        configRel,
        ...caseIds.flatMap((id) => ['--case', id]),
        '--output-root',
        relativeToRepo(RUNS_ROOT),
      ],
    };
  }
  return {
    label,
    script: RUN_SCRIPT,
    args: [
      '--config',
      configRel,
      ...(caseIds.length === 1 ? ['--case', caseIds[0]!] : []),
    ],
  };
}

function readConfigCaseIds(configPath: string): string[] {
  const targets = readYamlObject(configPath)?.dataset?.targets;
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => (target && typeof target.id === 'string' ? target.id : ''))
    .filter((id): id is string => id.length > 0);
}

type EvalVideoPlatform = 'youtube' | 'bilibili';

interface EvalCaseSummary {
  id: string;
  tier?: string;
  difficulty?: string;
  platform?: string;
  videoId?: string;
  url?: string | null;
  title?: string | null;
  duration?: string | null;
  segmentCount?: number;
  note?: string | null;
  adhoc?: boolean;
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

type JobStatus = 'running' | 'completed' | 'failed';

interface JobStep {
  label: string;
  script: string;
  args: string[];
}

interface Job {
  id: string;
  kind: 'run' | 'run-all' | 'submit-url';
  caseId: string | null;
  status: JobStatus;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
  steps: JobStep[];
  stepIndex: number;
  log: string[];
  partial: string;
  child?: ChildProcessWithoutNullStreams;
}

const jobs = new Map<string, Job>();

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

Environment:
  EVAL_CONFIG     Eval config used for runs (default: eval/config.local.yaml)
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

function safeId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Cases & runs
// ---------------------------------------------------------------------------

function readAdhocCaseIds(): Set<string> {
  const config = readYamlObject(ADHOC_CONFIG_PATH);
  const targets = config?.dataset?.targets;
  if (!Array.isArray(targets)) return new Set();
  return new Set(
    targets
      .map((target) =>
        target && typeof target.id === 'string' ? target.id : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
}

function readCases(): EvalCaseSummary[] {
  const adhocIds = readAdhocCaseIds();
  const byId = new Map<string, EvalCaseSummary>();

  // Primary source: per-case metadata.json on disk (always reflects what is
  // actually evaluable, even when the manifest cases[] array is empty).
  const casesDir = path.join(DATA_ROOT, 'cases');
  if (fs.existsSync(casesDir)) {
    for (const entry of fs.readdirSync(casesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = path.join(casesDir, entry.name, 'metadata.json');
      const metadata = readJsonFile<Record<string, any>>(metadataPath);
      if (!metadata) continue;
      const video = (metadata.video || {}) as Record<string, any>;
      const golden = (metadata.golden || {}) as Record<string, any>;
      const id = typeof metadata.id === 'string' ? metadata.id : entry.name;
      byId.set(id, {
        id,
        tier: metadata.tier,
        difficulty: metadata.difficulty,
        platform: video.platform,
        videoId: video.videoId,
        url: video.url ?? null,
        title: video.title ?? null,
        duration: video.duration ?? null,
        segmentCount:
          typeof golden.segmentCount === 'number'
            ? golden.segmentCount
            : undefined,
        note: metadata.note ?? null,
        adhoc: adhocIds.has(id),
        metadataPath: relativeToRepo(metadataPath),
      });
    }
  }

  // Secondary source: manifest cases[] for anything not on disk yet.
  const manifest = readJsonFile<{ cases?: EvalCaseSummary[] }>(
    path.join(DATA_ROOT, 'manifest.json'),
  );
  if (Array.isArray(manifest?.cases)) {
    for (const entry of manifest.cases) {
      if (!entry?.id || byId.has(entry.id)) continue;
      byId.set(entry.id, { ...entry, adhoc: adhocIds.has(entry.id) });
    }
  }

  return Array.from(byId.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
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

function latestRunByCase(
  runs: EvalRunSummary[],
): Record<string, EvalRunSummary> {
  const latest: Record<string, EvalRunSummary> = {};
  for (const run of runs) {
    if (run.caseId && !latest[run.caseId]) latest[run.caseId] = run;
  }
  return latest;
}

function readSelectedRun(runId: string | null) {
  const safe = safeId(runId);
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
  const selectedRunId = safeId(requestedRunId) || runs[0]?.runId || null;
  return {
    dataset: {
      root: relativeToRepo(DATA_ROOT),
      manifestPath: relativeToRepo(path.join(DATA_ROOT, 'manifest.json')),
      configPath: relativeToRepo(CONFIG_PATH),
      configExists: fs.existsSync(CONFIG_PATH),
      cases: readCases(),
    },
    runs,
    latestRunByCase: latestRunByCase(runs),
    jobs: listJobSummaries(),
    selected: readSelectedRun(selectedRunId),
  };
}

// ---------------------------------------------------------------------------
// Ad-hoc config (URL submissions)
// ---------------------------------------------------------------------------

function readYamlObject(filePath: string): Record<string, any> | null {
  try {
    const parsed = parseYaml(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}

function parseVideoUrl(
  raw: string,
): { platform: EvalVideoPlatform; videoId: string } | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }

  if (url) {
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (id) return { platform: 'youtube', videoId: id };
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return { platform: 'youtube', videoId: v };
      const match = url.pathname.match(/\/(?:shorts|embed|v|live)\/([^/?#]+)/);
      if (match?.[1]) return { platform: 'youtube', videoId: match[1] };
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
      if (match?.[1]) return { platform: 'bilibili', videoId: match[1] };
    }
  }

  if (/^BV[0-9A-Za-z]+$/.test(trimmed)) {
    return { platform: 'bilibili', videoId: trimmed };
  }
  if (/^av\d+$/i.test(trimmed)) {
    return { platform: 'bilibili', videoId: trimmed };
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return { platform: 'youtube', videoId: trimmed };
  }
  return null;
}

interface AdhocSubmission {
  url: string;
  platform: EvalVideoPlatform;
  videoId: string;
  tier?: string;
  difficulty?: string;
  expectedLanguage?: string;
  note?: string;
}

function upsertAdhocTarget(input: AdhocSubmission): {
  id: string;
  configPath: string;
} {
  const base = readYamlObject(CONFIG_PATH);
  if (!base) {
    throw new Error(
      `cannot read base config ${relativeToRepo(CONFIG_PATH)}; copy eval/config.example.yaml first`,
    );
  }
  const baseDataset =
    base.dataset && typeof base.dataset === 'object' ? base.dataset : {};

  const id = `adhoc-${input.platform}-${input.videoId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const tier = ['short', 'medium', 'long'].includes(input.tier || '')
    ? input.tier
    : 'short';
  const difficulty = ['normal', 'hard'].includes(input.difficulty || '')
    ? input.difficulty
    : 'normal';
  const target: Record<string, unknown> = {
    id,
    tier,
    difficulty,
    platform: input.platform,
    videoId: input.videoId,
    url: input.url,
    note:
      input.note?.trim() ||
      `Ad-hoc ${input.platform} video submitted from the dashboard`,
    ...(input.expectedLanguage?.trim()
      ? { expectedLanguage: input.expectedLanguage.trim() }
      : {}),
  };

  const existingTargets = Array.isArray(
    readYamlObject(ADHOC_CONFIG_PATH)?.dataset?.targets,
  )
    ? (readYamlObject(ADHOC_CONFIG_PATH)!.dataset.targets as Record<
        string,
        unknown
      >[])
    : [];
  const targets = [
    ...existingTargets.filter((entry) => entry?.id !== id),
    target,
  ];

  // Ad-hoc runs reuse the curated config's model/pipeline/aligner settings, but
  // stay lenient (no manual-caption / language requirement) so user videos with
  // auto captions still produce a golden reference.
  const merged = {
    dataset: {
      outputDir: baseDataset.outputDir ?? 'eval/data',
      requireManualCaptions: false,
      live: baseDataset.live ?? {
        metadata: true,
        subtitles: true,
        audio: true,
      },
      targets,
    },
    model: base.model,
    pipeline: base.pipeline,
    aligner: base.aligner,
    run: base.run,
    ...(base.qualityGate ? { qualityGate: base.qualityGate } : {}),
  };

  fs.writeFileSync(ADHOC_CONFIG_PATH, stringifyYaml(merged), 'utf8');
  return { id, configPath: ADHOC_CONFIG_PATH };
}

// ---------------------------------------------------------------------------
// Job runner (spawns the existing tsx CLIs)
// ---------------------------------------------------------------------------

function jobSummary(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    caseId: job.caseId,
    status: job.status,
    createdAt: job.createdAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    stepIndex: job.stepIndex,
    stepCount: job.steps.length,
    stepLabel: job.steps[job.stepIndex]?.label ?? null,
    logLength: job.log.length,
  };
}

function listJobSummaries() {
  return Array.from(jobs.values())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
    .map(jobSummary);
}

function pushLine(job: Job, line: string): void {
  job.log.push(line);
  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

function appendChunk(job: Job, chunk: string): void {
  const text = job.partial + chunk;
  const parts = text.split('\n');
  job.partial = parts.pop() ?? '';
  for (const line of parts) pushLine(job, line);
}

function spawnStep(job: Job, step: JobStep): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [step.script, ...step.args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    job.child = child;
    child.stdout.on('data', (data) => appendChunk(job, data.toString()));
    child.stderr.on('data', (data) => appendChunk(job, data.toString()));
    child.on('error', (error) => {
      pushLine(job, `[spawn error] ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      if (job.partial) {
        pushLine(job, job.partial);
        job.partial = '';
      }
      resolve(code ?? 0);
    });
  });
}

async function executeJob(job: Job): Promise<void> {
  for (let index = 0; index < job.steps.length; index += 1) {
    job.stepIndex = index;
    const step = job.steps[index]!;
    pushLine(job, `\n[step ${index + 1}/${job.steps.length}] ${step.label}`);
    pushLine(
      job,
      `$ tsx ${path.relative(REPO_ROOT, step.script)} ${step.args.join(' ')}`,
    );
    const code = await spawnStep(job, step);
    if (code !== 0) {
      job.status = 'failed';
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      pushLine(job, `[failed] step exited with code ${code}`);
      return;
    }
  }
  job.status = 'completed';
  job.exitCode = 0;
  job.endedAt = new Date().toISOString();
  pushLine(job, '[done] all steps completed');
}

function startJob(
  kind: Job['kind'],
  caseId: string | null,
  steps: JobStep[],
): Job {
  const job: Job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    caseId,
    status: 'running',
    createdAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    steps,
    stepIndex: 0,
    log: [],
    partial: '',
  };
  jobs.set(job.id, job);
  void executeJob(job);
  return job;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleJobsGet(url: URL, res: http.ServerResponse): void {
  const id = url.searchParams.get('id');
  if (!id) {
    sendJson(res, 200, { jobs: listJobSummaries() });
    return;
  }
  const job = jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: 'job not found' });
    return;
  }
  const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
  sendJson(res, 200, {
    ...jobSummary(job),
    since,
    nextSince: job.log.length,
    log: job.log.slice(since),
  });
}

async function handleRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const caseId = safeId(typeof body.caseId === 'string' ? body.caseId : null);
  if (!caseId) {
    sendJson(res, 400, { error: 'caseId is required' });
    return;
  }
  const isAdhoc = readAdhocCaseIds().has(caseId);
  const configPath = isAdhoc ? ADHOC_CONFIG_PATH : CONFIG_PATH;
  if (!fs.existsSync(configPath)) {
    sendJson(res, 400, {
      error: `config not found: ${relativeToRepo(configPath)}`,
    });
    return;
  }
  const pipeline = normalizePipeline(body.pipeline);
  const job = startJob('run', caseId, [
    buildRunStep(
      pipeline,
      `Run case ${caseId} (${pipeline})`,
      relativeToRepo(configPath),
      [caseId],
    ),
  ]);
  sendJson(res, 202, { jobId: job.id, ...jobSummary(job) });
}

async function handleRunAll(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!fs.existsSync(CONFIG_PATH)) {
    sendJson(res, 400, {
      error: `config not found: ${relativeToRepo(CONFIG_PATH)}`,
    });
    return;
  }
  const pipeline = normalizePipeline(body.pipeline);
  // llm-aligner enumerates config targets itself; gemini-fallback needs the ids
  // passed explicitly as repeated --case.
  const caseIds =
    pipeline === 'gemini-fallback' ? readConfigCaseIds(CONFIG_PATH) : [];
  const job = startJob('run-all', null, [
    buildRunStep(
      pipeline,
      `Run all golden cases (${pipeline})`,
      relativeToRepo(CONFIG_PATH),
      caseIds,
    ),
  ]);
  sendJson(res, 202, { jobId: job.id, ...jobSummary(job) });
}

async function handleSubmitUrl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const url = typeof body.url === 'string' ? body.url : '';
  const parsed = parseVideoUrl(url);
  if (!parsed) {
    sendJson(res, 400, {
      error: 'could not parse a YouTube or Bilibili video URL',
    });
    return;
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    sendJson(res, 400, {
      error: `base config not found: ${relativeToRepo(CONFIG_PATH)}`,
    });
    return;
  }

  const { id } = upsertAdhocTarget({
    url: url.trim(),
    platform: parsed.platform,
    videoId: parsed.videoId,
    tier: typeof body.tier === 'string' ? body.tier : undefined,
    difficulty:
      typeof body.difficulty === 'string' ? body.difficulty : undefined,
    expectedLanguage:
      typeof body.expectedLanguage === 'string'
        ? body.expectedLanguage
        : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  });

  const pipeline = normalizePipeline(body.pipeline);
  const adhocConfigRel = relativeToRepo(ADHOC_CONFIG_PATH);
  const job = startJob('submit-url', id, [
    {
      label: `Build golden reference for ${id}`,
      script: BUILD_SCRIPT,
      args: ['--config', adhocConfigRel, '--case', id],
    },
    buildRunStep(
      pipeline,
      `Run pipeline for ${id} (${pipeline})`,
      adhocConfigRel,
      [id],
    ),
  ]);
  sendJson(res, 202, {
    ...jobSummary(job),
    jobId: job.id,
    platform: parsed.platform,
    videoId: parsed.videoId,
  });
}

// Remove a case target from a YAML config while preserving comments/formatting.
function removeTargetFromConfig(configPath: string, caseId: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  let doc;
  try {
    doc = parseDocument(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return false;
  }
  const targets = doc.getIn(['dataset', 'targets']) as
    | { items?: unknown[] }
    | undefined;
  if (!targets || !Array.isArray(targets.items)) return false;
  const before = targets.items.length;
  targets.items = targets.items.filter((item) => {
    const id =
      item && typeof (item as { get?: unknown }).get === 'function'
        ? (item as { get: (k: string) => unknown }).get('id')
        : (item as { id?: unknown })?.id;
    return id !== caseId;
  });
  if (targets.items.length === before) return false;
  fs.writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

function removeCaseFromManifest(caseId: string): boolean {
  const manifestPath = path.join(DATA_ROOT, 'manifest.json');
  const manifest = readJsonFile<{ cases?: Array<{ id?: string }> }>(
    manifestPath,
  );
  if (!manifest || !Array.isArray(manifest.cases)) return false;
  const before = manifest.cases.length;
  manifest.cases = manifest.cases.filter((entry) => entry?.id !== caseId);
  if (manifest.cases.length === before) return false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return true;
}

function removeRunsForCase(caseId: string): number {
  if (!fs.existsSync(RUNS_ROOT)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(RUNS_ROOT)) {
    const dir = path.join(RUNS_ROOT, name);
    if (!dir.startsWith(RUNS_ROOT) || !fs.statSync(dir).isDirectory()) continue;
    if (summarizeRun(dir)?.caseId === caseId) {
      fs.rmSync(dir, { recursive: true, force: true });
      count += 1;
    }
  }
  return count;
}

async function handleDeleteCase(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const caseId = safeId(typeof body.caseId === 'string' ? body.caseId : null);
  if (!caseId) {
    sendJson(res, 400, { error: 'caseId is required' });
    return;
  }
  const casesRoot = path.join(DATA_ROOT, 'cases');
  const caseDir = path.join(casesRoot, caseId);
  const removed = {
    caseDir: false,
    manifest: false,
    configLocal: false,
    configAdhoc: false,
    runs: 0,
  };
  if (caseDir.startsWith(casesRoot + path.sep) && fs.existsSync(caseDir)) {
    fs.rmSync(caseDir, { recursive: true, force: true });
    removed.caseDir = true;
  }
  removed.manifest = removeCaseFromManifest(caseId);
  removed.configLocal = removeTargetFromConfig(CONFIG_PATH, caseId);
  removed.configAdhoc = removeTargetFromConfig(ADHOC_CONFIG_PATH, caseId);
  removed.runs = removeRunsForCase(caseId);
  sendJson(res, 200, { ok: true, caseId, removed });
}

async function main() {
  const { port, host } = parseArgs(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', `http://${host}:${port}`);
        const method = req.method || 'GET';

        if (url.pathname === '/api/artifacts') {
          if (method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          sendJson(res, 200, buildArtifactPayload(url));
          return;
        }
        if (url.pathname === '/api/jobs') {
          if (method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          handleJobsGet(url, res);
          return;
        }
        if (url.pathname === '/api/run') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          await handleRun(req, res);
          return;
        }
        if (url.pathname === '/api/run-all') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          await handleRunAll(req, res);
          return;
        }
        if (url.pathname === '/api/submit-url') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          await handleSubmitUrl(req, res);
          return;
        }
        if (url.pathname === '/api/delete-case') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          await handleDeleteCase(req, res);
          return;
        }
        serveStatic(url.pathname, res);
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  server.listen(port, host, () => {
    console.log(`Needle eval UI: http://${host}:${port}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
