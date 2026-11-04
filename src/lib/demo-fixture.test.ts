import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('disposable showcase fixture', () => {
  it('isolates all artifacts from existing data and disables background work', () => {
    const existingRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'needle-demo-test-'),
    );
    const existingDb = path.join(existingRoot, 'private.db');
    fs.writeFileSync(existingDb, 'Do not open or overwrite this file.');
    let demoRoot: string | undefined;
    let db: Database.Database | undefined;
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/demo.ts', '--seed-only'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            DATA_ROOT: existingRoot,
            DATABASE_PATH: existingDb,
            SUBTITLE_ROOT: existingRoot,
            SUMMARY_ROOT: existingRoot,
            SUMMARY_MD_ROOT: existingRoot,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      demoRoot = result.stdout.match(/Disposable data: (.+)/)?.[1];
      expect(demoRoot).toBeTruthy();
      expect(demoRoot).not.toBe(existingRoot);
      expect(fs.readdirSync(existingRoot)).toEqual(['private.db']);
      expect(fs.readFileSync(existingDb, 'utf8')).toBe(
        'Do not open or overwrite this file.',
      );
      db = new Database(path.join(demoRoot!, 'demo.db'), { readonly: true });
      expect(db.prepare('SELECT COUNT(*) AS n FROM channels').get()).toEqual({
        n: 6,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM videos').get()).toEqual({
        n: 9,
      });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM research_favorites').get(),
      ).toEqual({ n: 6 });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM research_collections').get(),
      ).toEqual({ n: 1 });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM intents WHERE auto_subtitle != 0 OR auto_summary != 0',
          )
          .get(),
      ).toEqual({ n: 0 });
      const settings = Object.fromEntries(
        (
          db.prepare('SELECT key, value FROM app_settings').all() as Array<{
            key: string;
            value: string;
          }>
        ).map(({ key, value }) => [key, value]),
      );
      expect(settings.scheduler_enabled).toBe('0');
      expect(settings.browser_keepalive_preset).toBe('off');
      expect(settings.bilibili_ai_summary_enabled).toBe('false');
      const videos = db
        .prepare(
          'SELECT video_id, platform, subtitle_path, thumbnail_url FROM videos',
        )
        .all() as Array<{
        video_id: string;
        platform: string;
        subtitle_path: string;
        thumbnail_url: string;
      }>;
      for (const video of videos) {
        expect(video.video_id).toMatch(/^needle-demo-\d+$/);
        expect(video.thumbnail_url).toMatch(/^data:image\/svg\+xml/);
        expect(video.subtitle_path.startsWith(demoRoot! + path.sep)).toBe(true);
        expect(
          JSON.parse(fs.readFileSync(video.subtitle_path, 'utf8')).sourceMethod,
        ).toBe('demo');
        const summary = fs.readFileSync(
          path.join(
            demoRoot!,
            'summaries',
            video.platform,
            `${video.video_id}.md`,
          ),
          'utf8',
        );
        expect(summary).toContain(
          'Illustrative sample, not an AI-generated summary of a real video.',
        );
      }
    } finally {
      db?.close();
      if (demoRoot) fs.rmSync(demoRoot, { recursive: true, force: true });
      fs.rmSync(existingRoot, { recursive: true, force: true });
    }
  }, 35_000);
});
