import { getDb, type ChatArtifact } from './db';
import { formatSecondsLabel } from './format';
import type { ChatMode } from '@/types';

export interface CreateChatArtifactInput {
  videoId: number;
  mode: ChatMode;
  prompt: string;
  rangeStart: number;
  rangeEnd: number;
  content: string;
}

export interface ChatArtifactPayload {
  id: number;
  video_id: number;
  mode: ChatMode;
  prompt: string;
  rangeStart: number;
  rangeEnd: number;
  content: string;
  createdAt: string;
}

function toPayload(row: ChatArtifact): ChatArtifactPayload {
  return {
    id: row.id,
    video_id: row.video_id,
    mode: row.mode,
    prompt: row.prompt,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function listChatArtifacts(videoId: number): ChatArtifactPayload[] {
  const rows = getDb()
    .prepare(
      `
        SELECT *
        FROM chat_artifacts
        WHERE video_id = ?
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(videoId) as ChatArtifact[];
  return rows.map(toPayload);
}

export function createChatArtifact(
  input: CreateChatArtifactInput,
): ChatArtifactPayload {
  const prompt = input.prompt.trim();
  const content = input.content.trim();
  if (!content) {
    throw new Error('content is required');
  }

  const result = getDb()
    .prepare(
      `
        INSERT INTO chat_artifacts (
          video_id,
          mode,
          prompt,
          range_start,
          range_end,
          content
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.videoId,
      input.mode,
      prompt,
      input.rangeStart,
      input.rangeEnd,
      content,
    );

  const row = getDb()
    .prepare('SELECT * FROM chat_artifacts WHERE id = ?')
    .get(result.lastInsertRowid) as ChatArtifact;
  return toPayload(row);
}

export function formatChatArtifactMarkdown(
  artifact: ChatArtifactPayload,
): string {
  const modeLabel = artifact.mode === 'roast' ? '吐槽模式' : '笔记模式';
  const prompt = artifact.prompt || '无';
  return [
    '---',
    `artifact: chat`,
    `mode: ${artifact.mode}`,
    `created_at: ${artifact.createdAt}`,
    `range: ${formatSecondsLabel(artifact.rangeStart)}-${formatSecondsLabel(artifact.rangeEnd)}`,
    '---',
    '',
    `# 视频问答 - ${modeLabel}`,
    '',
    `- 时间范围：${formatSecondsLabel(artifact.rangeStart)} - ${formatSecondsLabel(artifact.rangeEnd)}`,
    `- 用户输入：${prompt}`,
    '',
    artifact.content,
  ].join('\n');
}
