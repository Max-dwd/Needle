import { parseSeekSeconds } from './format';

export interface SummaryChapter {
  seconds: number; // 起始时间（来自标题锚点，或在缺失时按章节顺序推断）
  title: string; // 去掉 Markdown 装饰后的纯文本标题
  body: string; // 到下一个标题之前的正文（原文，可能含行内 markdown）
}

interface MarkdownHeading {
  level: number;
  text: string;
  lineIndex: number;
  order: number;
}

interface SummarySection {
  heading: MarkdownHeading;
  bodyLines: string[];
}

interface ParsedChapter {
  seconds: number | null;
  title: string;
  body: string;
  order: number;
  source: 'heading' | 'body' | 'inferred' | null;
}

interface ExtractSummaryChaptersOptions {
  duration?: number | null;
}

function stripFrontmatter(markdown: string): string {
  const frontmatterMatch = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return frontmatterMatch
    ? markdown.slice(frontmatterMatch[0].length)
    : markdown;
}

function extractMarkdownLinks(
  text: string,
): Array<{ full: string; label: string; href: string }> {
  return Array.from(text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)).map((match) => ({
    full: match[0],
    label: match[1],
    href: match[2],
  }));
}

function findFirstSeekSeconds(
  text: string,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): number | null {
  for (const link of extractMarkdownLinks(text)) {
    const parsed = parseSeekSeconds(link.href, video);
    if (typeof parsed === 'number' && !Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function cleanHeadingTitle(
  heading: string,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): string {
  let title = heading.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (full, label, href) => {
      const parsed = parseSeekSeconds(href, video);
      return typeof parsed === 'number' && !Number.isNaN(parsed) && parsed >= 0
        ? ''
        : label;
    },
  );

  title = title
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[\s·•\-—|]+|[\s·•\-—|]+$/g, '')
    .trim();

  return title;
}

function parseMarkdownHeading(
  line: string,
): { level: number; text: string } | null {
  const match = line.match(/^(#{1,6})[ \t]+(.+?)\s*$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2].replace(/[ \t]+#+\s*$/, '').trim(),
  };
}

function normalizeHeadingForMatch(heading: string): string {
  return heading
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\d+[.、)\-]\s*/, '')
    .replace(/\s+/g, '')
    .trim();
}

function isDetailedSummaryHeading(heading: string): boolean {
  const normalized = normalizeHeadingForMatch(heading);
  return (
    normalized === '详细总结' ||
    normalized === '详细摘要' ||
    normalized === '详细内容' ||
    normalized === '逐段总结'
  );
}

function isContainerHeading(heading: string): boolean {
  const normalized = normalizeHeadingForMatch(heading);
  return (
    normalized === '视频总结' ||
    normalized === '核心总结' ||
    normalized === '详细总结' ||
    normalized === '详细摘要' ||
    normalized === '详细内容' ||
    normalized === '逐段总结' ||
    normalized === '结论/观点/建议' ||
    normalized === '结论观点建议'
  );
}

function parseHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseMarkdownHeading(lines[i]);
    if (!parsed) continue;
    headings.push({
      level: parsed.level,
      text: parsed.text,
      lineIndex: i,
      order: headings.length,
    });
  }
  return headings;
}

function findSectionEndLine(
  heading: MarkdownHeading,
  headings: MarkdownHeading[],
  lineCount: number,
): number {
  const nextBoundary = headings.find(
    (candidate) =>
      candidate.lineIndex > heading.lineIndex &&
      candidate.level <= heading.level,
  );
  return nextBoundary?.lineIndex ?? lineCount;
}

function buildSection(
  heading: MarkdownHeading,
  headings: MarkdownHeading[],
  lines: string[],
): SummarySection {
  const endLine = findSectionEndLine(heading, headings, lines.length);
  return {
    heading,
    bodyLines: lines.slice(heading.lineIndex + 1, endLine),
  };
}

function findCandidateHeadings(headings: MarkdownHeading[]): MarkdownHeading[] {
  const detailHeading = headings.find((heading) =>
    isDetailedSummaryHeading(heading.text),
  );

  if (detailHeading) {
    const detailEndLine = findSectionEndLine(
      detailHeading,
      headings,
      Number.POSITIVE_INFINITY,
    );
    const chapterLevel = Math.min(6, detailHeading.level + 1);
    return headings.filter(
      (heading) =>
        heading.level === chapterLevel &&
        heading.lineIndex > detailHeading.lineIndex &&
        heading.lineIndex < detailEndLine,
    );
  }

  return headings.filter(
    (heading) => heading.level === 2 && !isContainerHeading(heading.text),
  );
}

function normalizeKnownTimes(chapters: ParsedChapter[]): ParsedChapter[] {
  let previous = -1;
  return chapters.map((chapter) => {
    if (chapter.seconds === null) return chapter;
    if (chapter.seconds <= previous) {
      return { ...chapter, seconds: null, source: null };
    }
    previous = chapter.seconds;
    return chapter;
  });
}

