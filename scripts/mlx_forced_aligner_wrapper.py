#!/usr/bin/env python3
"""Needle wrapper for MLX forced-alignment CLIs.

Needle calls a simple executable shaped like:

    mlx_forced_aligner --audio chunk.wav --text transcript.txt --model ... \
      --output-format json --output aligned.json

The public Qwen3 MLX forced-aligner entrypoint currently lives behind
`python -m mlx_audio.stt.generate`, which appends `.json` to its output path and
may return sentence/token or segment/word shapes. This wrapper translates
Needle's stable CLI into that upstream command and normalizes the result to:

    { "words": [{ "text": "...", "start": 0.0, "end": 0.1, "prob": 0.9 }] }
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mlx_forced_aligner",
        description="Needle wrapper around mlx_audio forced alignment",
    )
    parser.add_argument("--audio", required=True, help="Audio file to align")
    parser.add_argument("--text", required=True, help="Transcript text file")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="MLX model id/path")
    parser.add_argument(
        "--output-format",
        default="json",
        choices=["json"],
        help="Only json is supported",
    )
    parser.add_argument("--output", required=True, help="Output JSON file")
    parser.add_argument("--language", default="", help="Optional language code")
    return parser.parse_args()


def repo_python() -> str:
    configured = os.environ.get("NEEDLE_FORCED_ALIGNER_PYTHON")
    if configured:
        return configured
    repo_root = Path(__file__).resolve().parents[1]
    venv_python = repo_root / ".venv" / "bin" / "python"
    if venv_python.exists():
        return str(venv_python)
    return sys.executable


def numeric(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def normalize_item(item: dict[str, Any]) -> dict[str, Any] | None:
    text = item.get("text") or item.get("word") or item.get("token") or item.get("char")
    start = numeric(item.get("start") or item.get("start_time"))
    end = numeric(item.get("end") or item.get("end_time"))
    if not isinstance(text, str) or not text.strip() or start is None or end is None:
        return None
    if end < start:
        return None
    prob = numeric(item.get("prob") or item.get("score") or item.get("confidence"))
    normalized: dict[str, Any] = {
        "text": text.strip(),
        "start": start,
        "end": end,
    }
    if prob is not None:
        normalized["prob"] = prob
    return normalized


def collect_words(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []

    candidates: list[dict[str, Any]] = []

    for key in ("words", "tokens", "alignments"):
        entries = payload.get(key)
        if isinstance(entries, list):
            candidates.extend(entry for entry in entries if isinstance(entry, dict))

    sentences = payload.get("sentences")
    if isinstance(sentences, list):
        for sentence in sentences:
            if not isinstance(sentence, dict):
                continue
            tokens = sentence.get("tokens")
            if isinstance(tokens, list):
                candidates.extend(token for token in tokens if isinstance(token, dict))
            else:
                candidates.append(sentence)

    segments = payload.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            words = segment.get("words")
            if isinstance(words, list):
                candidates.extend(word for word in words if isinstance(word, dict))
            else:
                candidates.append(segment)

    normalized = [normalize_item(item) for item in candidates]
    return [word for word in normalized if word is not None]


def run() -> int:
    args = parse_args()
    text = Path(args.text).read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("transcript text file is empty")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="needle-mlx-align-") as temp_dir:
        output_base = Path(temp_dir) / "aligned"
        command = [
            repo_python(),
            "-m",
            "mlx_audio.stt.generate",
            "--model",
            args.model,
            "--audio",
            args.audio,
            "--output-path",
            str(output_base),
            "--format",
            "json",
            "--text",
            text,
        ]
        if args.language:
            command.extend(["--language", args.language])

        subprocess.run(command, check=True)

        generated_path = output_base.with_suffix(".json")
        payload = json.loads(generated_path.read_text(encoding="utf-8"))
        words = collect_words(payload)
        if not words:
            raise SystemExit("mlx_audio produced no alignable words/tokens")

        output_path.write_text(
            json.dumps({"words": words}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
