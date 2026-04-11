import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  getBufferedEntries,
  getLogStats,
  parseLogKV,
  parseLogLine,
  readStructuredLogs,
  readRecentLogs,
  log,
  cleanupOldLogs,
  type LogEntry,
} from '@/lib/logger';

function resetLoggerState() {
  (globalThis as Record<symbol, unknown>)[Symbol.for('folo:logger')] = undefined;
}

describe('parseLogKV', () => {
  it('parses simple key value pairs', () => {
    expect(parseLogKV('platform=youtube video=abc123')).toEqual({
      platform: 'youtube',
      video: 'abc123',
    });
  });

  it('keeps quoted and spaced values together', () => {
    expect(
      parseLogKV('title="Hello World" detail=with spaces status=done'),
    ).toEqual({
      title: '"Hello World"',
      detail: 'with spaces',
      status: 'done',
    });
  });

  it('returns an empty object for empty strings', () => {
    expect(parseLogKV('')).toEqual({});
  });

  it('ignores malformed segments without key value syntax', () => {
    expect(parseLogKV('just words without equals')).toEqual({});
  });
});

describe('parseLogLine', () => {
  describe('JSONL format', () => {
    it('parses a valid JSONL line into structured fields', () => {
      const jsonlLine = JSON.stringify({
        ts: '2026-03-23T12:00:00.000Z',
        level: 'info',
        scope: 'feed',
        event: 'attempt',
        platform: 'youtube',
        method: 'piped',
      });
      const result = parseLogLine(jsonlLine);
      expect(result).toEqual({
        ts: '2026-03-23T12:00:00.000Z',
        level: 'info',
        scope: 'feed',
        event: 'attempt',
        platform: 'youtube',
        method: 'piped',
      });
    });

    it('parses JSONL with all standard fields', () => {
      const jsonlLine = JSON.stringify({
        ts: '2026-03-26T21:47:35.432Z',
        level: 'warn',
        scope: 'subtitle',
        event: 'fallback',
        platform: 'youtube',
        target: 'w17fCuU6ZEk',
        duration_ms: 1234,
        method: 'browser',
        fallback_to: 'piped',
        reason: 'No captions available',
        circuit_breaker: 'closed',
        attempt_index: 1,
        run_id: 'crawl-1711489655',
      });
      const result = parseLogLine(jsonlLine);
      expect(result?.ts).toBe('2026-03-26T21:47:35.432Z');
      expect(result?.level).toBe('warn');
      expect(result?.scope).toBe('subtitle');
      expect(result?.event).toBe('fallback');
      expect(result?.platform).toBe('youtube');
      expect(result?.target).toBe('w17fCuU6ZEk');
      expect(result?.duration_ms).toBe(1234);
      expect(result?.method).toBe('browser');
    });

    it('returns null for invalid JSON', () => {
      expect(parseLogLine('not valid json {')).toBeNull();
    });

    it('returns null for JSON without required fields', () => {
      expect(parseLogLine(JSON.stringify({ ts: '123', level: 'info' }))).toBeNull();
    });
  });

  describe('legacy .log format', () => {
    it('parses a valid legacy log line into structured fields', () => {
      const result = parseLogLine(
        '[2026-03-23T12:00:00.000Z] [INFO] [feed] platform=youtube video=abc123',
      );
      expect(result).toMatchObject({
        ts: '2026-03-23T12:00:00.000Z',
        level: 'info',
        scope: 'feed',
        event: 'platform=youtube', // first word of message
        message: 'platform=youtube video=abc123',
        platform: 'youtube',
        video: 'abc123',
      });
    });

    it('parses WARN level', () => {
      const result = parseLogLine(
        '[2026-03-23T12:00:00.000Z] [WARN] [subtitle] fallback method=browser',
      );
      expect(result?.level).toBe('warn');
      expect(result?.scope).toBe('subtitle');
    });

    it('parses ERROR level', () => {
      const result = parseLogLine(
        '[2026-03-23T12:00:00.000Z] [ERROR] [system] error message',
      );
      expect(result?.level).toBe('error');
    });

    it('returns null for malformed log lines', () => {
      expect(parseLogLine('INFO [feed] missing brackets')).toBeNull();
    });

    it('returns null for empty strings', () => {
      expect(parseLogLine('')).toBeNull();
    });

    it('returns null when required fields are missing or invalid', () => {
      expect(
        parseLogLine('[2026-03-23T12:00:00.000Z] [INFO] message only'),
      ).toBeNull();
      expect(
        parseLogLine('[2026-03-23T12:00:00.000Z] [INFO] [unknown] message'),
      ).toBeNull();
    });
  });

  describe('debug level', () => {
    it('parses DEBUG level from JSONL', () => {
      const jsonlLine = JSON.stringify({
        ts: '2026-03-26T10:00:00.000Z',
        level: 'debug',
        scope: 'system',
        event: 'tick',
      });
      const result = parseLogLine(jsonlLine);
      expect(result?.level).toBe('debug');
    });

    it('parses DEBUG level from legacy log', () => {
      const result = parseLogLine(
        '[2026-03-26T10:00:00.000Z] [DEBUG] [system] tick',
      );
      expect(result?.level).toBe('debug');
    });
  });
});

