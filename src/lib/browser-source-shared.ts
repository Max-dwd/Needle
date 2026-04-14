import { runBrowserCliJson } from './browser-session-manager';
import { BROWSER_METHOD_ID, getBrowserMethodLabel } from './browser-method';

export const BROWSER_DISPLAY_NAME = getBrowserMethodLabel(BROWSER_METHOD_ID);
export const CONTROLLED_BROWSER_LABEL = '受控浏览器';

export interface BrowserFieldValueRow {
  field?: string;
  value?: unknown;
}

export interface BrowserVideoSummary {
  video_id: string;
  title: string;
  url?: string;
  thumbnail_url?: string;
  published_at?: string;
  duration?: string;
  is_members_only?: number;
  access_status?: 'members_only' | 'limited_free';
}

export interface BrowserVideoMeta {
  video_id: string;
  title: string;
  thumbnail_url: string;
  published_at: string;
  duration: string;
  is_members_only?: number;
  access_status?: 'members_only' | 'limited_free';
  channel_name?: string;
}

export interface BrowserChannelInfo {
  channel_id: string;
  name: string;
  avatar_url: string;
}

export interface BrowserSubtitleRow {
  index?: number;
  from?: string;
  to?: string;
  start?: string;
  end?: string;
  content?: string;
  text?: string;
}

export interface BrowserFollowingRow {
  mid?: number | string;
  name?: string;
  uname?: string;
  face?: string;
  sign?: string;
  following?: string;
  fans?: string;
}

export interface BrowserYoutubeSubscriptionRow {
  channel_id: string;
  name: string;
  avatar_url: string;
  description?: string;
}

export interface BrowserExecOptions {
  signal?: AbortSignal;
  allowBrowserBootstrap?: boolean;
  strategy?: 'default' | 'metadata';
}

export async function runBrowserJson(
  args: string[],
  options?: BrowserExecOptions,
): Promise<unknown> {
  return runBrowserCliJson(args, options);
}

function readExecErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStderr =
    'stderr' in error
      ? (error.stderr as Buffer | string | undefined)
      : undefined;
  const maybeStdout =
    'stdout' in error
      ? (error.stdout as Buffer | string | undefined)
      : undefined;
  const stderr =
    typeof maybeStderr === 'string'
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString('utf8')
        : '';
  const stdout =
    typeof maybeStdout === 'string'
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString('utf8')
        : '';
  return stderr.trim() || stdout.trim() || error.message;
}

export function normalizeBrowserError(error: unknown): string {
  const message = readExecErrorMessage(error).replace(/\s+/g, ' ').trim();

  if (/Failed to start Needle Browser daemon/i.test(message)) {
    return `${BROWSER_DISPLAY_NAME} daemon 启动失败。请确认 19825 端口可用，并在 ${CONTROLLED_BROWSER_LABEL}中连接 ${BROWSER_DISPLAY_NAME} Bridge 扩展。`;
  }

  if (
    /Daemon is running but the (Browser Extension|Needle Browser Bridge extension) is not connected|Extension: not connected|Browser Bridge/i.test(
      message,
    )
  ) {
    return `${BROWSER_DISPLAY_NAME} Bridge 扩展未连接。请在 ${CONTROLLED_BROWSER_LABEL}里启用并连接扩展后重试；如未安装，可先运行 \`npm run browser:bridge:build\`，再到 chrome://extensions 加载仓库内的 \`browser-bridge/extension\` 目录。`;
  }

  if (
    /browser runtime binary not found|first-class .* browser runtime bundle not found|未找到仓内 .* Browser 运行时|未找到仓内 .* Browser daemon client/i.test(
      message,
    )
  ) {
    return '未找到仓内浏览器抓取运行时，请确认 `browser-runtime/` 已构建完成；如缺少产物，可运行 `npm run browser:runtime:build`。';
  }

  if (
    /Not logged in to YouTube|YouTube login required|Sign in to YouTube/i.test(
      message,
    )
  ) {
    return `请先在 ${BROWSER_DISPLAY_NAME} ${CONTROLLED_BROWSER_LABEL}里登录 YouTube，然后重新抓取订阅列表。`;
  }

  if (/Not logged in to Bilibili|账号未登录|Requires browser/i.test(message)) {
    return `请先在 ${BROWSER_DISPLAY_NAME} ${CONTROLLED_BROWSER_LABEL}里登录 B 站；如果仍失败，再去设置页更新 SESSDATA 作为兜底。`;
  }

  if (
    /Browser background bootstrap disabled: no reusable controlled browser session/i.test(
      message,
    )
  ) {
    return `后台任务未检测到可复用的${CONTROLLED_BROWSER_LABEL}会话，已跳过 ${BROWSER_DISPLAY_NAME}，以避免重复拉起浏览器。`;
  }

  return message;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized || undefined;
}

