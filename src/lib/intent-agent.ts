import fs from 'fs';
import path from 'path';
import { getDb, type Intent, type Video } from './db';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const AGENT_ARTIFACT_ROOT = path.join(DATA_ROOT, 'agent-artifacts');
const SUBTITLE_ROOT =
  process.env.SUBTITLE_ROOT || path.join(DATA_ROOT, 'subtitles');

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** Ensure resolved path stays within the allowed root directory. */
function assertSafePath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path traversal blocked: ${segments.join('/')}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Shared subtitle parsing
// ---------------------------------------------------------------------------

/** Parse raw subtitle JSON into plain text. Returns null on failure. */
export function parseSubtitleJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((s: { text?: string }) => s.text || '').join('\n');
    }
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.text === 'string') return parsed.text;
      if (Array.isArray(parsed.segments)) {
        return (parsed.segments as { text?: string }[]).map(s => s.text || '').join('\n');
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact storage
// ---------------------------------------------------------------------------

const MAX_ARTIFACT_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_INTENT_NAME_LENGTH = 100;

function ensureArtifactDir(intentName: string): string {
  const dir = assertSafePath(AGENT_ARTIFACT_ROOT, intentName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveArtifact(
  intentName: string,
  filename: string,
  content: string,
): string {
  if (intentName.length > MAX_INTENT_NAME_LENGTH) {
    throw new Error(`Intent name too long (max ${MAX_INTENT_NAME_LENGTH} chars)`);
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new Error(`Artifact content too large (max ${MAX_ARTIFACT_CONTENT_BYTES} bytes)`);
  }
  const dir = ensureArtifactDir(intentName);
  const filePath = assertSafePath(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function listArtifacts(
  intentName: string,
): Array<{ filename: string; mtime: string; sizeBytes: number }> {
  const dir = assertSafePath(AGENT_ARTIFACT_ROOT, intentName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, mtime: stat.mtime.toISOString(), sizeBytes: stat.size };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function readArtifact(
  intentName: string,
  filename: string,
): string | null {
  const filePath = assertSafePath(AGENT_ARTIFACT_ROOT, intentName, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/** Remove all artifacts for the given intent name. */
export function removeArtifactDir(intentName: string): void {
  const dir = assertSafePath(AGENT_ARTIFACT_ROOT, intentName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Agent context — provides intent metadata + videos + subtitles
// ---------------------------------------------------------------------------

export interface AgentVideoContext {
  id: number;
  video_id: string;
  platform: string;
  title: string | null;
  channel_name: string | null | undefined;
  published_at: string | null;
  duration: string | number | null;
  subtitle_status: string | null;
  subtitle_text: string | null;
  has_summary: boolean;
}

export interface AgentContext {
  intent: {
    id: number;
    name: string;
    agent_prompt: string | null;
    agent_trigger: string | null;
    agent_schedule_time: string;
    agent_memory: string | null;
  };
  videos: AgentVideoContext[];
  artifacts: Array<{ filename: string; mtime: string; sizeBytes: number }>;
}

export function getAgentContext(
  intentId: number,
  options?: {
    days?: number;
    limit?: number;
    includeSubtitles?: boolean;
  },
): AgentContext | null {
  const db = getDb();
  const intent = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(intentId) as Intent | undefined;
  if (!intent) return null;

  const days = options?.days ?? 7;
  const limit = options?.limit ?? 50;
  const includeSubtitles = options?.includeSubtitles ?? true;

  const videos = db
    .prepare(
      `SELECT v.id, v.video_id, v.platform, v.title, v.channel_name,
              v.published_at, v.duration, v.subtitle_status, v.subtitle_path
       FROM videos v
       JOIN channels c ON v.channel_id = c.id
       WHERE c.intent = ?
         AND v.published_at >= datetime('now', ?)
       ORDER BY v.published_at DESC
       LIMIT ?`,
    )
    .all(intent.name, `-${days} days`, limit) as Array<
    Video & { subtitle_path: string | null }
  >;

  const videoContexts: AgentVideoContext[] = videos.map((v) => {
    let subtitleText: string | null = null;
    if (includeSubtitles && v.subtitle_path) {
      const fullPath = path.isAbsolute(v.subtitle_path)
        ? v.subtitle_path
        : path.join(SUBTITLE_ROOT, v.subtitle_path);
      try {
        subtitleText = parseSubtitleJson(fs.readFileSync(fullPath, 'utf-8'));
      } catch {
        // subtitle file missing or unreadable
      }
    }

    const summaryPath = path.join(
      DATA_ROOT,
      'summaries',
      v.platform,
      `${v.video_id}.md`,
    );
    const hasSummary = fs.existsSync(summaryPath);

    return {
      id: v.id,
      video_id: v.video_id,
      platform: v.platform,
      title: v.title,
      channel_name: v.channel_name,
      published_at: v.published_at,
      duration: v.duration,
      subtitle_status: v.subtitle_status,
      subtitle_text: subtitleText,
      has_summary: hasSummary,
    };
  });

  return {
    intent: {
      id: intent.id,
      name: intent.name,
      agent_prompt: intent.agent_prompt,
      agent_trigger: intent.agent_trigger,
      agent_schedule_time: intent.agent_schedule_time,
      agent_memory: intent.agent_memory,
    },
    videos: videoContexts,
    artifacts: listArtifacts(intent.name),
  };
}

// ---------------------------------------------------------------------------
// Video search across intents
// ---------------------------------------------------------------------------

export function searchVideos(query: {
  keyword?: string;
  platform?: string;
  intentName?: string;
  days?: number;
  limit?: number;
}): Array<{
  id: number;
  video_id: string;
  platform: string;
  title: string;
  channel_name: string | null;
  intent: string | null;
  published_at: string | null;
}> {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.keyword) {
    conditions.push(`v.title LIKE ?`);
    params.push(`%${query.keyword}%`);
  }
  if (query.platform) {
    conditions.push(`v.platform = ?`);
    params.push(query.platform);
  }
  if (query.intentName) {
    conditions.push(`c.intent = ?`);
    params.push(query.intentName);
  }
  if (query.days) {
    conditions.push(`v.published_at >= datetime('now', ?)`);
    params.push(`-${query.days} days`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = query.limit ?? 20;

  return db
    .prepare(
      `SELECT v.id, v.video_id, v.platform, v.title, v.channel_name, c.intent, v.published_at
       FROM videos v
       LEFT JOIN channels c ON v.channel_id = c.id
       ${where}
       ORDER BY v.published_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    video_id: string;
    platform: string;
    title: string;
    channel_name: string | null;
    intent: string | null;
    published_at: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Read single subtitle
// ---------------------------------------------------------------------------

export function readSubtitleText(
  platform: string,
  videoId: string,
): string | null {
  const db = getDb();
  const video = db
    .prepare(
      `SELECT subtitle_path FROM videos WHERE video_id = ? AND platform = ?`,
    )
    .get(videoId, platform) as { subtitle_path: string | null } | undefined;

  if (!video?.subtitle_path) return null;

  const fullPath = path.isAbsolute(video.subtitle_path)
    ? video.subtitle_path
    : path.join(SUBTITLE_ROOT, video.subtitle_path);

  try {
    return parseSubtitleJson(fs.readFileSync(fullPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory update
// ---------------------------------------------------------------------------

export function updateAgentMemory(
  intentId: number,
  memory: string,
): boolean {
  const db = getDb();
  const result = db
    .prepare(`UPDATE intents SET agent_memory = ? WHERE id = ?`)
    .run(memory, intentId);
  return result.changes > 0;
}
