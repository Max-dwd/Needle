'use client';

import type { ReactNode } from 'react';
import { parseSeekSeconds } from '@/lib/format';
import type { VideoWithMeta } from '@/types';

function renderInlineMarkdown(
  text: string,
  video: VideoWithMeta,
  onTimestampClick: (seconds: number) => void,
  tone: 'light' | 'dark',
  hideTimestamps: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  const isDarkTone = tone === 'dark';
  const strongColor = 'var(--text-primary)';
  const accentColor = 'var(--accent-purple)';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[3]) {
      nodes.push(
        <strong
          key={`bold-${match.index}`}
          style={{ fontWeight: 700, color: strongColor }}
        >
          {match[3]}
        </strong>,
      );
    } else {
      const label = match[1];
      const href = match[2];
      const seekSeconds = parseSeekSeconds(href, video);
      if (seekSeconds !== null) {
        nodes.push(
          <button
            key={`${href}-${match.index}`}
            type="button"
            onClick={() => onTimestampClick(seekSeconds)}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              color: hideTimestamps ? 'inherit' : accentColor,
              cursor: hideTimestamps ? 'text' : 'pointer',
              textDecoration: hideTimestamps ? 'none' : 'underline',
              font: 'inherit',
            }}
          >
            {hideTimestamps ? '' : label}
          </button>,
        );
      } else {
        nodes.push(
          <a
            key={`${href}-${match.index}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: accentColor, textDecoration: 'underline' }}
          >
            {label}
          </a>,
        );
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function parseTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split('|').map((cell) => cell.trim());
}

function isTableSeparatorRow(line: string): boolean {
  const cells = parseTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

export default function MarkdownRenderer({
  markdown,
  video,
  onTimestampClick,
  streaming = false,
  tone = 'light',
  fontSizeVariant = 'normal',
  hideTimestamps = false,
}: {
  markdown: string;
  video: VideoWithMeta;
  onTimestampClick: (seconds: number) => void;
  streaming?: boolean;
  tone?: 'light' | 'dark';
  fontSizeVariant?: 'normal' | 'compact';
  hideTimestamps?: boolean;
}) {
  const isDarkTone = tone === 'dark';
  const textColor = 'var(--text-primary)';
  const headingColor = 'var(--text-primary)';
  const headingGray = 'var(--bg-hover)';
  const headingGrayStrong = 'var(--border)';
  const cursorColor = 'var(--accent-purple)';

  const isCompact = fontSizeVariant === 'compact';
  const baseSize = isCompact ? 12 : 14;
  const lineMultiplier = isCompact ? 1.5 : 1.7;
  const marginMultiplier = isCompact ? 0.6 : 1;

  const lines = markdown.split('\n');
  let streamingLastLine = '';
  if (streaming && lines.length > 0) {
    const lastElement = lines.pop();
    if (lastElement !== undefined && lastElement !== '') {
      streamingLastLine = lastElement;
    }
  }

  const elements: ReactNode[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let isOrderedList = false;
  let listStartNumber = 1;
  let tableHeader: string[] | null = null;
  let tableRows: string[][] = [];
  let hasRenderedBlock = false;

  const pushSectionSpacer = () => {
    if (!hasRenderedBlock) return;
    elements.push(
      <div
        key={`spacer-${elements.length}`}
        aria-hidden="true"
        style={{ height: 12 * marginMultiplier }}
      />,
    );
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const text = paragraphLines.join(' ').trim();
    if (text) {
      elements.push(
        <p
          key={`p-${elements.length}`}
          style={{
            color: textColor,
            fontSize: baseSize,
            lineHeight: lineMultiplier,
            margin: `0 0 ${10 * marginMultiplier}px`,
          }}
        >
          {renderInlineMarkdown(
            text,
            video,
            onTimestampClick,
            tone,
            hideTimestamps,
          )}
        </p>,
      );
      hasRenderedBlock = true;
    }
    paragraphLines = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const ListTag = isOrderedList ? 'ol' : 'ul';
    elements.push(
      <ListTag
        key={`list-${elements.length}`}
        start={isOrderedList ? listStartNumber : undefined}
        style={{
          margin: `0 0 ${12 * marginMultiplier}px`,
          paddingLeft: isOrderedList ? 26 : 18,
          fontSize: baseSize,
          lineHeight: lineMultiplier,
          color: textColor,
          listStyleType: isOrderedList ? 'decimal' : 'disc',
        }}
      >
        {listItems.map((item, index) => (
          <li
            key={`li-${index}`}
            style={{ marginBottom: 8 * marginMultiplier, lineHeight: 1.6 }}
          >
            {renderInlineMarkdown(
              item,
              video,
              onTimestampClick,
              tone,
              hideTimestamps,
            )}
          </li>
        ))}
      </ListTag>,
    );
    hasRenderedBlock = true;
    listItems = [];
    isOrderedList = false;
    listStartNumber = 1;
  };

  const flushTable = () => {
    if (!tableHeader || tableRows.length === 0) {
      tableHeader = null;
      tableRows = [];
      return;
    }
    const header = tableHeader;

    elements.push(
      <div
        key={`table-wrap-${elements.length}`}
        style={{
          overflowX: 'auto',
          margin: '0 0 12px',
          border: `1px solid var(--border)`,
          borderRadius: 10,
          background: 'var(--bg-secondary)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: baseSize,
            lineHeight: lineMultiplier,
            color: textColor,
          }}
        >
          <thead>
            <tr style={{ background: 'var(--bg-hover)' }}>
              {header.map((cell, index) => (
                <th
                  key={`th-${index}`}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderBottom: `1px solid var(--border)`,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {renderInlineMarkdown(
                    cell,
                    video,
                    onTimestampClick,
                    tone,
                    hideTimestamps,
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row, rowIndex) => (
              <tr key={`tr-${rowIndex}`}>
                {header.map((_, cellIndex) => (
                  <td
                    key={`td-${rowIndex}-${cellIndex}`}
                    style={{
                      padding: '10px 12px',
                      borderBottom:
                        rowIndex === tableRows.length - 1
                          ? 'none'
                          : `1px solid var(--border)`,
                      verticalAlign: 'top',
                    }}
                  >
                    {renderInlineMarkdown(
                      row[cellIndex] || '',
                      video,
                      onTimestampClick,
                      tone,
                      hideTimestamps,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    hasRenderedBlock = true;
    tableHeader = null;
    tableRows = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushTable();

      // Lookahead: Only flush the list if the next non-empty line isn't a list item of the same type.
      // This allows supporting list items separated by blank lines (loose lists).
      let shouldFlushList = true;
      if (listItems.length > 0) {
        for (let j = index + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].trim();
          if (!nextTrimmed) continue;
          const nextOrdered = /^\d+\.\s+/.test(nextTrimmed);
          const nextUnordered = /^([-*+])\s+/.test(nextTrimmed);
          if (
            (isOrderedList && nextOrdered) ||
            (!isOrderedList && nextUnordered)
          ) {
            shouldFlushList = false;
          }
          break;
        }
      }

      if (shouldFlushList) {
        flushList();
      }
      continue;
    }

    const nextLine = lines[index + 1]?.trim() || '';
    if (
      line.includes('|') &&
      nextLine.includes('|') &&
      isTableSeparatorRow(nextLine)
    ) {
      flushParagraph();
      flushList();
      flushTable();
      tableHeader = parseTableRow(line);
      index += 1;
      continue;
    }

    if (tableHeader && line.includes('|')) {
      tableRows.push(parseTableRow(line));
      continue;
    }

    if (tableHeader) {
      flushTable();
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushTable();
      pushSectionSpacer();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const fontSize =
        level === 1
          ? isCompact ? 16 : 20
          : level === 2
          ? isCompact ? 14 : 16
          : baseSize;
      const marginTop = level === 1 ? 0 : 12 * marginMultiplier;
      const headingNode =
        level === 1 ? (
          <span
            style={{
              display: 'inline-block',
              padding: '6px 10px',
              borderRadius: 8,
              background: headingGray,
              color: headingColor,
              boxShadow: isDarkTone
                ? 'inset 0 0 0 1px rgba(148, 163, 184, 0.18)'
                : 'inset 0 0 0 1px rgba(148, 163, 184, 0.12)',
            }}
          >
            {renderInlineMarkdown(
              text,
              video,
              onTimestampClick,
              tone,
              hideTimestamps,
            )}
          </span>
        ) : level === 2 ? (
          <span
            style={{
              display: 'inline-block',
              paddingBottom: 4,
              borderBottom: `4px solid ${headingGrayStrong}`,
              color: headingColor,
            }}
          >
            {renderInlineMarkdown(
              text,
              video,
              onTimestampClick,
              tone,
              hideTimestamps,
            )}
          </span>
        ) : (
          renderInlineMarkdown(text, video, onTimestampClick, tone, hideTimestamps)
        );
      elements.push(
        <div
          key={`h-${elements.length}`}
          style={{
            color: headingColor,
            fontWeight: level === 3 ? 700 : 800,
            fontSize,
            lineHeight: 1.3,
            margin: `${marginTop}px 0 8px`,
          }}
        >
          {headingNode}
        </div>,
      );
      hasRenderedBlock = true;
      continue;
    }

    const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    const unorderedMatch = line.match(/^([-*+])\s+(.+)$/);
    if (orderedMatch || unorderedMatch) {
      const isCurrentOrdered = !!orderedMatch;
      // If switching between ordered and unordered, flush the current list
      if (listItems.length > 0 && isOrderedList !== isCurrentOrdered) {
        flushList();
      }
      if (listItems.length === 0 && orderedMatch) {
        listStartNumber = parseInt(orderedMatch[1], 10);
      }
      isOrderedList = isCurrentOrdered;
      flushParagraph();
      flushTable();
      listItems.push(isCurrentOrdered ? orderedMatch![2] : unorderedMatch![2]);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();

  return (
    <div style={{ position: 'relative' }}>
      {elements}
      {streamingLastLine && (
        <span
          style={{
            color: textColor,
            fontSize: baseSize,
            lineHeight: lineMultiplier,
          }}
        >
          {streamingLastLine}
        </span>
      )}
      {streaming && (
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 16,
            background: cursorColor,
            borderRadius: 1,
            animation: 'cursorBlink 1s steps(2) infinite',
            verticalAlign: 'text-bottom',
            marginLeft: 2,
          }}
        />
      )}
    </div>
  );
}
