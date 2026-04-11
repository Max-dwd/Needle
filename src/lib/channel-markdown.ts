import type { Channel, Intent } from './db';
import { buildChannelUrl } from './url-utils';
import {
  parseBilibiliUid,
  resolveChannelFromUrl,
  resolveYouTubeChannelId,
} from './fetcher';

export interface ParsedChannelImport {
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string;
  url: string;
  intent: string;
  topics: string[];
}

function escapeMarkdown(text: string): string {
  return text.replace(/[[\]()`]/g, '\\$&');
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([[\]()`])/g, '$1');
}

function getChannelUrl(
  channel: Pick<Channel, 'platform' | 'channel_id'>,
): string {
  return buildChannelUrl(channel.platform, channel.channel_id);
}

/**
 * Serializes subscribed channels into the new intent-based markdown format.
 *
 * Format:
 * # Needle Subscriptions
 *
 * ## 工作
 * - [Name](url) `youtube:channel_id` #topic1 #topic2
 *
 * ## 未分类
 * - [Name](url) `bilibili:channel_id`
 *
 * @param channels - Channel records to group by intent
 * @param intents - Intent records ordered by sort_order (未分类 always last)
 * @returns A markdown document that can be re-imported later
 */
export function exportChannelsToMarkdown(
  channels: Channel[],
  intents: Intent[],
): string {
  if (channels.length === 0) {
    return '# Needle Subscriptions\n\n';
  }

  // Group channels by intent
  const byIntent = new Map<string, Channel[]>();
  for (const channel of channels) {
    const intentName = channel.intent || '未分类';
    if (!byIntent.has(intentName)) {
      byIntent.set(intentName, []);
    }
    byIntent.get(intentName)!.push(channel);
  }

  // Separate user intents from 未分类
  const userIntents = intents.filter((i) => i.name !== '未分类');

  const lines: string[] = ['# Needle Subscriptions', '', ''];

  // Render user intents in sort_order (only if they have channels)
  for (const intent of userIntents) {
    const channelsInIntent = byIntent.get(intent.name);
    if (!channelsInIntent || channelsInIntent.length === 0) {
      continue; // Skip intents with no channels
    }
    // Sort channels alphabetically within group
    const sorted = [...channelsInIntent].sort((a, b) =>
      (a.name || a.channel_id).localeCompare(b.name || b.channel_id, 'zh-Hans-CN'),
    );

    lines.push(`## ${intent.name}`);
    for (const channel of sorted) {
      const name = escapeMarkdown(
        (channel.name || channel.channel_id).trim() || channel.channel_id,
      );
      const url = getChannelUrl(channel);
      const meta = `\`${channel.platform}:${channel.channel_id}\``;
      const topics = Array.isArray(channel.topics) ? channel.topics : [];
      const tagsSuffix =
        topics.length > 0 ? ' ' + topics.map((t) => `#${t}`).join(' ') : '';
      lines.push(`- [${name}](${url}) ${meta}${tagsSuffix}`);
    }
    lines.push('');
  }

  // Render 未分类 last
  const unclassifiedChannels = byIntent.get('未分类') || byIntent.get('') || [];
  if (unclassifiedChannels.length > 0) {
    const sorted = [...unclassifiedChannels].sort((a, b) =>
      (a.name || a.channel_id).localeCompare(b.name || b.channel_id, 'zh-Hans-CN'),
    );
    lines.push('## 未分类');
    for (const channel of sorted) {
      const name = escapeMarkdown(
        (channel.name || channel.channel_id).trim() || channel.channel_id,
      );
      const url = getChannelUrl(channel);
      const meta = `\`${channel.platform}:${channel.channel_id}\``;
      const topics = Array.isArray(channel.topics) ? channel.topics : [];
      const tagsSuffix =
        topics.length > 0 ? ' ' + topics.map((t) => `#${t}`).join(' ') : '';
      lines.push(`- [${name}](${url}) ${meta}${tagsSuffix}`);
    }
    lines.push('');
  }

  // Remove trailing empty line
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n') + '\n';
}

