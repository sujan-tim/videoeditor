"""Runtime configuration, read from environment variables (and backend/.env if present)."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

DATA_DIR = Path(os.environ.get("VIDEO_EDITOR_DATA_DIR", BACKEND_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG = os.environ.get("FFMPEG_BIN", shutil.which("ffmpeg") or "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", shutil.which("ffprobe") or "ffprobe")

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
CLAUDE_EFFORT = os.environ.get("CLAUDE_EFFORT", "medium")
AGENT_MAX_ROUNDS = int(os.environ.get("AGENT_MAX_ROUNDS", "25"))

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")

CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "4096")) * 1024 * 1024
ALLOWED_UPLOAD_EXTENSIONS = {".mp4", ".mov", ".m4v"}

DEFAULT_FONT = os.environ.get("OVERLAY_FONT", "")
_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def overlay_font() -> str | None:
    if DEFAULT_FONT and Path(DEFAULT_FONT).exists():
        return DEFAULT_FONT
    for candidate in _FONT_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    return None


def anthropic_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
