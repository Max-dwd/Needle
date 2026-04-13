export type VideoAvailabilityStatus = 'unavailable' | 'abandoned' | null;
export type UnavailableVideoBehavior = 'keep' | 'abandon';

export interface VideoWithMeta {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  is_read: number;
  is_members_only: number;
  access_status: 'members_only' | 'limited_free' | null;
  availability_status: VideoAvailabilityStatus;
  availability_reason: string | null;
  availability_checked_at: string | null;
  subtitle_status: string | null;
  subtitle_error: string | null;
  subtitle_last_attempt_at: string | null;
  subtitle_cooldown_until: string | null;
  channel_name: string;
  avatar_url: string | null;
  summary_status: SummaryTaskStatus | null;
  /** DB `channels.id` (FK on video row). */
  channel_id: string;
  /** Platform channel id (YouTube UC… / Bilibili mid) from joined `channels` row. */
  channel_channel_id?: string;
  intent: string;
  research?: {
    is_favorited: boolean;
    favorite_id?: number;
    intent_type_name?: string;
    note_preview?: string;
  };
  _isNew?: boolean;
}

export interface ResearchFavoriteWithVideo {
  id: number;
  video_id: number;
  intent_type_id: number;
  note: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  title: string | null;
  platform: 'youtube' | 'bilibili';
  platform_video_id: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  subtitle_status: string | null;
  channel_name: string | null;
  channel_channel_id: string;
  intent_type_name: string;
  intent_type_slug: string;
}

export interface ResearchCollectionWithStats {
  id: number;
  name: string;
  slug: string;
  goal: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  item_count: number;
}

export interface ExportPackResult {
  pack_path: string;
  items_count: number;
  skipped_count: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogScope =
  | 'feed'
  | 'subtitle'
  | 'summary'
  | 'api'
  | 'system'
  | 'enrichment'
  | 'agent';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: LogScope;
  event: string;
  [key: string]: unknown;
}

export interface LogMethodStats {
  attempts: number;
  successes: number;
  failures: number;
}

export interface LogRecentError {
  time: string;
  method: string;
  platform: string;
  error: string;
}

export interface LogScopeStats {
  attempts: number;
  successes: number;
  failures: number;
  fallbacks: number;
  successRate: number;
  byMethod: Record<string, LogMethodStats>;
  byPlatform: Record<string, number>;
  recentErrors: LogRecentError[];
}

export interface LogStats {
  total: number;
  byLevel: Record<LogLevel, number>;
  byScope: Record<LogScope, number>;
  feed: LogScopeStats;
  subtitle: LogScopeStats;
  summary: LogScopeStats;
}

export interface SubtitleData {
  status: string;
  language?: string;
  format?: string;
  text?: string;
  error?: string | null;
  cooldownUntil?: string | null;
  preferredMethod?: string;
  activeMethod?: string;
  message?: string;
  sourceMethod?: string;
  segmentStyle?: 'coarse' | 'fine';
  metadata?: Record<string, string | number>;
  segments?: Array<{ start: number; end: number; text: string }>;
}

export interface CrawlerScopeStatus {
  state: 'idle' | 'running' | 'cooldown' | 'error';
  platform?: 'youtube' | 'bilibili';
  preferredMethod?: string;
  activeMethod?: string;
  isFallback?: boolean;
  targetId?: string;
  targetLabel?: string;
  message?: string;
  cooldownUntil?: string;
  updatedAt?: string;
  progress?: number;
  total?: number;
}

export type SchedulerTaskName = 'crawl';
export type SchedulerIndicatorState = 'idle' | 'running' | 'waiting';

export interface SchedulerIndicatorStatus {
  state: SchedulerIndicatorState;
  currentTask?: SchedulerTaskName;
  nextRunAt?: string | null;
  message?: string;
  updatedAt?: string;
}

export interface CrawlerRuntimeStatus {
  feed: CrawlerScopeStatus;
  scheduler?: SchedulerStatus;
  paused: boolean;
  pauseUpdatedAt?: string;
}

export interface SchedulerConfig {
  enabled: boolean;
  crawlInterval: number;
  subtitleInterval: number;
}

export interface SchedulerStatus {
  running: boolean;
  state: SchedulerIndicatorState;
  currentTask: SchedulerTaskName | null;
  lastCrawl: string | null;
  nextCrawl: string | null;
  todayStats: {
    videos: number;
    subtitles: number;
    summaries: number;
  };
  message?: string | null;
  updatedAt: string;
}

export interface VideoSummaryData {
  format?: 'markdown';
  metadata?: Record<string, string | number>;
  markdown?: string;
  previous?: VideoSummaryData | null;
  error?: string;
  details?: string;
}

export type ChatMode = 'obsidian' | 'roast';

export interface ChatRequest {
  mode: ChatMode;
  prompt: string;
  rangeStart: number;
  rangeEnd: number;
  modelId?: string;
}

export interface VideoComment {
  author?: string;
  thumbnail?: string;
  commentId?: string;
  commentText?: string;
  commentedTime?: string;
  commentorUrl?: string;
  likeCount?: number;
  pinned?: boolean;
  verified?: boolean;
  creatorReplied?: boolean;
  channelOwner?: boolean;
}

export interface VideoCommentsData {
  source?: string;
  comments?: VideoComment[];
  error?: string;
  details?: string;
}

export interface AiSummaryModelConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface AiSummaryPromptTemplates {
  default: string;
  subtitleApi: string;
}

// AI Summary types

export type SummaryTaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface SummaryTaskData {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  status: SummaryTaskStatus;
  method: 'api' | 'external' | 'mcp' | null;
  error: string | null;
  title: string | null;
  created_at: string;
}

export interface SummaryTaskStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface SummaryQueueState {
  running: boolean;
  stopRequested?: boolean;
  processed: number;
  total: number;
  currentVideoId?: string;
  currentTitle?: string | null;
  startedAt?: string | null;
}

// Auto-pipeline types

export interface AutoPipelineStatus {
  subtitle: {
    queueLength: number;
    videoCount: number;
    processing: boolean;
    currentVideoId: string | null;
    currentVideoTitle: string | null;
    currentBatchId: string | null;
    currentBatchLabel: string | null;
    currentBatchVideoCount: number;
    nextRunAt: string | null;
    stats: { completed: number; failed: number; queued: number };
    throttle: {
      state: 'clear' | 'backoff' | 'exhausted';
      platform: 'youtube' | 'bilibili' | null;
      multiplier: number;
      consecutiveErrors: number;
      maxRetries: number;
      exhaustedCount: number;
      platforms: Record<
        'youtube' | 'bilibili',
        {
          state: 'clear' | 'backoff' | 'exhausted';
          multiplier: number;
          consecutiveErrors: number;
          maxRetries: number;
          exhaustedCount: number;
          nextRunAt: string | null;
          intervalMs: number;
        }
      >;
    };
    pool?: {
      name: string;
      currentConcurrency: number;
      activeJobs: number;
      queueDepth: number;
      state: string;
    };
  };
  summary: {
    queueLength: number;
    processing: boolean;
    currentVideoId: string | null;
  };
}
