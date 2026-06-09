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

1. Prepare the Needle Browser runtime and Chrome extension. This is required

when the golden builder fetches live browser captions or audio.

```bash
npm run browser:prepare
```

Then open `chrome://extensions`, enable Developer mode, click Load unpacked,
and select `browser-bridge/extension`. If the extension is already loaded and
up to date, you can skip this step. Existing `eval/data` cases can be evaluated
and viewed without the extension.

1. Copy the eval config and edit the video targets, provider, and model:

```bash
cp eval/config.example.yaml eval/config.local.yaml
```

1. Put required secrets and any local tool path overrides in the repo-root `.env.local`.

The YAML chooses the provider with `model.protocol`, `model.endpoint`, and  `model.model`; `.env.local` only stores secrets and optional machine-local path overrides.

```env
# .env.example
NEEDLE_EVAL_API_KEY=replace-with-your-provider-key
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
# Optional: defaults to ./scripts/mlx_forced_aligner_wrapper.py when present.
MLX_FORCED_ALIGNER_BIN=./scripts/mlx_forced_aligner_wrapper.py
```

1. In `eval/config.local.yaml`, point `apiKeyEnv` at the key name above:

```yaml
model:
  protocol: gemini
  endpoint: https://generativelanguage.googleapis.com/v1beta
  model: gemini-2.5-flash-lite
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

Run the gemini-fallback pipeline (Gemini self-emitted timestamps, no forced
aligner) for comparison against llm-aligner. Defaults to the 4 cases that have
llm-aligner results; pass `--case` (repeatable) to choose others:

```bash
npm run eval:gemini-fallback -- --config eval/config.local.yaml
npm run eval:gemini-fallback -- --config eval/config.local.yaml --case short-youtube-llm-ibm
```

Outputs land in `eval/runs-gemini-fallback/` (gitignored), one `metrics.json`
per case scored against the same browser golden as llm-aligner.

Build or run a single case and merge it into the existing golden manifest
(without rebuilding the other cases):

```bash
npm run eval:golden:build -- --config eval/config.local.yaml --case short-youtube-llm-ibm
```

Open the eval dashboard:

```bash
npm run eval:ui
```

Then visit `http://127.0.0.1:4173`. If the port is busy:

```bash
npm run eval:ui -- --port 4174
```

The dashboard is no longer read-only. From the browser you can:

- **Run a case** — click `Run` next to any case (in the Cases list or the
Golden Set Overview) to spawn the pipeline for just that case. Use **Run all**
in the header to run the whole golden set. Live logs stream into the Jobs
console and the metrics refresh when the job finishes.
- **Submit a URL** — paste a YouTube or Bilibili video URL into the **Add Video**
form (with optional tier/difficulty/language/note). The server writes the
target into a generated `eval/config.adhoc.yaml` (the curated
`config.local.yaml` golden set is left untouched), fetches its golden captions,
and runs the pipeline. You never hand-edit config.
- **See per-item metrics** — the Golden Set Overview table shows each case's
latest gate result, coverage, NCER, start MAE, and segment count at a glance;
click a row to open that run's full diff.

Notes:

- The dashboard runs against the config in `EVAL_CONFIG` (default
`eval/config.local.yaml`). It spawns the same `eval:golden:build` /
`eval:llm-aligner` CLIs as child processes, so runs need the provider API key,
`ffmpeg`/`ffprobe`, and the MLX forced aligner just like the CLI.
- A full URL submission additionally needs the Needle Browser runtime + Chrome
extension running, because the golden caption + audio fetch goes through the
live browser source (see Setup step 3).
- `eval/config.adhoc.yaml` is generated and gitignored; it re-derives its
model/pipeline/aligner blocks from `config.local.yaml` on each submission so
credentials stay in sync.

## Eval Results

Historical snapshot: 12 configured cases from `eval/config.example.yaml`,
generated on 2026-05-26 with `gemini-2.5-flash-lite`. That run passed 10 of 12
quality gates (see the no-longer-current "Known failures" note below).

### llm-aligner vs. gemini-fallback (both scored against the browser golden, `gemini-3.1-flash-lite`)

> **What is being compared.** The meta-review asked to compare "the Needle
> Browser pipeline against the Gemini fallback." In this harness the **browser
> captions are the trusted reference (`golden.json`), not a candidate** — they
> are assumed correct and every pipeline is scored against them. So the two
> things actually competing are the *fallbacks that run when browser captions
> are unavailable*: `llm-aligner` and `gemini`. Both consume the same audio and
> are graded against the same browser golden, which is exactly the production
> question — "when we can't get browser captions, which fallback reproduces them
> best?"

