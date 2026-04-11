import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { batchCheckSummaryExistence } from '@/lib/video-summary';
import { getScopeLastRefreshAt } from '@/lib/refresh-history';
import { getAppSetting } from '@/lib/app-settings';

type QueryArg = string | number;

const VIDEO_SORT_KEY_SQL = `
  CASE
    WHEN julianday(v.published_at) IS NOT NULL THEN julianday(v.published_at)
    WHEN v.published_at = '刚刚' THEN julianday('now')
    WHEN v.published_at LIKE '%分钟前' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, '分钟前', '') AS INTEGER) || ' minutes'
    )
    WHEN v.published_at LIKE '%小时前' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, '小时前', '') AS INTEGER) || ' hours'
    )
    WHEN v.published_at LIKE '%天前' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, '天前', '') AS INTEGER) || ' days'
    )
    WHEN v.published_at LIKE '%周前' THEN julianday(
      'now',
      '-' || (CAST(REPLACE(v.published_at, '周前', '') AS INTEGER) * 7) || ' days'
    )
    WHEN v.published_at LIKE '%个月前' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, '个月前', '') AS INTEGER) || ' months'
    )
    WHEN v.published_at LIKE '%年前' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, '年前', '') AS INTEGER) || ' years'
    )
    WHEN v.published_at = 'just now' THEN julianday('now')
    WHEN v.published_at LIKE '% minute ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' minute ago', '') AS INTEGER) || ' minutes'
    )
    WHEN v.published_at LIKE '% minutes ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' minutes ago', '') AS INTEGER) || ' minutes'
    )
    WHEN v.published_at LIKE '% hour ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' hour ago', '') AS INTEGER) || ' hours'
    )
    WHEN v.published_at LIKE '% hours ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' hours ago', '') AS INTEGER) || ' hours'
    )
    WHEN v.published_at LIKE '% day ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' day ago', '') AS INTEGER) || ' days'
    )
    WHEN v.published_at LIKE '% days ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' days ago', '') AS INTEGER) || ' days'
    )
    WHEN v.published_at LIKE '% week ago' THEN julianday(
      'now',
      '-' || (CAST(REPLACE(v.published_at, ' week ago', '') AS INTEGER) * 7) || ' days'
    )
    WHEN v.published_at LIKE '% weeks ago' THEN julianday(
      'now',
      '-' || (CAST(REPLACE(v.published_at, ' weeks ago', '') AS INTEGER) * 7) || ' days'
    )
    WHEN v.published_at LIKE '% month ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' month ago', '') AS INTEGER) || ' months'
    )
    WHEN v.published_at LIKE '% months ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' months ago', '') AS INTEGER) || ' months'
    )
    WHEN v.published_at LIKE '% year ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' year ago', '') AS INTEGER) || ' years'
    )
    WHEN v.published_at LIKE '% years ago' THEN julianday(
      'now',
      '-' || CAST(REPLACE(v.published_at, ' years ago', '') AS INTEGER) || ' years'
    )
    ELSE julianday(v.created_at)
  END
`;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform'); // 'youtube' | 'bilibili' | null (all)
  const intent = searchParams.get('intent');
  const topic = searchParams.get('topic');
  const channel_id = searchParams.get('channel_id');
  const includeResearch = searchParams.get('include_research') === '1';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '30');
  const offset = (page - 1) * limit;

  const db = getDb();

  let whereClause = '';
  const args: QueryArg[] = [];

  if (platform || intent || topic || channel_id) {
    const conditions = [];
    if (platform) {
      conditions.push('v.platform = ?');
      args.push(platform);
    }
    if (intent) {
      if (intent === '未分类') {
        // Include channels with NULL, empty, literal '未分类', or orphaned intent
        // (intent name that doesn't exist in the intents table)
        conditions.push(
          "(c.intent = '未分类' OR c.intent IS NULL OR c.intent = '' OR NOT EXISTS (SELECT 1 FROM intents WHERE name = c.intent))",
        );
      } else {
        conditions.push('c.intent = ?');
        args.push(intent);
      }
    }
    if (topic) {
      conditions.push(
        'EXISTS (SELECT 1 FROM json_each(c.topics) WHERE json_each.value = ?)',
      );
      args.push(topic);
    }
    if (channel_id) {
      conditions.push('v.channel_id = ?');
      args.push(channel_id);
    }
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  const query = `
    SELECT v.id, v.channel_id, v.platform, v.video_id, v.title, v.thumbnail_url,
           v.published_at, v.duration, v.is_read, v.is_members_only, v.access_status,
           v.subtitle_status, v.subtitle_path, v.subtitle_language, v.subtitle_format,
           v.subtitle_error, v.subtitle_last_attempt_at, v.subtitle_cooldown_until, v.created_at,
           c.name as channel_name, c.avatar_url, c.channel_id as channel_channel_id, c.intent, c.topics,
           st.status as summary_status
           ${includeResearch ? `,
           CASE WHEN rf.id IS NULL THEN 0 ELSE 1 END as research_is_favorited,
           rf.id as research_favorite_id,
           rit.name as research_intent_type_name,
           CASE
             WHEN rf.note IS NULL THEN NULL
             WHEN length(rf.note) <= 50 THEN rf.note
             ELSE substr(rf.note, 1, 50)
           END as research_note_preview` : ''}
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
    LEFT JOIN summary_tasks st ON v.video_id = st.video_id AND v.platform = st.platform
    ${includeResearch ? `
    LEFT JOIN research_favorites rf ON rf.video_id = v.id AND rf.archived_at IS NULL
    LEFT JOIN research_intent_types rit ON rit.id = rf.intent_type_id
    ` : ''}
    ${whereClause}
    ORDER BY ${VIDEO_SORT_KEY_SQL} DESC, v.created_at DESC, v.id DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(query).all(...args, limit, offset) as Array<
    Record<string, unknown>
  >;
  const storedSummaryVideoIds = batchCheckSummaryExistence(
    rows.map((row) => ({
      platform: row.platform as 'youtube' | 'bilibili',
      video_id: row.video_id as string,
    })),
  );
  const videos = rows.map((row) => {
    const baseRow = { ...row };
    delete baseRow.research_is_favorited;
    delete baseRow.research_favorite_id;
    delete baseRow.research_intent_type_name;
    delete baseRow.research_note_preview;
    const research = includeResearch
      ? {
          is_favorited: Boolean(row.research_is_favorited),
          favorite_id:
            typeof row.research_favorite_id === 'number'
              ? row.research_favorite_id
              : undefined,
          intent_type_name:
            typeof row.research_intent_type_name === 'string'
              ? row.research_intent_type_name
              : undefined,
          note_preview:
            typeof row.research_note_preview === 'string'
              ? row.research_note_preview
              : undefined,
        }
      : undefined;
    if (
      !row.summary_status &&
      storedSummaryVideoIds.has(baseRow.video_id as string)
    ) {
      return {
        ...baseRow,
        summary_status: 'completed',
        research,
      };
    }
    return {
      ...baseRow,
      research,
    };
  });

  const countQuery = `
      SELECT COUNT(*) as count 
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      ${whereClause}
    `;

  const totalRes = db.prepare(countQuery).get(...args) as { count: number };
  const total = totalRes ? totalRes.count : 0;
  const last_refresh_at = getScopeLastRefreshAt({
    channelId: channel_id,
    intent,
    fallback: getAppSetting('scheduler_last_crawl'),
  });

  return NextResponse.json(
    { videos, total, page, limit, last_refresh_at },
    {
      headers: {
        'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    },
  );
}

export async function PATCH(req: NextRequest) {
  const { id, is_read } = await req.json();
  const db = getDb();
  db.prepare('UPDATE videos SET is_read = ? WHERE id = ?').run(
    is_read ? 1 : 0,
    id,
  );
  return NextResponse.json({ success: true });
}
