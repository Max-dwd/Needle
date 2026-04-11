import fs from 'fs';
import path from 'path';

export interface PipedComment {
  author?: string;
  thumbnail?: string;
  commentId?: string;
  commentText?: string;
  commentedTime?: string;
  commentorUrl?: string;
  repliesPage?: string;
  likeCount?: number;
  replyCount?: number;
  hearted?: boolean;
  pinned?: boolean;
  verified?: boolean;
  creatorReplied?: boolean;
  channelOwner?: boolean;
}

interface PipedCommentsPage {
  comments?: PipedComment[];
  nextpage?: string | null;
}

interface InstanceCache {
  expiresAt: number;
  discovered: string[];
  effective: string[];
}

interface PipedResponse<T> {
  instance: string;
  data: T;
}

const DEFAULT_PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://api.piped.yt',
  'https://pipedapi.adminforge.de',
];

const PUBLIC_INSTANCES_SOURCE =
  process.env.PIPED_INSTANCES_SOURCE_URL ||
  'https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md';
const INSTANCES_FILE =
  process.env.PIPED_INSTANCES_FILE ||
  path.join(process.cwd(), 'data', 'piped-instances.json');
const REQUEST_TIMEOUT_MS =
  Number.parseInt(process.env.PIPED_REQUEST_TIMEOUT_MS || '', 10) || 8000;
const CACHE_MS =
  Number.parseInt(process.env.PIPED_INSTANCES_CACHE_MS || '', 10) ||
  15 * 60 * 1000;

let cache: InstanceCache | null = null;
let lastWorkingInstance: string | null = null;
let lastError: string | null = null;

const INSTANCE_BLOCKLIST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const instanceBlocklist = new Map<string, number>();

function isInstanceBlocked(instance: string): boolean {
  const blockUntil = instanceBlocklist.get(instance);
  if (blockUntil === undefined) return false;
  if (Date.now() >= blockUntil) {
    instanceBlocklist.delete(instance);
    return false;
  }
  return true;
}

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

function dedupInstances(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const normalized = normalizeBase(item);
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://'))
      continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseEnvInstances(): string[] {
  const raw = process.env.PIPED_API_BASES || '';
  if (!raw.trim()) return [];
  return dedupInstances(
    raw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function readLocalInstances(): string[] {
  if (!fs.existsSync(INSTANCES_FILE)) return [];
  try {
    const raw = fs.readFileSync(INSTANCES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as string[] | { instances?: string[] };
    if (Array.isArray(parsed)) return dedupInstances(parsed);
    return dedupInstances(
      Array.isArray(parsed.instances) ? parsed.instances : [],
    );
  } catch {
    return [];
  }
}

function parseInstancesFromMarkdown(markdown: string): string[] {
  const list: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/\|\s*(https?:\/\/[^\s|]+)\s*\|/);
    if (match?.[1]) list.push(match[1]);
  }
  return dedupInstances(list);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverInstances(): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      PUBLIC_INSTANCES_SOURCE,
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const text = await res.text();
    return parseInstancesFromMarkdown(text);
  } catch {
    return [];
  }
}

async function getInstancePool(): Promise<InstanceCache> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache;

  const discovered = await discoverInstances();
  const effective = dedupInstances([
    ...parseEnvInstances(),
    ...readLocalInstances(),
    ...discovered,
    ...DEFAULT_PIPED_INSTANCES,
  ]);

  cache = {
    expiresAt: now + CACHE_MS,
    discovered,
    effective,
  };
  return cache;
}

function buildUrl(
  base: string,
  endpoint: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const pathPart = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = new URL(`${base}${pathPart}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function pipedRequest<T>(
  endpoint: string,
  query?: Record<string, string | number | boolean | undefined>,
  opts?: { preferredInstance?: string; timeoutMs?: number },
): Promise<PipedResponse<T>> {
  const timeoutMs = opts?.timeoutMs || REQUEST_TIMEOUT_MS;
  const pool = await getInstancePool();
  const preferred = opts?.preferredInstance
    ? normalizeBase(opts.preferredInstance)
    : '';

  // Build ordered list, filtering out blocked instances
  const allOrdered = dedupInstances([
    preferred,
    lastWorkingInstance || '',
    ...pool.effective,
  ]);

  // Filter to only non-blocked instances
  const nonBlockedInstances = allOrdered.filter(
    (inst) => !isInstanceBlocked(inst),
  );

  // Fast-fail if all instances are blocked
  if (nonBlockedInstances.length === 0) {
    lastError = 'All Piped instances are temporarily blocked';
    throw new Error(
      'All Piped instances are temporarily blocked (5-min cooldown after failures)',
    );
  }

  // Limit to max 3 attempts
  const order = nonBlockedInstances.slice(0, 3);
  const errors: string[] = [];

  for (const instance of order) {
    try {
      const res = await fetchWithTimeout(
        buildUrl(instance, endpoint, query),
        timeoutMs,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as T;
      lastWorkingInstance = instance;
      lastError = null;
      return { instance, data };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${instance}: ${msg}`);
      // Block failed instance for 5 minutes
      instanceBlocklist.set(
        instance,
        Date.now() + INSTANCE_BLOCKLIST_DURATION_MS,
      );
    }
  }

  lastError = errors.join(' | ');
  throw new Error(`All Piped instances failed. ${lastError}`);
}

export async function getPipedComments(
  videoId: string,
  limit = 30,
): Promise<PipedResponse<PipedComment[]>> {
  const first = await pipedRequest<PipedCommentsPage>(
    `/comments/${encodeURIComponent(videoId)}`,
    undefined,
    {
      timeoutMs: 12000,
    },
  );
  const acc = Array.isArray(first.data.comments)
    ? [...first.data.comments]
    : [];
  let nextpage = first.data.nextpage || '';
  let instance = first.instance;

  while (acc.length < limit && nextpage) {
    try {
      const next = await pipedRequest<PipedCommentsPage>(
        `/nextpage/comments/${encodeURIComponent(videoId)}`,
        { nextpage },
        { preferredInstance: instance, timeoutMs: 12000 },
      );
      instance = next.instance;
      const comments = Array.isArray(next.data.comments)
        ? next.data.comments
        : [];
      acc.push(...comments);
      nextpage = next.data.nextpage || '';
    } catch {
      break;
    }
  }

  return {
    instance,
    data: acc.slice(0, Math.max(1, limit)),
  };
}
