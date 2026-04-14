import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  SummaryTaskStatus,
  VideoAvailabilityStatus,
} from '@/types';

const DB_PATH = process.env.DATABASE_PATH || './data/folo.db';
const CHANNEL_INTENT_MIGRATION_KEY = 'channels_intent_topics_migrated_v1';
const RESEARCH_INTENT_TYPES_SEEDED_KEY = 'research_intent_types_seeded_v1';
const DEFAULT_INTENTS = [
  { id: 1, name: '工作', auto_subtitle: 1, auto_summary: 1, sort_order: 0 },
  { id: 2, name: '娱乐', auto_subtitle: 0, auto_summary: 0, sort_order: 1 },
  { id: 3, name: '探索', auto_subtitle: 1, auto_summary: 0, sort_order: 2 },
  { id: 4, name: '新闻', auto_subtitle: 1, auto_summary: 1, sort_order: 3 },
  { id: 5, name: '未分类', auto_subtitle: 0, auto_summary: 0, sort_order: 99 },
] as const;
const DEFAULT_RESEARCH_INTENT_TYPES = [
  { name: '信息验证', slug: 'fact-check', sort_order: 0 },
  { name: 'Deep Research', slug: 'deep-research', sort_order: 1 },
  { name: '学习探索', slug: 'learning', sort_order: 2 },
] as const;

let db: Database.Database | null = null;

/**
 * Lazily opens the SQLite database, applies pragmas, and ensures the schema exists.
 *
 * @returns The shared Better SQLite3 database instance for server-side data access.
 */
