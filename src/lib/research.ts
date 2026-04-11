import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { readStoredSubtitle } from '@/lib/subtitles';
import { generateSlug } from '@/lib/utils';
import type { ExportPackResult } from '@/types';
import type { Video } from './db';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');
const RESEARCH_PACK_ROOT = path.join(DATA_ROOT, 'research-packs');

export interface ResearchExportItem {
  favorite_id: number;
  override_note: string | null;
  override_intent_type_id: number | null;
  note: string;
  title: string | null;
  platform: Video['platform'];
  platform_video_id: string;
  channel_name: string | null;
  subtitle_status: string | null;
  subtitle_path: string | null;
  intent_name: string;
  intent_template: string | null;
}

export function buildResearchVideoUrl(
  platform: Video['platform'],
  videoId: string,
): string {
  if (platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return `https://www.bilibili.com/video/${videoId}/`;
}

export function buildUniqueSlug(
  db: Database.Database,
  table: 'research_intent_types' | 'research_collections',
  name: string,
  excludeId?: number,
): string {
  const baseSlug = generateSlug(name) || 'item';
  let slug = baseSlug;
  let suffix = 2;

  while (true) {
    const existing = excludeId
      ? db
          .prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ? LIMIT 1`)
          .get(slug, excludeId)
      : db
          .prepare(`SELECT id FROM ${table} WHERE slug = ? LIMIT 1`)
          .get(slug);
    if (!existing) {
      return slug;
    }
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

export function extractSubtitlePlainText(
  video: Pick<Video, 'subtitle_path'>,
): string | null {
  const subtitle = readStoredSubtitle(video);
  if (!subtitle) {
    return null;
  }
  if (Array.isArray(subtitle.segments) && subtitle.segments.length > 0) {
    const text = subtitle.segments
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    return text || null;
  }
  const text = (subtitle.text || '').replace(/\[[^\]]+\]\s*/g, '').trim();
  return text || null;
}

export function renderExportTemplate(
  template: string | null | undefined,
  values: Record<string, string>,
): string {
  const source = template?.trim() || [
    '# {{title}}',
    '',
    '- Channel: {{channel_name}}',
    '- Platform: {{platform}}',
    '- URL: {{url}}',
    '- Intent: {{intent_name}}',
    '',
    '## Note',
    '',
    '{{note}}',
  ].join('\n');

  return source.replace(
    /{{\s*(title|channel_name|platform|url|note|intent_name)\s*}}/g,
    (_, key: string) => values[key] || '',
  );
}

export function exportResearchCollectionPack(input: {
  collectionSlug: string;
  collectionName: string;
  collectionGoal: string | null;
  collectionDescription: string | null;
  items: ResearchExportItem[];
  skipMissingSubtitles: boolean;
}): {
  needs_confirmation?: true;
  missing_count?: number;
  missing?: Array<{ video_id: string; title: string | null }>;
} & Partial<ExportPackResult> {
  const missing = input.items
    .filter((item) => !extractSubtitlePlainText({ subtitle_path: item.subtitle_path }))
    .map((item) => ({
      video_id: item.platform_video_id,
      title: item.title,
    }));

  if (missing.length > 0 && !input.skipMissingSubtitles) {
    return {
      needs_confirmation: true,
      missing_count: missing.length,
      missing,
    };
  }

  const now = new Date();
  const timestamp = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') +
    '-' +
    [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
  const packDir = path.join(
    RESEARCH_PACK_ROOT,
    `${timestamp}-${input.collectionSlug}`,
  );
  const itemsDir = path.join(packDir, 'items');
  fs.mkdirSync(itemsDir, { recursive: true });

  const exportedItems: Array<Record<string, unknown>> = [];
  let skippedCount = 0;

  for (const item of input.items) {
    const subtitleText = extractSubtitlePlainText({
      subtitle_path: item.subtitle_path,
    });
    if (!subtitleText) {
      skippedCount += 1;
      continue;
    }

    const note = (item.override_note || item.note).trim();
    const intentName = item.intent_name;
    const url = buildResearchVideoUrl(item.platform, item.platform_video_id);
    const body = renderExportTemplate(item.intent_template, {
      title: item.title || '',
      channel_name: item.channel_name || '',
      platform: item.platform,
      url,
      note,
      intent_name: intentName,
    });
    const fileName = `${item.platform}-${item.platform_video_id}.md`;
    const filePath = path.join(itemsDir, fileName);
    const markdown = [
      body.trim(),
      '',
      '## Subtitle',
      '',
      subtitleText,
      '',
    ].join('\n');
    fs.writeFileSync(filePath, markdown, 'utf8');

    exportedItems.push({
      favorite_id: item.favorite_id,
      title: item.title,
      platform: item.platform,
      platform_video_id: item.platform_video_id,
      channel_name: item.channel_name,
      note,
      intent_name: intentName,
      url,
      file: path.relative(packDir, filePath),
    });
  }

  const manifest = {
    collection: {
      slug: input.collectionSlug,
      name: input.collectionName,
      goal: input.collectionGoal,
      description: input.collectionDescription,
    },
    items: exportedItems,
    exported_at: now.toISOString(),
    skipped_count: skippedCount,
  };
  fs.writeFileSync(
    path.join(packDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  const brief = [
    `# ${input.collectionName}`,
    '',
    input.collectionGoal ? `## Goal\n\n${input.collectionGoal}\n` : '',
    input.collectionDescription
      ? `## Description\n\n${input.collectionDescription}\n`
      : '',
    '## Items',
    '',
    ...exportedItems.map(
      (item) =>
        `- ${(item.title as string | null) || 'Untitled'} (${item.platform as string})`,
    ),
    '',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(path.join(packDir, 'brief.md'), brief, 'utf8');

  return {
    pack_path: packDir,
    items_count: exportedItems.length,
    skipped_count: skippedCount,
  };
}