The two candidate fallback pipelines, each scored against the same trusted
browser captions (`golden.json`) with the same coverage / NCER / timing-MAE
logic and gate. They differ only in where timestamps come from:

```
llm-aligner    : audio → Gemini transcription (text) → MLX Qwen3 forced aligner (timing) → subtitle.json
gemini-fallback: audio → Gemini transcription with self-emitted [mm:ss] timestamps → subtitle.json
```

Both correspond to real Needle production subtitle methods (`SubtitleMethod =
'browser' | 'whisper-ai' | 'llm-aligner' | 'gemini'`). The llm-aligner numbers
come from `eval:llm-aligner`; the gemini-fallback numbers from
`run-gemini-fallback-eval.ts`, which faithfully replays the production `gemini`
method (`fetchSubtitleViaSegmentedAudio`: 900s chunks, the production timestamp
prompt, `parseAiRangeBlock`) on the same cached audio.

Sample: the same 4 cases run on 2026-06-08 (other 14 golden cases left unrun for
cost/rate limits).

| Case | Pipeline | Recall (cov) | Precision (1−NCER) | start MAE | end MAE | end P95 | Tokens | Gate |
| ---- | -------- | ------------ | ------------------ | --------- | ------- | ------- | ------ | ---- |
| `short-youtube-llm-ibm`        | llm-aligner     | 0.958 | 0.945 | 1.06s | 0.97s | 4.32s | 13.3k | pass |
|                                | gemini-fallback | 0.995 | 0.988 | 0.31s | 0.39s | 1.50s | 10.1k | pass |
| `adhoc-youtube-5sLYAQS9sWQ`    | llm-aligner     | 0.976 | 0.971 | 0.80s | 0.75s | 2.46s | 13.3k | pass |
|                                | gemini-fallback | 0.996 | 0.991 | 0.55s | 0.63s | 2.00s | 10.1k | pass |
| `short-chinese-chloe-remember` | llm-aligner     | 0.941 | 0.929 | 0.63s | 0.60s | 1.61s | 18.4k | pass |
|                                | gemini-fallback | 0.928 | 0.920 | 0.26s | 0.28s | 1.00s | 18.1k | pass |
| `adhoc-youtube-LAwBdRR4wQk` (38min) | llm-aligner     | 0.998 | 0.994 | 1.03s | 1.46s | 3.45s | 73.7k | pass |
|                                     | gemini-fallback | 0.998 | 0.997 | 2.03s | 2.78s | 8.28s | 69.5k | **FAIL** |
| **Average (n=4)** | llm-aligner     | **0.968** | **0.960** | **0.88s** | **0.94s** | — | **29.7k** | **4/4** |
|                   | gemini-fallback | **0.979** | **0.974** | **0.79s** | **1.02s** | — | **27.0k** | **3/4** |

What the comparison shows:

- **Text fidelity** — gemini-fallback is the better transcriber on the 3 English
  cases (recall 0.995–0.998 vs 0.958–0.998, lower NCER) and slightly cheaper.
  The reason is structural: llm-aligner runs Gemini text through the forced
  aligner, which *drops words it cannot align*, shaving coverage. gemini-fallback
  keeps Gemini's raw text. On Chinese, gemini-fallback is marginally worse
  (0.928 vs 0.941) from homophone/name swaps (雯→文, 丽荣→莉蓉).
- **Timing** — gemini-fallback's self-emitted timestamps are *tighter on short
  content* (start MAE 0.26–0.55s vs 0.63–1.06s) but **drift on long audio**: on
  the 38-min case it fails all four timing checks (start MAE 2.03s, end MAE
  2.78s, P95 8.3s, gate FAIL), because nothing bounds drift inside a 900s chunk.
  The MLX forced aligner keeps llm-aligner's timing bounded on the same case
  (1.03s / 1.46s, P95 3.4s, pass).
- **Cost** — gemini-fallback uses slightly fewer tokens and skips the local MLX
  aligner step entirely (~100–300s/case of local compute), so it is cheaper and
  faster wall-clock.

Takeaway: gemini-fallback wins on short content (better text, tighter timing,
cheaper); llm-aligner is the safer choice for long content because forced
alignment keeps timestamps trustworthy where raw-LLM timing drifts. This is
consistent with Needle ordering the forced-alignment methods (`whisper-ai`,
`llm-aligner`) ahead of `gemini` in the production fallback chain. With only 4
cases (2 short EN, 1 short ZH, 1 medium EN), this is indicative, not a full-set
verdict; long/hard tiers are unrun.

### Worked example: a challenging case, end-to-end

The hardest case in the sample is `adhoc-youtube-LAwBdRR4wQk`, a 38-minute
English talk. It is a good illustration of *what the gate is for*, because the
same audio produces a **pass** on one pipeline and a **FAIL** on the other, and
the difference is entirely about which errors we tolerate.

