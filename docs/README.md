# Needle Documentation

[中文版](./README.zh.md)

Last source scan: 2026-05-30.

This directory holds the details that make the root README hard to scan: setup variants, settings behavior, route inventory, data layout, and architecture notes. Prefer updating these docs when behavior changes instead of expanding the root README.

## Start Here

| Need | Read |
| --- | --- |
| Install, configure, deploy, or import subscriptions | [Configuration](./configuration.md) |
| Understand the app architecture, API routes, data layout, and pipelines | [Project details](./project-details.md) |
| Evaluate the llm-aligner subtitle pipeline | [Eval README](../eval/README.md) |
| Work as a coding agent in this repo | [AGENTS.md](../AGENTS.md) |

## Documentation Rules

- Root README stays short: product summary, quick start, command shortlist, links.
- `docs/configuration*.md` owns runtime setup, environment variables, Settings tabs, Docker, and optional subtitle runtimes.
- `docs/project-details*.md` owns architecture, routes, database tables, data flow, and subproject maps.
- `docs/design/` and `docs/specs/` contain historical or feature-specific design records. Verify them against source before treating them as current behavior.

## Current Source Anchors

| Area | Source files |
| --- | --- |
| App pages | `src/app/page.tsx`, `src/app/channels/page.tsx`, `src/app/settings/page.tsx`, `src/app/research/page.tsx` |
| API routes | `src/app/api/**/route.ts` |
| Settings tabs | `src/components/settings/SettingsShell.tsx`, `src/components/settings/shared.ts` |
| Pipelines | `src/lib/pipeline-config.ts`, `src/lib/fetcher.ts`, `src/lib/subtitles.ts`, `src/lib/auto-pipeline.ts` |
| AI settings and prompts | `src/lib/ai-summary-settings.ts`, `src/lib/ai-summary-client.ts`, `src/lib/ai-chat-client.ts` |
| Database | `src/lib/db.ts` |
| Browser integration | `browser-runtime/`, `browser-bridge/extension/`, `src/lib/browser-*.ts` |
| Eval harness | `eval/README.md`, `eval/config.example.yaml`, `eval/run-llm-aligner-eval.ts` |
