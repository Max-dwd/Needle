import React from 'react';

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    nodes.push(
      <strong key={`bold-${match.index}`} style={{ fontWeight: 700 }}>
        {match[1]}
      </strong>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown;
  const closingIndex = markdown.indexOf('\n---\n', 4);
  if (closingIndex === -1) return markdown;
  return markdown.slice(closingIndex + 5).trim();
}

function extractSummaryPreview(markdown: string): {
  coreSummaryLines: string[];
  detailTitles: string[];
} {
  const cleanMarkdown = stripFrontmatter(markdown);
  const lines = cleanMarkdown.split('\n');

  let inCoreSummary = false;
  let inDetailSummary = false;
  const coreSummaryLines: string[] = [];
  const detailTitles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      if (level === 1) {
        inCoreSummary = text === '核心总结';
        inDetailSummary = text === '详细总结';
        continue;
      }

      if (level === 2 && inDetailSummary) {
        detailTitles.push(text);
      }
      continue;
    }

    if (inCoreSummary) {
      coreSummaryLines.push(line);
      continue;
    }
  }

  return {
    coreSummaryLines,
    detailTitles,
  };
}

export default function SummaryHoverPreview({
  markdown,
}: {
  markdown: string;
}) {
  const { coreSummaryLines, detailTitles } = extractSummaryPreview(markdown);
  const coreSummaryText =
    coreSummaryLines
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
      .trim() || '暂无内容';

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '16px 18px',
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--text-primary)',
        width: 'fit-content',
        maxWidth: 520,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: 13,
          color: 'var(--text-muted)',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 6,
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span style={{ color: '#60a5fa' }}>✨</span> 核心总结
      </div>
      <div
        style={{
          width: '100%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginBottom: 0,
          color: 'var(--text-primary)',
          textAlign: 'left',
          overflow: 'visible',
        }}
      >
        <div>{renderInlineMarkdown(coreSummaryText)}</div>
        {detailTitles.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: 'var(--text-muted)',
                marginBottom: 8,
              }}
            >
              详细总结
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
              gap: 6,
              }}
            >
              {detailTitles.map((title, index) => (
                <div key={`${title}-${index}`}>
                  {renderInlineMarkdown(title)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
