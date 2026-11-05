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
    speed: float = 1.0
    overlap_in: float = 0.0  # seconds this clip overlaps the previous one (transition)


def place_clips(plan: EditPlan) -> list[PlacedClip]:
    t = 0.0
    placed = []
    for i, c in enumerate(plan.clips):
        d = c.duration
        ov = plan.transition_overlap(i)
        start = t - ov
        placed.append(PlacedClip(i, c.id, c.source_id, c.start, c.end, round(start, 3),
                                 round(start + d, 3), c.volume, c.speed, round(ov, 3)))
        t = start + d
    return placed


def _first_video_source(project: Project, plan: EditPlan):
    for c in plan.clips:
        src = project.sources.get(c.source_id)
        if src and src.width:
            return src
    return None


def output_dimensions(project: Project, plan: EditPlan, preview: bool = False) -> tuple[int, int]:
    out = plan.output
    short = PREVIEW_SHORT_SIDE if preview else SHORT_SIDE[out.resolution]
    if out.aspect == "original":
        src = _first_video_source(project, plan)
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
    src = _first_video_source(project, plan)
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
                    ws = (max(w["start"], pc.source_start) - pc.source_start) / pc.speed + pc.timeline_start
                    we = (min(w["end"], pc.source_end) - pc.source_start) / pc.speed + pc.timeline_start
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


CAPTION_STYLES = {
    # name: (border_style, outline_ratio, shadow_ratio, back_colour, highlight, pop, size_factor)
    "bold_highlight": (1, 0.08, 0.0, "&H80000000", True, False, 1.0),
    "karaoke": (1, 0.09, 0.0, "&H80000000", True, True, 1.0),
    "boxed": (3, 0.18, 0.0, "&H60000000", True, False, 0.9),
    "clean": (1, 0.05, 0.03, "&H80000000", False, False, 0.85),
    "minimal": (1, 0.0, 0.05, "&HA0000000", False, False, 0.7),
}


def build_ass(plan: EditPlan, words: list[dict], width: int, height: int) -> str:
    st = plan.subtitles
    border, outline_r, shadow_r, back, highlight, pop, factor = CAPTION_STYLES.get(
        st.style, CAPTION_STYLES["bold_highlight"])
    scale = min(width, height) / 1080
    size = max(12, int(st.font_size * scale * factor))
    align = {"bottom": 2, "center": 5, "top": 8}[st.position]
    margin_v = int(height * (0.14 if st.position == "bottom" else 0.10))
    hl = color_hex(st.highlight_color) if st.highlight_color else "FFFFFF"
    bold = 0 if st.style in ("clean", "minimal") else -1
    outline = max(0, int(size * outline_r)) if outline_r else 0
    if border == 1 and outline_r:
        outline = max(2, outline)
    shadow = max(0, int(size * shadow_r))
    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,{size},&H00FFFFFF,&H00FFFFFF,"
        f"{'&H60000000' if border == 3 else '&H00000000'},{back},{bold},0,0,0,100,100,0,0,{border},"
        f"{outline},{shadow},{align},{int(width * 0.06)},{int(width * 0.06)},{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    cues = group_cues(words, st.max_words_per_line)
    for ci, cue in enumerate(cues):
        cue_end = cue[-1]["end"]
        if ci + 1 < len(cues):
            cue_end = min(max(cue_end, cue[-1]["end"] + 0.25), cues[ci + 1][0]["start"])
        texts = [_ass_escape(w["word"].upper() if st.uppercase else w["word"]) for w in cue]
        if not highlight:
            if cue_end > cue[0]["start"]:
                lines.append(f"Dialogue: 0,{_ass_time(cue[0]['start'])},{_ass_time(cue_end)},Default,,0,0,0,,"
                             + " ".join(texts))
            continue
        for wi, w in enumerate(cue):
            start = cue[0]["start"] if wi == 0 else w["start"]
            end = cue[wi + 1]["start"] if wi + 1 < len(cue) else cue_end
            if end <= start:
                continue
            parts = []
            for k, t in enumerate(texts):
                if k == wi:
                    grow = "\\fscx112\\fscy112" if pop else ""
                    parts.append("{\\c" + _ass_color(hl) + "&" + grow + "}" + t
                                 + "{\\c&H00FFFFFF&\\fscx100\\fscy100}")
                else:
                    parts.append(t)
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


