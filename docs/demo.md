# Demo and screenshot guide

Needle's README images are screenshots of the running application, not UI mockups. They use only fictional channels, original SVG covers, and explicitly authored sample transcripts and summaries.

## Run a disposable demo

```bash
npm ci
npm run demo
```

Visit http://127.0.0.1:3100. To use a different port:

```bash
DEMO_PORT=3101 npm run demo
```

For screenshots without development indicators:

```bash
npm run build
npm run demo -- --production
```

The launcher creates a unique directory under the operating system's temporary directory. Before loading the database module or starting Next.js, it overrides the application storage paths: `DATA_ROOT`, `DATABASE_PATH`, `SUBTITLE_ROOT`, `SUMMARY_ROOT`, `SUMMARY_MD_ROOT`, and `PIPED_INSTANCES_FILE`. These take precedence over paths in `.env.local`.

The fixture has nine fictional videos, six fictional channels, six research favorites, one collection, and sample subtitles/summaries. Scheduled crawling, per-intent subtitle/summary automation, and browser keepalive are off. No AI provider credentials are added. Normal shutdown removes the temporary dataset; a forced kill or crash may leave its printed temporary directory behind.

This is an interactive UI demo, not a network-isolated sandbox. Do not enable crawling, import real subscriptions, add provider keys, or sign into platforms when preparing public assets. Fictional video links do not play real media. Do not describe the authored sample summaries as model output.

## Capture the product

1. Use the demo launcher, not your usual database. Verify the six channel names are Local Lab, 设计手记, Systems Studio, 研究日常, Form & Function, and 开放笔记.
2. Open the feed in a desktop browser. Capture the content area with its native gray/purple UI. The existing images use a 1203 × 899 viewport (with a focused crop for the summary preview).
3. Capture light and dark themes using the sidebar theme switch. Hover over the first card for the summary preview.
4. Capture an organized research collection and Channel Management. Keep useful controls and notes visible.
5. Inspect every image at full size. Check browser chrome, account names, URLs, API keys, notifications, personal subscriptions, and background windows before committing.

Screenshot files are under [`docs/assets/`](./assets/). `feed-light.png` and `feed-dark.png` are selected automatically by the README's `<picture>` element. The other images show summary previews, research favorites, and intent/topic channel management.

The launcher lives in [`scripts/demo.ts`](../scripts/demo.ts); improve the fixture there instead of editing pixels or replacing private names after a screenshot.