export function extractYoutubeChannelId(raw: string | undefined): string {
  const value = (raw || '').trim();
  if (!value) return '';
  if (/^(UC|HC)[A-Za-z0-9_-]+$/.test(value)) return value;

  try {
    const parsed = value.startsWith('http')
      ? new URL(value)
      : new URL(value, 'https://www.youtube.com');
    const direct = parsed.searchParams.get('channel_id');
    if (direct) return direct;

    const pathname = parsed.pathname.replace(/\/+$/, '');
    const channelMatch = pathname.match(/\/channel\/((?:UC|HC)[A-Za-z0-9_-]+)/);
    if (channelMatch?.[1]) return channelMatch[1];

    const handleMatch = pathname.match(/\/(@[A-Za-z0-9._-]+)/);
    if (handleMatch?.[1]) return handleMatch[1];

    const userMatch = pathname.match(/\/(?:user|c)\/([A-Za-z0-9._-]+)/);
    if (userMatch?.[1]) return userMatch[1];
  } catch {
    // ignore malformed URL
  }

  return value;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asFieldValueRows(
  value: unknown,
): BrowserFieldValueRow[] | null {
  if (!Array.isArray(value)) return null;
  if (
    value.every(
      (row) =>
        row && typeof row === 'object' && ('field' in row || 'value' in row),
    )
  ) {
    return value as BrowserFieldValueRow[];
  }
  return null;
}

export function parseFieldValueMap(
  rows: BrowserFieldValueRow[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const field = asString(row.field);
    if (!field || field === '---') continue;
    map[field] = asString(row.value);
  }
  return map;
}

export function parseYoutubeVideoIdFromUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) return '';

  try {
    const parsed = url.startsWith('http')
      ? new URL(url)
      : new URL(url, 'https://www.youtube.com');
    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v') || '';
    }

    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.replace(/^\/+/, '').split('/')[0] || '';
    }

    const pathMatch = parsed.pathname.match(
      /^\/(shorts|embed|live|v)\/([^/?]+)/,
    );
    if (pathMatch?.[2]) return pathMatch[2];
  } catch {
    // ignore
  }

  return url;
}

export function buildYoutubeWatchUrl(videoIdOrUrl: string): string {
  const normalized = videoIdOrUrl.trim();
  if (!normalized) return normalized;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  const videoId = parseYoutubeVideoIdFromUrl(normalized);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : normalized;
}

export function parseBilibiliVideoIdFromUrl(rawUrl: string): string {
  const match = rawUrl.trim().match(/\/video\/(BV[A-Za-z0-9]+)/i);
  return match?.[1] || rawUrl.trim();
}

