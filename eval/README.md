# LLM Aligner Eval

This folder extracts Needle's current `llm-aligner` subtitle path into a file-based experiment runner. It takes local audio files, chunks them, asks a configured multimodal model to transcribe each chunk, runs the local MLX forced aligner, then writes subtitle and metrics artifacts per experiment.

The runner is intentionally independent from the app video table. It reuses the production pipeline functions from:

- `src/lib/subtitle-llm-align-correction.ts`
- `src/lib/forced-aligner-runtime.ts`
- `src/lib/audio-slicer.ts`
- `src/lib/subtitle-providers/*`

## Run

```bash
npm exec tsx -- eval/run-llm-aligner-eval.ts \
  --manifest eval/llm-aligner-manifest.example.json
```

Single audio file:

```bash
npm exec tsx -- eval/run-llm-aligner-eval.ts \
  --audio /path/to/audio.mp3 \
  --id sample-a \
  --model-id your-multimodal-model-id \
  --chunk-seconds 300 \
  --max-segment-seconds 3 \
  --golden-json eval/data/cases/short-bilibili-ai-news/golden.json \
  --chunk-concurrency 2
```

`--model-id` resolves from Settings -> Models via the local SQLite app settings. For isolated experiments, pass a model JSON with `--model-file` or inline `model` in the manifest.
Use `--provider-model <slug>` when you want to reuse a configured model's endpoint/API key but test another provider model slug from the same provider. This is useful for temporary A/B runs and avoids writing API keys to ad hoc model files.
Use `--coverage-prompt` to add stricter verbatim-coverage instructions for a single run without changing the default production transcription prompt.

Before importing the eval pipeline, the CLI loads environment variables from the repo root in this order:

1. `.env.local`
2. `.env`

Existing shell variables win. Values that are already present in `process.env` are not overwritten, and `.env` does not override values loaded from `.env.local`. This keeps eval runs aligned with the app runtime so settings such as `MLX_FORCED_ALIGNER_BIN` are available before production modules read env at import time.

## Golden Quality Metrics

Manifest `defaults` and each `experiments[]` entry may include either:

- `goldenJsonPath`: path to a generated golden file such as `eval/data/cases/*/golden.json`.
- `goldenSubtitlePath`: path to a Needle-style subtitle JSON file. This is accepted as an alias for ad hoc references.

When a golden path is present, the runner adds `quality` to `metrics.json` and to `subtitle.json.metadata`. The console `[ok]` line also includes a compact quality summary:

```text
[ok] sample segments=120 chunks=2 fallback=0 ncer=0.0831 coverage=0.942 startMae=0.421s endMae=0.517s out=eval/runs/...
```

Current scoring is intentionally simple and stable:

- `text.normalizedCharErrorRate`: CER over NFKC/lowercased text after removing whitespace and punctuation.
- `text.coverage`: LCS reference-character coverage found in the hypothesis text. This is less brittle than greedy subsequence coverage when a local word difference shifts later matching text.
- `segments.countRatio`: hypothesis segment count divided by reference segment count.
- `pairingMethod`: currently `lcs-anchor`, meaning timing errors compare hypothesis segment boundaries against nearby reference characters found by LCS text anchors.
- `timing.startMaeSeconds` / `endMaeSeconds`: LCS-anchor timing MAE. This is the primary timing gate when text coverage is acceptable, because it is less distorted by local insertions/deletions than proportional text-position pairing.
- `timing.startP95Seconds` / `endP95Seconds`: LCS-anchor timing P95.
- `textPositionTiming`: the older proportional text-position timing metrics, kept as a drift diagnostic.
- `fallbackRatio`: copied from the run summary so quality reports show how often aligner fallback was used.

If no golden path is configured, the runner keeps the previous behavior and does not write `quality`.

## Subtitle Timing Analysis

Compare any hypothesis `subtitle.json` against a golden reference without rerunning the eval pipeline:

```bash
npm exec tsx -- eval/analyze-subtitle-timing.ts \
  --hyp eval/runs/<run>/subtitle.json \
  --golden eval/data/cases/short-bilibili-ai-news/golden.json
```

The helper reports text-position pairing: each hypothesis segment is matched to the reference timeline at the same proportional normalized text position. It reports median / MAE / P95 for start, end, and combined boundary timing errors overall and by early / mid / late text-position buckets. Use it as a drift diagnostic; the eval runner's primary `quality.timing` uses LCS anchors.

If `eval/runs/<run>/metrics.json` exists next to the hypothesis file, chunk metadata is loaded automatically and the report also includes chunk-boundary-distance buckets. Pass `--metrics <path>` for another metrics file, `--boundary-window-seconds 10` to adjust the near-boundary window, or `--json-output eval/runs/<run>/timing-analysis.json` to persist the full per-segment analysis.

## Parallelism

- `concurrency`: how many experiments run at the same time.
- `chunkConcurrency`: how many chunks inside one experiment run at the same time.

Keep `chunkConcurrency` low for MLX forced-aligner runs if the machine is memory constrained.

## Segment Target

`llm.maxSegmentSeconds` and CLI `--max-segment-seconds` control the final subtitle split target, not the audio chunk length. The default is `3` seconds to match the checked-in golden dataset's short 1-4 second subtitle style. Use a larger value only when deliberately testing long-segment behavior.

## Output

Each experiment writes a separate directory under `eval/runs/` unless `outputDir` is set:

- `input.json`: normalized input and redacted model metadata
- `transcripts/chunk-*.json`: LLM utterance output per chunk
- `aligner/chunk-*/`: transcript text and aligner JSON output
- `subtitle.json`: Needle-style subtitle payload
- `subtitle.txt`: readable timestamped subtitle text
- `metrics.json`: full experiment metrics, optional `quality`, and chunk records

Audio chunks are removed by default. Set `keepAudioChunks: true` or pass `--keep-audio-chunks` when you need to inspect them.

## Runtime Requirements

Use the same local runtime as the app:

```bash
MLX_FORCED_ALIGNER_BIN=./scripts/mlx_forced_aligner_wrapper.py
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
```

The forced aligner wrapper expects the repo-local MLX runtime described in the main README.
Put local paths in `.env.local` when possible so both the app and eval runner see the same runtime configuration.

## Golden Dataset

Build the checked-in golden references from locally fetched Needle subtitles:

```bash
npm run eval:golden:build
```

The output lives in `eval/data/`:

- `manifest.json`: case list, metadata, and any missing local subtitles
- `cases/*/golden.json`: normalized reference subtitle payload
- `cases/*/golden.txt`: timestamped readable reference subtitle

Use `npm run eval:golden:build -- --strict` when a missing target should fail the command.
