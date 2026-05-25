#!/usr/bin/env python3
"""Host-side HTTP sidecar for Needle's MLX forced aligner.

Run this on Apple Silicon macOS, then point a containerized Needle app at it
with FORCED_ALIGNER_RUNTIME=remote and FORCED_ALIGNER_REMOTE_URL.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_aligner_bin() -> str:
    return str(repo_root() / "scripts" / "mlx_forced_aligner_wrapper.py")


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def read_version(aligner_bin: str) -> str | None:
    try:
        result = subprocess.run(
            [aligner_bin, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None

    text = (result.stdout or result.stderr or "").strip()
    return text.splitlines()[0][:160] if text else None


def check_status(aligner_bin: str, model_id: str) -> dict[str, Any]:
    try:
        subprocess.run(
            [aligner_bin, "--help"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return {
            "available": True,
            "runtime": "sidecar",
            "binPath": aligner_bin,
            "modelId": model_id,
            "version": read_version(aligner_bin),
        }
    except Exception as exc:
        return {
            "available": False,
            "runtime": "sidecar",
            "binPath": aligner_bin,
            "modelId": model_id,
            "version": None,
            "error": str(exc),
        }


def parse_request_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length", "0") or "0")
    if length <= 0:
        raise ValueError("request body is empty")
    if length > 512 * 1024 * 1024:
        raise ValueError("request body is too large")
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def write_json(handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, Any]) -> None:
    body = json_bytes(payload)
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class ForcedAlignerSidecar(BaseHTTPRequestHandler):
    server_version = "NeedleForcedAlignerSidecar/1.0"

    def do_GET(self) -> None:
        if self.path.rstrip("/") != "/status":
            write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        write_json(
            self,
            HTTPStatus.OK,
            check_status(self.server.aligner_bin, self.server.model_id),  # type: ignore[attr-defined]
        )

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/align":
            write_json(self, HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            payload = parse_request_json(self)
            audio_base64 = payload.get("audioBase64")
            text = payload.get("text")
            if not isinstance(audio_base64, str) or not audio_base64:
                raise ValueError("audioBase64 is required")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("text is required")

            model_id = payload.get("modelId")
            if not isinstance(model_id, str) or not model_id.strip():
                model_id = self.server.model_id  # type: ignore[attr-defined]

            audio_suffix = Path(str(payload.get("audioFilename") or "audio.wav")).suffix or ".wav"
            audio_bytes = base64.b64decode(audio_base64)

            with tempfile.TemporaryDirectory(prefix="needle-aligner-sidecar-") as temp_dir:
                temp_path = Path(temp_dir)
                audio_path = temp_path / f"audio{audio_suffix}"
                text_path = temp_path / "transcript.txt"
                output_path = temp_path / "aligned.json"
                audio_path.write_bytes(audio_bytes)
                text_path.write_text(text, encoding="utf-8")

                env = {
                    **os.environ,
                    "PATH": ":".join(
                        part
                        for part in [
                            "/opt/homebrew/bin",
                            "/usr/local/bin",
                            os.environ.get("PATH", ""),
                        ]
                        if part
                    ),
                }
                subprocess.run(
                    [
                        self.server.aligner_bin,  # type: ignore[attr-defined]
                        "--audio",
                        str(audio_path),
                        "--text",
                        str(text_path),
                        "--model",
                        model_id,
                        "--output-format",
                        "json",
                        "--output",
                        str(output_path),
                    ],
                    check=True,
                    env=env,
                )
                result = json.loads(output_path.read_text(encoding="utf-8"))

            write_json(self, HTTPStatus.OK, result)
        except Exception as exc:
            write_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("FORCED_ALIGNER_SIDECAR_VERBOSE") == "1":
            super().log_message(format, *args)


class NeedleSidecarServer(ThreadingHTTPServer):
    aligner_bin: str
    model_id: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Needle forced aligner sidecar")
    parser.add_argument(
        "--host",
        default=os.environ.get("FORCED_ALIGNER_SIDECAR_HOST", "127.0.0.1"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("FORCED_ALIGNER_SIDECAR_PORT", "8766")),
    )
    parser.add_argument(
        "--aligner-bin",
        default=os.environ.get("MLX_FORCED_ALIGNER_BIN", default_aligner_bin()),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("FORCED_ALIGNER_MODEL_ID", DEFAULT_MODEL),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = NeedleSidecarServer((args.host, args.port), ForcedAlignerSidecar)
    server.aligner_bin = args.aligner_bin
    server.model_id = args.model
    print(
        f"Needle forced aligner sidecar listening on http://{args.host}:{args.port}",
        flush=True,
    )
    print(f"aligner_bin={args.aligner_bin}", flush=True)
    print(f"model={args.model}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Needle forced aligner sidecar stopped", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
