"""Footage analysis: silence, scenes, speech, and output quality checks.

Results are cached as JSON in the project's analysis/ folder keyed by source
and parameters, so the agent can call these freely.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path
from typing import Callable, Optional

from .. import config
from . import ffmpeg

log = logging.getLogger("analysis")

_SIL_START = re.compile(r"silence_start: (-?[\d.]+)")
_SIL_END = re.compile(r"silence_end: (-?[\d.]+)")


def _cached(cache_file: Path, compute: Callable[[], object]):
    if cache_file.exists():
        return json.loads(cache_file.read_text())
    result = compute()
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(result))
    return result


# ---- silence -------------------------------------------------------------------
def detect_silence(path: Path, duration: float, cache_dir: Path, noise_db: float = -35.0,
                   min_silence: float = 0.6) -> list[list[float]]:
    """Return [[start, end], ...] silent intervals in source seconds."""
    key = f"silence_{path.stem}_{noise_db:g}_{min_silence:g}.json"

    def compute():
        proc = ffmpeg.run(["-i", str(path), "-vn", "-af",
                           f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"],
                          timeout=1800)
        intervals: list[list[float]] = []
        start: Optional[float] = None
        for line in proc.stderr.splitlines():
            m = _SIL_START.search(line)
            if m:
                start = max(0.0, float(m.group(1)))
                continue
            m = _SIL_END.search(line)
            if m and start is not None:
                intervals.append([round(start, 3), round(float(m.group(1)), 3)])
                start = None
        if start is not None:
            intervals.append([round(start, 3), round(duration, 3)])
        return intervals

    return _cached(cache_dir / key, compute)


# ---- scenes --------------------------------------------------------------------
def detect_scenes(path: Path, cache_dir: Path, threshold: float = 27.0) -> list[list[float]]:
    key = f"scenes_{path.stem}_{threshold:g}.json"

    def compute():
        from scenedetect import ContentDetector, detect  # lazy: heavy import

        scenes = detect(str(path), ContentDetector(threshold=threshold))
        return [[round(s.get_seconds(), 3), round(e.get_seconds(), 3)] for s, e in scenes]

    return _cached(cache_dir / key, compute)


# ---- transcription -------------------------------------------------------------
_whisper_model = None
_whisper_lock = threading.Lock()


class TranscriptionUnavailable(Exception):
    pass


def _get_whisper():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover
                raise TranscriptionUnavailable("faster-whisper is not installed") from exc
            try:
                _whisper_model = WhisperModel(config.WHISPER_MODEL, device=config.WHISPER_DEVICE,
                                              compute_type="int8")
            except Exception as exc:  # noqa: BLE001 - usually a failed model download
                raise TranscriptionUnavailable(
                    f"could not load Whisper model '{config.WHISPER_MODEL}': {exc}. "
                    "The first run downloads it from huggingface.co.") from exc
        return _whisper_model


def transcript_path(cache_dir: Path, source_path: Path) -> Path:
    return cache_dir / f"transcript_{source_path.stem}.json"


def load_transcript(cache_dir: Path, source_path: Path) -> Optional[dict]:
    p = transcript_path(cache_dir, source_path)
    return json.loads(p.read_text()) if p.exists() else None


def transcribe(path: Path, cache_dir: Path, language: Optional[str] = None,
               on_progress: Optional[Callable[[float], None]] = None,
               duration: float = 0.0) -> dict:
    """Transcribe with word timestamps. Returns {language, segments:[{start,end,text,words}]}"""
    cached = load_transcript(cache_dir, path)
    if cached is not None:
        return cached
    from ..ai import groq
    if groq.configured() and config.CLOUD_TRANSCRIPTION:
        try:
            result = _transcribe_groq(path, cache_dir, language, on_progress, duration)
        except groq.GroqError as exc:
            log.warning("cloud transcription failed, using local Whisper: %s", exc)
        else:
            save_transcript(cache_dir, path, result)
            return result
    model = _get_whisper()
    segments_iter, info = model.transcribe(str(path), language=language, word_timestamps=True,
                                           vad_filter=True)
    segments = []
    for seg in segments_iter:
        words = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip()}
                 for w in (seg.words or []) if w.word.strip()]
        segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3),
                         "text": seg.text.strip(), "words": words})
        if on_progress and duration:
            on_progress(min(1.0, seg.end / duration))
    result = {"language": info.language, "segments": segments}
    out = transcript_path(cache_dir, path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result))
    return result


CHUNK_SECONDS = 600  # 10 minutes of 32 kbps mono MP3 is about 2.4 MB, well under Groq's upload limit


def _transcribe_groq(path: Path, cache_dir: Path, language: Optional[str],
                     on_progress: Optional[Callable[[float], None]], duration: float) -> dict:
    """Transcribe with Whisper on Groq: compress the audio, send it in 10-minute chunks, and merge."""
    from ..ai import groq

    total = duration or float(ffmpeg.summarize_probe(ffmpeg.probe(path))["duration"])
    tmp = cache_dir / "tmp_audio"
    tmp.mkdir(parents=True, exist_ok=True)
    segments: list[dict] = []
    lang = language
    start = 0.0
    n = 0
    while start < total - 0.05:
        length = min(CHUNK_SECONDS, total - start)
        chunk = tmp / f"chunk_{n}.mp3"
        ffmpeg.run(["-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(path), "-vn", "-ac", "1",
                    "-ar", "16000", "-b:a", "32k", str(chunk)])
        res = groq.transcribe_file(chunk, config.GROQ_WHISPER_MODEL, language=language)
        chunk.unlink(missing_ok=True)
        lang = lang or res.get("language")
        words = [{"start": round(w["start"] + start, 3), "end": round(w["end"] + start, 3),
                  "word": str(w.get("word", "")).strip()} for w in res.get("words") or [] if str(w.get("word", "")).strip()]
        for seg in res.get("segments") or []:
            s0, s1 = seg["start"] + start, seg["end"] + start
            segments.append({"start": round(s0, 3), "end": round(s1, 3), "text": str(seg.get("text", "")).strip(),
                             "words": [w for w in words if s0 - 0.01 <= (w["start"] + w["end"]) / 2 < s1 + 0.01]})
        start += length
        n += 1
        if on_progress and total:
            on_progress(min(1.0, start / total))
    return {"language": lang or "", "segments": segments, "engine": "groq:" + config.GROQ_WHISPER_MODEL}


def save_transcript(cache_dir: Path, source_path: Path, transcript: dict) -> None:
    """Used by tests and by imports of external transcripts (e.g. an .srt)."""
    out = transcript_path(cache_dir, source_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(transcript))


# ---- output checks -------------------------------------------------------------
_BLACK = re.compile(r"black_start:([\d.]+) black_end:([\d.]+)")
_MEAN = re.compile(r"mean_volume: (-?[\d.]+) dB")
_MAX = re.compile(r"max_volume: (-?[\d.]+) dB")


def quality_check(path: Path, has_audio: bool) -> dict:
    vf = "blackdetect=d=0.5:pix_th=0.10"
    args = ["-i", str(path), "-vf", vf]
    if has_audio:
        args += ["-af", "volumedetect"]
    else:
        args += ["-an"]
    proc = ffmpeg.run([*args, "-f", "null", "-"], timeout=3600)
    black = [[float(a), float(b)] for a, b in _BLACK.findall(proc.stderr)]
    mean = _MEAN.search(proc.stderr)
    peak = _MAX.search(proc.stderr)
    return {
        "black_segments": black[:20],
        "mean_volume_db": float(mean.group(1)) if mean else None,
        "max_volume_db": float(peak.group(1)) if peak else None,
    }
