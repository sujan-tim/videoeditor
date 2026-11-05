"""Per-source media prepared after upload so the browser editor feels instant.

- proxy:      small H.264 copy with short GOPs, so the in-browser player seeks and scrubs quickly
- filmstrip:  one horizontal sprite of thumbnails drawn under video clips on the timeline
- waveform:   peak levels drawn under audio on the timeline

Everything here is derived, regenerable data; the original upload is never touched.
"""
from __future__ import annotations

import array
import json
import logging
import math
import os
import subprocess
from pathlib import Path

from .. import config
from ..models import Source
from . import ffmpeg

log = logging.getLogger("prep")

PROXY_SHORT_SIDE = 540
FILMSTRIP_HEIGHT = 64
WAVEFORM_RATE = 50  # peaks per second
WAVEFORM_SAMPLE_RATE = 8000


def needs_proxy(src: Source) -> bool:
    """Browsers play H.264 up to 1080p smoothly; make a proxy only for other codecs or bigger frames.
    PROXY_MODE=always|never|auto (default auto) overrides this."""
    mode = os.environ.get("PROXY_MODE", "auto").lower()
    if mode in ("always", "never"):
        return mode == "always"
    playable = (src.video_codec or "").lower() in ("h264", "avc1") and Path(src.path).suffix.lower() in (".mp4", ".m4v", ".mov")
    return not playable or min(src.width, src.height) > 1080 or src.fps > 61


def make_proxy(pdir: Path, src: Source) -> str:
    rel = f"proxies/{src.id}.mp4"
    (pdir / "proxies").mkdir(exist_ok=True)
    if src.width >= src.height:
        scale = f"scale=-2:'min({PROXY_SHORT_SIDE},ih)'"
    else:
        scale = f"scale='min({PROXY_SHORT_SIDE},iw)':-2"
    args = ["-y", "-i", src.path, "-vf", f"{scale},format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "28", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0"]
    args += ["-c:a", "aac", "-b:a", "96k", "-ac", "2"] if src.has_audio else ["-an"]
    args += ["-movflags", "+faststart", rel]
    ffmpeg.run(args, timeout=max(600, src.duration * 20), cwd=pdir)
    return rel


def make_filmstrip(pdir: Path, src: Source) -> tuple[str, float]:
    rel = f"frames/filmstrip_{src.id}.jpg"
    count = int(min(120, max(4, math.ceil(src.duration / 1.0))))
    interval = max(src.duration / count, 0.04)
    vf = f"fps=1/{interval:.4f},scale=-2:{FILMSTRIP_HEIGHT},tile={count}x1"
    out = pdir / rel
    # Decoding only keyframes is much faster; files with very few keyframes need a full decode.
    for fast in (True, False):
        out.unlink(missing_ok=True)
        ffmpeg.run(["-y", *(["-skip_frame", "nokey"] if fast else []), "-i", src.path, "-vf", vf,
                    "-frames:v", "1", "-q:v", "6", rel], timeout=max(300, src.duration * 5), cwd=pdir)
        if out.exists() and out.stat().st_size > 0:
            break
    else:
        raise ffmpeg.MediaError("filmstrip came out empty")
    return rel, round(interval, 4)


def make_waveform(pdir: Path, src: Source) -> str:
    rel = f"analysis/waveform_{src.id}.json"
    proc = subprocess.run([config.FFMPEG, "-v", "error", "-i", str(pdir / src.path), "-vn", "-ac", "1",
                           "-ar", str(WAVEFORM_SAMPLE_RATE), "-f", "s16le", "-"],
                          capture_output=True, timeout=max(300, src.duration * 5))
    if proc.returncode != 0:
        raise ffmpeg.MediaError(proc.stderr.decode(errors="replace")[-400:])
    samples = array.array("h")
    samples.frombytes(proc.stdout[: len(proc.stdout) // 2 * 2])
    step = WAVEFORM_SAMPLE_RATE // WAVEFORM_RATE
    peaks = []
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        peaks.append(max(abs(min(chunk)), abs(max(chunk))) / 32768 if chunk else 0)
    top = max(peaks) if peaks else 1
    norm = 1 / top if top > 0 else 1
    (pdir / rel).write_text(json.dumps([round(min(1.0, p * norm), 3) for p in peaks]))
    return rel


def prepare(pdir: Path, src: Source, on_note=None) -> dict:
    """Build whatever this source needs. Returns the Source fields to update. Failures are logged and
    skipped: the editor still works with the original file."""
    out: dict = {}
    steps = []
    if src.kind == "video":
        steps.append(("filmstrip", "Drawing the filmstrip", make_filmstrip))
        if needs_proxy(src):
            steps.append(("proxy", "Making a smooth-playback copy", make_proxy))
    if src.has_audio:
        steps.append(("waveform", "Reading the waveform", make_waveform))
    for key, note, fn in steps:
        if on_note:
            on_note(note)
        try:
            res = fn(pdir, src)
        except Exception as exc:  # noqa: BLE001
            log.warning("prep %s for %s failed: %s", key, src.id, exc)
            continue
        if key == "proxy":
            out["proxy_path"] = res
        elif key == "filmstrip":
            out["filmstrip_path"], out["filmstrip_interval"] = res
        else:
            out["waveform_path"], out["waveform_rate"] = res, WAVEFORM_RATE
    return out
