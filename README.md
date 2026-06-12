# Needle

[中文版](./README.zh.md) · [Documentation](./docs/README.md)

**Local-first video subscription manager for YouTube and Bilibili.**

Needle fetches channel metadata and video lists, extracts subtitles, generates AI summaries through OpenAI-compatible providers, and organizes channels by **Intent × Topics**. Data stays local: SQLite plus subtitle, summary, log, backup, and agent artifact files under `data/`.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen)](https://nodejs.org/)

> [!WARNING]
> **No authentication.** Needle's API routes are unauthenticated. Run it only on localhost or a trusted private network.

## What It Does

- Subscribes to YouTube and Bilibili channels
- Imports YouTube OPML and Bilibili following lists
- Crawls videos through the first-party Needle Browser runtime and Chrome extension
- Runs an event-driven pipeline: new video -> subtitle -> summary
- Supports native subtitles, Whisper + AI correction, optional LLM transcription + forced alignment, and Gemini-style multimodal fallback
- Stores editable AI model configs, prompt templates, shared AI budgets, and automation toggles in Settings
- Provides a research workspace for favorites, collections, notes, and ZIP export
- Exposes an MCP server for intent agents and external automation

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run browser:prepare
npm run dev
```

Open `http://localhost:3000`.

Install the Chrome bridge once:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `browser-bridge/extension`

AI providers are configured in **Settings -> Models**, not in `.env.local`.

## Docker

```bash
cp .env.example .env.local
docker compose up -d --build
```

Open `http://localhost:3000`.

The web app runs in Docker, but the Chrome extension still runs on the host and connects through port `19825`. Detailed Docker, sidecar, and runtime notes are in [Configuration](./docs/configuration.md).

## Common Commands

```bash
npm run dev
npm run build
npm run start
npm run stop
npm run typecheck
npm run test
npm run lint
npm run backup
npm run restore
npm run export:summary-md
npm run mcp:start
```

Browser subprojects:

```bash
npm run browser:prepare
npm run browser:runtime:build
npm run browser:bridge:build
npm run browser:bridge:package
```

Eval harness:

```bash
npm run eval:golden:build -- --config eval/config.local.yaml
npm run eval:llm-aligner -- --config eval/config.local.yaml
npm run eval:ui
```

## Documentation

- [Documentation index](./docs/README.md)
- [Configuration](./docs/configuration.md): environment variables, Settings tabs, Docker, browser bridge, subtitle runtimes, imports
- [Project details](./docs/project-details.md): architecture, routes, data layout, database tables, pipelines, subprojects
- [Eval harness](./eval/README.md): golden dataset and llm-aligner evaluation workflow
- [Agent instructions](./AGENTS.md): current repository navigation notes for Codex-style agents

## Tech Stack

- Next.js 16 / React 19 App Router
- TypeScript strict, `@/*` alias to `src/*`
- SQLite via `better-sqlite3`
- Tailwind CSS v4, `tailwind-merge`, `class-variance-authority`
- `@base-ui/react`
- Vitest

## License

MIT, see [LICENSE](./LICENSE).
