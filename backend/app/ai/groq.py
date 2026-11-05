"""Minimal client for Groq's OpenAI-compatible API (free tier friendly).

Used for the chat editor (gpt-oss models) and, when a key is set, for fast cloud transcription with
Whisper, which is far quicker than running Whisper on a small free server.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import httpx

log = logging.getLogger("groq")

BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
MAX_RATE_WAIT = 75  # seconds we are willing to wait on a 429 before giving up


class GroqError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def api_key() -> str:
    return os.environ.get("GROQ_API_KEY", "").strip()


def configured() -> bool:
    return bool(api_key())


def _retry_after(resp: httpx.Response) -> float:
    for h in ("retry-after", "x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"):
        v = resp.headers.get(h)
        if not v:
            continue
        try:
            return float(v)
        except ValueError:
            # formats like "7.66s" or "1m2.5s"
            total, num = 0.0, ""
            for ch in v:
                if ch.isdigit() or ch == ".":
                    num += ch
                elif ch in "hms" and num:
                    total += float(num) * {"h": 3600, "m": 60, "s": 1}[ch]
                    num = ""
            if total:
                return total
    return 10.0


def _post(path: str, *, json: Optional[dict] = None, files: Any = None, data: Any = None,
          timeout: float = 120, on_wait=None) -> dict:
    if not configured():
        raise GroqError("GROQ_API_KEY is not set.", 401)
    headers = {"Authorization": f"Bearer {api_key()}"}
    waited = 0.0
    for attempt in range(6):
        try:
            resp = httpx.post(BASE_URL + path, headers=headers, json=json, files=files, data=data, timeout=timeout)
        except httpx.HTTPError as exc:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise GroqError(f"Could not reach Groq: {exc}") from exc
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = min(_retry_after(resp) + 0.5, 30) if resp.status_code == 429 else 3.0 * (attempt + 1)
            if waited + wait > MAX_RATE_WAIT:
                break
            if on_wait:
                on_wait(wait)
            time.sleep(wait)
            waited += wait
            continue
        if resp.status_code >= 400:
            try:
                msg = resp.json().get("error", {}).get("message", resp.text)
            except ValueError:
                msg = resp.text
            raise GroqError(msg[:500], resp.status_code)
        return resp.json()
    raise GroqError("Groq's free tier is busy (rate limit). Wait a minute and try again.", 429)


def chat(messages: list[dict], model: str, *, json_mode: bool = True, max_tokens: int = 2500,
         reasoning_effort: Optional[str] = "low", temperature: float = 0.3, on_wait=None) -> dict:
    body: dict[str, Any] = {"model": model, "messages": messages, "max_completion_tokens": max_tokens,
                            "temperature": temperature}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if reasoning_effort and model.startswith("openai/gpt-oss"):
        body["reasoning_effort"] = reasoning_effort
        body["include_reasoning"] = False
    return _post("/chat/completions", json=body, on_wait=on_wait)


def transcribe_file(path: Path, model: str, language: Optional[str] = None, on_wait=None) -> dict:
    data: list[tuple[str, str]] = [("model", model), ("response_format", "verbose_json"),
                                   ("timestamp_granularities[]", "word"),
                                   ("timestamp_granularities[]", "segment"), ("temperature", "0")]
    if language:
        data.append(("language", language))
    with open(path, "rb") as fh:
        return _post("/audio/transcriptions", files={"file": (path.name, fh, "audio/mpeg")}, data=data,
                     timeout=300, on_wait=on_wait)
