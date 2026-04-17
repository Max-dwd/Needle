import { parseSeekSeconds } from './format';

export interface SummaryChapter {
  seconds: number;   // 起始时间（来自标题里的时间戳链接）
  title: string;     // 去掉时间戳 markdown 后的纯文本标题
  body: string;      // 到下一个同级/更高级标题之前的正文（原文，可能含行内 markdown）
}

export function extractSummaryChapters(
  markdown: string | null | undefined,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): SummaryChapter[] {
  if (!markdown) return [];

  // 1. 先剥离 YAML frontmatter
  let text = markdown;
  const frontmatterMatch = text.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    text = text.slice(frontmatterMatch[0].length);
  }

  // 2. 扫描所有 ^(#{1,4})\s+(.+)$ 行
  const lines = text.split('\n');
  const chapters: SummaryChapter[] = [];
  
  let currentChapter: { seconds: number; title: string; bodyLines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      const headingText = match[2];
      
      // If we encounter any heading 1-4, it ends the body of the current chapter
      if (currentChapter) {
         chapters.push({
           seconds: currentChapter.seconds,
           title: currentChapter.title,
           body: currentChapter.bodyLines.join('\n').trim(),
         });
         currentChapter = null;
      }

      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let linkMatch;
      let seconds: number | null = null;
      const linksToStrip: string[] = [];

      while ((linkMatch = linkRegex.exec(headingText)) !== null) {
        const href = linkMatch[2];
        const parsed = parseSeekSeconds(href, video);
        if (typeof parsed === 'number' && !Number.isNaN(parsed) && parsed >= 0) {
           if (seconds === null) {
              seconds = parsed;
           }
           linksToStrip.push(linkMatch[0]);
        }
      }

      if (seconds !== null) {
        let cleanTitle = headingText;
        for (const link of linksToStrip) {
             // Use plain string replace for exact match
             cleanTitle = cleanTitle.replace(link, '');
        }
        // strip leading/trailing spaces and separators
        cleanTitle = cleanTitle.replace(/^[\s·•\-—|]+|[\s·•\-—|]+$/g, '').trim();

        currentChapter = {
          seconds,
          title: cleanTitle,
          bodyLines: [],
        };
      }
    } else {
      if (currentChapter) {
        currentChapter.bodyLines.push(line);
      }
    }
  }

  if (currentChapter) {
    chapters.push({
      seconds: currentChapter.seconds,
      title: currentChapter.title,
      body: currentChapter.bodyLines.join('\n').trim(),
    });
  }

  return chapters
    .filter(c => typeof c.seconds === 'number' && !Number.isNaN(c.seconds) && c.seconds >= 0)
    .sort((a, b) => a.seconds - b.seconds);
}
