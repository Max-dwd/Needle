/** Launch a fresh, disposable showcase. Never opens or writes the user's data/. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'needle-demo-'));
Object.assign(process.env, {
  DATA_ROOT: root,
  PIPED_INSTANCES_FILE: path.join(root, 'piped-instances.json'),
  BILIBILI_SESSDATA: '',
  YOUTUBE_COOKIES_BROWSER: '',
  NEXT_TELEMETRY_DISABLED: '1',
  DATABASE_PATH: path.join(root, 'demo.db'),
  SUBTITLE_ROOT: path.join(root, 'subtitles'),
  SUMMARY_ROOT: path.join(root, 'summaries'),
  SUMMARY_MD_ROOT: path.join(root, 'summary-md'),
});

async function main() {
  // Import only after the isolated paths have been set.
  const { getDb, closeDb } = await import('../src/lib/db');
  const db = getDb();
  db.prepare('UPDATE intents SET auto_subtitle = 0, auto_summary = 0').run();
  const setting = db.prepare(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
  );
  setting.run('scheduler_enabled', '0');
  setting.run('browser_keepalive_preset', 'off');
  setting.run('bilibili_ai_summary_enabled', 'false');

  const samples = [
    {
      title: 'Building a local-first knowledge system',
      channel: 'Local Lab',
      platform: 'youtube',
      intent: '工作',
      topic: 'Engineering',
      cover: 'LOCAL\nFIRST',
      color: '#e9efe5',
      ink: '#2d5745',
      note: 'Keep the source material portable. SQLite + Markdown make a useful, inspectable foundation.',
      length: '18:42',
    },
    {
      title: '设计一个真正安静的信息流',
      channel: '设计手记',
      platform: 'bilibili',
      intent: '探索',
      topic: 'Design',
      cover: 'LESS,\nBETTER.',
      color: '#f6dfd3',
      ink: '#a9472d',
      note: '减少视觉噪声，让内容与阅读意图成为界面的中心。',
      length: '12:08',
    },
    {
      title: 'A visual guide to event-driven systems',
      channel: 'Systems Studio',
      platform: 'youtube',
      intent: '工作',
      topic: 'Engineering',
      cover: 'EVENT\nDRIVEN',
      color: '#dfe9f2',
      ink: '#285878',
      note: 'Separate discovery, enrichment and processing so each stage can retry independently.',
      length: '24:16',
    },
    {
      title: '从视频到笔记：建立自己的研究工作流',
      channel: '研究日常',
      platform: 'bilibili',
      intent: '探索',
      topic: 'Research',
      cover: 'WATCH.\nCONNECT.',
      color: '#ebe3f1',
      ink: '#654778',
      note: '记录观点，也保留原始时间戳。让笔记可以回到证据。',
      length: '16:35',
    },
    {
      title: 'Typography is a system, not a font',
      channel: 'Form & Function',
      platform: 'youtube',
      intent: '探索',
      topic: 'Design',
      cover: 'TYPE\nMATTERS',
      color: '#f0e9d9',
      ink: '#74603c',
      note: 'Hierarchy, rhythm and spacing do more work than decoration.',
      length: '09:54',
    },
    {
      title: 'AI 摘要的边界：如何回到原文验证',
      channel: '开放笔记',
      platform: 'bilibili',
      intent: '工作',
      topic: 'AI',
      cover: 'TRUST,\nVERIFY.',
      color: '#dfece7',
      ink: '#3b6758',
      note: 'AI 总结是导航，不是原始证据的替代品。保留字幕与引用。',
      length: '21:07',
    },
    {
      title: 'Small tools, thoughtful defaults',
      channel: 'Local Lab',
      platform: 'youtube',
      intent: '工作',
      topic: 'Engineering',
      cover: 'SMALL\nTOOLS',
      color: '#efe0dc',
      ink: '#8a5045',
      note: 'A small, understandable tool is easier to trust and maintain.',
      length: '14:22',
    },
    {
      title: '城市里的几何与留白',
      channel: '设计手记',
      platform: 'bilibili',
      intent: '娱乐',
      topic: 'Design',
      cover: 'SPACE\nTO THINK',
      color: '#dce6ef',
      ink: '#47647a',
      note: '从建筑与日常观察中寻找节奏。',
      length: '08:46',
    },
    {
      title: 'The case for owning your reading queue',
      channel: 'Systems Studio',
      platform: 'youtube',
      intent: '新闻',
      topic: 'Research',
      cover: 'YOUR\nQUEUE',
      color: '#e9e8df',
      ink: '#60664c',
      note: 'Organize subscriptions around a question, not a recommendation algorithm.',
      length: '17:38',
    },
  ];
  const channelIds = new Map<string, number>();
  const insertChannel = db.prepare(
    'INSERT INTO channels (platform, channel_id, name, intent, topics) VALUES (?, ?, ?, ?, ?)',
  );
  const insertVideo = db.prepare(
    `INSERT INTO videos (channel_id, platform, video_id, title, thumbnail_url, published_at, duration, channel_name, subtitle_status, subtitle_path, subtitle_language, subtitle_format) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFavorite = db.prepare(
    'INSERT INTO research_favorites (video_id, intent_type_id, note) VALUES (?, ?, ?)',
  );
  const collection = db
    .prepare(
      'INSERT INTO research_collections (name, slug, goal, description) VALUES (?, ?, ?, ?)',
    )
    .run(
      'Local-first research',
      'local-first-research',
      'Build a research workflow you can inspect and own.',
      'Illustrative demo collection.',
    );

  samples.forEach((sample, index) => {
    if (!channelIds.has(sample.channel)) {
      const channel = insertChannel.run(
        sample.platform,
        `needle-demo-channel-${channelIds.size}`,
        sample.channel,
        sample.intent,
        JSON.stringify([sample.topic]),
      );
      channelIds.set(sample.channel, Number(channel.lastInsertRowid));
    }
    const [line1, line2] = sample.cover.split('\n');
    const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="${sample.color}"/><g fill="none" stroke="${sample.ink}" stroke-width="2" opacity=".22"><circle cx="790" cy="270" r="158"/><circle cx="790" cy="270" r="117"/><circle cx="790" cy="270" r="76"/><path d="M600 80v380M540 270h420"/></g><text x="58" y="65" font-family="Arial,sans-serif" font-size="20" letter-spacing="4" fill="${sample.ink}">${sample.topic.toUpperCase()} / DEMO DATA</text><g fill="${sample.ink}" font-family="Arial,sans-serif" font-weight="700" font-size="80" letter-spacing="-3"><text x="52" y="250">${line1}</text><text x="52" y="350">${line2}</text></g><path d="M58 438h80" stroke="${sample.ink}" stroke-width="4"/><text x="58" y="492" font-family="Arial,sans-serif" font-size="20" letter-spacing="3" fill="${sample.ink}">ILLUSTRATIVE DEMO · ${String(index + 1).padStart(2, '0')}</text></svg>`;
    const id = `needle-demo-${index + 1}`;
    const subtitleDir = path.join(root, 'subtitles', sample.platform, id);
    fs.mkdirSync(subtitleDir, { recursive: true });
    const subtitlePath = path.join(subtitleDir, 'demo.json');
    const segments = [
      {
        start: 0,
        duration: 18,
        text: 'This is an illustrative transcript created for the Needle demo.',
      },
      { start: 18, duration: 24, text: sample.note },
      {
        start: 42,
        duration: 30,
        text: 'Keep the original source, organize it by intent, and turn useful ideas into durable notes.',
      },
    ];
    fs.writeFileSync(
      subtitlePath,
      JSON.stringify(
        {
          language: 'en',
          format: 'json',
          text: segments.map((s) => s.text).join('\n'),
          segments,
          sourceMethod: 'demo',
        },
        null,
        2,
      ),
    );
    const summaryDir = path.join(root, 'summaries', sample.platform);
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(
      path.join(summaryDir, `${id}.md`),
      `---\nvideo_id: ${id}\nplatform: ${sample.platform}\ngenerated_from: illustrative-demo\n---\n\n# ${sample.title}\n\n> Illustrative sample, not an AI-generated summary of a real video.\n\n# 核心总结\n\n**Demo text.** ${sample.note}\n\n# 详细总结\n\n## 01 · Keep the source inspectable\n\nSave subtitles and summaries in readable local files.\n\n## 02 · Organize around a question\n\nConnect channels by intent and topics, rather than platform alone.\n\n## 03 · Return to the evidence\n\nUse timestamps to check context before reusing a claim.\n`,
    );
    const video = insertVideo.run(
      channelIds.get(sample.channel),
      sample.platform,
      id,
      sample.title,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cover)}`,
      new Date(Date.now() - (index + 1) * 3600_000).toISOString(),
      sample.length,
      sample.channel,
      'fetched',
      subtitlePath,
      'en',
      'json',
    );
    if (index < 6) {
      const favorite = insertFavorite.run(
        video.lastInsertRowid,
        2,
        sample.note,
      );
      if (index === 0 || index === 2)
        db.prepare(
          'INSERT INTO research_collection_items (collection_id, favorite_id, sort_order) VALUES (?, ?, ?)',
        ).run(collection.lastInsertRowid, favorite.lastInsertRowid, index);
    }
  });
  closeDb();
  console.log(
    `\nNeedle demo: 9 fictional videos, 6 channels, no account or API key required.\nDisposable data: ${root}\nYour normal data/ directory is not used.\n`,
  );
  if (process.argv.includes('--seed-only')) return;
  const child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      ...(process.argv.includes('--production')
        ? ['start']
        : ['dev', '--webpack']),
      '--hostname',
      '127.0.0.1',
      '--port',
      process.env.DEMO_PORT || '3100',
    ],
    {
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    },
  );
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    if (shutdownTimer) return;
    signalChild('SIGTERM');
    // Open SSE connections can delay Next's graceful shutdown indefinitely.
    shutdownTimer = setTimeout(() => signalChild('SIGKILL'), 5_000);
    shutdownTimer.unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => {
    clearTimeout(shutdownTimer);
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = code ?? 0;
  });
  child.on('error', (error) => {
    console.error(error);
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
});
