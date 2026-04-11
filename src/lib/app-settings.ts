import { getDb } from './db';

interface AppSettingRow {
  value: string | null;
}

/**
 * Reads a persisted application setting value by key.
 */
export function getAppSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as AppSettingRow | undefined;

  return row?.value ?? null;
}

/**
 * Upserts an application setting and refreshes its update timestamp.
 */
export function setAppSetting(key: string, value: string) {
  getDb()
    .prepare(
      `
      INSERT INTO app_settings(key, value, updated_at)
      VALUES(?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(key, value);
}

/**
 * Returns the last update timestamp for a persisted application setting.
 */
export function getAppSettingUpdatedAt(key: string): string | null {
  const row = getDb()
    .prepare('SELECT updated_at FROM app_settings WHERE key = ?')
    .get(key) as { updated_at?: string | null } | undefined;

  return row?.updated_at ?? null;
}

/**
 * Reads a positive integer setting value, falling back when unset or invalid.
 */
export function getPositiveIntAppSetting(
  key: string,
  fallback: number,
): number {
  const raw = getAppSetting(key);
  const value = Number.parseInt(raw || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
