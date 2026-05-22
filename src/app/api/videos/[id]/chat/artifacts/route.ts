import { NextResponse } from 'next/server';
import {
  createChatArtifact,
  listChatArtifacts,
} from '@/lib/chat-artifacts';
import { getDb } from '@/lib/db';
import type { ChatMode } from '@/types';

function parseVideoId(id: string) {
  const videoId = Number(id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return null;
  }
  return videoId;
}

function ensureVideoExists(videoId: number) {
  return Boolean(
    getDb()
      .prepare('SELECT id FROM videos WHERE id = ? LIMIT 1')
      .get(videoId),
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseVideoId(id);
  if (!videoId) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }
  if (!ensureVideoExists(videoId)) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  return NextResponse.json({ items: listChatArtifacts(videoId) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseVideoId(id);
  if (!videoId) {
    return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });
  }
  if (!ensureVideoExists(videoId)) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const mode = body?.mode as ChatMode | undefined;
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const content = typeof body?.content === 'string' ? body.content : '';
  const rangeStart = Number(body?.rangeStart);
  const rangeEnd = Number(body?.rangeEnd);

  if (mode !== 'obsidian' && mode !== 'roast') {
    return NextResponse.json({ error: 'Invalid chat mode' }, { status: 400 });
  }
  if (
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd <= rangeStart
  ) {
    return NextResponse.json({ error: 'Invalid time range' }, { status: 400 });
  }
  if (!content.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 });
  }

  const item = createChatArtifact({
    videoId,
    mode,
    prompt,
    rangeStart,
    rangeEnd,
    content,
  });
  return NextResponse.json(item, { status: 201 });
}
