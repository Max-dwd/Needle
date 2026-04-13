/**
 * Layer 1 Enrichment Queue
 *
 * Fetches missing video metadata and member-only status from platform APIs
 * and emits video:enriched events.
 *
 * Architecture:
 * - Uses async pool for adaptive concurrency (initial=3, min=1, max=6)
 * - Rate limited to 10 req/5s for Bilibili API
 * - Manual-only repair path; never auto-enqueues from refresh/scheduler/startup
 * - Skips videos that already have complete metadata and member-only status
 *
 * Singleton via globalThis[Symbol.for('folo:enrichment-queue')].
 */

import { log } from './logger';
import { appEvents } from './events';
import { getDb } from './db';
import { getOrCreatePool, type PoolStatus } from './async-pool';
import {
  fetchBilibiliVideoDetail,
  probeYouTubeVideoAvailability,
  fetchYouTubeVideoDetail,
} from './fetcher';
import {
  clearVideoAvailability,
  markVideoAsUnavailable,
} from './video-error-handling';
import type { VideoAvailabilityStatus } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VideoWithChannel {
  id: number;
  video_id: string;
  platform: 'youtube' | 'bilibili';
  channel_id: number;
  channel_id__platform: string; // channels.channel_id
  channel_name: string;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  members_only_checked_at: string | null;
  access_status: string | null;
  availability_status: VideoAvailabilityStatus;
  created_at: string;
}

interface EnrichmentJob {
  videoDbId: number;
  videoId: string;
  platform: 'youtube' | 'bilibili';
  channelId: string;
  channelName: string;
}

export interface EnrichmentQueueStatus {
  pool: PoolStatus;
  initialized: boolean;
}

interface EnrichmentState {
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENRICHMENT_POOL_CONFIG = {
  name: 'enrichment',
  initialConcurrency: 3,
  minConcurrency: 1,
  maxConcurrency: 6,
  adjustIntervalMs: 30_000,
  rateLimit: {
    requestsPerWindow: 10,
    windowMs: 5_000,
  },
} as const;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const GLOBAL_KEY = Symbol.for('folo:enrichment-queue');

function getState(): EnrichmentState {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: EnrichmentState;
  };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      initialized: false,
    };
  }
  return g[GLOBAL_KEY]!;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get video by internal DB id with channel JOIN for context.
 */
