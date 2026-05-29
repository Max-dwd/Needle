# Needle Subtitle Pipeline Eval

## Project Description

This eval project tests Needle's artifact-only subtitle pipeline for YouTube and
Bilibili videos. The content set focuses on English and Chinese technical talks,
education videos, keynotes, and conversation-style videos across short, medium,
long, and hard cases. The goal is to measure whether an audio-based LLM
transcription plus forced-alignment pipeline can produce subtitles that are
close enough to trusted browser captions in both text coverage and timestamp
quality.

## Setup

1. Install project dependencies from the repo root:

```bash
npm install
```

1. Install the local forced-aligner runtime:

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install mlx-audio mlx-forced-aligner
```

1. Copy the eval config and edit the video targets, provider, and model:

```bash
cp eval/config.example.yaml eval/config.local.yaml
```

1. Put required secrets and local tool paths in the repo-root `.env.local`.

The YAML chooses the provider with `model.protocol`, `model.endpoint`, and
`model.model`; `.env.local` only stores secrets and machine-local paths.

```env
# .env.example
NEEDLE_EVAL_API_KEY=replace-with-your-provider-key
MLX_FORCED_ALIGNER_BIN=./scripts/mlx_forced_aligner_wrapper.py
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
```

1. In `eval/config.local.yaml`, point `apiKeyEnv` at the key name above:

```yaml
model:
  protocol: gemini
  endpoint: https://generativelanguage.googleapis.com/v1beta
  model: gemini-3.1-flash-lite
  apiKeyEnv: NEEDLE_EVAL_API_KEY
```

1. Validate the config before running live fetches or eval jobs:

```bash
npm run eval:llm-aligner -- --config eval/config.local.yaml --validate-config
```

## How To Run

Build or refresh the golden dataset from configured live videos:

```bash
npm run eval:golden:build -- --config eval/config.local.yaml
```

Run the artifact-only subtitle pipeline:

```bash
npm run eval:llm-aligner -- --config eval/config.local.yaml
```

Run a single case:

```bash
npm run eval:llm-aligner -- --config eval/config.local.yaml --case short-youtube-llm-ibm
```

Open the eval artifact viewer:

```bash
npm run eval:ui
```

Then visit `http://127.0.0.1:4173`. If the port is busy:

```bash
npm run eval:ui -- --port 4174
```

## Eval Results

Snapshot: 12 configured cases from `eval/config.example.yaml`, generated on
2026-05-26 with `gemini-3.1-flash-lite`. The latest recorded run passed 10 of
12 quality gates.

Precision and recall are reported as eval proxies because the current harness
stores subtitle quality metrics rather than classification labels:

- Precision proxy: `1 - normalizedCharErrorRate`
- Recall proxy: LCS text coverage against the golden subtitle
- Cost: measured average token or local compute cost per case; dollar cost is
not stored in the current artifacts.


| Stage                | Precision     | Recall        | Cost                                    |
| -------------------- | ------------- | ------------- | --------------------------------------- |
| Golden caption fetch | N/A           | N/A           | Browser/runtime fetch only              |
| Audio cache/prep     | N/A           | N/A           | Local `ffmpeg`/`ffprobe` work           |
| LLM transcription    | TBD per stage | TBD per stage | 54,400 tokens avg/case                  |
| Forced alignment     | TBD per stage | TBD per stage | 117.1s local aligner avg/case           |
| End-to-end           | 0.9318        | 0.9543        | 224.3s avg/case, 54,400 tokens avg/case |


Known failures:


| Case                              | Main issue                                       |
| --------------------------------- | ------------------------------------------------ |
| `short-chinese-chloe-remember`    | Text coverage below the configured gate          |
| `long-hard-youtube-openai-devday` | One interpolated alignment chunk lowers coverage |


## Pipeline Stages

1. Golden dataset build: fetch video metadata, trusted browser captions, and

audio for configured videos. This creates stable case directories so later runs
can compare against the same references.

1. Audio chunking: split long audio into smaller chunks. This keeps LLM audio

requests manageable and makes retries/debugging cheaper.

1. LLM transcription: send each audio chunk to the configured multimodal model.

This stage is used because the target pipeline must work even when platform
captions are missing or insufficient.

1. Forced alignment: align the transcript text back to audio with a local MLX

forced aligner. This stage gives word/segment timing instead of relying on the
LLM to invent timestamps.

1. Quality scoring: compare generated subtitles against golden captions with

text coverage, normalized character error rate, segment count ratio, and
timestamp MAE/P95. This makes pipeline changes measurable instead of judged by
manual inspection alone.

1. Artifact viewer: inspect saved runs from `eval/runs` without starting long

eval jobs from the UI. This keeps generation, logging, and review separate.