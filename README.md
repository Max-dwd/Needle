# Needle

[中文版](./README.zh.md)

**Local-first video subscription manager for YouTube and Bilibili.**

Needle fetches channel metadata and video lists, downloads subtitles, generates AI summaries through any OpenAI-compatible backend, and organizes channels along two independent axes — **Intent** and **Topics** — with an event-driven pipeline that takes a new video from discovery to subtitled summary automatically.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen)](https://nodejs.org/)

> [!WARNING]
> **No authentication.** All API endpoints are unauthenticated. Run Needle only on localhost or a trusted private network — never expose it to the public internet.

---

## Features

- **Intent × Topics** channel organization — each Intent has independent auto-subtitle / auto-summary toggles and per-intent model overrides
- **Event-driven pipeline** — new video → subtitle → summary, all automatic
- **Subtitle pipeline** — Needle Browser → Whisper-anchored AI subtitles → Gemini audio transcription fallback, with staged retry backoff
- **AI summaries** — OpenAI-compatible (OpenAI, Ollama, Gemini, any endpoint); shared RPM/TPM/RPD budget across all AI calls
- **AI Chat panel** — select a subtitle time range and chat with the content; outputs Obsidian-style markdown notes or roast share cards (PNG export)
- **Audio mode + Media Session** — full lock-screen controls on mobile, silent-MP3 heartbeat keeps iOS audio session alive
- **Intent Agents** — per-intent AI agents with persistent memory, triggered manually, daily, or on new videos; exposed via MCP server
- **Research workspace** — bookmark videos, organize into collections, export as ZIP with subtitles and summaries
- **Backup / restore** — one command archives the SQLite database, subtitles, and summaries
- **Real-time UI** — SSE push for crawler status, pipeline progress, subtitle and summary events; no polling

---

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run browser:prepare   # build the Needle Browser sub-projects (required once)
npm run dev               # http://localhost:3000
```

The database and data directories are created automatically on first run.

---

## Docker Quick Start

Run Needle in Docker on the same machine as Chrome:

```bash
cp .env.example .env.local   # optional, for local overrides and secrets
docker compose up -d --build
```

Then open `http://localhost:3000`.

Important notes for Docker:
- The web app runs in the container, but the **Needle Browser Bridge extension still runs in Chrome on the host machine**.
- `compose.yaml` publishes `19825:19825`; keep that port available because the host extension connects to `localhost:19825`.
- `./data` is bind-mounted to `/app/data`, so SQLite, subtitles, summaries, logs, and backups persist on the host.
- `.env.local` is loaded into the container when present. The compose file pins the container data paths and daemon bind host; use `.env.local` mainly for optional values such as `BILIBILI_SESSDATA`, `LOG_LEVEL`, or tool path overrides.
- You do **not** need to run `npm run browser:prepare` on the host just to start the container. Run it only when you want to rebuild the local browser runtime / extension bundle from source.

Install or refresh the host-side Chrome extension from this repo:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `browser-bridge/extension`

Useful Docker commands:

```bash
docker compose logs -f
docker compose down
docker compose up -d --build
NEEDLE_HTTP_PORT=3001 docker compose up -d --build  # if port 3000 is already in use
```

> [!NOTE]
> `YOUTUBE_COOKIES_BROWSER=chrome` points to a browser profile inside the container, not your host Chrome profile. For Docker deployments, prefer OPML import, the browser-based import flow, or explicit auth values such as `BILIBILI_SESSDATA`.

---

## Requirements

**Minimum:**
- Node.js 20+
- Google Chrome or Chromium (used by the Needle Browser runtime and Bridge extension)

**Optional — enable by feature:**

| Tool | Used for |
|------|----------|
| `yt-dlp` | YouTube cookie import, Gemini subtitle audio extraction |
| `ffmpeg` / `ffprobe` | Gemini and Whisper subtitle audio slicing |
| `mlx-whisper` | Whisper-anchored subtitle source on Apple Silicon |

```bash
# macOS
brew install yt-dlp ffmpeg
python3 -m pip install mlx-whisper

# Ubuntu / Debian
sudo apt install -y ffmpeg
sudo add-apt-repository ppa:tomtomtom/yt-dlp && sudo apt install -y yt-dlp
```

`mlx-whisper` is the local CLI Needle uses for Whisper-anchored subtitles. It currently targets Apple Silicon Macs, and the first run downloads the selected Whisper model from Hugging Face automatically.

---

## Configuration

### Environment variables

Copy `.env.example` to `.env.local` and adjust as needed:

```env
# Core paths
PORT=3000
DATA_ROOT=./data
DATABASE_PATH=./data/folo.db
SUBTITLE_ROOT=./data/subtitles
SUMMARY_ROOT=./data/summaries
SUMMARY_MD_ROOT=./data/summary-md

# Optional: tools
PYTHON_BIN=python3
YT_DLP_BIN=yt-dlp
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
MLX_WHISPER_BIN=mlx_whisper
WHISPER_MODEL_ID=mlx-community/whisper-base-mlx-q4

# Optional: authenticated access
YOUTUBE_COOKIES_BROWSER=chrome   # browser whose cookie store to use
BILIBILI_SESSDATA=your_sessdata

# Optional: logging
LOG_LEVEL=info

# Needle Browser daemon
FOLO_BROWSER_DAEMON_PORT=19825
FOLO_BROWSER_DAEMON_BIND_HOST=127.0.0.1
```

AI model endpoints, API keys, and model IDs are configured at runtime in **Settings → Models** — not through environment variables.

### Install the Needle Browser Bridge extension

The crawler and subscription import flow run through the first-party `browser-runtime` daemon and `browser-bridge` Chrome extension.

```bash
npm run browser:prepare
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `browser-bridge/extension`.

For Docker deployments, this extension still runs on the host Chrome instance and talks to the containerized daemon through the published `19825` port.

### Install mlx-whisper for Whisper-anchored subtitles

Needle checks for a local `mlx_whisper` binary before it tries the Whisper-anchored subtitle source. On Apple Silicon macOS, install it with:

```bash
brew install ffmpeg
python3 -m pip install mlx-whisper
```

If the binary is not on your `PATH`, set `MLX_WHISPER_BIN` to the full executable path. The default Whisper model is `mlx-community/whisper-base-mlx-q4`; you can override it with `WHISPER_MODEL_ID` or pick a different model in Settings → Subtitles.

After installation, open Settings → Subtitles and click **Check Environment**. Needle will call `/api/settings/whisper-status` and confirm whether `mlx_whisper` is available.

### Import subscriptions

| Source | How |
|--------|-----|
| YouTube | Import an OPML file in Settings → Import |
| Bilibili | Set `BILIBILI_SESSDATA` then import following list |
| Manual | Paste any channel or video URL — supports `/channel/{id}`, `/@handle`, `/c/{name}`, `/space/{uid}`, `/video/{bvid}`, `watch?v=...` |

---

## How it works

### Intent × Topics

**Intents** are the primary navigation axis. Each intent has:
- Independent `auto_subtitle` and `auto_summary` toggles
- An optional per-intent model override (`auto_summary_model_id`)
- Agent configuration (prompt, trigger, persistent memory)

Five built-in intents: Work, Entertainment, Explore, News, Uncategorized.

**Topics** are free-form tags stored as a JSON array on each channel. They work across intents as a secondary filter.

Manage intents in **Settings → Intents & Automation**.

### Crawling

A built-in scheduler polls channels on a configurable interval (default: every 2 hours). Failed channels back off exponentially (30 min → 24 h max). The crawler can be paused or triggered manually at any time; a scope lock prevents scheduler and manual refresh from colliding.

Crawl source order is configurable in **Settings → Crawling**.

### Subtitle pipeline

1. Needle Browser downloads native subtitles
2. Falls back to Whisper-anchored AI subtitles: local `mlx_whisper` produces timestamp anchors, then a multimodal LLM corrects the transcript; if that fails, Needle keeps the raw Whisper text as a last-resort fallback
3. Falls back to Gemini audio transcription if Whisper-anchored subtitles are unavailable
4. Retry schedule on failure: `10 min → 30 min → 2 h → 6 h → 24 h` (staged by error type)

VTT, SRT, and JSON3 formats are normalized to a unified `SubtitleSegment[]` structure.

### AI Summaries

- Works with any OpenAI-compatible endpoint (OpenAI, Ollama, Gemini, LM Studio, etc.)
- Two default models: one for manual triggers, one for the auto pipeline
- Five editable prompt templates: Default · Subtitle API · Subtitle Segment · Chat (Obsidian) · Chat (Roast)
- Summaries written to `data/summaries/{platform}/{videoId}.md` with full YAML frontmatter (model, endpoint, token usage, latency, trigger source)
- Previous version automatically backed up as `.prev.md` before regeneration
- Streamed via SSE with real-time character progress, TTFT, and TPS metrics

**Shared AI budget:** summaries, Gemini subtitle transcription, and chat all share one RPM/TPM/RPD scheduler. Priority: `manual-summary > manual-subtitle > auto-summary > auto-subtitle`.

### AI Chat panel

Inside the player, select a subtitle time range with the dual-handle `TimelineRange` slider and chat with that segment of content.

| Mode | Output |
|------|--------|
| **Obsidian** | Markdown note with YAML frontmatter — copy or download as `.md` |
| **Roast** | Short commentary rendered as a 540 px dark share card, exportable as PNG |

Both prompt templates are editable in **Settings → Summaries**.

### Intent Agents

Each intent can have an AI agent with:
- **Prompt** — what to analyze (e.g., "Extract actionable signals from new videos this week")
- **Trigger** — `manual`, `daily`, or `on_new_videos`
- **Persistent memory** — the agent reads and writes its own memory across runs

Agents connect to Needle via the MCP server (`npm run mcp:start`) and have five tools:

| Tool | Purpose |
|------|---------|
| `get_intent_agent_context` | Intent config + recent video list with subtitles |
| `search_videos` | Search across intents by keyword, platform, or date range |
| `read_subtitle` | Read a single video's subtitle text |
| `save_artifact` | Save analysis output to `data/agent-artifacts/{intentName}/` |
| `update_memory` | Read/write the agent's persistent memory |

MCP connection settings are in `.mcp.json`.

### Research workspace

`/research` is a dedicated workspace for deeper investigation:
- **Favorites** — bookmark any video with notes, tagged by research intent type (presets: Fact-check, Deep Research, Learning; fully customizable)
- **Collections** — group favorites into named collections with per-item annotation overrides
- **Export** — package a collection as a ZIP with subtitles and summaries, ready for external LLM workflows

### Audio mode

On mobile (viewport ≤ 900 px), the player automatically enters audio mode:
- `AudioModeOverlay` shows album-cover UI with title, channel, play/pause, ±10 s jump, and a tap-to-seek progress bar
- Media Session API integration for lock-screen controls and headphone buttons
- A looping silent MP3 keeps the iOS audio session alive through screen lock

---

## Subtitle export workflow

Export subtitles as self-contained Markdown task files that an external LLM can summarize directly:

```bash
npm run export:summary-md

# With filters
node scripts/export-subtitle-markdown.mjs --platform youtube
node scripts/export-subtitle-markdown.mjs --platform bilibili --video BV18TAkzbETb --overwrite
node scripts/export-subtitle-markdown.mjs --platform youtube --video I9cnH-D0FRY --clickable
```

`--clickable` expands timestamps into `https://youtu.be/{id}?t={sec}` links. Each file includes a YAML frontmatter header (video_id, platform, source_url, channel, duration, subtitle_language) followed by the full subtitle text.

Convert task files to structured JSON summaries:

```bash
node scripts/generate-summary-json.mjs  # output → data/summaries/
```

---

## Data layout

```
data/
  folo.db                            # SQLite database (WAL mode)
  subtitles/<platform>/<videoId>/    # Downloaded subtitle JSON files
  summaries/<platform>/<videoId>.md  # AI summaries (YAML frontmatter + body)
  summary-md/<platform>/<videoId>.md # Exported subtitle task files
  agent-artifacts/<intentName>/      # Intent agent output artifacts
  logs/                              # Structured JSONL logs
  backups/                           # Backup archives
```

---

## Commands

```bash
# Development
npm run dev              # Start dev server (http://localhost:3000)
npm run build            # Production build
npm run start            # Start production server
npm run stop             # Stop production server
npm run restart          # stop → git pull → build → start

# Quality
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest
npm run format           # Prettier

# Data
npm run backup           # Create backup archive
npm run restore          # Restore from backup archive
npm run export:summary-md  # Export subtitle markdown task files

# Needle Browser sub-projects
npm run browser:prepare          # Build runtime + bridge (run once)
npm run browser:runtime:build    # browser-runtime only
npm run browser:bridge:build     # browser-bridge/extension only
npm run browser:bridge:package   # Package extension as distributable zip

# MCP server
npm run mcp:start        # Start stdio MCP server for external agents
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 / React 19 (App Router, Server Components) |
| Language | TypeScript (strict), `@/*` → `src/*` |
| Database | SQLite via `better-sqlite3` (sync API, WAL, server-side only) |
| Styling | Tailwind CSS v4 + `tailwind-merge` + `class-variance-authority` |
| UI primitives | `@base-ui/react` |
| Image export | `html-to-image` (roast share card → PNG) |
| Testing | Vitest |

---

## Sub-projects

| Directory | Purpose |
|-----------|---------|
| `browser-runtime/` | First-party Needle Browser daemon (own `package.json`) |
| `browser-bridge/extension/` | Needle Browser Bridge Chrome extension source |
| `browser-bridge-package/` | Pre-built bridge extension artifacts (loaded at runtime) |

---

## Developer docs

Architecture, database schema, API route inventory, internal singletons, and gotchas are documented in [`CLAUDE.md`](./CLAUDE.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).
