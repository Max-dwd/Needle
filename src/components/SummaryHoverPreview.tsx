import React from 'react';
import type { VideoWithMeta } from '@/types';
import MarkdownRenderer from '@/components/MarkdownRenderer';

// Preserve emphasis when no interactive video context is available. React
// escapes all text here, so summary content is never inserted as raw HTML.
function renderPreviewText(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index} style={{ fontWeight: 700 }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
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
  video,
  onTimestampClick,
}: {
  markdown: string;
  video?: VideoWithMeta;
  onTimestampClick?: (seconds: number) => void;
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
        <div>
          {video && onTimestampClick ? (
            <MarkdownRenderer
              markdown={coreSummaryText}
              video={video}
              onTimestampClick={onTimestampClick}
              fontSizeVariant="compact"
              hideTimestamps={true}
            />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {renderPreviewText(coreSummaryText)}
            </div>
          )}
        </div>
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
                  {video && onTimestampClick ? (
                    <MarkdownRenderer
                      markdown={title}
                      video={video}
                      onTimestampClick={onTimestampClick}
                      fontSizeVariant="compact"
                      hideTimestamps={true}
                    />
                  ) : (
                    renderPreviewText(title)
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
