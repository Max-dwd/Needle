import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SummaryHoverPreview from '@/components/SummaryHoverPreview';

describe('SummaryHoverPreview', () => {
  it('renders detailed summary section titles only', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(SummaryHoverPreview, {
        markdown: `---
video_id: abc123
platform: youtube
---

# 核心总结

这是核心总结内容。

# 详细总结

## 第一部分

- 这一行不应该显示

## 第二部分

这里的正文也不应该显示
`,
      }),
    );

    expect(html).toContain('这是核心总结内容。');
    expect(html).toContain('详细总结');
    expect(html).toContain('第一部分');
    expect(html).toContain('第二部分');
    expect(html).not.toContain('这一行不应该显示');
    expect(html).not.toContain('这里的正文也不应该显示');
  });

  it('renders bold inline markdown in the hover preview', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(SummaryHoverPreview, {
        markdown: `---
video_id: abc123
platform: youtube
---

# 核心总结

这是**加粗**内容。
`,
      }),
    );

    expect(html).toContain('<strong style="font-weight:700">加粗</strong>');
    expect(html).toContain('这是');
    expect(html).toContain('内容。');
  });

  it('renders all core summary paragraphs', () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(SummaryHoverPreview, {
        markdown: `---
video_id: abc123
platform: youtube
---

# 核心总结

第一段内容。

第二段内容，包含**重点**。

# 详细总结

## 小节
`,
      }),
    );

    expect(html).toContain('第一段内容。');
    expect(html).toContain('第二段内容');
    expect(html).toContain('<strong style="font-weight:700">重点</strong>');
  });
});