# ---- looks ---------------------------------------------------------------------
LOOK_FILTERS = {
    "none": "",
    "bw": "hue=s=0,eq=contrast=1.08",
    "warm": "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06,eq=saturation=1.08",
    "cool": "colorbalance=rs=-0.08:bs=0.10:rm=-0.04:bm=0.08",
    "vintage": "curves=preset=vintage,eq=saturation=0.85",
    "vivid": "eq=saturation=1.4:contrast=1.08",
    "faded": "eq=contrast=0.85:brightness=0.04:saturation=0.8",
    "cinematic": "colorbalance=rs=-0.05:bs=0.08:rh=0.08:bh=-0.05,eq=contrast=1.1:saturation=0.9",
    "dramatic": "eq=contrast=1.3:saturation=0.8:brightness=-0.03",
}


def look_chain(look: str, adjust=None) -> list[str]:
    chain = [LOOK_FILTERS.get(look, "")] if LOOK_FILTERS.get(look) else []
    if adjust is not None and (adjust.brightness or adjust.contrast or adjust.saturation):
        chain.append(f"eq=brightness={adjust.brightness * 0.3:.3f}:contrast={1 + adjust.contrast * 0.5:.3f}"
                     f":saturation={max(0.0, 1 + adjust.saturation):.3f}")
    return chain


def atempo_chain(speed: float) -> list[str]:
    """atempo accepts 0.5..2 per instance; chain it for larger changes."""
    parts = []
    s = speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1.0) > 1e-3:
        parts.append(f"atempo={s:.4f}")
    return parts