function inferMissingTimes(
  chapters: ParsedChapter[],
  duration: number | null | undefined,
): ParsedChapter[] {
  if (!Number.isFinite(duration) || !duration || duration <= 0) {
    return chapters;
  }

  const safeDuration = Math.max(0, duration);
  const next = normalizeKnownTimes(chapters).map((chapter) => ({ ...chapter }));
  if (next.length === 0) return next;

  const knownIndexes = next
    .map((chapter, index) => (chapter.seconds === null ? null : index))
    .filter((index): index is number => index !== null);

  if (knownIndexes.length === 0) {
    return next.map((chapter, index) => ({
      ...chapter,
      seconds: (safeDuration * index) / next.length,
      source: 'inferred',
    }));
  }

  const firstKnownIndex = knownIndexes[0];
  const firstKnown = next[firstKnownIndex];
  const firstKnownSeconds =
    firstKnown.source === 'heading'
      ? (firstKnown.seconds ?? 0)
      : firstKnownIndex === 0
        ? 0
        : (firstKnown.seconds ?? 0);

  if (firstKnownIndex === 0 && firstKnown.source !== 'heading') {
    next[0] = { ...next[0], seconds: 0, source: 'inferred' };
  } else {
    for (let index = 0; index < firstKnownIndex; index++) {
      next[index] = {
        ...next[index],
        seconds: (firstKnownSeconds * index) / firstKnownIndex,
        source: 'inferred',
      };
    }
  }

  for (let i = 0; i < knownIndexes.length - 1; i++) {
    const leftIndex = knownIndexes[i];
    const rightIndex = knownIndexes[i + 1];
    const leftSeconds = next[leftIndex].seconds ?? 0;
    const rightSeconds = next[rightIndex].seconds ?? leftSeconds;
    const span = rightIndex - leftIndex;
    for (let index = leftIndex + 1; index < rightIndex; index++) {
      next[index] = {
        ...next[index],
        seconds:
          leftSeconds +
          ((rightSeconds - leftSeconds) * (index - leftIndex)) / span,
        source: 'inferred',
      };
    }
  }

  const lastKnownIndex = knownIndexes[knownIndexes.length - 1];
  const lastKnownSeconds = next[lastKnownIndex].seconds ?? 0;
  const tailSpan = next.length - lastKnownIndex;
  for (let index = lastKnownIndex + 1; index < next.length; index++) {
    next[index] = {
      ...next[index],
      seconds:
        lastKnownSeconds +
        ((safeDuration - lastKnownSeconds) * (index - lastKnownIndex)) /
          tailSpan,
      source: 'inferred',
    };
  }

  const minGap =
    safeDuration >= next.length ? 1 : safeDuration / next.length / 2;
  let previous = -minGap;
  return next.map((chapter, index) => {
    const remaining = next.length - index - 1;
    const maxStart = Math.max(0, safeDuration - remaining * minGap);
    const seconds = Math.min(
      maxStart,
      Math.max(previous + minGap, chapter.seconds ?? 0),
    );
    previous = seconds;
    return { ...chapter, seconds };
  });
}

export function extractSummaryChapters(
  markdown: string | null | undefined,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
  options: ExtractSummaryChaptersOptions = {},
): SummaryChapter[] {
  if (!markdown) return [];

  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const headings = parseHeadings(lines);
  const candidates = findCandidateHeadings(headings);
  const sections = candidates.map((heading) =>
    buildSection(heading, headings, lines),
  );
  const hasHeadingAnchors = sections.some(
    (section) => findFirstSeekSeconds(section.heading.text, video) !== null,
  );

  const parsedChapters = sections.map((section): ParsedChapter => {
    const body = section.bodyLines.join('\n').trim();
    const headingSeconds = findFirstSeekSeconds(section.heading.text, video);
    const bodySeconds =
      headingSeconds === null && !hasHeadingAnchors
        ? findFirstSeekSeconds(body, video)
        : null;
    const seconds = headingSeconds ?? bodySeconds;

    return {
      seconds,
      title:
        cleanHeadingTitle(section.heading.text, video) ||
        `第 ${section.heading.order + 1} 节`,
      body,
      order: section.heading.order,
      source:
        headingSeconds !== null
          ? 'heading'
          : bodySeconds !== null
            ? 'body'
            : null,
    };
  });

  const chaptersWithTimes = inferMissingTimes(parsedChapters, options.duration);

  return chaptersWithTimes
    .filter(
      (chapter): chapter is ParsedChapter & { seconds: number } =>
        chapter.seconds !== null,
    )
    .sort((a, b) =>
      Number.isFinite(options.duration) &&
      options.duration &&
      options.duration > 0
        ? a.order - b.order
        : a.seconds - b.seconds || a.order - b.order,
    )
    .map((chapter) => ({
      seconds: chapter.seconds,
      title: chapter.title,
      body: chapter.body,
    }));
}
