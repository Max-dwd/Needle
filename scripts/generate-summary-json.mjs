import fs from 'fs';
import path from 'path';

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), 'data');
const SUMMARY_MD_ROOT = path.join(DATA_ROOT, 'summary-md');
const OUTPUT_ROOT = path.join(DATA_ROOT, 'summaries');

const SOURCE_DIRS = [
  path.join(SUMMARY_MD_ROOT, 'youtube'),
  path.join(SUMMARY_MD_ROOT, 'bilibili'),
];

function parseTimestamp(text) {
  const parts = text.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { metadata: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { metadata: {}, body: raw };

  const meta = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  return { metadata: meta, body: raw.slice(end + 5) };
}

function parseChapters(raw) {
  const lines = raw.split('\n');
  const chapters = [];
  let current = null;

  for (const line of lines) {
    const chapterMatch = line.match(/^###\s+(\d{2}:\d{2}(?::\d{2})?)\s+-\s+(\d{2}:\d{2}(?::\d{2})?)\s*$/);
    if (chapterMatch) {
      if (current) chapters.push(current);
      const start = parseTimestamp(chapterMatch[1]);
      const end = parseTimestamp(chapterMatch[2]);
      if (start === null || end === null) return null;
      current = {
        title: `${chapterMatch[1]} - ${chapterMatch[2]}`,
        start,
        end,
        bullets: [],
      };
      continue;
    }

    if (!current) continue;
    const bulletMatch = line.match(/^-\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.+?)\s*$/);
    if (!bulletMatch) continue;
    const timestamp = parseTimestamp(bulletMatch[1]);
    const text = bulletMatch[2].trim();
    if (timestamp === null || !text) return null;
    current.bullets.push({ timestamp, text });
  }

  if (current) chapters.push(current);
  if (!chapters.length) return null;
  if (chapters.some(ch => !ch.bullets.length)) return null;
  return chapters;
}

function buildSummary(chapters) {
  const parts = [];
  for (const chapter of chapters) {
    const texts = chapter.bullets
      .map(b => b.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!texts.length) continue;
    const head = texts.slice(0, 3).join('，');
    const tail = texts.length > 3 ? `；并延伸到${texts[texts.length - 1]}` : '';
    parts.push(`${head}${tail}`.replace(/，([，。；])/g, '$1'));
  }
  return parts.join('\n\n').slice(0, 4000);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function processFile(filePath) {
  const platform = path.basename(path.dirname(filePath));
  const videoId = path.basename(filePath, '.md');
  const outputDir = path.join(OUTPUT_ROOT, platform);
  const outputPath = path.join(outputDir, `${videoId}.json`);

  if (fs.existsSync(outputPath)) {
    return { status: 'skipped-existing', filePath, outputPath, videoId, platform };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const { metadata, body } = parseFrontmatter(raw);
  const parsedPlatform = metadata.platform || platform;
  const parsedVideoId = metadata.video_id || videoId;
  const chapters = parseChapters(body);
  if (!chapters) {
    return { status: 'skipped-malformed', filePath, outputPath, videoId: parsedVideoId, platform: parsedPlatform };
  }

  const payload = {
    video_id: parsedVideoId,
    platform: parsedPlatform,
    summary: buildSummary(chapters),
    chapters,
  };

  ensureDir(outputDir);
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { status: 'written', filePath, outputPath, videoId: parsedVideoId, platform: parsedPlatform };
}

function main() {
  const results = [];
  for (const sourceDir of SOURCE_DIRS) {
    if (!fs.existsSync(sourceDir)) {
      results.push({ status: 'missing-source-dir', sourceDir });
      continue;
    }
    const files = fs.readdirSync(sourceDir)
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(name => path.join(sourceDir, name));
    for (const filePath of files) {
      results.push(processFile(filePath));
    }
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main();