def fit_chain(width: int, height: int, fit: str, aspect: str, fx: float = 0.5, fy: float = 0.5,
              zoom: float = 1.0, bg_label: str = "") -> tuple[list[str], Optional[str]]:
    """Return filters that fit a stream into width x height.

    For "blur" this returns (pre, None) with a split/overlay graph signalled by the caller.
    """
    if fit == "pad" or aspect == "original":
        chain = [f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2",
                 f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"]
    else:
        chain = [f"scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2",
                 f"crop={width}:{height}:(iw-{width})*{fx:.3f}:(ih-{height})*{fy:.3f}"]
    if zoom > 1.001:
        zw, zh = _even(width * zoom), _even(height * zoom)
        chain += [f"scale={zw}:{zh}", f"crop={width}:{height}:({zw}-{width})*{fx:.3f}:({zh}-{height})*{fy:.3f}"]
    return chain, None


def _video_fit(label_in: str, label_out: str, width: int, height: int, plan: EditPlan,
               fx: float, fy: float, zoom: float, tag: str) -> list[str]:
    out = plan.output
    if out.fit == "blur" and out.aspect != "original":
        fg, _ = fit_chain(width, height, "pad", "x", fx, fy, 1.0)
        fg = [fg[0]]  # scale only, no pad
        bg, _ = fit_chain(width, height, "crop", "x", 0.5, 0.5, 1.0)
        f = [f"[{label_in}]split=2[{tag}bg][{tag}fg]",
             f"[{tag}bg]{','.join(bg)},boxblur=20:2,eq=brightness=-0.08[{tag}bgb]",
             f"[{tag}fg]{','.join(fg)}[{tag}fgs]",
             f"[{tag}bgb][{tag}fgs]overlay=(W-w)/2:(H-h)/2"]
        if zoom > 1.001:
            zw, zh = _even(width * zoom), _even(height * zoom)
            f[-1] += f",scale={zw}:{zh},crop={width}:{height}:({zw}-{width})*{fx:.3f}:({zh}-{height})*{fy:.3f}"
        f[-1] += f"[{label_out}]"
        return f
    chain, _ = fit_chain(width, height, out.fit, out.aspect, fx, fy, zoom)
    return [f"[{label_in}]{','.join(chain)}[{label_out}]"]


# ---- text overlays (rendered with libass, like captions) ------------------------
def build_overlay_ass(plan: EditPlan, width: int, height: int) -> str:
    """Text overlays as ASS events: styles, positions and animations without needing drawtext,
    which some FFmpeg builds lack."""
    scale = min(width, height) / 1080
    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Text,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n"
        "Style: Box,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H73000000,&H80000000,-1,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    for ov in plan.overlays:
        size = max(10, int(ov.font_size * scale))
        max_chars = max(8, int(width * 0.88 / (size * 0.58)))
        s, e = ov.start, ov.end
        dur = max(0.05, e - s)
        fade_ms = int(min(0.3, dur / 3) * 1000)
        if ov.x is not None or ov.y is not None:
            an, x, y = 5, width * (ov.x if ov.x is not None else 0.5), height * (ov.y if ov.y is not None else 0.5)
        else:
            an, x, y = {"top": (8, width / 2, height * 0.08), "center": (5, width / 2, height / 2),
                        "bottom": (2, width / 2, height * 0.78)}[ov.position]
        fc = color_hex(ov.color)
        style = "Box" if ov.style in ("box", "highlight") else "Text"
        tags = [f"\\an{an}", f"\\fs{size}", f"\\1c{_ass_color(fc)}&"]
        if ov.style == "box":
            tags += [f"\\bord{max(4, int(size * 0.35))}", "\\3c&H000000&", "\\3a&H73&", "\\shad0"]
        elif ov.style == "highlight":
            text_col = "FFFFFF" if fc.upper() == "000000" else "000000"
            tags = [f"\\an{an}", f"\\fs{size}", f"\\1c{_ass_color(text_col)}&",
                    f"\\bord{max(4, int(size * 0.3))}", f"\\3c{_ass_color(fc)}&", "\\3a&H00&", "\\shad0"]
        elif ov.style == "outline":
            tags += [f"\\bord{max(2, int(size * 0.08))}", "\\3c&H000000&", "\\shad0"]
        elif ov.style == "shadow":
            tags += ["\\bord0", f"\\shad{max(1, int(size * 0.05))}", "\\4c&H000000&", "\\4a&H40&"]
        else:
            tags += ["\\bord0", "\\shad0"]
        if ov.animation == "slide_up":
            tags.append(f"\\move({x:.0f},{y + height * 0.04:.0f},{x:.0f},{y:.0f},0,350)")
        else:
            tags.append(f"\\pos({x:.0f},{y:.0f})")
        if ov.animation == "pop":
            tags.append("\\fscx60\\fscy60\\t(0,180,\\fscx100\\fscy100)")
        text = "\\N".join(_ass_escape(line) for line in wrap_text(ov.text, max_chars).split("\n"))
        steps = [(text, s, e, True, True)]
        if ov.animation == "typewriter":
            words = wrap_text(ov.text, max_chars).replace("\n", " ").split(" ")
            if 1 < len(words) <= 16:
                reveal = min(dur * 0.6, 0.12 * len(words))
                steps = []
                for i in range(1, len(words) + 1):
                    t0 = s + reveal * (i - 1) / len(words)
                    t1 = s + reveal * i / len(words) if i < len(words) else e
                    part = "\\N".join(_ass_escape(line) for line in wrap_text(" ".join(words[:i]), max_chars).split("\n"))
                    steps.append((part, t0, t1, i == 1, i == len(words)))
        for txt, t0, t1, first, last in steps:
            fad = ""
            if ov.animation != "none":
                fad = f"\\fad({fade_ms if first else 0},{fade_ms if last else 0})"
            lines.append(f"Dialogue: 1,{_ass_time(t0)},{_ass_time(t1)},{style},,0,0,0,,{{{''.join(tags)}{fad}}}{txt}")
    return header + "\n".join(lines) + "\n"


# ---- compile -------------------------------------------------------------------
@dataclass
class CompiledRender:
    args: list[str]
    duration: float
    width: int
    height: int
    warnings: list[str]


PIP_POS = {
    "top_left": ("W*0.04", "H*0.04"),
    "top_right": ("W-w-W*0.04", "H*0.04"),
    "bottom_left": ("W*0.04", "H-h-H*0.04"),
    "bottom_right": ("W-w-W*0.04", "H-h-H*0.04"),
}
AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"


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
    total = round(plan.duration(), 3)

    args: list[str] = ["-y"]
    filters: list[str] = []
    n_in = 0

    # -- main track ---------------------------------------------------------------
    vlabels, alabels, durs = [], [], []
    for i, c in enumerate(plan.clips):
        src = project.sources.get(c.source_id)
        if src is None:
            raise ffmpeg.MediaError(f"clip {c.id} references missing source {c.source_id}")
        if src.kind != "video":
            raise ffmpeg.MediaError(f"clip {c.id} uses {src.filename}, which has no picture")
        d = round(c.duration, 3)
        args += ["-ss", f"{c.start:.3f}", "-t", f"{c.source_duration:.3f}", "-i", src.path]
        idx = n_in
        n_in += 1
        sp = max(0.01, c.speed)
        filters.append(f"[{idx}:v]setpts=(PTS-STARTPTS)/{sp:.4f}[vr{i}]")
        filters += _video_fit(f"vr{i}", f"vf{i}", width, height, plan, c.focus_x, c.focus_y, c.zoom, f"m{i}")
        post = look_chain(c.look, c.adjust)
        post += [f"setsar=1,fps={fps},format=yuv420p,trim=duration={d}", "setpts=PTS-STARTPTS"]
        if c.fade_in > 0:
            post.append(f"fade=t=in:st=0:d={min(c.fade_in, d):.3f}")
        if c.fade_out > 0:
            post.append(f"fade=t=out:st={max(0, d - c.fade_out):.3f}:d={min(c.fade_out, d):.3f}")
        filters.append(f"[vf{i}]{','.join(post)}[v{i}]")
        if src.has_audio:
            ach = [f"asetpts=PTS-STARTPTS", AUDIO_FMT] + atempo_chain(sp) + [f"volume={c.volume:.3f}"]
        else:
            ach = None
        if ach:
            if c.fade_in > 0:
                ach.append(f"afade=t=in:st=0:d={min(c.fade_in, d):.3f}")
            if c.fade_out > 0:
                ach.append(f"afade=t=out:st={max(0, d - c.fade_out):.3f}:d={min(c.fade_out, d):.3f}")
            ach += [f"apad=whole_dur={d}", f"atrim=0:{d}", "asetpts=PTS-STARTPTS"]
            filters.append(f"[{idx}:a]{','.join(ach)}[a{i}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{d}[a{i}]")
        vlabels.append(f"v{i}")
        alabels.append(f"a{i}")
        durs.append(d)

    has_transition = any(plan.transition_overlap(i) > 0 for i in range(len(plan.clips)))
    if not has_transition:
        filters.append("".join(f"[{v}][{a}]" for v, a in zip(vlabels, alabels))
                       + f"concat=n={len(plan.clips)}:v=1:a=1[vmain][amain]")
    else:
        vacc, aacc, acc_d = vlabels[0], alabels[0], durs[0]
        for i in range(1, len(plan.clips)):
            ov = round(plan.transition_overlap(i), 3)
            vo, ao = f"vx{i}", f"ax{i}"
            if ov > 0:
                tr = plan.clips[i].transition_in
                filters.append(f"[{vacc}][{vlabels[i]}]xfade=transition={tr.type}:duration={ov}"
                               f":offset={max(0.0, acc_d - ov):.3f}[{vo}]")
                filters.append(f"[{aacc}][{alabels[i]}]acrossfade=d={ov}:c1=tri:c2=tri[{ao}]")
            else:
                filters.append(f"[{vacc}][{aacc}][{vlabels[i]}][{alabels[i]}]concat=n=2:v=1:a=1[{vo}][{ao}]")
            vacc, aacc = vo, ao
            acc_d = acc_d + durs[i] - ov
        filters.append(f"[{vacc}]null[vmain]")
        filters.append(f"[{aacc}]anull[amain]")

    # -- b-roll / picture-in-picture ------------------------------------------------
    vcur = "vmain"
    extra_audio: list[tuple[str, bool]] = []  # (label, duck)
    for k, b in enumerate(sorted(plan.broll, key=lambda b: b.timeline_start)):
        src = project.sources.get(b.source_id)
        if src is None or src.kind != "video":
            warnings.append(f"B-roll {b.id} skipped: source missing or has no picture")
            continue
        if b.timeline_start >= total:
            continue
        d = round(min(b.duration, total - b.timeline_start), 3)
        args += ["-ss", f"{b.start:.3f}", "-t", f"{d:.3f}", "-i", src.path]
        idx = n_in
        n_in += 1
        if b.mode == "pip":
            pw = _even(width * b.pip_scale)
            chain = [f"scale={pw}:-2"]
        else:
            chain, _ = fit_chain(width, height, "crop" if plan.output.aspect != "original" else "pad",
                                 plan.output.aspect if plan.output.aspect != "original" else "x")
        chain = ["setpts=PTS-STARTPTS"] + chain + look_chain(b.look) + [f"fps={fps}", "format=yuva420p",
                                                                       f"trim=duration={d}"]
        fd = min(b.fade, d / 3)
        if fd > 0:
            chain += [f"fade=t=in:st=0:d={fd:.3f}:alpha=1", f"fade=t=out:st={d - fd:.3f}:d={fd:.3f}:alpha=1"]
        chain.append(f"setpts=PTS+{b.timeline_start:.3f}/TB")
        filters.append(f"[{idx}:v]{','.join(chain)}[bv{k}]")
        x, y = PIP_POS[b.pip_corner] if b.mode == "pip" else ("0", "0")
        filters.append(f"[{vcur}][bv{k}]overlay=x={x}:y={y}:eof_action=pass"
                       f":enable='between(t,{b.timeline_start:.3f},{b.timeline_start + d:.3f})'[vb{k}]")
        vcur = f"vb{k}"
        if b.volume > 0 and src.has_audio:
            ms = int(b.timeline_start * 1000)
            filters.append(f"[{idx}:a]asetpts=PTS-STARTPTS,{AUDIO_FMT},atrim=0:{d},volume={b.volume:.3f},"
                           f"adelay={ms}|{ms}[ba{k}]")
            extra_audio.append((f"ba{k}", False))

    # -- audio track (music, voice-over, sfx) ------------------------------------------
    for k, au in enumerate(sorted(plan.audio, key=lambda a: a.timeline_start)):
        src = project.sources.get(au.source_id)
        if src is None or not src.has_audio:
            warnings.append(f"Audio {au.id} skipped: source missing or silent")
            continue
        if au.timeline_start >= total:
            continue
        d = round(min(au.duration, total - au.timeline_start), 3)
        args += ["-ss", f"{au.start:.3f}", "-t", f"{d:.3f}", "-i", src.path]
        idx = n_in
        n_in += 1
        ch = ["asetpts=PTS-STARTPTS", AUDIO_FMT, f"atrim=0:{d}", f"volume={au.volume:.3f}"]
        if au.fade_in > 0:
            ch.append(f"afade=t=in:st=0:d={min(au.fade_in, d / 2):.3f}")
        if au.fade_out > 0:
            fo = min(au.fade_out, d / 2)
            ch.append(f"afade=t=out:st={d - fo:.3f}:d={fo:.3f}")
        ms = int(au.timeline_start * 1000)
        ch.append(f"adelay={ms}|{ms}")
        filters.append(f"[{idx}:a]{','.join(ch)}[mu{k}]")
        extra_audio.append((f"mu{k}", au.duck and au.role == "music"))

    acur = "amain"
    if extra_audio:
        ducked = [lbl for lbl, dk in extra_audio if dk]
        free = [lbl for lbl, dk in extra_audio if not dk]
        mix_inputs = []
        if ducked:
            filters.append(f"[{acur}]asplit=2[amx][asc]")
            acur = "amx"
            if len(ducked) > 1:
                filters.append("".join(f"[{l}]" for l in ducked)
                               + f"amix=inputs={len(ducked)}:duration=longest:normalize=0[bed]")
                bed = "bed"
            else:
                bed = ducked[0]
            filters.append(f"[{bed}][asc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350"
                           f":makeup=1[bedd]")
            mix_inputs.append("bedd")
        mix_inputs += free
        filters.append(f"[{acur}]" + "".join(f"[{l}]" for l in mix_inputs)
                       + f"amix=inputs={1 + len(mix_inputs)}:duration=first:dropout_transition=0:normalize=0[amixed]")
        acur = "amixed"

    # -- text overlays and subtitles (both drawn by libass from generated files) ---------
    vchain: list[str] = []
    font = config.overlay_font()
    fonts_opt = ""
    if font is not None:
        # Ship the font next to the .ass files so libass finds it on any system.
        fonts = cache / "fonts"
        fonts.mkdir(exist_ok=True)
        target = fonts / Path(font).name
        if not target.exists():
            shutil.copy(font, target)
        fonts_opt = ":fontsdir=cache/fonts"
    if plan.subtitles.enabled:
        words, missing = timeline_words(project, plan, project_dir)
        if missing:
            warnings.append("Subtitles skipped for sources without a transcript: " + ", ".join(missing))
        if words:
            sub_file = cache / "subtitles.ass"
            sub_file.write_text(build_ass(plan, words, width, height))
            vchain.append(f"ass=cache/{sub_file.name}{fonts_opt}")
    if plan.overlays:
        text_file = cache / "overlays.ass"
        text_file.write_text(build_overlay_ass(plan, width, height))
        vchain.append(f"ass=cache/{text_file.name}{fonts_opt}")
    vchain.append("format=yuv420p")
    filters.append(f"[{vcur}]{','.join(vchain)}[vout]")

    achain = [f"volume={plan.output.master_volume:.3f}"]
    if plan.output.normalize_audio:
        achain.append("loudnorm=I=-14:TP=-1.5:LRA=11")
        achain.append("aresample=48000")
    achain.append(f"atrim=0:{total}")
    filters.append(f"[{acur}]{','.join(achain)}[aout]")

    preset, crf, abr = QUALITY["preview" if preview else quality]
    args += [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", abr, "-ar", "48000",
        "-t", f"{total:.3f}",
        "-movflags", "+faststart", out_rel,
    ]
    return CompiledRender(args, total, width, height, warnings)


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
