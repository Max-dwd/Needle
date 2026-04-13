import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';
import { getDb } from './db';
import type {
  UnavailableVideoBehavior,
  VideoAvailabilityStatus,
} from '@/types';

const HIDE_UNAVAILABLE_VIDEOS_KEY = 'hide_unavailable_videos';
const UNAVAILABLE_VIDEO_BEHAVIOR_KEY = 'unavailable_video_behavior';

const DEFAULT_HIDE_UNAVAILABLE_VIDEOS = true;
const DEFAULT_UNAVAILABLE_VIDEO_BEHAVIOR: UnavailableVideoBehavior = 'keep';

interface CountRow {
  unavailable_count: number | null;
  abandoned_count: number | null;
}

export interface VideoErrorHandlingSettings {
  hideUnavailableVideos: boolean;
  unavailableVideoBehavior: UnavailableVideoBehavior;
  updatedAt: string | null;
  counts: {
    unavailable: number;
    abandoned: number;
  };
}

export interface VideoErrorHandlingConfig {
  hideUnavailableVideos: boolean;
  unavailableVideoBehavior: UnavailableVideoBehavior;
  updatedAt: string | null;
}

function parseHideUnavailableVideos(raw: string | null): boolean {
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return DEFAULT_HIDE_UNAVAILABLE_VIDEOS;
}

function parseUnavailableVideoBehavior(
  raw: string | null,
): UnavailableVideoBehavior {
  return raw === 'abandon' ? 'abandon' : DEFAULT_UNAVAILABLE_VIDEO_BEHAVIOR;
}

export function getTrackedUnavailableVideoCounts(): {
  unavailable: number;
  abandoned: number;
} {
  const row = getDb()
    .prepare(
      `
        SELECT
          SUM(CASE WHEN availability_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_count,
          SUM(CASE WHEN availability_status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_count
        FROM videos
      `,
    )
    .get() as CountRow | undefined;

  return {
    unavailable: row?.unavailable_count ?? 0,
    abandoned: row?.abandoned_count ?? 0,
  };
}

export function getVideoErrorHandlingConfig(): VideoErrorHandlingConfig {
  const hideUnavailableVideos = parseHideUnavailableVideos(
    getAppSetting(HIDE_UNAVAILABLE_VIDEOS_KEY),
  );
  const unavailableVideoBehavior = parseUnavailableVideoBehavior(
    getAppSetting(UNAVAILABLE_VIDEO_BEHAVIOR_KEY),
  );
  const hideUpdatedAt = getAppSettingUpdatedAt(HIDE_UNAVAILABLE_VIDEOS_KEY);
  const behaviorUpdatedAt = getAppSettingUpdatedAt(UNAVAILABLE_VIDEO_BEHAVIOR_KEY);
  const updatedAt =
    [hideUpdatedAt, behaviorUpdatedAt].filter(Boolean).sort().at(-1) ?? null;

  return {
    hideUnavailableVideos,
    unavailableVideoBehavior,
    updatedAt,
  };
}

export function getVideoErrorHandlingSettings(): VideoErrorHandlingSettings {
  return {
    ...getVideoErrorHandlingConfig(),
    counts: getTrackedUnavailableVideoCounts(),
  };
}

export function isTrackedUnavailableVideo(
  status: VideoAvailabilityStatus | string | null | undefined,
): boolean {
  return status === 'unavailable' || status === 'abandoned';
}

export function applyUnavailableVideoBehavior(
  behavior: UnavailableVideoBehavior,
): void {
  const nextStatus = behavior === 'abandon' ? 'abandoned' : 'unavailable';
  const previousStatus = behavior === 'abandon' ? 'unavailable' : 'abandoned';

  getDb()
    .prepare(
      `
        UPDATE videos
        SET availability_status = ?, availability_checked_at = ?
        WHERE availability_status = ?
      `,
    )
    .run(nextStatus, new Date().toISOString(), previousStatus);
}

export function setVideoErrorHandlingSettings(
  input: Partial<{
    hideUnavailableVideos: boolean;
    unavailableVideoBehavior: UnavailableVideoBehavior;
  }>,
): VideoErrorHandlingSettings {
  if (typeof input.hideUnavailableVideos === 'boolean') {
    setAppSetting(
      HIDE_UNAVAILABLE_VIDEOS_KEY,
      input.hideUnavailableVideos ? '1' : '0',
    );
  }

  if (
    input.unavailableVideoBehavior === 'keep' ||
    input.unavailableVideoBehavior === 'abandon'
  ) {
    setAppSetting(UNAVAILABLE_VIDEO_BEHAVIOR_KEY, input.unavailableVideoBehavior);
    applyUnavailableVideoBehavior(input.unavailableVideoBehavior);
  }

  return getVideoErrorHandlingSettings();
}

export function markVideoAsUnavailable(
  videoDbId: number,
  reason: string,
): VideoAvailabilityStatus {
  const settings = getVideoErrorHandlingConfig();
  const nextStatus: Exclude<VideoAvailabilityStatus, null> =
    settings.unavailableVideoBehavior === 'abandon'
      ? 'abandoned'
      : 'unavailable';

  getDb()
    .prepare(
      `
        UPDATE videos
        SET
          availability_status = ?,
          availability_reason = ?,
          availability_checked_at = ?
        WHERE id = ?
      `,
    )
    .run(nextStatus, reason, new Date().toISOString(), videoDbId);

  return nextStatus;
}

export function clearVideoAvailability(videoDbId: number): void {
  getDb()
    .prepare(
      `
        UPDATE videos
        SET
          availability_status = NULL,
          availability_reason = NULL,
          availability_checked_at = ?
        WHERE id = ?
      `,
    )
    .run(new Date().toISOString(), videoDbId);
}
