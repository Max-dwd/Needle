import { describe, it, expect } from 'vitest';
import { extractSummaryChapters } from './summary-chapters';

describe('extractSummaryChapters', () => {
  const dummyVideo = { platform: 'youtube' as const, video_id: '12345' };

  it('handles empty or null markdown', () => {
    expect(extractSummaryChapters(null, dummyVideo)).toEqual([]);
    expect(extractSummaryChapters('', dummyVideo)).toEqual([]);
  });

  it('strips YAML frontmatter', () => {
    const markdown = `---
title: test
---
## [01:00](https://youtube.com/watch?v=12345&t=60s) Chapter 1
Body 1
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].seconds).toBe(60);
  });

  it('ignores headings without timestamp links or unparseable time', () => {
    const markdown = `
## Introduction
Some intro text
## [Chapter 1](invalid)
More text
## [02:00](https://youtube.com/watch?v=12345&t=120s) Valid Chapter
Valid text
    `;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].seconds).toBe(120);
    expect(chapters[0].title).toBe('Valid Chapter');
    expect(chapters[0].body).toBe('Valid text');
  });

  it('uses the first timestamp in a section body when the heading has none', () => {
    const markdown = `
## Section From Body
- First point [01:10](https://youtube.com/watch?v=12345&t=70s)
- Later point [02:20](https://youtube.com/watch?v=12345&t=140s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].seconds).toBe(70);
    expect(chapters[0].title).toBe('Section From Body');
    expect(chapters[0].body).toContain('First point');
  });

  it('prefers heading timestamps over body timestamps in the same section', () => {
    const markdown = `
## [00:30](https://youtube.com/watch?v=12345&t=30s) Heading Time
- Body point [01:10](https://youtube.com/watch?v=12345&t=70s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].seconds).toBe(30);
    expect(chapters[0].title).toBe('Heading Time');
  });

  it('keeps non-timestamp heading links as text while stripping timestamp links', () => {
    const markdown = `
## **[Topic](https://example.com/topic)** • [01:00](https://youtube.com/watch?v=12345&t=60s)
Body
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Topic');
  });

  it('multiple headings and sorting', () => {
    const markdown = `
## [05:00](https://youtube.com/watch?v=12345&t=300s) Late Chapter
Late text
## [01:00](https://youtube.com/watch?v=12345&t=60s) Early Chapter
Early text
    `;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].seconds).toBe(60);
    expect(chapters[0].title).toBe('Early Chapter');
    expect(chapters[1].seconds).toBe(300);
    expect(chapters[1].title).toBe('Late Chapter');
  });

  it('uses h2 headings as chapters and keeps nested h3 content in the parent body', () => {
    const markdown = `
## Parent
Parent body [01:00](https://youtube.com/watch?v=12345&t=60s)
### Child
Child body [02:00](https://youtube.com/watch?v=12345&t=120s)
## Sibling
Sibling body [03:00](https://youtube.com/watch?v=12345&t=180s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(2);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'Parent',
      'Sibling',
    ]);
    expect(chapters[0].body).toContain(
      'Parent body [01:00](https://youtube.com/watch?v=12345&t=60s)',
    );
    expect(chapters[0].body).toContain('### Child');
    expect(chapters[0].body).toContain('Child body');
  });

  it('uses h2 headings inside the detailed summary section and ignores core timestamps', () => {
    const markdown = `
# 核心总结
Core point [00:15](https://youtube.com/watch?v=12345&t=15s)

# 详细总结

## 1. Opening
- Detail [01:00](https://youtube.com/watch?v=12345&t=60s)

## 2. Middle
- Detail [03:00](https://youtube.com/watch?v=12345&t=180s)

# 结论 / 观点 / 建议
Final [09:00](https://youtube.com/watch?v=12345&t=540s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      '1. Opening',
      '2. Middle',
    ]);
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([60, 180]);
  });

  it('keeps legacy converted summaries that put chapters under h3 headings', () => {
    const markdown = `
## 详细总结

### Legacy One
- Detail [01:00](https://youtube.com/watch?v=12345&t=60s)

### Legacy Two
- Detail [02:00](https://youtube.com/watch?v=12345&t=120s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'Legacy One',
      'Legacy Two',
    ]);
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([60, 120]);
  });

  it('infers missing h2 chapter starts from duration when summary anchors are incomplete', () => {
    const markdown = `
# 详细总结

## 1. Opening
No timestamp here.

## 2. Setup
Still no timestamp.

## 3. Payoff
- Detail [05:00](https://youtube.com/watch?v=12345&t=300s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo, {
      duration: 600,
    });
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      '1. Opening',
      '2. Setup',
      '3. Payoff',
    ]);
    expect(chapters.map((chapter) => chapter.seconds)).toEqual([0, 150, 300]);
  });

  it('keeps document order when sections share the same first timestamp', () => {
    const markdown = `
## First
Same time [01:00](https://youtube.com/watch?v=12345&t=60s)
## Second
Same time [01:00](https://youtube.com/watch?v=12345&t=60s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('platform mismatch is ignored', () => {
    const markdown = `
## Bilibili Chapter
[01:00](https://bilibili.com/video/BV123?t=60)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(0); // empty because link doesn't match youtube
  });

  it('multiple timestamps take the first one', () => {
    const markdown = `
## Dual Chapter
[01:00](https://youtube.com/watch?v=12345&t=60s) - [02:00](https://youtube.com/watch?v=12345&t=120s)
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].seconds).toBe(60);
    expect(chapters[0].title).toBe('Dual Chapter');
  });

  it('cleans separators', () => {
    const markdown = `
## • [01:00](https://youtube.com/watch?v=12345&t=60s) — Hello World | 
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters[0].title).toBe('Hello World');
  });
});
