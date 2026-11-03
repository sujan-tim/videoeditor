"""Compile an EditPlan into an FFmpeg command and render it.

ffmpeg runs with the project directory as its working directory and every
auxiliary file (overlay text, subtitles, font) is referenced by a generated
relative path, so no user-controlled text ever reaches the filter graph
parser. Overlay text is passed through `textfile=` rather than inline.
"""
from __future__ import annotations

import logging
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .. import config
from ..media import analysis, ffmpeg
from ..models import EditPlan, Project, RenderInfo, new_id

log = logging.getLogger("render")

SHORT_SIDE = {"2160p": 2160, "1080p": 1080, "720p": 720, "480p": 480}
PREVIEW_SHORT_SIDE = 540
QUALITY = {
    "preview": ("veryfast", "30", "128k"),
    "draft": ("veryfast", "26", "128k"),
    "standard": ("medium", "21", "192k"),
    "high": ("slow", "18", "256k"),
}
NAMED_COLORS = {
    "white": "FFFFFF", "black": "000000", "yellow": "FFD400", "red": "FF3B30",
    "green": "34C759", "blue": "0A84FF", "orange": "FF9500", "pink": "FF2D92",
    "purple": "AF52DE", "cyan": "32D2F5", "gray": "8E8E93", "grey": "8E8E93",
}
COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{6}|" + "|".join(NAMED_COLORS) + r")$")


def color_hex(color: str) -> str:
    color = color.strip().lower()
    if color in NAMED_COLORS:
        return NAMED_COLORS[color]
    if re.fullmatch(r"#[0-9a-f]{6}", color):
        return color[1:].upper()
    return "FFFFFF"


def _even(x: float) -> int:
    return max(2, int(round(x / 2.0)) * 2)


# ---- timeline helpers ----------------------------------------------------------
@dataclass
class PlacedClip:
    index: int
    clip_id: str
    source_id: str
    source_start: float
    source_end: float
    timeline_start: float
    timeline_end: float
    volume: float


def place_clips(plan: EditPlan) -> list[PlacedClip]:
    t = 0.0
    placed = []
    for i, c in enumerate(plan.clips):
        d = c.duration
        placed.append(PlacedClip(i, c.id, c.source_id, c.start, c.end, round(t, 3),
                                 round(t + d, 3), c.volume))
        t += d
    return placed


def output_dimensions(project: Project, plan: EditPlan, preview: bool = False) -> tuple[int, int]:
    out = plan.output
    short = PREVIEW_SHORT_SIDE if preview else SHORT_SIDE[out.resolution]
    if out.aspect == "original":
        src = None
        if plan.clips:
            src = project.sources.get(plan.clips[0].source_id)
        sw, sh = (src.width, src.height) if src else (1920, 1080)
        src_short = min(sw, sh)
        short = min(short, src_short)
        scale = short / src_short
        return _even(sw * scale), _even(sh * scale)
    ratios = {"9:16": (9, 16), "16:9": (16, 9), "1:1": (1, 1), "4:5": (4, 5)}
    rw, rh = ratios[out.aspect]
    if rw <= rh:
        return _even(short), _even(short * rh / rw)
    return _even(short * rw / rh), _even(short)


def output_fps(project: Project, plan: EditPlan) -> float:
    if plan.clips:
        src = project.sources.get(plan.clips[0].source_id)
        if src and src.fps:
            return round(min(60.0, max(1.0, src.fps)), 3)
    return 30.0


# ---- subtitles -----------------------------------------------------------------
def timeline_words(project: Project, plan: EditPlan, project_dir: Path) -> tuple[list[dict], list[str]]:
    """Map transcript words from source time onto the output timeline.

    Returns (words, source_ids_missing_transcripts). Because subtitles are
    derived at render time, they stay correct after any cut or reorder.
    """
    words: list[dict] = []
    missing: list[str] = []
    cache = project_dir / "analysis"
    transcripts: dict[str, Optional[dict]] = {}
    for pc in place_clips(plan):
        src = project.sources.get(pc.source_id)
        if src is None:
            continue
        if pc.source_id not in transcripts:
            transcripts[pc.source_id] = analysis.load_transcript(cache, project_dir / src.path)
            if transcripts[pc.source_id] is None and src.has_audio:
                missing.append(pc.source_id)
        tr = transcripts[pc.source_id]
        if not tr:
            continue
        for seg in tr.get("segments", []):
            if seg["end"] < pc.source_start or seg["start"] > pc.source_end:
                continue
            for w in seg.get("words", []):
                mid = (w["start"] + w["end"]) / 2
                if pc.source_start <= mid < pc.source_end:
                    ws = max(w["start"], pc.source_start) - pc.source_start + pc.timeline_start
                    we = min(w["end"], pc.source_end) - pc.source_start + pc.timeline_start
                    words.append({"start": round(ws, 3), "end": round(max(we, ws + 0.05), 3),
                                  "word": w["word"]})
    words.sort(key=lambda w: w["start"])
    return words, missing


