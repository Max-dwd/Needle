import fs from 'fs';
import path from 'path';
import { appEvents } from './events';
import type { LogEntryEvent } from './events';
import type {
  LogEntry,
  LogLevel,
  LogScope,
  LogScopeStats,
  LogStats,
} from '@/types';

const MAX_AGE_DAYS = 7;
const MAX_RECENT_ERRORS = 5;
const MAX_LOG_READ_BYTES = 128 * 1024;
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LOG_SCOPES: LogScope[] = [
  'feed',
  'subtitle',
  'summary',
  'api',
  'system',
  'enrichment',
  'agent',
];
const TRACKED_STATS_SCOPES = ['feed', 'subtitle', 'summary'] as const;

type TrackedStatsScope = (typeof TRACKED_STATS_SCOPES)[number];

interface LogQueryOptions {
  lines?: number;
  level?: LogLevel;
  scope?: LogScope;
  platform?: string;
}

interface LoggerState {
  buffer: LogEntry[];
  maxBufferSize: number;
  stats: LogStats;
  legacyApiWarned: boolean;
}

const globalKey = Symbol.for('folo:logger');

function getDataRoot(): string {
  return process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
}

function getLogDir(): string {
  return path.join(getDataRoot(), 'logs');
}

function ensureLogDir() {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

function getJsonLogFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}.jsonl`;
}

function isDebugEnabled(): boolean {
  return process.env.LOG_LEVEL === 'debug';
}

function emptyScopeStats(): LogScopeStats {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    fallbacks: 0,
    successRate: 0,
    byMethod: {},
    byPlatform: {},
    byErrorType: {},
    recentErrors: [],
  };
}

function createEmptyStats(): LogStats {
  return {
    total: 0,
    byLevel: {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    },
    byScope: {
      feed: 0,
      subtitle: 0,
      summary: 0,
      api: 0,
      system: 0,
      enrichment: 0,
      agent: 0,
    },
    feed: emptyScopeStats(),
    subtitle: emptyScopeStats(),
    summary: emptyScopeStats(),
  };
}

function cloneScopeStats(scope: LogScopeStats): LogScopeStats {
  return {
    attempts: scope.attempts,
    successes: scope.successes,
    failures: scope.failures,
    fallbacks: scope.fallbacks,
    successRate: scope.successRate,
    byMethod: Object.fromEntries(
      Object.entries(scope.byMethod).map(([name, stats]) => [
        name,
        { ...stats },
      ]),
    ),
    byPlatform: { ...scope.byPlatform },
    byErrorType: { ...scope.byErrorType },
    recentErrors: scope.recentErrors.map((error) => ({ ...error })),
  };
}

function createLoggerState(): LoggerState {
  return {
    buffer: [],
    maxBufferSize: 500,
    stats: createEmptyStats(),
    legacyApiWarned: false,
  };
}

function getLoggerState(): LoggerState {
  const g = globalThis as Record<symbol, LoggerState | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = createLoggerState();
  }
  return g[globalKey]!;
}

/**
 * Format a JSON log entry as a human-readable string for legacy clients.
 */
export function formatBufferedEntry(entry: LogEntry): string {
  const base = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.event}`;
  const extraKeys = Object.keys(entry).filter(
    (k) => !['ts', 'level', 'scope', 'event'].includes(k),
  );
  if (extraKeys.length === 0) return base;

  const pairs = extraKeys
    .map((k) => {
      const v = entry[k];
      if (typeof v === 'object' && v !== null) {
        return `${k}=${JSON.stringify(v)}`;
      }
      return `${k}=${String(v)}`;
    })
    .join(' ');
  return `${base} ${pairs}`;
}

function writeJsonLine(entry: LogEntry) {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    const filePath = path.join(getLogDir(), getJsonLogFileName());
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    // Logging should never throw
  }
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && LOG_LEVELS.includes(value as LogLevel);
}

function isLogScope(value: unknown): value is LogScope {
  return typeof value === 'string' && LOG_SCOPES.includes(value as LogScope);
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LogEntry>;
  return (
    typeof entry.ts === 'string' &&
    typeof entry.event === 'string' &&
    isLogLevel(entry.level) &&
    isLogScope(entry.scope)
  );
}

/**
 * Parses a persisted log line into its structured entry fields.
 * Tries JSON.parse first (for .jsonl), falls back to regex (for legacy .log).
 */
