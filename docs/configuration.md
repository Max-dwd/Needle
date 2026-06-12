# Configuration

[中文版](./configuration.zh.md)

Last source scan: 2026-05-30.

Needle has two configuration layers:

1. `.env.local` configures local paths, external binaries, auth values, logging, and the browser daemon port.
2. The Settings UI configures AI providers, prompt templates, pipeline order, automation, performance, backup, Bilibili auth, and UI preferences.

AI model endpoint, API key, and model IDs live in **Settings -> Models**. Do not add new AI provider env vars unless the code changes.

## Environment Variables

Copy `.env.example` to `.env.local`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Next.js port for local `npm run dev` / `npm run start` |
| `DATA_ROOT` | Root for runtime data |
| `DATABASE_PATH` | SQLite database path |
| `SUBTITLE_ROOT` | Subtitle JSON root |
| `SUMMARY_ROOT` | Summary markdown root |
| `SUMMARY_MD_ROOT` | Exported subtitle task markdown root |
| `PYTHON_BIN` | Python executable used by helper scripts |
| `YT_DLP_BIN` | `yt-dlp` executable for YouTube cookies and audio extraction paths |
| `FFMPEG_BIN` | `ffmpeg` executable |
| `FFPROBE_BIN` | `ffprobe` executable |
| `MLX_WHISPER_BIN` | `mlx_whisper` executable for Whisper + AI correction subtitles |
| `WHISPER_MODEL_ID` | Default Whisper model |
| `FORCED_ALIGNER_RUNTIME` | `local` or `remote` forced-aligner mode |
| `FORCED_ALIGNER_REMOTE_URL` | Remote sidecar URL, normally `http://host.docker.internal:8766` in Docker |
| `MLX_FORCED_ALIGNER_BIN` | Optional local forced-aligner wrapper path; defaults to `./scripts/mlx_forced_aligner_wrapper.py` when present |
| `FORCED_ALIGNER_MODEL_ID` | Default forced-aligner model |
| `YOUTUBE_COOKIES_BROWSER` | Browser cookie source for YouTube import/extraction helpers |
| `BILIBILI_SESSDATA` | Optional Bilibili login cookie value |
| `LOG_LEVEL` | Structured log verbosity |
| `FOLO_BROWSER_DAEMON_PORT` | Needle Browser daemon port, default `19825` |
| `FOLO_BROWSER_DAEMON_BIND_HOST` | Needle Browser daemon bind host |

## Settings Tabs

The Settings page is routed by `?tab=` through `src/components/settings/SettingsShell.tsx`.

| Tab id | Component | What it owns |
| --- | --- | --- |
| `performance` | `PerformanceTab.tsx` | Crawler performance profile, browser keepalive preset, desktop/mobile frontend performance mode |
| `crawling` | `CrawlingTab.tsx` | Scheduler runtime, crawl interval, crawl source order |
| `subtitles` | `SubtitlesTab.tsx` | Subtitle source order, Whisper status, forced-aligner status, Gemini/API subtitle prompts and fallback model rules |
| `summary` | `SummaryTab.tsx` | Prompt templates for summaries, subtitle API, subtitle segments, chat Obsidian mode, and chat roast mode |
| `models` | `ModelsTab.tsx` | AI provider list, API keys, protocols, default manual/auto models, shared RPM/TPM/RPD budget |
| `errors` | `ErrorHandlingTab.tsx` | Hidden/unavailable/abandoned video behavior and inspection |
| `backup` | `BackupTab.tsx` | Backup creation and restore modes |
| `logs` | `LogsTab.tsx` | JSONL log viewer and stats |
| `intents` | `IntentTab.tsx` | Intent CRUD, ordering, auto-subtitle, auto-summary, per-intent model override, agent config |
| `bilibili` | `BilibiliSummaryTab.tsx` | Bilibili SESSDATA and official AI summary access |
| `appearance` | `AppearanceTab.tsx` | Theme/display preferences and player keyboard shortcuts |
| `research` | `ResearchIntentManagement.tsx` | Research intent type management |

Legacy tab names are normalized in `src/components/settings/shared.ts`: `general` and `scheduler` route to `crawling`, `ai` routes to `models`, and `bilibili-summary` routes to `bilibili`.

## Needle Browser Bridge

Needle crawling and browser-based imports use two local subprojects:

| Directory | Role |
| --- | --- |
| `browser-runtime/` | Node CLI/daemon that drives browser commands |
| `browser-bridge/extension/` | Chrome extension loaded by the user |
| `browser-bridge-package/` | Prebuilt bridge artifacts read by the app |

Build both local subprojects:

```bash
npm run browser:prepare
```

Load `browser-bridge/extension` in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `browser-bridge/extension`

## Docker

Start the app:

```bash
cp .env.example .env.local
docker compose up -d --build
```

Important details:

- `compose.yaml` maps the web app to host port `3000` by default.
- The browser daemon uses port `19825`; the host Chrome extension talks to that mapped port.
- `./data` is bind-mounted to `/app/data`.
- `.env.local` is loaded when present.
- Docker runs Linux, so Apple Silicon MLX runtimes should run on the host as a sidecar.

Use another HTTP port if needed:

```bash
NEEDLE_HTTP_PORT=3001 docker compose up -d --build
```

## Host Forced-Aligner Sidecar

When the app runs in Docker and the forced aligner runs on macOS:

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install mlx-audio mlx-forced-aligner
chmod +x scripts/mlx_forced_aligner_wrapper.py scripts/forced_aligner_sidecar.py

FORCED_ALIGNER_SIDECAR_PORT=8766 \
  .venv/bin/python scripts/forced_aligner_sidecar.py
```

Then run Needle with:

```bash
FORCED_ALIGNER_RUNTIME=remote \
FORCED_ALIGNER_REMOTE_URL=http://host.docker.internal:8766 \
docker compose up -d --build
```

The status API is `/api/settings/forced-aligner-status`.

## Subtitle Runtime Options

The current subtitle source ids are defined in `src/lib/pipeline-config.ts`.

| Source | Default | Notes |
| --- | --- | --- |
| `browser` | Enabled | Native subtitles through Needle Browser |
| `whisper-ai` | Enabled | Local Whisper timestamps plus multimodal AI correction |
| `llm-aligner` | Disabled | Multimodal transcription plus MLX forced alignment |
| `gemini` | Enabled | Multimodal audio transcription fallback |

Typical local setup:

```bash
brew install yt-dlp ffmpeg
python3 -m pip install mlx-whisper
```

Open **Settings -> Subtitles** to check Whisper and forced-aligner availability and to reorder/enable sources.

For normal repo-local `llm-aligner` runs, `MLX_FORCED_ALIGNER_BIN` can usually be omitted because Needle defaults to the bundled `./scripts/mlx_forced_aligner_wrapper.py` when that file exists. Set it only when you want to use a custom aligner executable.

## Subscription Import

| Source | Path |
| --- | --- |
| YouTube OPML | Import from the app UI through `/api/subscriptions/youtube` |
| YouTube browser login flow | `/api/subscriptions/youtube/browser` opens the login page in Needle Browser |
| Bilibili following list | Configure `BILIBILI_SESSDATA` or Settings -> Bilibili AI, then use `/api/bilibili/following` |
| Manual URL | Paste channel/video URLs in the app; route handling flows through channel/video APIs |

## Backup And Restore

Use the Settings backup tab or:

```bash
npm run backup
npm run restore
```

Backups include the SQLite database plus subtitle and summary file roots.
