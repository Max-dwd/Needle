import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownRenderer from '@/components/MarkdownRenderer';
import type { VideoWithMeta } from '@/types';

const video = {
  platform: 'youtube',
  video_id: 'abc123',
} as VideoWithMeta;

describe('MarkdownRenderer', () => {
  it('renders headings with distinct section styling', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        markdown: `# 总结

## 详细总结

### 小节
正文`,
        video,
        onTimestampClick: () => {},
      }),
    );

    expect(html).toContain('display:inline-block');
    expect(html).toContain('background:var(--bg-hover)');
    expect(html).toContain('border-bottom:4px solid var(--border)');
  });

  it('renders markdown unordered lists with *, +, and - bullets', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        markdown: `# 视频总结

## 核心总结

* 第一条
+ 第二条
- 第三条
`,
        video,
        onTimestampClick: () => {},
      }),
    );

    expect(html).toContain('<ul style=');
    expect(html).toContain('<li style=');
    expect(html).toContain('第一条');
    expect(html).toContain('第二条');
    expect(html).toContain('第三条');
  });

  it('renders markdown tables in the summary panel', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        markdown: `# 详细总结

| 项目 | 说明 | 时间戳 |
| --- | --- | --- |
| 事件 | **核心进展** | [00:17](https://www.youtube.com/watch?v=abc123&t=17s) |
| 影响 | 市场反应 | 无 |
`,
        video,
        onTimestampClick: () => {},
      }),
    );

    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('核心进展');
    expect(html).toContain('时间戳');
  });
});