def group_cues(words: list[dict], max_words: int) -> list[list[dict]]:
    cues: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if current:
            gap = w["start"] - current[-1]["end"]
            too_long = w["end"] - current[0]["start"] > 3.5
            ends_sentence = current[-1]["word"][-1:] in ".?!"
            if len(current) >= max_words or gap > 0.7 or too_long or ends_sentence:
                cues.append(current)
                current = []
        current.append(w)
    if current:
        cues.append(current)
    return cues


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_color(hex6: str) -> str:
    r, g, b = hex6[0:2], hex6[2:4], hex6[4:6]
    return f"&H00{b}{g}{r}"


def _ass_escape(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_ass(plan: EditPlan, words: list[dict], width: int, height: int) -> str:
    st = plan.subtitles
    scale = min(width, height) / 1080
    size = max(12, int(st.font_size * scale))
    align = {"bottom": 2, "center": 5, "top": 8}[st.position]
    margin_v = int(height * (0.14 if st.position == "bottom" else 0.10))
    hl = color_hex(st.highlight_color) if st.highlight_color else "FFFFFF"
    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,"
        f"{max(2, int(size * 0.08))},0,{align},{int(width * 0.06)},{int(width * 0.06)},{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    cues = group_cues(words, st.max_words_per_line)
    for ci, cue in enumerate(cues):
        cue_end = cue[-1]["end"]
        if ci + 1 < len(cues):
            cue_end = min(max(cue_end, cue[-1]["end"] + 0.25), cues[ci + 1][0]["start"])
        texts = [_ass_escape(w["word"].upper() if st.uppercase else w["word"]) for w in cue]
        for wi, w in enumerate(cue):
            start = cue[0]["start"] if wi == 0 else w["start"]
            end = cue[wi + 1]["start"] if wi + 1 < len(cue) else cue_end
            if end <= start:
                continue
            parts = []
            for k, t in enumerate(texts):
                parts.append("{\\c" + _ass_color(hl) + "&}" + t + "{\\c&H00FFFFFF&}" if k == wi else t)
            lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{' '.join(parts)}")
    return header + "\n".join(lines) + "\n"


# ---- text overlays -------------------------------------------------------------
def wrap_text(text: str, max_chars: int) -> str:
    out_lines = []
    for paragraph in text.splitlines() or [""]:
        line = ""
        for word in paragraph.split():
            if line and len(line) + 1 + len(word) > max_chars:
                out_lines.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        out_lines.append(line)
    return "\n".join(out_lines)


# ---- compile -------------------------------------------------------------------
@dataclass
class CompiledRender:
    args: list[str]
    duration: float
    width: int
    height: int
    warnings: list[str]


def compile_plan(project: Project, plan: EditPlan, project_dir: Path, out_rel: str,
                 mode: str = "preview", quality: str = "standard") -> CompiledRender:
    if not plan.clips:
        raise ffmpeg.MediaError("The timeline is empty; add a clip first.")
    preview = mode == "preview"
    width, height = output_dimensions(project, plan, preview=preview)
    fps = output_fps(project, plan)
    scale = min(width, height) / 1080
    warnings: list[str] = []
    cache = project_dir / "cache"
    cache.mkdir(exist_ok=True)

    args: list[str] = ["-y"]
    filters: list[str] = []
    concat_inputs = []
    for i, c in enumerate(plan.clips):
        src = project.sources.get(c.source_id)
        if src is None:
            raise ffmpeg.MediaError(f"clip {c.id} references missing source {c.source_id}")
        d = round(c.duration, 3)
        args += ["-ss", f"{c.start:.3f}", "-t", f"{d:.3f}", "-i", src.path]
        if plan.output.fit == "pad" or plan.output.aspect == "original":
            fit = (f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                   f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
        else:
            fit = (f"scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2,"
                   f"crop={width}:{height}")
        filters.append(f"[{i}:v]setpts=PTS-STARTPTS,{fit},setsar=1,fps={fps},format=yuv420p,"
                       f"trim=duration={d}[v{i}]")
        if src.has_audio:
            filters.append(f"[{i}:a]asetpts=PTS-STARTPTS,aresample=48000,"
                           f"aformat=sample_fmts=fltp:channel_layouts=stereo,volume={c.volume:.3f},"
                           f"apad=whole_dur={d},atrim=0:{d}[a{i}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{d}[a{i}]")
        concat_inputs.append(f"[v{i}][a{i}]")
    filters.append(f"{''.join(concat_inputs)}concat=n={len(plan.clips)}:v=1:a=1[vcat][acat]")

    # Video post-processing: overlays then subtitles.
    vchain: list[str] = []
    font = config.overlay_font()
    if plan.overlays:
        if font is None:
            warnings.append("No TTF font found for text overlays; set OVERLAY_FONT.")
        else:
            local_font = cache / f"overlay_font{Path(font).suffix}"
            if not local_font.exists():
                shutil.copy(font, local_font)
            for k, ov in enumerate(plan.overlays):
                size = max(10, int(ov.font_size * scale))
                max_chars = max(8, int(width * 0.88 / (size * 0.58)))
                tfile = cache / f"overlay_{k}.txt"
                tfile.write_text(wrap_text(ov.text, max_chars))
                y = {"top": "h*0.08", "center": "(h-text_h)/2", "bottom": "h*0.78-text_h"}[ov.position]
                box = (f":box=1:boxcolor=black@0.55:boxborderw={max(4, int(size * 0.35))}"
                       if ov.background else ":borderw=3:bordercolor=black@0.8")
                vchain.append(
                    f"drawtext=fontfile=cache/{local_font.name}:textfile=cache/{tfile.name}:expansion=none"
                    f":fontsize={size}:fontcolor=0x{color_hex(ov.color)}:line_spacing={int(size * 0.25)}"
                    f":x=(w-text_w)/2:y={y}{box}:enable='between(t,{ov.start:.3f},{ov.end:.3f})'")
    if plan.subtitles.enabled:
        words, missing = timeline_words(project, plan, project_dir)
        if missing:
            warnings.append("Subtitles skipped for sources without a transcript: " + ", ".join(missing))
        if words:
            sub_file = cache / "subtitles.ass"
            sub_file.write_text(build_ass(plan, words, width, height))
            vchain.append(f"ass=cache/{sub_file.name}")
    filters.append(f"[vcat]{','.join(vchain) if vchain else 'null'}[vout]")

    achain = [f"volume={plan.output.master_volume:.3f}"]
    if plan.output.normalize_audio:
        achain.append("loudnorm=I=-14:TP=-1.5:LRA=11")
        achain.append("aresample=48000")
    filters.append(f"[acat]{','.join(achain)}[aout]")

    preset, crf, abr = QUALITY["preview" if preview else quality]
    args += [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", abr, "-ar", "48000",
        "-movflags", "+faststart", out_rel,
    ]
    return CompiledRender(args, round(plan.duration(), 3), width, height, warnings)


def render(project: Project, project_dir: Path, mode: str = "preview", quality: str = "standard",
           on_progress: Optional[Callable[[float], None]] = None) -> tuple[RenderInfo, list[str]]:
    rid = new_id("rnd")
    out_rel = f"renders/{mode}_v{project.version}_{rid[4:]}.mp4"
    compiled = compile_plan(project, project.plan, project_dir, out_rel, mode, quality)
    started = time.time()
    ffmpeg.run_with_progress(compiled.args, compiled.duration, on_progress, cwd=project_dir)
    out_path = project_dir / out_rel
    info = RenderInfo(id=rid, mode=mode, version=project.version, path=out_rel,
                      width=compiled.width, height=compiled.height, duration=compiled.duration,
                      quality="preview" if mode == "preview" else quality,
                      size_bytes=out_path.stat().st_size)
    log.info("rendered %s in %.1fs", out_rel, time.time() - started)
    return info, compiled.warnings