function parseLogLine(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line);
    if (isLogEntry(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON, fall through to regex
  }

  const match = line.match(
    /^\[([^\]]+)\] \[(DEBUG|INFO|WARN|ERROR)\] \[([a-z]+)\] (.*)$/i,
  );
  if (!match) return null;

  const [, timestamp, rawLevel, rawScope, message] = match;
  const level = rawLevel.toLowerCase() as LogLevel;
  const scope = rawScope.toLowerCase() as LogScope;
  if (!isLogScope(scope)) return null;

  const entry: LogEntry = {
    ts: timestamp,
    level,
    scope,
    event: message.split(' ')[0] || message,
    message,
  };

  Object.assign(entry, parseLogKV(message));
  return entry;
}

/**
 * Extracts `key=value` pairs from a log message for downstream filtering.
 */
function parseLogKV(message: string): Record<string, string> {
  const kv: Record<string, string> = {};
  const re = /(\w+)=((?:[^ =]| (?!\w+=))*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    kv[match[1]] = match[2].trim();
  }
  return kv;
}

function resolveEntryPlatform(entry: LogEntry): string | undefined {
  if (typeof entry.platform === 'string' && entry.platform) {
    return entry.platform;
  }
  if (typeof entry.message === 'string') {
    return parseLogKV(entry.message).platform;
  }
  return undefined;
}

function entryMatches(entry: LogEntry, options: LogQueryOptions): boolean {
  if (options.level && entry.level !== options.level) return false;
  if (options.scope && entry.scope !== options.scope) return false;
  if (options.platform && resolveEntryPlatform(entry) !== options.platform) {
    return false;
  }
  return true;
}

function filterEntries(entries: LogEntry[], options: LogQueryOptions): LogEntry[] {
  const maxLines = options.lines ?? 200;
  const output: LogEntry[] = [];

  for (const entry of entries) {
    if (output.length >= maxLines) break;
    if (!entryMatches(entry, options)) continue;
    output.push(entry);
  }

  return output;
}

function pushToBuffer(entry: LogEntry) {
  const state = getLoggerState();
  state.buffer.push(entry);
  if (state.buffer.length > state.maxBufferSize) {
    state.buffer.shift();
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

function updateSuccessRate(scopeStats: LogScopeStats) {
  const decided = scopeStats.successes + scopeStats.failures;
  scopeStats.successRate =
    decided > 0 ? Math.round((scopeStats.successes / decided) * 1000) / 10 : 0;
}

function updateStats(entry: LogEntry) {
  const state = getLoggerState();
  const stats = state.stats;
  const trackedScope = TRACKED_STATS_SCOPES.includes(entry.scope as TrackedStatsScope)
    ? (entry.scope as TrackedStatsScope)
    : null;

  stats.total += 1;
  stats.byLevel[entry.level] += 1;
  stats.byScope[entry.scope] += 1;

  if (!trackedScope) return;

  const scopeStats = stats[trackedScope];
  const action = entry.event.split(' ')[0];
  const method =
    typeof entry.method === 'string'
      ? entry.method
      : typeof entry.from === 'string'
        ? entry.from
        : 'unknown';
  const platform = resolveEntryPlatform(entry) || 'unknown';

  if (platform !== 'unknown') {
    scopeStats.byPlatform[platform] = (scopeStats.byPlatform[platform] || 0) + 1;
  }

  if (!scopeStats.byMethod[method]) {
    scopeStats.byMethod[method] = { attempts: 0, successes: 0, failures: 0 };
  }

  switch (action) {
    case 'attempt':
    case 'start':
      scopeStats.attempts += 1;
      scopeStats.byMethod[method].attempts += 1;
      break;
    case 'success':
      scopeStats.successes += 1;
      scopeStats.byMethod[method].successes += 1;
      break;
    case 'failure': {
      scopeStats.failures += 1;
      scopeStats.byMethod[method].failures += 1;
      const errorType =
        typeof entry.error_type === 'string' ? entry.error_type : 'unknown';
      scopeStats.byErrorType[errorType] =
        (scopeStats.byErrorType[errorType] || 0) + 1;
      scopeStats.recentErrors.unshift({
        time: formatTimestamp(entry.ts),
        method,
        platform,
        error:
          typeof entry.error === 'string'
            ? entry.error
            : typeof entry.message === 'string'
              ? entry.message
              : '',
        error_type: errorType,
      });
      scopeStats.recentErrors = scopeStats.recentErrors.slice(0, MAX_RECENT_ERRORS);
      break;
    }
    case 'fallback':
      scopeStats.fallbacks += 1;
      break;
    default:
      break;
  }

  updateSuccessRate(scopeStats);
}

function emitLogEntry(entry: LogEntry) {
  appEvents.emit('log:entry', entry satisfies LogEntryEvent);
}

function warnLegacyApiUsage() {
  const state = getLoggerState();
  if (state.legacyApiWarned || process.env.NODE_ENV !== 'development') return;
  state.legacyApiWarned = true;
  console.warn(
    '[logger] 2-arg logging API is deprecated. Use log.info(scope, event, fields).',
  );
}

function writeLog(
  level: LogLevel,
  scope: LogScope,
  event: string,
  extra: Record<string, unknown> = {},
) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...extra,
  };

  if (level !== 'debug' || isDebugEnabled()) {
    writeJsonLine(entry);
  }

  pushToBuffer(entry);
  updateStats(entry);
  emitLogEntry(entry);
}

