#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const dataRoot = process.env.DATA_ROOT || path.join(cwd, 'data');
const subtitleRoot = process.env.SUBTITLE_ROOT || path.join(dataRoot, 'subtitles');
const outputRoot = process.env.SUMMARY_MD_ROOT || path.join(dataRoot, 'summary-md');
const summaryRoot = process.env.SUMMARY_ROOT || path.join(dataRoot, 'summaries');

function parseArgs(argv) {
  const options = {
    platform: null,
    videoId: null,
    overwrite: false,
    clickable: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') {
      options.platform = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--video') {
      options.videoId = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (arg === '--clickable') {
      options.clickable = true;
    }
  }

  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listSubtitleFiles(platform) {
  const platformDir = path.join(subtitleRoot, platform);
  if (!fs.existsSync(platformDir)) return [];
  return fs.readdirSync(platformDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(platformDir, name))
    .sort((a, b) => a.localeCompare(b));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function estimateSegmentsFromText(text) {
  const lines = String(text || '').split('\n').map(normalizeText).filter(Boolean);
  const segments = [];
  let cursor = 0;

  for (const line of lines) {
    const duration = Math.max(2, Math.min(8, Math.ceil(line.length / 12)));
    segments.push({
      start: cursor,
      end: cursor + duration,
      text: line,
    });
    cursor += duration;
  }

  return segments;
}

function readSubtitlePayload(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const segments = Array.isArray(payload.segments) && payload.segments.length > 0
    ? payload.segments.map((segment) => ({
      start: Math.max(0, Math.floor(Number(segment.start) || 0)),
      end: Math.max(0, Math.floor(Number(segment.end) || 0)),
      text: normalizeText(segment.text),
    })).filter((segment) => segment.text)
    : estimateSegmentsFromText(payload.text || '');

  return {
    ...payload,
    segments,
  };
}

function formatSeconds(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildVideoUrl(platform, videoId, seconds = 0) {
  if (platform === 'youtube') {
    const url = new URL(`https://www.youtube.com/watch?v=${videoId}`);
    if (seconds > 0) url.searchParams.set('t', `${Math.floor(seconds)}s`);
    return url.toString();
  }
  const url = new URL(`https://www.bilibili.com/video/${videoId}/`);
  if (seconds > 0) url.searchParams.set('t', String(Math.floor(seconds)));
  return url.toString();
}

function buildUrlTemplate(platform, videoId) {
  if (platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${videoId}&t={seconds}s`;
  }
  return `https://www.bilibili.com/video/${videoId}/?t={seconds}`;
}

function getSummaryOutputPath(platform, videoId) {
  return path.join(summaryRoot, platform, `${videoId}.md`);
}

function chunkSegments(segments) {
  const chunks = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = {
        start: segment.start,
        end: segment.end,
        items: [],
      };
    }

    const nextDuration = segment.end - current.start;
    if (current.items.length >= 8 || nextDuration >= 120) {
      chunks.push(current);
      current = {
        start: segment.start,
        end: segment.end,
        items: [],
      };
    }

    current.end = Math.max(current.end, segment.end);
    current.items.push(segment);
  }

  if (current && current.items.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildPromptSection(payload) {
  const sourceUrl = buildVideoUrl(payload.platform, payload.video_id);
  return [
    '## Task',
    '',
    '请直接完成这个任务文件，并将最终结果写入 `target_output_path` 指定的位置。',
    '',
    '硬性要求：',
    '1. 只用中文输出最终总结。',
    '2. 尽可能总结全文，不要只覆盖前半段或只摘最显眼的观点。',
    '3. 要覆盖：主论点、关键论据、例子、转折、例外、结论、行动建议。',
    '4. 以“总结可读性”为中心组织结构，不要写成逐段字幕改写，不要写成流水账时间轴。',
    '5. 不要全篇堆时间戳。只在需要支撑某句结论、某段说明或某个关键事实时，在句末附 1-3 个最相关的时间戳链接。',
    '6. 时间戳必须使用可点击的 Markdown 链接。',
    '7. 如果字幕存在明显 ASR 错字，按语义纠正后再总结，但不要编造原文没有的信息。',
    '8. 如果有广告、寒暄、引流、口播或免责声明，单独放到对应章节，不要混入核心总结。',
    '9. 如果 `target_output_path` 已存在，则不应覆写，应跳过这个任务。',
    '',
    '链接格式：',
    '- YouTube: `[00:17](https://www.youtube.com/watch?v=<video_id>&t=17s)`',
    '- Bilibili: `[00:17](https://www.bilibili.com/video/<video_id>/?t=17)`',
    '',
    '最终文件必须使用 Markdown，并遵循以下结构：',
    '# 标题',
    '## 核心总结',
    '用 2-6 段或若干条项目符号，尽可能完整地概括全文主旨。',
    '',
    '## 详细总结',
    '按主题组织若干小节。每节解释一个主要部分，必要时在句末附时间戳链接。',
    '',
    '## 结论 / 观点 / 建议',
    '总结视频最后的判断、观点归纳、建议或行动项。',
    '',
    '## 广告 / 寒暄 / 引流',
    '只有当这类内容确实存在时才输出此节。',
    '',
    '写回规则：',
    `- target_output_path: \`${getSummaryOutputPath(payload.platform, payload.video_id)}\``,
    '- 输出文件名必须与当前任务文件 basename 一致，只是目录改为 `data/summaries/<platform>/`。',
    '- 完成任务后删除此文件。',
    '',
    `原视频：${sourceUrl}`,
    '',
  ].join('\n');
}

function buildMetadataSection(payload) {
  return [
    '---',
    'task_type: video-summary',
    `video_id: ${payload.video_id}`,
    `platform: ${payload.platform}`,
    `language: ${payload.language || 'unknown'}`,
    `format: ${payload.format || 'unknown'}`,
    `source_url: ${buildVideoUrl(payload.platform, payload.video_id)}`,
    `source_url_template: ${buildUrlTemplate(payload.platform, payload.video_id)}`,
    `source_subtitle_path: ${path.join(subtitleRoot, payload.platform, `${payload.video_id}.json`)}`,
    `task_file_path: ${path.join(outputRoot, payload.platform, `${payload.video_id}.md`)}`,
    `target_output_path: ${getSummaryOutputPath(payload.platform, payload.video_id)}`,
    `generated_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
}

function buildQuickLinksSection(payload, chunks, options) {
  const lines = [
    '## Jump Links',
    '',
    options.clickable
      ? `- [Open video](${buildVideoUrl(payload.platform, payload.video_id)})`
      : `- Open video: ${buildVideoUrl(payload.platform, payload.video_id)}`,
  ];

  for (const chunk of chunks.slice(0, 12)) {
    lines.push(
      options.clickable
        ? `- [${formatSeconds(chunk.start)}](${buildVideoUrl(payload.platform, payload.video_id, chunk.start)})`
        : `- ${formatSeconds(chunk.start)}`
    );
  }

  lines.push('', '');
  return lines.join('\n');
}

function buildTranscriptSection(payload, options) {
  const chunks = chunkSegments(payload.segments);
  const lines = [
    '# Video Summary Task',
    '',
    '## Source',
    '',
    `- Video ID: \`${payload.video_id}\``,
    `- Platform: \`${payload.platform}\``,
    `- Subtitle language: \`${payload.language || 'unknown'}\``,
    `- Subtitle format: \`${payload.format || 'unknown'}\``,
    options.clickable
      ? `- Video: [Open original](${buildVideoUrl(payload.platform, payload.video_id)})`
      : `- Video: ${buildVideoUrl(payload.platform, payload.video_id)}`,
    `- Jump template: \`${buildUrlTemplate(payload.platform, payload.video_id)}\``,
    '',
  ];

  lines.push(buildQuickLinksSection(payload, chunks, options));
  lines.push(buildPromptSection(payload));
  lines.push('## Extra Context');
  lines.push('');
  lines.push('- 这是一个自包含任务文件。外部 LLM 不需要额外 prompt 说明输出结构。');
  lines.push('- 你只需要读取本文件，按其中规则生成最终总结，并写入 `target_output_path`。');
  lines.push('- 如果目标文件已存在，应跳过。');
  lines.push('');
  lines.push('## Timestamped Transcript');
  lines.push('');

  for (const chunk of chunks) {
    lines.push(`### ${formatSeconds(chunk.start)} - ${formatSeconds(chunk.end)}`);
    lines.push('');
    for (const item of chunk.items) {
      lines.push(
        options.clickable
          ? `- [${formatSeconds(item.start)}](${buildVideoUrl(payload.platform, payload.video_id, item.start)}) ${item.text}`
          : `- ${formatSeconds(item.start)} ${item.text}`
      );
    }
    lines.push('');
  }

  return buildMetadataSection(payload) + lines.join('\n');
}

function exportMarkdown(filePath, options) {
  const payload = readSubtitlePayload(filePath);
  if (options.videoId && payload.video_id !== options.videoId) return null;

  const outDir = path.join(outputRoot, payload.platform);
  const outPath = path.join(outDir, `${payload.video_id}.md`);
  ensureDir(outDir);

  if (!options.overwrite && fs.existsSync(outPath)) {
    return { outPath, skipped: true, videoId: payload.video_id };
  }

  const markdown = buildTranscriptSection(payload, options);
  fs.writeFileSync(outPath, markdown, 'utf8');
  return { outPath, skipped: false, videoId: payload.video_id };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const platforms = options.platform ? [options.platform] : ['youtube', 'bilibili'];
  const results = [];

  for (const platform of platforms) {
    for (const filePath of listSubtitleFiles(platform)) {
      const result = exportMarkdown(filePath, options);
      if (result) results.push(result);
    }
  }

  if (results.length === 0) {
    console.log('No subtitle files matched.');
    process.exit(0);
  }

  for (const result of results) {
    console.log(`${result.skipped ? 'skip' : 'write'} ${result.videoId} -> ${path.relative(cwd, result.outPath)}`);
  }
}

main();