function getVideoWithChannel(videoDbId: number): VideoWithChannel | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT
        v.id,
        v.video_id,
        v.platform,
        v.channel_id,
        c.channel_id AS channel_id__platform,
        c.name AS channel_name,
        v.title,
        v.thumbnail_url,
        v.published_at,
        v.duration,
        v.members_only_checked_at,
        v.access_status,
        v.availability_status,
        v.created_at
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      WHERE v.id = ?
      LIMIT 1
    `,
    )
    .get(videoDbId) as VideoWithChannel | undefined;
  return row ?? null;
}

/**
 * Check if a video needs enrichment or member-only status probing.
 */
function needsEnrichment(video: VideoWithChannel): boolean {
  if (video.availability_status === 'abandoned') {
    return false;
  }
  const hasThumbnail = Boolean(video.thumbnail_url && video.thumbnail_url.trim() !== '');
  const hasDuration = Boolean(video.duration && video.duration.trim() !== '');
  const hasPublishedAt = Boolean(
    video.published_at &&
      video.published_at.trim() !== '' &&
      Number.isFinite(Date.parse(video.published_at)),
  );
  return (
    !hasThumbnail ||
    !hasDuration ||
    !hasPublishedAt ||
    !video.members_only_checked_at
  );
}

/**
 * Update video with enriched fields.
 */
function updateVideoFields(
  videoDbId: number,
  fields: {
    thumbnail_url?: string | null;
    published_at?: string | null;
    duration?: string | null;
    is_members_only?: number;
    access_status?: 'members_only' | 'limited_free' | null;
    members_only_checked_at?: string | null;
    availability_status?: VideoAvailabilityStatus;
    availability_reason?: string | null;
    availability_checked_at?: string | null;
  },
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (fields.thumbnail_url !== undefined) {
    sets.push('thumbnail_url = ?');
    values.push(fields.thumbnail_url);
  }
  if (fields.published_at !== undefined) {
    sets.push('published_at = ?');
    values.push(fields.published_at);
  }
  if (fields.duration !== undefined) {
    sets.push('duration = ?');
    values.push(fields.duration);
  }
  if (fields.is_members_only !== undefined) {
    sets.push('is_members_only = ?');
    values.push(String(fields.is_members_only));
  }
  if (fields.access_status !== undefined) {
    sets.push('access_status = ?');
    values.push(fields.access_status);
  }
  if (fields.members_only_checked_at !== undefined) {
    sets.push('members_only_checked_at = ?');
    values.push(fields.members_only_checked_at);
  }
  if (fields.availability_status !== undefined) {
    sets.push('availability_status = ?');
    values.push(fields.availability_status);
  }
  if (fields.availability_reason !== undefined) {
    sets.push('availability_reason = ?');
    values.push(fields.availability_reason);
  }
  if (fields.availability_checked_at !== undefined) {
    sets.push('availability_checked_at = ?');
    values.push(fields.availability_checked_at);
  }

  if (sets.length === 0) return;

  values.push(String(videoDbId));

  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

// ---------------------------------------------------------------------------
// Enrichment executor (runs in the async pool)
// ---------------------------------------------------------------------------

/**
 * Executor function for enrichment jobs in the async pool.
 */
async function runEnrichmentJob(
  job: EnrichmentJob,
): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const startTime = Date.now();

  try {
    const detail =
      job.platform === 'youtube'
        ? await fetchYouTubeVideoDetail(job.videoId)
        : await fetchBilibiliVideoDetail(job.videoId);

    const hasUsableDetail = Boolean(
      detail &&
        (
          (detail.thumbnail_url && detail.thumbnail_url.trim() !== '') ||
          (detail.published_at && detail.published_at.trim() !== '') ||
          (detail.duration && detail.duration.trim() !== '') ||
          detail.access_status !== undefined ||
          detail.is_members_only === 1
        ),
    );

    if (!detail || !hasUsableDetail) {
      if (job.platform === 'youtube') {
        const availability = await probeYouTubeVideoAvailability(job.videoId);
        if (availability.status === 'unavailable') {
          const status = markVideoAsUnavailable(
            job.videoDbId,
            availability.reason || 'YouTube video unavailable',
          );
          appEvents.emit('video:availability-changed', {
            videoDbId: job.videoDbId,
            videoId: job.videoId,
            platform: job.platform,
            status,
            reason: availability.reason || null,
          });
          log.warn('enrichment', 'video_unavailable', {
            videoDbId: job.videoDbId,
            videoId: job.videoId,
            platform: job.platform,
            status,
            reason: availability.reason || null,
          });
          return {
            success: true,
            durationMs: Date.now() - startTime,
          };
        }
      }

      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: 'No detail returned from platform detail API',
      };
    }

    clearVideoAvailability(job.videoDbId);
    appEvents.emit('video:availability-changed', {
      videoDbId: job.videoDbId,
      videoId: job.videoId,
      platform: job.platform,
      status: null,
      reason: null,
    });

    // Build update fields
    const updateFields: {
      thumbnail_url?: string | null;
      published_at?: string | null;
      duration?: string | null;
      is_members_only?: number;
      access_status?: 'members_only' | 'limited_free' | null;
      availability_status?: VideoAvailabilityStatus;
      availability_reason?: string | null;
      availability_checked_at?: string | null;
    } = {};

    if (detail.thumbnail_url) {
      updateFields.thumbnail_url = detail.thumbnail_url;
    }
    if (detail.published_at) {
      updateFields.published_at = detail.published_at;
    }
    if (detail.duration) {
      updateFields.duration = detail.duration;
    }
    if (detail.is_members_only !== undefined) {
      updateFields.is_members_only = detail.is_members_only;
    }
    if (detail.access_status !== undefined) {
      updateFields.access_status = detail.access_status;
    }

    const shouldMarkChecked = detail.is_members_only !== undefined;

    // Update DB
    if (Object.keys(updateFields).length > 0 || shouldMarkChecked) {
      updateVideoFields(job.videoDbId, {
        ...updateFields,
        members_only_checked_at: shouldMarkChecked
          ? new Date().toISOString()
          : undefined,
      });
    }

    // Emit video:enriched event
    appEvents.emit('video:enriched', {
      videoDbId: job.videoDbId,
      videoId: job.videoId,
      platform: job.platform,
      channel_id: job.channelId,
      channel_name: job.channelName,
      fields: {
        thumbnail_url: detail.thumbnail_url ?? null,
        published_at: detail.published_at ?? null,
        duration: detail.duration ?? null,
        is_members_only: detail.is_members_only ?? undefined,
        access_status: detail.access_status ?? null,
        availability_status: null,
        availability_reason: null,
        availability_checked_at: new Date().toISOString(),
      },
    });

    log.info('enrichment', 'video_enriched', {
      videoDbId: job.videoDbId,
      videoId: job.videoId,
      channel_id: job.channelId,
      channel_name: job.channelName,
      platform: job.platform,
      duration_ms: Date.now() - startTime,
    });

    return { success: true, durationMs: Date.now() - startTime };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('enrichment', 'enrichment_failed', {
      channel_id: job.channelId,
      channel_name: job.channelName,
      videoId: job.videoId,
      error: message,
    });
    return { success: false, durationMs: Date.now() - startTime, error: message };
  }
}

// ---------------------------------------------------------------------------
// Core enrichment function
// ---------------------------------------------------------------------------

/**
 * Manually repair a video by fetching detail metadata from the platform.
 *
 * - Skips YouTube videos
 * - Skips Bilibili videos that already have thumbnail_url, published_at, and duration
 * - Updates DB with enriched fields and emits video:enriched event
 *
 * @param videoDbId - Internal DB id of the video
 * @param channelId - Optional channel_id from channels table (for logging)
 * @param channelName - Optional channel_name (for logging)
 */
export async function enrichVideo(
  videoDbId: number,
  channelId?: string,
  channelName?: string,
): Promise<void> {
  // Get video with channel context
  const video = getVideoWithChannel(videoDbId);
  if (!video) {
    log.warn('enrichment', 'video_not_found', { videoDbId });
    return;
  }

  // Use provided channel context or fall back to video query
  const resolvedChannelId = channelId ?? video.channel_id__platform;
  const resolvedChannelName = channelName ?? video.channel_name;

  // Check if enrichment is needed
  if (!needsEnrichment(video)) {
    log.info(
      'enrichment',
      video.availability_status === 'abandoned'
        ? 'skip_abandoned_unavailable'
        : 'skip_already_complete',
      {
      videoDbId,
      videoId: video.video_id,
      platform: video.platform,
      channel_id: resolvedChannelId,
      channel_name: resolvedChannelName,
      availability_status: video.availability_status ?? null,
    },
    );
    return;
  }

  // Enqueue in the pool
  const pool = getOrCreatePool<EnrichmentJob>(
    ENRICHMENT_POOL_CONFIG.name,
    ENRICHMENT_POOL_CONFIG,
  );

  pool.enqueue(
    {
      videoDbId,
      videoId: video.video_id,
      platform: video.platform,
      channelId: video.channel_id__platform,
      channelName: video.channel_name,
    },
    1, // priority 1 = auto (lower than manual priority 0)
    runEnrichmentJob,
  );
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Ensures the repair queue exists.
 * Idempotent — subsequent calls are no-ops.
 */
export function ensureEnrichmentQueue(): void {
  const state = getState();
  if (state.initialized) return;
  state.initialized = true;

  // Ensure the pool exists (singleton)
  getOrCreatePool<EnrichmentJob>(
    ENRICHMENT_POOL_CONFIG.name,
    ENRICHMENT_POOL_CONFIG,
  );

  log.info('enrichment', 'initialized', {
    pool: ENRICHMENT_POOL_CONFIG.name,
    initialConcurrency: ENRICHMENT_POOL_CONFIG.initialConcurrency,
    minConcurrency: ENRICHMENT_POOL_CONFIG.minConcurrency,
    maxConcurrency: ENRICHMENT_POOL_CONFIG.maxConcurrency,
    rateLimit: ENRICHMENT_POOL_CONFIG.rateLimit,
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Returns the current enrichment queue status for SSE and API use.
 */
export function getEnrichmentQueueStatus(): EnrichmentQueueStatus {
  const state = getState();
  const pool = getOrCreatePool<EnrichmentJob>(
    ENRICHMENT_POOL_CONFIG.name,
    ENRICHMENT_POOL_CONFIG,
  );

  return {
    pool: pool.getStatus(),
    initialized: state.initialized,
  };
}

/**
 * Get the enrichment pool instance (for testing).
 */
export function getEnrichmentQueue() {
  return getOrCreatePool<EnrichmentJob>(
    ENRICHMENT_POOL_CONFIG.name,
    ENRICHMENT_POOL_CONFIG,
  );
}
