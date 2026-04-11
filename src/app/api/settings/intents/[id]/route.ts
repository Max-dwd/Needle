import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { Intent } from '@/lib/db';
import { removeArtifactDir } from '@/lib/intent-agent';

const VALID_AGENT_TRIGGERS = new Set(['manual', 'daily', 'on_new_videos']);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const db = getDb();

  const intent = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(id) as Intent | undefined;
  if (!intent) {
    return NextResponse.json({ error: '意图不存在' }, { status: 404 });
  }

  // --- Validate before entering transaction ---

  // Handle name update
  let newName: string | undefined;
  if (body?.name !== undefined) {
    newName = typeof body.name === 'string' ? body.name.trim() : '';

    if (!newName) {
      return NextResponse.json(
        { error: '意图名称不能为空' },
        { status: 400 },
      );
    }
    if (newName.length > 100) {
      return NextResponse.json(
        { error: '意图名称过长（最多 100 字符）' },
        { status: 400 },
      );
    }

    // Reject rename of 未分类
    if (intent.name === '未分类') {
      return NextResponse.json(
        { error: '未分类 不能被重命名' },
        { status: 400 },
      );
    }

    // Reject duplicate names
    if (newName !== intent.name) {
      const duplicate = db
        .prepare('SELECT id FROM intents WHERE name = ? AND id != ?')
        .get(newName, id);
      if (duplicate) {
        return NextResponse.json(
          { error: `意图 "${newName}" 已存在` },
          { status: 409 },
        );
      }
    } else {
      newName = undefined; // no actual change
    }
  }

  // Validate agent_trigger enum
  if (body?.agent_trigger !== undefined && body.agent_trigger !== null) {
    if (typeof body.agent_trigger !== 'string' || !VALID_AGENT_TRIGGERS.has(body.agent_trigger)) {
      return NextResponse.json(
        { error: `无效的触发方式，允许值: ${[...VALID_AGENT_TRIGGERS].join(', ')}` },
        { status: 400 },
      );
    }
  }

  // --- Apply all updates in a single transaction ---
  const applyUpdates = db.transaction(() => {
    if (newName) {
      db.prepare(`UPDATE channels SET intent = ? WHERE intent = ?`).run(newName, intent.name);
      db.prepare(`UPDATE intents SET name = ? WHERE id = ?`).run(newName, id);
    }

    if (body?.auto_subtitle !== undefined) {
      db.prepare(`UPDATE intents SET auto_subtitle = ? WHERE id = ?`).run(
        body.auto_subtitle ? 1 : 0,
        id,
      );
    }
    if (body?.auto_summary !== undefined) {
      db.prepare(`UPDATE intents SET auto_summary = ? WHERE id = ?`).run(
        body.auto_summary ? 1 : 0,
        id,
      );
    }

    if (body?.auto_summary_model_id !== undefined) {
      const modelId =
        typeof body.auto_summary_model_id === 'string' &&
        body.auto_summary_model_id.trim() !== ''
          ? body.auto_summary_model_id.trim()
          : null;
      db.prepare(
        `UPDATE intents SET auto_summary_model_id = ? WHERE id = ?`,
      ).run(modelId, id);
    }

    if (body?.agent_prompt !== undefined) {
      const val = typeof body.agent_prompt === 'string' ? body.agent_prompt : null;
      db.prepare(`UPDATE intents SET agent_prompt = ? WHERE id = ?`).run(val, id);
    }
    if (body?.agent_trigger !== undefined) {
      const val = typeof body.agent_trigger === 'string' ? body.agent_trigger : null;
      db.prepare(`UPDATE intents SET agent_trigger = ? WHERE id = ?`).run(val, id);
    }
    if (body?.agent_schedule_time !== undefined) {
      const val = typeof body.agent_schedule_time === 'string' && /^\d{2}:\d{2}$/.test(body.agent_schedule_time)
        ? body.agent_schedule_time
        : '09:00';
      db.prepare(`UPDATE intents SET agent_schedule_time = ? WHERE id = ?`).run(val, id);
    }
    if (body?.agent_memory !== undefined) {
      const val = typeof body.agent_memory === 'string' ? body.agent_memory : null;
      db.prepare(`UPDATE intents SET agent_memory = ? WHERE id = ?`).run(val, id);
    }
  });

  applyUpdates();

  const updated = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(id) as Intent;
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const intent = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(id) as Intent | undefined;
  if (!intent) {
    return NextResponse.json({ error: '意图不存在' }, { status: 404 });
  }

  if (intent.name === '未分类') {
    return NextResponse.json(
      { error: '未分类 不能被删除' },
      { status: 400 },
    );
  }

  // Reassign channels and delete in a single transaction
  const deleteIntent = db.transaction(() => {
    db.prepare(
      `UPDATE channels SET intent = '未分类' WHERE intent = ?`,
    ).run(intent.name);
    db.prepare('DELETE FROM intents WHERE id = ?').run(id);
  });

  deleteIntent();

  // Clean up artifact directory (best-effort, outside transaction)
  try {
    removeArtifactDir(intent.name);
  } catch {
    // non-critical — orphaned directory is acceptable
  }

  return NextResponse.json({ success: true });
}
