"""Thin, safe wrappers around ffmpeg/ffprobe.

Every command is built as an argument list and run without a shell, so no
string coming from a user or the model is ever interpreted by a shell.
"""
from __future__ import annotations

import json
import logging
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Callable, Optional

from .. import config

log = logging.getLogger("ffmpeg")


class MediaError(Exception):
    pass


def run(args: list[str], timeout: float = 600, cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    cmd = [config.FFMPEG, "-hide_banner", "-nostdin", *args]
    log.debug("ffmpeg %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-12:])
        raise MediaError(f"ffmpeg failed (exit {proc.returncode}): {tail}")
    return proc


def run_with_progress(args: list[str], expected_duration: float,
                      on_progress: Optional[Callable[[float], None]] = None,
                      timeout: float = 4 * 3600, cwd: Optional[Path] = None) -> None:
    """Run ffmpeg reporting progress (0..1) from its -progress output."""
    cmd = [config.FFMPEG, "-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats", *args]
    log.info("ffmpeg render: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd)
    stderr_lines: list[str] = []

    import threading

    def _drain_stderr():
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)
            if len(stderr_lines) > 200:
                del stderr_lines[:100]

    t = threading.Thread(target=_drain_stderr, daemon=True)
    t.start()
    assert proc.stdout is not None
    for line in proc.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_us" and on_progress and expected_duration > 0:
            try:
                on_progress(min(1.0, int(value) / 1e6 / expected_duration))
            except ValueError:
                pass
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise MediaError("render timed out")
    t.join(timeout=5)
    if proc.returncode != 0:
        tail = "".join(stderr_lines[-15:])
        raise MediaError(f"ffmpeg render failed (exit {proc.returncode}): {tail}")


def probe(path: Path) -> dict:
    cmd = [config.FFPROBE, "-v", "error", "-print_format", "json", "-show_format",
           "-show_streams", str(path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise MediaError(f"ffprobe could not read the file: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def summarize_probe(data: dict) -> dict:
    """Reduce ffprobe JSON to the fields the editor cares about."""
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise MediaError("file has no video or audio stream")
    if video is None:  # audio-only file (music, voice-over)
        fmt = data.get("format", {})
        return {
            "kind": "audio", "duration": round(float(fmt.get("duration") or audio.get("duration") or 0), 3),
            "width": 0, "height": 0, "fps": 0.0, "has_audio": True, "video_codec": None,
            "audio_codec": audio.get("codec_name"),
            "audio_sample_rate": int(audio.get("sample_rate", 0) or 0),
            "bit_rate": int(fmt.get("bit_rate", 0) or 0), "size_bytes": int(fmt.get("size", 0) or 0),
            "rotation": 0, "container": fmt.get("format_name"),
        }
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or video.get("duration") or 0)
    fps = 30.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        rate = video.get(key)
        if rate and rate != "0/0":
            try:
                fps = float(Fraction(rate))
                break
            except (ValueError, ZeroDivisionError):
                continue
    rotation = 0
    for side in video.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = int(side["rotation"])
    rotation = int(video.get("tags", {}).get("rotate", rotation))
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    if abs(rotation) % 180 == 90:  # ffmpeg auto-rotates on decode
        width, height = height, width
    return {
        "kind": "video",
        "duration": round(duration, 3),
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "has_audio": audio is not None,
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "audio_sample_rate": int(audio.get("sample_rate", 0)) if audio else None,
        "bit_rate": int(fmt.get("bit_rate", 0) or 0),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "rotation": rotation,
        "container": fmt.get("format_name"),
    }


def extract_frame(path: Path, t: float, out: Path, width: int = 512) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    run(["-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(path), "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-q:v", "4", str(out)], timeout=60)
    return out
