import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { exportResearchCollectionPack, type ResearchExportItem } from '@/lib/research';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const collectionId = Number.parseInt(String(body?.collection_id ?? ''), 10);
  const skipMissingSubtitles = body?.skip_missing_subtitles === true;

  if (!Number.isFinite(collectionId)) {
    return NextResponse.json({ error: 'collection_id 无效' }, { status: 400 });
  }

  const db = getDb();
  const collection = db
    .prepare(
      `
        SELECT *
        FROM research_collections
        WHERE id = ? AND archived_at IS NULL
      `,
    )
    .get(collectionId) as
    | {
        id: number;
        name: string;
        slug: string;
        goal: string | null;
        description: string | null;
      }
    | undefined;

  if (!collection) {
    return NextResponse.json({ error: '清单不存在' }, { status: 404 });
  }

  const items = db
    .prepare(
      `
        SELECT rci.favorite_id, rci.override_note, rci.override_intent_type_id,
               rf.note,
               v.title, v.platform, v.video_id AS platform_video_id,
               v.subtitle_status, v.subtitle_path,
               COALESCE(c.name, v.channel_name) AS channel_name,
               COALESCE(orit.name, rit.name) AS intent_name,
               COALESCE(orit.export_template, rit.export_template) AS intent_template
        FROM research_collection_items rci
        JOIN research_favorites rf ON rf.id = rci.favorite_id
        JOIN videos v ON v.id = rf.video_id
        LEFT JOIN channels c ON c.id = v.channel_id
        JOIN research_intent_types rit ON rit.id = rf.intent_type_id
        LEFT JOIN research_intent_types orit ON orit.id = rci.override_intent_type_id
        WHERE rci.collection_id = ?
        ORDER BY rci.sort_order ASC, rci.created_at ASC
      `,
    )
    .all(collectionId) as ResearchExportItem[];

  const result = exportResearchCollectionPack({
    collectionSlug: collection.slug,
    collectionName: collection.name,
    collectionGoal: collection.goal,
    collectionDescription: collection.description,
    items,
    skipMissingSubtitles,
  });

  if (result.needs_confirmation) {
    return NextResponse.json(result);
  }

  return NextResponse.json(result);
}
