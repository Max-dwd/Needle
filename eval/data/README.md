# LLM Aligner Golden Dataset

Generated at: 2026-05-03T16:40:17.139Z

Complete cases: 4
Missing cases: 0

See `manifest.json` for case metadata and `cases/*/golden.json` for reference subtitles.

Use a case as an eval reference by adding `goldenJsonPath` to an experiment:

```json
{
  "id": "short-bilibili-ai-news",
  "audioPath": "/absolute/path/to/audio.mp3",
  "goldenJsonPath": "eval/data/cases/short-bilibili-ai-news/golden.json"
}
```

Runs with a golden reference write `quality` metrics into `metrics.json`, including normalized character error rate, text coverage, segment count ratio, timing MAE/P95, and fallback ratio.