export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(DB_PATH);
    fs.mkdirSync(dbDir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (!db) {
    return;
  }
  db.close();
  db = null;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      name TEXT,
      avatar_url TEXT,
      crawl_error_count INTEGER DEFAULT 0,
      crawl_backoff_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      video_id TEXT NOT NULL UNIQUE,
      title TEXT,
      thumbnail_url TEXT,
      published_at DATETIME,
      duration TEXT,
      is_read INTEGER DEFAULT 0,
      access_status TEXT,
      availability_status TEXT,
      availability_reason TEXT,
      availability_checked_at DATETIME,
      subtitle_path TEXT,
      subtitle_language TEXT,
      subtitle_format TEXT,
      subtitle_status TEXT,
      subtitle_error TEXT,
      subtitle_last_attempt_at DATETIME,
      subtitle_retry_count INTEGER NOT NULL DEFAULT 0,
      subtitle_cooldown_until DATETIME,
      members_only_checked_at DATETIME,
      automation_tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      auto_subtitle INTEGER NOT NULL DEFAULT 0,
      auto_summary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_intents_sort_order ON intents(sort_order, id);

    CREATE TABLE IF NOT EXISTS summary_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      method TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      UNIQUE(video_id, platform)
    );
    CREATE INDEX IF NOT EXISTS idx_summary_tasks_status ON summary_tasks(status);

    CREATE TABLE IF NOT EXISTS research_intent_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      is_preset INTEGER NOT NULL DEFAULT 0,
      export_template TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS research_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
      intent_type_id INTEGER NOT NULL REFERENCES research_intent_types(id),
      note TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS research_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      goal TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS research_collection_items (
      collection_id INTEGER NOT NULL REFERENCES research_collections(id) ON DELETE CASCADE,
      favorite_id INTEGER NOT NULL REFERENCES research_favorites(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      override_intent_type_id INTEGER REFERENCES research_intent_types(id),
      override_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (collection_id, favorite_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rf_video_id ON research_favorites(video_id);
    CREATE INDEX IF NOT EXISTS idx_rf_archived_created ON research_favorites(archived_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rci_collection ON research_collection_items(collection_id);
    CREATE INDEX IF NOT EXISTS idx_rci_favorite ON research_collection_items(favorite_id);
  `);

  // Migrations — safe to run multiple times
  const cols = (
    db.prepare('PRAGMA table_info(videos)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes('is_members_only')) {
    db.exec('ALTER TABLE videos ADD COLUMN is_members_only INTEGER DEFAULT 0');
  }
  if (!cols.includes('access_status')) {
    db.exec('ALTER TABLE videos ADD COLUMN access_status TEXT');
  }
  if (!cols.includes('availability_status')) {
    db.exec('ALTER TABLE videos ADD COLUMN availability_status TEXT');
  }
  if (!cols.includes('availability_reason')) {
    db.exec('ALTER TABLE videos ADD COLUMN availability_reason TEXT');
  }
  if (!cols.includes('availability_checked_at')) {
    db.exec('ALTER TABLE videos ADD COLUMN availability_checked_at DATETIME');
  }
  if (!cols.includes('subtitle_path')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_path TEXT');
  }
  if (!cols.includes('subtitle_language')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_language TEXT');
  }
  if (!cols.includes('subtitle_format')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_format TEXT');
  }
  if (!cols.includes('subtitle_status')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_status TEXT');
  }
  if (!cols.includes('subtitle_error')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_error TEXT');
  }
  if (!cols.includes('subtitle_last_attempt_at')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_last_attempt_at DATETIME');
  }
  if (!cols.includes('subtitle_retry_count')) {
    db.exec(
      'ALTER TABLE videos ADD COLUMN subtitle_retry_count INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!cols.includes('subtitle_cooldown_until')) {
    db.exec('ALTER TABLE videos ADD COLUMN subtitle_cooldown_until DATETIME');
  }
  if (!cols.includes('members_only_checked_at')) {
    db.exec('ALTER TABLE videos ADD COLUMN members_only_checked_at DATETIME');
  }
  if (!cols.includes('automation_tags')) {
    db.exec("ALTER TABLE videos ADD COLUMN automation_tags TEXT DEFAULT '[]'");
  }
  if (!cols.includes('source')) {
    db.exec("ALTER TABLE videos ADD COLUMN source TEXT");
  }
  if (!cols.includes('channel_name')) {
    db.exec("ALTER TABLE videos ADD COLUMN channel_name TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_videos_subtitle_status ON videos(subtitle_status);
    CREATE INDEX IF NOT EXISTS idx_videos_availability_status ON videos(availability_status);
  `);

  const channelCols = (
    db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!channelCols.includes('category')) {
    db.exec("ALTER TABLE channels ADD COLUMN category TEXT DEFAULT '未分类'");
  }
  if (!channelCols.includes('category2')) {
    db.exec("ALTER TABLE channels ADD COLUMN category2 TEXT DEFAULT ''");
  }
  if (!channelCols.includes('intent')) {
    db.exec("ALTER TABLE channels ADD COLUMN intent TEXT DEFAULT '未分类'");
  }
  if (!channelCols.includes('topics')) {
    db.exec("ALTER TABLE channels ADD COLUMN topics TEXT DEFAULT '[]'");
  }
  if (!channelCols.includes('crawl_error_count')) {
    db.exec(
      'ALTER TABLE channels ADD COLUMN crawl_error_count INTEGER DEFAULT 0',
    );
  }
  if (!channelCols.includes('crawl_backoff_until')) {
    db.exec('ALTER TABLE channels ADD COLUMN crawl_backoff_until DATETIME');
  }
  if (!channelCols.includes('description')) {
    db.exec('ALTER TABLE channels ADD COLUMN description TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_channels_intent ON channels(intent)');

  const intentCols = (
    db.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!intentCols.includes('auto_summary_model_id')) {
    db.exec('ALTER TABLE intents ADD COLUMN auto_summary_model_id TEXT DEFAULT NULL');
  }
  if (!intentCols.includes('agent_prompt')) {
    db.exec('ALTER TABLE intents ADD COLUMN agent_prompt TEXT DEFAULT NULL');
  }
  if (!intentCols.includes('agent_trigger')) {
    db.exec('ALTER TABLE intents ADD COLUMN agent_trigger TEXT DEFAULT NULL');
  }
  if (!intentCols.includes('agent_memory')) {
    db.exec('ALTER TABLE intents ADD COLUMN agent_memory TEXT DEFAULT NULL');
  }
  if (!intentCols.includes('agent_schedule_time')) {
    db.exec("ALTER TABLE intents ADD COLUMN agent_schedule_time TEXT DEFAULT '09:00'");
  }

  seedDefaultIntents(db);
  migrateChannelIntentAndTopics(db);
  seedResearchIntentTypes(db);
}

function seedDefaultIntents(db: Database.Database) {
  const intentCount = db
    .prepare('SELECT COUNT(*) as count FROM intents')
    .get() as { count: number };

  if (intentCount.count > 0) {
    return;
  }

  const insertIntent = db.prepare(`
    INSERT INTO intents (id, name, auto_subtitle, auto_summary, sort_order)
    VALUES (@id, @name, @auto_subtitle, @auto_summary, @sort_order)
  `);

  const insertDefaults = db.transaction(() => {
    for (const intent of DEFAULT_INTENTS) {
      insertIntent.run(intent);
    }
  });

  insertDefaults();
}

function migrateChannelIntentAndTopics(db: Database.Database) {
  const migrationState = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CHANNEL_INTENT_MIGRATION_KEY) as { value?: string } | undefined;

  if (migrationState?.value === 'done') {
    return;
  }

  const channels = db
    .prepare(
      `
        SELECT id, category, category2, intent, topics
        FROM channels
      `,
    )
    .all() as Array<{
    id: number;
    category: string | null;
    category2: string | null;
    intent: string | null;
    topics: string | null;
  }>;

  const updateChannel = db.prepare(
    'UPDATE channels SET intent = ?, topics = ? WHERE id = ?',
  );
  const markMigration = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, 'done', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const migrate = db.transaction(() => {
    for (const channel of channels) {
      const topicSet = new Set<string>();

      for (const value of [channel.category, channel.category2]) {
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (normalizedValue && normalizedValue !== '未分类') {
          topicSet.add(normalizedValue);
        }
      }

      const nextIntent =
        typeof channel.intent === 'string' && channel.intent.trim()
          ? channel.intent.trim()
          : '未分类';

      updateChannel.run(nextIntent, JSON.stringify([...topicSet]), channel.id);
    }

    markMigration.run(CHANNEL_INTENT_MIGRATION_KEY);
  });

  migrate();
}

function seedResearchIntentTypes(db: Database.Database) {
  const seedState = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(RESEARCH_INTENT_TYPES_SEEDED_KEY) as { value?: string } | undefined;

  if (seedState?.value === 'done') {
    return;
  }

  const insertIntentType = db.prepare(`
    INSERT INTO research_intent_types (name, slug, is_preset, sort_order)
    VALUES (@name, @slug, 1, @sort_order)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      is_preset = 1,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `);
  const markSeeded = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, 'done', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const seed = db.transaction(() => {
    for (const intentType of DEFAULT_RESEARCH_INTENT_TYPES) {
      insertIntentType.run(intentType);
    }
    markSeeded.run(RESEARCH_INTENT_TYPES_SEEDED_KEY);
  });

  seed();
}

// Typed helper types
export interface Intent {
  id: number;
  name: string;
  auto_subtitle: number;
  auto_summary: number;
  sort_order: number;
  auto_summary_model_id: string | null;
  agent_prompt: string | null;
  agent_trigger: string | null;
  agent_schedule_time: string;
  agent_memory: string | null;
  created_at: string;
}

export interface Channel {
  id: number;
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string | null;
  avatar_url: string | null;
  intent: string;
  topics: string[];
  category: string;
  category2: string;
  crawl_error_count: number;
  crawl_backoff_until: string | null;
  created_at: string;
}

export interface SummaryTask {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  status: SummaryTaskStatus;
  method: 'api' | 'external' | 'mcp' | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Video {
  id: number;
  channel_id: number;
  platform: 'youtube' | 'bilibili';
  video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  is_read: number;
  is_members_only: number;
  access_status: string | null;
  availability_status: VideoAvailabilityStatus;
  availability_reason: string | null;
  availability_checked_at: string | null;
  subtitle_path: string | null;
  subtitle_language: string | null;
  subtitle_format: string | null;
  subtitle_status: string | null;
  subtitle_error: string | null;
  subtitle_last_attempt_at: string | null;
  subtitle_retry_count: number;
  subtitle_cooldown_until: string | null;
  members_only_checked_at: string | null;
  created_at: string;
  /** Channel name (fetched via JOIN for context in logs) */
  channel_name?: string | null;
  /** Intent id (fetched via JOIN for subtitle fallback matching) */
  intent_id?: number | null;
}

export interface ResearchIntentType {
  id: number;
  name: string;
  slug: string;
  is_preset: number;
  export_template: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ResearchFavorite {
  id: number;
  video_id: number;
  intent_type_id: number;
  note: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ResearchCollection {
  id: number;
  name: string;
  slug: string;
  goal: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ResearchCollectionItem {
  collection_id: number;
  favorite_id: number;
  sort_order: number;
  override_intent_type_id: number | null;
  override_note: string | null;
  created_at: string;
}