function parseListLine(
  line: string,
): { indent: number; content: string } | null {
  const match = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (!match) return null;
  return { indent: match[1].length, content: match[2].trim() };
}

function parseMarkdownLink(
  value: string,
): { name: string; url: string; meta: string } | null {
  // Use a pattern that handles escaped brackets: (?:[^\]\\]|\\.)+ matches
  // either non-bracket/non-backslash chars, OR a backslash followed by any char
  const match = value.match(/^\[((?:[^\]\\]|\\.)+)\]\((https?:\/\/[^\s)]+)\)\s*(.*)$/);
  if (!match) return null;
  return {
    name: match[1].trim(),
    url: match[2].trim(),
    meta: match[3].trim(),
  };
}

function parseInlineMeta(
  meta: string,
): { platform: 'youtube' | 'bilibili'; channel_id: string } | null {
  const match = meta.match(/`(youtube|bilibili):([^`]+)`/i);
  if (!match) return null;
  return {
    platform: match[1].toLowerCase() as 'youtube' | 'bilibili',
    channel_id: match[2].trim(),
  };
}

async function resolveImportIdentity(
  platformHint: 'youtube' | 'bilibili' | null,
  url: string,
  meta: string,
): Promise<{ platform: 'youtube' | 'bilibili'; channel_id: string }> {
  const parsedMeta = parseInlineMeta(meta);
  if (parsedMeta) return parsedMeta;

  if (platformHint === 'bilibili' || url.includes('bilibili.com')) {
    return { platform: 'bilibili', channel_id: await parseBilibiliUid(url) };
  }
  if (
    platformHint === 'youtube' ||
    url.includes('youtube.com') ||
    url.includes('youtu.be')
  ) {
    try {
      return {
        platform: 'youtube',
        channel_id: await resolveYouTubeChannelId(url),
      };
    } catch {
      const resolved = await resolveChannelFromUrl(url);
      return { platform: resolved.platform, channel_id: resolved.channel_id };
    }
  }

  const resolved = await resolveChannelFromUrl(url);
  return { platform: resolved.platform, channel_id: resolved.channel_id };
}

type GetDb = () => import('better-sqlite3').Database;

function ensureIntentExists(
  db: import('better-sqlite3').Database,
  intentName: string,
): void {
  const existing = db
    .prepare('SELECT id FROM intents WHERE name = ?')
    .get(intentName);
  if (!existing) {
    // Auto-create with default settings (auto_subtitle=0, auto_summary=0)
    // Insert before 未分类
    const unclassified = db
      .prepare('SELECT sort_order FROM intents WHERE name = ?')
      .get('未分类') as { sort_order: number } | undefined;
    const sortOrder = unclassified ? unclassified.sort_order : 99;
    db.prepare(
      'INSERT INTO intents (name, auto_subtitle, auto_summary, sort_order) VALUES (?, 0, 0, ?)',
    ).run(intentName, sortOrder);
  }
}

/**
 * Detects whether the markdown uses the new intent-based format or the old
 * platform/category format.
 *
 * New format: ## headings are intent names (not platform names)
 * Old format: top-level list items are 'YouTube' or 'Bilibili' (not ## headings)
 */
function detectFormat(lines: string[]): 'new' | 'old' {
  for (const line of lines) {
    const trimmed = line.trim();
    // Old format: `- YouTube` or `- Bilibili` at indent 0
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch && !trimmed.startsWith('  ') && !trimmed.startsWith('\t')) {
      const value = listMatch[1].trim().toLowerCase();
      if (value === 'youtube' || value === 'bilibili' || value === 'b站' || value === 'bili') {
        return 'old';
      }
    }
    // New format: ## intent headings
    if (trimmed.startsWith('##')) {
      return 'new';
    }
  }
  // Default to new format
  return 'new';
}

/**
 * Parses an exported markdown document (new format) and resolves canonical channel identities.
 *
 * @param markdown - Markdown content produced by the channel export workflow
 * @param getDb - Database getter for intent auto-creation during import
 * @returns Parsed channel imports with intent and topics
 */
export async function importChannelsFromMarkdown(
  markdown: string,
  getDb: GetDb,
): Promise<ParsedChannelImport[]> {
  const lines = markdown.split(/\r?\n/);
  const format = detectFormat(lines);

  if (format === 'old') {
    return importOldFormat(markdown);
  }

  return importNewFormat(lines, getDb);
}

async function importNewFormat(
  lines: string[],
  getDb: GetDb,
): Promise<ParsedChannelImport[]> {
  const results: ParsedChannelImport[] = [];
  let currentIntent = '未分类';
  const db = getDb();

  for (const rawLine of lines) {
    const line = rawLine;

    // Check for ## intent heading
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      currentIntent = headingMatch[1].trim();
      continue;
    }

    // Skip non-list lines
    const parsed = parseListLine(line);
    if (!parsed) continue;

    const link = parseMarkdownLink(parsed.content);
    if (!link) continue;

    const identity = await resolveImportIdentity(null, link.url, link.meta);

    // Parse hashtags from the remaining content after the backtick meta
    // The meta is already consumed by resolveImportIdentity, so we re-parse
    const topics: string[] = [];
    const meta = parseInlineMeta(link.meta);
    if (meta) {
      // Extract hashtags from the part after the backtick
      const afterMeta = link.meta.replace(/`[^`]+`/, '').trim();
      const tagMatches = afterMeta.match(/#([^\s#]+)/g);
      if (tagMatches) {
        for (const tag of tagMatches) {
          topics.push(tag.slice(1)); // Remove leading #
        }
      }
    }

    // Ensure intent exists in DB
    ensureIntentExists(db, currentIntent);

    results.push({
      platform: identity.platform,
      channel_id: identity.channel_id,
      name: unescapeMarkdown(link.name),
      url: link.url,
      intent: currentIntent,
      topics,
    });
  }

  // Deduplicate by platform:channel_id (keep first occurrence)
  const deduped = new Map<string, ParsedChannelImport>();
  for (const item of results) {
    const key = `${item.platform}:${item.channel_id}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

async function importOldFormat(
  markdown: string,
): Promise<ParsedChannelImport[]> {
  const lines = markdown.split(/\r?\n/);
  const results: ParsedChannelImport[] = [];

  const stack: Array<{ level: number; value: string }> = [];

  for (const rawLine of lines) {
    const parsed = parseListLine(rawLine);
    if (!parsed) continue;

    const level = Math.floor(parsed.indent / 2);
    while (stack.length > level) {
      stack.pop();
    }
    stack[level] = { level, value: parsed.content };

    const link = parseMarkdownLink(parsed.content);
    if (!link) continue;

    const contextValues = stack.slice(0, level).map((item) => item.value);

    // Determine platform from context
    const platformValue = contextValues.find((v) => {
      const lower = v.toLowerCase();
      return (
        lower === 'youtube' ||
        lower === 'bilibili' ||
        lower === 'b站' ||
        lower === 'bili'
      );
    });
    let platform: 'youtube' | 'bilibili' | null = null;
    if (platformValue) {
      const lower = platformValue.toLowerCase();
      if (lower === 'youtube') platform = 'youtube';
      else if (
        lower === 'bilibili' ||
        lower === 'b站' ||
        lower === 'bili'
      )
        platform = 'bilibili';
    }

    const categories = contextValues.filter((v) => {
      const lower = v.toLowerCase();
      return !['youtube', 'bilibili', 'b站', 'bili'].includes(lower);
    });

    const identity = await resolveImportIdentity(platform, link.url, link.meta);

    // Map old categories to topics, intent always '未分类'
    const topics = categories.filter((c) => c.trim() !== '' && c.trim() !== '未分类');

    results.push({
      platform: identity.platform,
      channel_id: identity.channel_id,
      name: unescapeMarkdown(link.name),
      url: link.url,
      intent: '未分类',
      topics,
    });
  }

  // Deduplicate (keep first occurrence)
  const deduped = new Map<string, ParsedChannelImport>();
  for (const item of results) {
    const key = `${item.platform}:${item.channel_id}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}