function parseRelativeDate(input: string): string | undefined {
  // "刚刚" / "just now"
  if (input === '刚刚' || input.toLowerCase() === 'just now') {
    return new Date().toISOString();
  }

  // Chinese: "3分钟前", "1小时前", "2天前", "1周前", "3个月前", "1年前"
  const zh = input.match(/^(\d+)(分钟|小时|天|周|个月|年)前$/);
  if (zh) {
    const n = parseInt(zh[1], 10);
    const MS: Record<string, number> = { 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000, 周: 604_800_000, 个月: 30 * 86_400_000, 年: 365 * 86_400_000 };
    return new Date(Date.now() - n * MS[zh[2]]).toISOString();
  }

  // English: "3 minutes ago", "1 hour ago", "2 days ago", "1 week ago", "3 months ago", "1 year ago"
  const en = input.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (en) {
    const n = parseInt(en[1], 10);
    const MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
    return new Date(Date.now() - n * MS[en[2].toLowerCase()]).toISOString();
  }

  return undefined;
}

export function normalizePublishedAtValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }

  const input = asOptionalString(value)?.replace(/\u00a0/g, ' ').trim();
  if (!input) return '';

  const relative = parseRelativeDate(input);
  if (relative) return relative;

  return normalizeIsoDate(input) || input;
}

function normalizeSummaryPublishedAt(value: unknown): string | undefined {
  const normalized = normalizePublishedAtValue(value);
  return normalized || undefined;
}

function normalizeIsoDate(value: unknown): string {
  const input = asString(value);
  if (!input) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) return input;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(`${input}T00:00:00Z`).toISOString();
  }
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function formatDurationFromSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function normalizeDuration(value: unknown): string {
  const input = asString(value);
  if (!input) return '';
  const secondsMatch = input.match(/^(\d+)s$/i);
  if (secondsMatch?.[1]) {
    return formatDurationFromSeconds(Number.parseInt(secondsMatch[1], 10));
  }
  return input;
}

function normalizeMembersOnly(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (value === 0 || value === 1) return value;
    return value > 0 ? 1 : 0;
  }

  const input = asString(value).toLowerCase();
  if (!input) return undefined;
  if (['1', 'true', 'yes'].includes(input)) return 1;
  if (['0', 'false', 'no'].includes(input)) return 0;
  if (/member|会员|付费|exclusive|subscriber|premium/.test(input)) return 1;
  if (/public|free|公开/.test(input)) return 0;
  return undefined;
}

function normalizeAccessStatus(
  value: unknown,
): 'members_only' | 'limited_free' | undefined {
  const input = asString(value).toLowerCase();
  if (!input) return undefined;
  if (
    /限时免费|limited free|temporarily free|free for limited time/.test(input)
  ) {
    return 'limited_free';
  }
  if (
    /member|会员|付费|exclusive|subscriber|premium|充电专属|会员专属|购买观看/.test(
      input,
    )
  ) {
    return 'members_only';
  }
  return undefined;
}

