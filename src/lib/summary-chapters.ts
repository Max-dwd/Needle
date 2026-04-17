import { parseSeekSeconds } from './format';

export interface SummaryChapter {
  seconds: number; // 起始时间（来自 section 内第一个可解析时间戳链接）
  title: string; // 去掉 Markdown 装饰后的纯文本标题
  body: string; // 到下一个标题之前的正文（原文，可能含行内 markdown）
}

interface SummarySection {
  heading: string;
  bodyLines: string[];
  order: number;
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

export function extractSummaryChapters(
  markdown: string | null | undefined,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): SummaryChapter[] {
  if (!markdown) return [];

  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const sections: SummarySection[] = [];
  let currentSection: SummarySection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      if (currentSection) sections.push(currentSection);
      currentSection = {
        heading: match[2],
        bodyLines: [],
        order: sections.length,
      };
      continue;
    }

    if (currentSection) {
      currentSection.bodyLines.push(line);
    }
  }

  if (currentSection) sections.push(currentSection);

  return sections
    .map((section) => {
      const body = section.bodyLines.join('\n').trim();
      const seconds = findFirstSeekSeconds(
        `${section.heading}\n${body}`,
        video,
      );
      if (seconds === null) return null;

      return {
        seconds,
        title: cleanHeadingTitle(section.heading, video),
        body,
        order: section.order,
      };
    })
    .filter(
      (chapter): chapter is SummaryChapter & { order: number } =>
        chapter !== null,
    )
    .sort((a, b) => a.seconds - b.seconds || a.order - b.order)
    .map((chapter) => ({
      seconds: chapter.seconds,
      title: chapter.title,
      body: chapter.body,
    }));
}