The gate (`qualityGate` in `eval/config.local.yaml`) is:

```yaml
minCoverage: 0.90              # LCS text coverage vs golden  (recall)
maxNormalizedCharErrorRate: 0.25  # 1 − this ≈ precision
maxStartMaeSeconds: 2          # mean |start − golden start|
maxStartP95Seconds: 8          # 95th-pctile start error
maxEndMaeSeconds: 2            # mean |end − golden end|
maxEndP95Seconds: 8            # 95th-pctile end error
```

End-to-end on this case:

1. **Build golden** — fetch trusted browser captions + audio, cache as
   `golden.json` / `audio.mp3` under `eval/data/cases/adhoc-youtube-LAwBdRR4wQk/`.
2. **Transcribe** — Gemini reads the audio in 900s chunks. Both pipelines get
   essentially perfect text here (coverage 0.998, NCER ~0.003).
3. **Time the text** —
   - `llm-aligner` hands the text to the MLX forced aligner, which re-anchors
     every segment to the audio waveform. Timing stays bounded: start MAE 1.03s,
     end MAE 1.46s, P95 3.45s → **pass**.
   - `gemini-fallback` keeps Gemini's self-emitted `[mm:ss]` timestamps. Nothing
     re-anchors them, so small per-line offsets accumulate across a 900s chunk:
     start MAE 2.03s, end MAE 2.78s, end P95 8.28s → **FAIL** on all four timing
     checks.
4. **Score & gate** — same metrics, same thresholds, against the same golden.

**Acceptable errors** (the gate passes through; the output is still usable):

- *Text coverage ≥ 0.90 with minor wording loss.* The forced aligner drops a few
  words it can't align (llm-aligner recall 0.958–0.998); the subtitle is still
  faithful.
- *Homophone / proper-noun substitutions in Chinese* (雯→文, 丽荣→莉蓉). They
  dent NCER slightly but stay under 0.25 and don't change meaning.
- *Sub-2s average timing slop and the occasional outlier under P95 = 8s.* Viewers
  don't perceive a < 2s mean offset on a talking-head video.

**Rejecting errors** (these *should* fail the case — and do):

- *Average timing drift ≥ 2s* (`maxStart/EndMaeSeconds`). Subtitles that are a
  beat behind the whole video are worse than none; this is exactly the
  gemini-fallback failure above.
- *Tail timing blow-ups ≥ 8s at P95* (`maxStart/EndP95Seconds`). Even if the mean
  looks OK, a long tail means whole stretches are mistimed.
- *Coverage < 0.90 or NCER > 0.25.* The transcript is missing or mangling too
  much content to trust — this is what tripped `short-chinese-chloe-remember` on
  the old model before the re-run.

The takeaway for the pipeline order: forced alignment is what turns "great text,
untrustworthy timing" into a pass, which is why production runs `whisper-ai` /
`llm-aligner` ahead of raw `gemini`. The gate encodes the line between
*acceptable* (small, bounded, meaning-preserving) and *reject* (drift or loss
large enough that a viewer would rather have no subtitle).

Precision and recall are reported as eval proxies because the current harness
stores subtitle quality metrics rather than classification labels:

- Precision proxy: `1 - normalizedCharErrorRate`
- Recall proxy: LCS text coverage against the golden subtitle
- Cost: measured average token or local compute cost per case; dollar cost is
not stored in the current artifacts.

Per-stage aggregate below is from the historical 2026-05-26 12-case run
(`gemini-2.5-flash-lite`); the end-to-end row averages that set.

| Stage                | Precision     | Recall        | Cost                                    |
| -------------------- | ------------- | ------------- | --------------------------------------- |
| Golden caption fetch | N/A           | N/A           | Browser/runtime fetch only              |
| Audio cache/prep     | N/A           | N/A           | Local `ffmpeg`/`ffprobe` work           |
| LLM transcription    | TBD per stage | TBD per stage | 54,400 tokens avg/case                  |
| Forced alignment     | TBD per stage | TBD per stage | 117.1s local aligner avg/case           |
| End-to-end           | 0.9318        | 0.9543        | 224.3s avg/case, 54,400 tokens avg/case |


Known failures (from the 2026-05-26 `gemini-2.5-flash-lite` snapshot):


| Case                              | Main issue                                       | Status on `gemini-3.1-flash-lite`            |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| `short-chinese-chloe-remember`    | Text coverage below the configured gate          | Resolved — now passes at coverage 0.941 (re-run 2026-06-08) |
| `long-hard-youtube-openai-devday` | One interpolated alignment chunk lowers coverage | Not re-run — status on the current model unverified |


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