export const log = {
  info(
    scope: LogScope,
    eventOrMessage: string,
    fieldsOrUndefined?: Record<string, unknown>,
  ): void {
    if (fieldsOrUndefined !== undefined) {
      writeLog('info', scope, eventOrMessage, fieldsOrUndefined);
      return;
    }

    warnLegacyApiUsage();
    writeLog('info', scope, 'message', { message: eventOrMessage });
  },

  warn(
    scope: LogScope,
    eventOrMessage: string,
    fieldsOrUndefined?: Record<string, unknown>,
  ): void {
    if (fieldsOrUndefined !== undefined) {
      writeLog('warn', scope, eventOrMessage, fieldsOrUndefined);
      return;
    }

    warnLegacyApiUsage();
    writeLog('warn', scope, 'message', { message: eventOrMessage });
  },

  error(
    scope: LogScope,
    eventOrMessage: string,
    fieldsOrUndefined?: Record<string, unknown>,
  ): void {
    if (fieldsOrUndefined !== undefined) {
      writeLog('error', scope, eventOrMessage, fieldsOrUndefined);
      return;
    }

    warnLegacyApiUsage();
    writeLog('error', scope, 'message', { message: eventOrMessage });
  },

  debug(
    scope: LogScope,
    event: string,
    fields?: Record<string, unknown>,
  ): void {
    if (isDebugEnabled()) {
      writeLog('debug', scope, event, fields || {});
    }
  },
};

export function getBufferedEntries(
  options: LogQueryOptions = {},
): LogEntry[] {
  const entries = [...getLoggerState().buffer].reverse();
  return filterEntries(entries, options);
}

/**
 * Reads recent structured log entries from disk.
 * Reads both .jsonl (new) and .log (legacy) files.
 */
export function readStructuredLogs(
  options: LogQueryOptions = {},
): LogEntry[] {
  const maxLines = options.lines ?? 200;

  try {
    ensureLogDir();
    const logDir = getLogDir();
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.log'))
      .sort()
      .reverse();

    const output: LogEntry[] = [];

    for (const file of files) {
      if (output.length >= maxLines) break;
      const content = readRecentLogFile(path.join(logDir, file));
      const lines = content.split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        if (output.length >= maxLines) break;

        const entry = parseLogLine(line);
        if (!entry || !entryMatches(entry, options)) continue;
        output.push(entry);
      }
    }

    return output;
  } catch {
    return [];
  }
}

function readRecentLogFile(filePath: string): string {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize <= MAX_LOG_READ_BYTES) {
    return fs.readFileSync(filePath, 'utf8');
  }

  const offset = fileSize - MAX_LOG_READ_BYTES;
  const buffer = Buffer.alloc(MAX_LOG_READ_BYTES);
  let fd: number | undefined;

  try {
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_LOG_READ_BYTES, offset);
    let content = buffer.toString('utf8', 0, bytesRead);
    const firstNewlineIndex = content.indexOf('\n');
    if (firstNewlineIndex === -1) {
      return '';
    }
    content = content.slice(firstNewlineIndex + 1);
    return content;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * @deprecated Prefer `readStructuredLogs()` and format at the edge when needed.
 */
export function readRecentLogs(options: LogQueryOptions = {}): string[] {
  return readStructuredLogs(options).map((entry) => formatBufferedEntry(entry));
}

export function getLogStats(): LogStats {
  const stats = getLoggerState().stats;
  return {
    total: stats.total,
    byLevel: { ...stats.byLevel },
    byScope: { ...stats.byScope },
    feed: cloneScopeStats(stats.feed),
    subtitle: cloneScopeStats(stats.subtitle),
    summary: cloneScopeStats(stats.summary),
  };
}

export { parseLogKV, parseLogLine };

/**
 * Removes daily log files older than the configured retention window.
 * Cleans up both .jsonl and .log files.
 */
export function cleanupOldLogs() {
  try {
    ensureLogDir();
    const logDir = getLogDir();
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.log'));
    for (const file of files) {
      const jsonlMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      const logMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      const dateMatch = jsonlMatch || logMatch;
      if (!dateMatch) continue;
      const fileDate = Date.parse(dateMatch[1]);
      if (Number.isFinite(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(path.join(logDir, file));
      }
    }
  } catch {
    // Cleanup should never throw
  }
}

export type { LogEntry, LogLevel, LogScope, LogStats };