describe('log API', () => {
  // Use a temp directory for log files to avoid polluting real logs
  const tempDir = path.join(os.tmpdir(), `folo-log-test-${Date.now()}`);
  const originalDataRoot = process.env.DATA_ROOT;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.DATA_ROOT = tempDir;
    fs.mkdirSync(tempDir, { recursive: true });
    resetLoggerState();
  });

  afterEach(() => {
    process.env.DATA_ROOT = originalDataRoot;
    process.env.LOG_LEVEL = originalLogLevel;
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('writes valid JSONL line with 3-arg API', () => {
    log.info('subtitle', 'attempt', { platform: 'youtube', method: 'browser' });

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as LogEntry;
    expect(entry.ts).toBeDefined();
    expect(entry.level).toBe('info');
    expect(entry.scope).toBe('subtitle');
    expect(entry.event).toBe('attempt');
    expect(entry.platform).toBe('youtube');
    expect(entry.method).toBe('browser');
  });

  it('writes valid JSONL line with 2-arg backward compat API', () => {
    log.info('subtitle', 'some text message');

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const content = fs.readFileSync(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as LogEntry;
    // 2-arg API: event should be 'message', text preserved in message field
    expect(entry.event).toBe('message');
    expect(entry.message).toBe('some text message');
    expect(entry.level).toBe('info');
    expect(entry.scope).toBe('subtitle');
  });

  it('log.warn writes warn level', () => {
    log.warn('system', 'something went wrong', { code: 500 });

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const content = fs.readFileSync(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as LogEntry;
    expect(entry.level).toBe('warn');
  });

  it('log.error writes error level', () => {
    log.error('system', 'failure', { error: 'something broke' });

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const content = fs.readFileSync(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as LogEntry;
    expect(entry.level).toBe('error');
  });

  it('log.debug is silent by default', () => {
    log.debug('system', 'debug message');

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    // File should not exist since debug is disabled by default
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('log.debug writes when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    // Re-import to pick up env change (or use the existing log instance)
    log.debug('system', 'debug message');

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const content = fs.readFileSync(logFile, 'utf8');
    const entry = JSON.parse(content.trim()) as LogEntry;
    expect(entry.level).toBe('debug');
  });

  it('stores structured entries in memory buffer newest first', () => {
    log.info('subtitle', 'attempt', { platform: 'youtube', method: 'browser' });
    log.error('summary', 'failure', {
      platform: 'bilibili',
      method: 'api',
      error: 'boom',
    });

    const entries = getBufferedEntries({ lines: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 'error',
      scope: 'summary',
      event: 'failure',
      platform: 'bilibili',
      error: 'boom',
    });
    expect(entries[1]).toMatchObject({
      level: 'info',
      scope: 'subtitle',
      event: 'attempt',
      platform: 'youtube',
      method: 'browser',
    });
  });

  it('updates aggregated stats on write', () => {
    log.info('subtitle', 'attempt', { platform: 'youtube', method: 'browser' });
    log.warn('subtitle', 'fallback', {
      platform: 'youtube',
      method: 'browser',
    });
    log.error('subtitle', 'failure', {
      platform: 'youtube',
      method: 'browser',
      error: 'rate limit',
    });
    log.info('subtitle', 'success', {
      platform: 'youtube',
      method: 'browser',
    });

    const stats = getLogStats();
    expect(stats.total).toBe(4);
    expect(stats.byLevel.info).toBe(2);
    expect(stats.byLevel.warn).toBe(1);
    expect(stats.byLevel.error).toBe(1);
    expect(stats.byScope.subtitle).toBe(4);
    expect(stats.subtitle.attempts).toBe(1);
    expect(stats.subtitle.successes).toBe(1);
    expect(stats.subtitle.failures).toBe(1);
    expect(stats.subtitle.fallbacks).toBe(1);
    expect(stats.subtitle.byMethod.browser).toEqual({
      attempts: 1,
      successes: 1,
      failures: 1,
    });
    expect(stats.subtitle.byPlatform.youtube).toBe(4);
    expect(stats.subtitle.recentErrors[0]).toMatchObject({
      method: 'browser',
      platform: 'youtube',
      error: 'rate limit',
    });
    expect(stats.subtitle.successRate).toBe(50);
  });
});

describe('readStructuredLogs/readRecentLogs', () => {
  const tempDir = path.join(os.tmpdir(), `folo-log-read-test-${Date.now()}`);
  const originalDataRoot = process.env.DATA_ROOT;

  beforeEach(() => {
    process.env.DATA_ROOT = tempDir;
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    resetLoggerState();
  });

  afterEach(() => {
    process.env.DATA_ROOT = originalDataRoot;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reads entries from .jsonl files as structured data', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    fs.writeFileSync(logFile, JSON.stringify({
      ts: today.toISOString(),
      level: 'info',
      scope: 'feed',
      event: 'attempt',
      platform: 'youtube',
    }) + '\n', 'utf8');

    const entries = readStructuredLogs({ lines: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      scope: 'feed',
      event: 'attempt',
      platform: 'youtube',
    });
  });

  it('reads entries from .log files (legacy)', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.log`);

    fs.writeFileSync(logFile, `[${today.toISOString()}] [INFO] [feed] platform=youtube video=abc123\n`, 'utf8');

    const entries = readStructuredLogs({ lines: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      scope: 'feed',
      platform: 'youtube',
      video: 'abc123',
    });
  });

  it('filters by level', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const jsonlFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);
    const logFile = path.join(tempDir, 'logs', `${dateStr}.log`);

    fs.writeFileSync(jsonlFile, JSON.stringify({
      ts: today.toISOString(),
      level: 'info',
      scope: 'feed',
      event: 'info-entry',
    }) + '\n', 'utf8');

    fs.writeFileSync(logFile, `[${today.toISOString()}] [WARN] [feed] warn-entry\n`, 'utf8');

    const warnLogs = readStructuredLogs({ level: 'warn', lines: 10 });
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].level).toBe('warn');
  });

  it('filters by scope', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const jsonlFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    fs.writeFileSync(jsonlFile,
      JSON.stringify({ ts: today.toISOString(), level: 'info', scope: 'feed', event: 'feed-entry' }) + '\n', 'utf8');
    fs.appendFileSync(jsonlFile,
      JSON.stringify({ ts: today.toISOString(), level: 'info', scope: 'subtitle', event: 'subtitle-entry' }) + '\n', 'utf8');

    const subtitleLogs = readStructuredLogs({ scope: 'subtitle', lines: 10 });
    expect(subtitleLogs).toHaveLength(1);
    expect(subtitleLogs[0].scope).toBe('subtitle');
  });

  it('filters by platform', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const jsonlFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    fs.writeFileSync(jsonlFile,
      JSON.stringify({ ts: today.toISOString(), level: 'info', scope: 'feed', event: 'yt', platform: 'youtube' }) + '\n', 'utf8');
    fs.appendFileSync(jsonlFile,
      JSON.stringify({ ts: today.toISOString(), level: 'info', scope: 'feed', event: 'bilibili', platform: 'bilibili' }) + '\n', 'utf8');

    const ytLogs = readStructuredLogs({ platform: 'youtube', lines: 10 });
    expect(ytLogs).toHaveLength(1);
    expect(ytLogs[0].platform).toBe('youtube');
  });

  it('keeps readRecentLogs available as formatted compatibility output', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    fs.writeFileSync(
      logFile,
      JSON.stringify({
        ts: today.toISOString(),
        level: 'info',
        scope: 'summary',
        event: 'success',
        platform: 'youtube',
      }) + '\n',
      'utf8',
    );

    const logs = readRecentLogs({ lines: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[INFO]');
    expect(logs[0]).toContain('[summary]');
    expect(logs[0]).toContain('success');
  });

  it('reads small log files completely when they are under 128KB', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    fs.writeFileSync(
      logFile,
      [
        JSON.stringify({
          ts: today.toISOString(),
          level: 'info',
          scope: 'feed',
          event: 'older-entry',
        }),
        JSON.stringify({
          ts: today.toISOString(),
          level: 'info',
          scope: 'feed',
          event: 'newer-entry',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const entries = readStructuredLogs({ lines: 10 });
    expect(entries.map((entry) => entry.event)).toEqual([
      'newer-entry',
      'older-entry',
    ]);
  });

  it('reads only the tail of large log files and skips the truncated first line', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tempDir, 'logs', `${dateStr}.jsonl`);

    const hugePrefix = 'x'.repeat(128 * 1024);
    const truncatedLine = `${hugePrefix}${JSON.stringify({
      ts: today.toISOString(),
      level: 'info',
      scope: 'feed',
      event: 'too-old-to-read',
    })}\n`;
    const recentLine = `${JSON.stringify({
      ts: today.toISOString(),
      level: 'info',
      scope: 'feed',
      event: 'tail-entry',
      platform: 'youtube',
    })}\n`;

    fs.writeFileSync(logFile, truncatedLine + recentLine, 'utf8');

    const entries = readStructuredLogs({ lines: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'tail-entry',
      platform: 'youtube',
    });
  });
});

describe('cleanupOldLogs', () => {
  const tempDir = path.join(os.tmpdir(), `folo-log-cleanup-test-${Date.now()}`);
  const originalDataRoot = process.env.DATA_ROOT;

  beforeEach(() => {
    process.env.DATA_ROOT = tempDir;
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    resetLoggerState();
  });

  afterEach(() => {
    process.env.DATA_ROOT = originalDataRoot;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('removes .jsonl files older than MAX_AGE_DAYS', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}-${String(oldDate.getDate()).padStart(2, '0')}`;

    const oldFile = path.join(tempDir, 'logs', `${oldDateStr}.jsonl`);
    fs.writeFileSync(oldFile, 'old content\n', 'utf8');

    const today = new Date();
    const todayDateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayFile = path.join(tempDir, 'logs', `${todayDateStr}.jsonl`);
    fs.writeFileSync(todayFile, 'today content\n', 'utf8');

    cleanupOldLogs();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(todayFile)).toBe(true);
  });

  it('removes .log files older than MAX_AGE_DAYS', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}-${String(oldDate.getDate()).padStart(2, '0')}`;

    const oldFile = path.join(tempDir, 'logs', `${oldDateStr}.log`);
    fs.writeFileSync(oldFile, 'old content\n', 'utf8');

    cleanupOldLogs();

    expect(fs.existsSync(oldFile)).toBe(false);
  });
});