function detectNestedMembersOnly(
  value: unknown,
  keyHint = '',
  depth = 0,
): number | undefined {
  if (depth > 4 || value == null) return undefined;

  const direct = normalizeMembersOnly(value);
  if (direct !== undefined) {
    if (keyHint && /title$/i.test(keyHint) && typeof value === 'string') {
      return undefined;
    }
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = detectNestedMembersOnly(item, keyHint, depth + 1);
      if (detected !== undefined) return detected;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  for (const [key, nested] of Object.entries(record)) {
    const detected = detectNestedMembersOnly(
      nested,
      keyHint ? `${keyHint}.${key}` : key,
      depth + 1,
    );
    if (detected !== undefined) return detected;
  }

  return undefined;
}

function detectNestedAccessStatus(
  value: unknown,
  keyHint = '',
  depth = 0,
): 'members_only' | 'limited_free' | undefined {
  if (depth > 4 || value == null) return undefined;

  const direct = normalizeAccessStatus(value);
  if (direct !== undefined) {
    if (keyHint && /title$/i.test(keyHint) && typeof value === 'string') {
      return undefined;
    }
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = detectNestedAccessStatus(item, keyHint, depth + 1);
      if (detected !== undefined) return detected;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  for (const [key, nested] of Object.entries(record)) {
    const detected = detectNestedAccessStatus(
      nested,
      keyHint ? `${keyHint}.${key}` : key,
      depth + 1,
    );
    if (detected !== undefined) return detected;
  }

  return undefined;
}

export function normalizeVideoSummaryRecord(
  record: Record<string, unknown>,
  platform: 'youtube' | 'bilibili',
): BrowserVideoSummary | null {
  const rawId =
    asString(record.video_id) ||
    asString(record.bvid) ||
    asString(record.videoId) ||
    (platform === 'youtube'
      ? parseYoutubeVideoIdFromUrl(asString(record.url))
      : parseBilibiliVideoIdFromUrl(asString(record.url)));
  const title = asString(record.title);
  if (!rawId || !title) return null;

  return {
    video_id: rawId,
    title,
    url: asOptionalString(record.url),
    thumbnail_url:
      asOptionalString(record.thumbnail_url) ||
      asOptionalString(record.thumbnail) ||
      asOptionalString(record.pic),
    published_at: normalizeSummaryPublishedAt(
      record.published_at ??
        record.publishDate ??
        record.date ??
        record.created,
    ),
    duration: normalizeDuration(record.duration ?? record.length),
    access_status:
      normalizeAccessStatus(
        record.access_status ??
          record.accessStatus ??
          record.members_only_status,
      ) ?? detectNestedAccessStatus(record),
    is_members_only:
      normalizeMembersOnly(
        record.is_members_only ??
          record.isMembersOnly ??
          record.members_only ??
          record.isMembersOnlyText,
      ) ??
      ((normalizeAccessStatus(
        record.access_status ??
          record.accessStatus ??
          record.members_only_status,
      ) ?? detectNestedAccessStatus(record)) === 'members_only'
        ? 1
        : undefined) ??
      detectNestedMembersOnly(record),
  };
}

export function normalizeVideoMetaRecord(
  record: Record<string, unknown>,
  platform: 'youtube' | 'bilibili',
  fallbackId: string,
): BrowserVideoMeta {
  const summary = normalizeVideoSummaryRecord(record, platform) || {
    video_id: fallbackId,
    title: asString(record.title),
  };

  return {
    video_id: summary.video_id || fallbackId,
    title: summary.title || fallbackId,
    thumbnail_url:
      asString(record.thumbnail_url) ||
      asString(record.thumbnail) ||
      summary.thumbnail_url ||
      '',
    published_at: normalizeIsoDate(
      record.published_at ?? record.publishDate ?? summary.published_at,
    ),
    duration: normalizeDuration(record.duration ?? summary.duration),
    access_status:
      normalizeAccessStatus(
        record.access_status ?? record.accessStatus ?? summary.access_status,
      ) ?? summary.access_status,
    is_members_only:
      normalizeMembersOnly(
        record.is_members_only ??
          record.isMembersOnly ??
          summary.is_members_only,
      ) ??
      ((normalizeAccessStatus(
        record.access_status ?? record.accessStatus ?? summary.access_status,
      ) ?? summary.access_status) === 'members_only'
        ? 1
        : undefined),
    channel_name:
      asString(record.channel_name) ||
      asString(record.author) ||
      asString(record.channel) ||
      asString(record.owner_name) ||
      asString(record.uploader) ||
      '',
  };
}

export function normalizeChannelInfoRecord(
  record: Record<string, unknown>,
  fallbackId: string,
): BrowserChannelInfo {
  return {
    channel_id:
      asString(record.channel_id) ||
      asString(record.channelId) ||
      asString(record.uid) ||
      fallbackId,
    name:
      asString(record.name) ||
      asString(record.channel) ||
      asString(record.uname) ||
      asString(record.handle) ||
      fallbackId,
    avatar_url:
      asString(record.avatar_url) ||
      asString(record.avatar) ||
      asString(record.face) ||
      '',
  };
}
