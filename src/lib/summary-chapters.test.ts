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

  it('multiple headings and sorting', () => {
    const markdown = `
### [05:00](https://youtube.com/watch?v=12345&t=300s) Late Chapter
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

  it('platform mismatch is ignored', () => {
    const markdown = `
## [01:00](https://bilibili.com/video/BV123?t=60) Bilibili Chapter
`;
    const chapters = extractSummaryChapters(markdown, dummyVideo);
    expect(chapters).toHaveLength(0); // empty because link doesn't match youtube
  });

  it('multiple timestamps take the first one', () => {
    const markdown = `
## [01:00](https://youtube.com/watch?v=12345&t=60s) - [02:00](https://youtube.com/watch?v=12345&t=120s) Dual Chapter
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
