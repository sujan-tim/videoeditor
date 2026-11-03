"""Editing tools. Each one changes only the JSON EditPlan; originals are untouched."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field, field_validator, model_validator

from ..media import analysis
from ..models import Clip, EditPlan, Position, TextOverlay
from ..render.compiler import COLOR_RE, place_clips
from .registry import ToolContext, ToolError, ToolInput, ToolResult, registry

MIN_CLIP = 0.05


# ---- helpers -------------------------------------------------------------------
def _clip_index(plan: EditPlan, clip_id: str) -> int:
    for i, c in enumerate(plan.clips):
        if c.id == clip_id:
            return i
    raise ToolError(f"No clip with id '{clip_id}'. Call get_project to see clip ids.")


def _fmt(t: float) -> str:
    m, s = divmod(max(0.0, t), 60)
    return f"{int(m)}:{s:05.2f}"


def _shift_overlays(plan: EditPlan, start: float, end: float) -> None:
    """Keep overlays aligned with content after removing [start, end) from the timeline."""
    removed = end - start
    kept = []
    for ov in plan.overlays:
        if ov.end <= start:
            kept.append(ov)
            continue
        s = ov.start if ov.start < start else (start if ov.start < end else ov.start - removed)
        e = ov.end - removed if ov.end >= end else start
        if e - s >= 0.2:
            ov.start, ov.end = round(s, 3), round(e, 3)
            kept.append(ov)
    plan.overlays = kept


def cut_timeline_range(plan: EditPlan, start: float, end: float) -> float:
    """Remove [start, end) of the output timeline. Returns seconds removed."""
    if end <= start:
        return 0.0
    new_clips: list[Clip] = []
    removed = 0.0
    for pc, clip in zip(place_clips(plan), plan.clips):
        if pc.timeline_end <= start or pc.timeline_start >= end:
            new_clips.append(clip)
            continue
        cut_from = max(start, pc.timeline_start) - pc.timeline_start + clip.start
        cut_to = min(end, pc.timeline_end) - pc.timeline_start + clip.start
        removed += cut_to - cut_from
        if cut_from - clip.start >= MIN_CLIP:
            new_clips.append(Clip(source_id=clip.source_id, start=clip.start,
                                  end=round(cut_from, 3), volume=clip.volume))
        if clip.end - cut_to >= MIN_CLIP:
            new_clips.append(Clip(source_id=clip.source_id, start=round(cut_to, 3),
                                  end=clip.end, volume=clip.volume))
    plan.clips = new_clips
    _shift_overlays(plan, start, min(end, start + removed))
    return removed


# ---- clips ---------------------------------------------------------------------
class AddClipArgs(ToolInput):
    source_id: str
    start: float = Field(0.0, ge=0, description="Start time in the source, seconds.")
    end: Optional[float] = Field(None, gt=0, description="End time in the source; default = end of source.")
    index: Optional[int] = Field(None, ge=0, description="Timeline position; default = append at the end.")


@registry.register("add_clip", "Add a range of an uploaded source video to the timeline. Use it to "
                   "combine multiple clips or reuse footage.", AddClipArgs, category="edit", mutates=True)
def add_clip(ctx: ToolContext, a: AddClipArgs) -> ToolResult:
    src = ctx.project.sources.get(a.source_id)
    if src is None:
        raise ToolError(f"No source with id '{a.source_id}'.")
    end = min(a.end if a.end is not None else src.duration, src.duration)
    if end - a.start < MIN_CLIP:
        raise ToolError(f"Range {a.start}-{end} is empty; the source is {src.duration:.2f}s long.")
    clip = Clip(source_id=src.id, start=round(a.start, 3), end=round(end, 3))
    idx = len(ctx.project.plan.clips) if a.index is None else min(a.index, len(ctx.project.plan.clips))
    ctx.project.plan.clips.insert(idx, clip)
    return ToolResult({"clip_id": clip.id, "index": idx},
                      label=f"Added {src.filename} {_fmt(clip.start)}-{_fmt(clip.end)}")


class TrimClipArgs(ToolInput):
    clip_id: str
    start: Optional[float] = Field(None, ge=0, description="New start time in the source, seconds.")
    end: Optional[float] = Field(None, gt=0, description="New end time in the source, seconds.")


@registry.register("trim_clip", "Change the in and out points (source seconds) of one timeline clip.",
                   TrimClipArgs, category="edit", mutates=True)
def trim_clip(ctx: ToolContext, a: TrimClipArgs) -> ToolResult:
    plan = ctx.project.plan
    clip = plan.clips[_clip_index(plan, a.clip_id)]
    src = ctx.project.sources[clip.source_id]
    start = clip.start if a.start is None else a.start
    end = clip.end if a.end is None else min(a.end, src.duration)
    if end - start < MIN_CLIP:
        raise ToolError("Trim would leave an empty clip; start must be before end.")
    clip.start, clip.end = round(start, 3), round(end, 3)
    return ToolResult({"clip_id": clip.id, "start": clip.start, "end": clip.end},
                      label=f"Trimmed clip to {_fmt(clip.start)}-{_fmt(clip.end)}")


class SplitArgs(ToolInput):
    timeline_time: float = Field(..., gt=0, description="Where to split, in output-timeline seconds.")


@registry.register("split_clip", "Split the clip under a timeline time into two clips.",
                   SplitArgs, category="edit", mutates=True)
def split_clip(ctx: ToolContext, a: SplitArgs) -> ToolResult:
    plan = ctx.project.plan
    for pc in place_clips(plan):
        if pc.timeline_start + MIN_CLIP < a.timeline_time < pc.timeline_end - MIN_CLIP:
            clip = plan.clips[pc.index]
            at = round(clip.start + a.timeline_time - pc.timeline_start, 3)
            second = Clip(source_id=clip.source_id, start=at, end=clip.end, volume=clip.volume)
            clip.end = at
            plan.clips.insert(pc.index + 1, second)
            return ToolResult({"left_clip_id": clip.id, "right_clip_id": second.id},
                              label=f"Split at {_fmt(a.timeline_time)}")
    raise ToolError("No clip spans that time (or it is at a clip boundary).")


class ClipIdArgs(ToolInput):
    clip_id: str


@registry.register("delete_clip", "Remove a clip from the timeline (the source footage is kept).",
                   ClipIdArgs, category="edit", mutates=True)
def delete_clip(ctx: ToolContext, a: ClipIdArgs) -> ToolResult:
    plan = ctx.project.plan
    pcs = place_clips(plan)
    i = _clip_index(plan, a.clip_id)
    plan.clips.pop(i)
    _shift_overlays(plan, pcs[i].timeline_start, pcs[i].timeline_end)
    return ToolResult({"deleted": a.clip_id}, label=f"Deleted clip {i + 1}")


class MoveClipArgs(ToolInput):
    clip_id: str
    index: int = Field(..., ge=0, description="New zero-based position on the timeline.")


@registry.register("move_clip", "Reorder a clip on the timeline.", MoveClipArgs, category="edit",
                   mutates=True)
def move_clip(ctx: ToolContext, a: MoveClipArgs) -> ToolResult:
    plan = ctx.project.plan
    i = _clip_index(plan, a.clip_id)
    clip = plan.clips.pop(i)
    j = min(a.index, len(plan.clips))
    plan.clips.insert(j, clip)
    return ToolResult({"clip_id": clip.id, "index": j}, label=f"Moved clip {i + 1} to position {j + 1}")


class CutRangeArgs(ToolInput):
    start: float = Field(..., ge=0, description="Output-timeline start of the range to remove, seconds.")
    end: float = Field(..., gt=0, description="Output-timeline end of the range to remove, seconds.")

    @model_validator(mode="after")
    def _order(self):
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


@registry.register("cut_range", "Remove a time range from the output timeline, across clip boundaries. "
                   "Times are output-timeline seconds as shown by get_project.", CutRangeArgs,
                   category="edit", mutates=True)
def cut_range(ctx: ToolContext, a: CutRangeArgs) -> ToolResult:
    removed = cut_timeline_range(ctx.project.plan, a.start, a.end)
    if removed <= 0:
        raise ToolError("Nothing on the timeline in that range.")
    return ToolResult({"removed_seconds": round(removed, 3),
                       "new_duration": round(ctx.project.plan.duration(), 3)},
                      label=f"Cut {_fmt(a.start)}-{_fmt(a.end)}")


class RemoveSilencesArgs(ToolInput):
    min_silence: float = Field(0.6, ge=0.2, le=10, description="Shortest pause to remove, seconds.")
    noise_db: float = Field(-35, ge=-80, le=-10, description="Level below which audio counts as silence.")
    padding: float = Field(0.15, ge=0, le=1, description="Seconds of pause kept on each side of speech.")


@registry.register("remove_silences", "Detect pauses in every timeline clip's audio and cut them out, "
                   "keeping a little padding so speech does not sound clipped.", RemoveSilencesArgs,
                   category="edit", mutates=True, long_running=True)
def remove_silences(ctx: ToolContext, a: RemoveSilencesArgs) -> ToolResult:
    plan = ctx.project.plan
    ranges: list[tuple[float, float]] = []
    for pc in place_clips(plan):
        src = ctx.project.sources[pc.source_id]
        if not src.has_audio:
            continue
        ctx.note(f"Detecting silence in {src.filename}")
        silences = analysis.detect_silence(ctx.project_dir / src.path, src.duration,
                                           ctx.project_dir / "analysis", a.noise_db, a.min_silence)
        for s, e in silences:
            s, e = max(s, pc.source_start), min(e, pc.source_end)
            # keep padding next to speech, but cut fully at clip edges
            s2 = s if s <= pc.source_start + 1e-3 else s + a.padding
            e2 = e if e >= pc.source_end - 1e-3 else e - a.padding
            if e2 - s2 >= 0.1:
                ranges.append((pc.timeline_start + s2 - pc.source_start,
                               pc.timeline_start + e2 - pc.source_start))
    if not ranges:
        return ToolResult({"removed_count": 0, "removed_seconds": 0,
                           "message": "No pauses found with these settings."})
    before = plan.duration()
    for s, e in sorted(ranges, reverse=True):
        cut_timeline_range(plan, s, e)
    removed = before - plan.duration()
    return ToolResult({"removed_count": len(ranges), "removed_seconds": round(removed, 2),
                       "old_duration": round(before, 2), "new_duration": round(plan.duration(), 2)},
                      label=f"Removed {len(ranges)} pauses ({removed:.1f}s)")


class VolumeArgs(ToolInput):
    volume: float = Field(..., ge=0, le=4, description="Gain multiplier: 1 = unchanged, 0.5 = half, 0 = mute.")
    clip_id: Optional[str] = Field(None, description="One clip; omit to apply to every clip.")


@registry.register("set_clip_volume", "Set the audio volume of one clip or of all clips.", VolumeArgs,
                   category="edit", mutates=True)
def set_clip_volume(ctx: ToolContext, a: VolumeArgs) -> ToolResult:
    plan = ctx.project.plan
    targets = [plan.clips[_clip_index(plan, a.clip_id)]] if a.clip_id else plan.clips
    for c in targets:
        c.volume = round(a.volume, 3)
    who = "1 clip" if a.clip_id else "all clips"
    return ToolResult({"updated": len(targets)}, label=f"Volume {a.volume:g}x on {who}")


class AudioArgs(ToolInput):
    master_volume: Optional[float] = Field(None, ge=0, le=4, description="Overall gain multiplier.")
    normalize: Optional[bool] = Field(None, description="Loudness-normalize to -14 LUFS (social platforms).")


@registry.register("set_audio", "Set the master volume and loudness normalization of the output.",
                   AudioArgs, category="edit", mutates=True)
def set_audio(ctx: ToolContext, a: AudioArgs) -> ToolResult:
    out = ctx.project.plan.output
    if a.master_volume is not None:
        out.master_volume = round(a.master_volume, 3)
    if a.normalize is not None:
        out.normalize_audio = a.normalize
    return ToolResult({"master_volume": out.master_volume, "normalize": out.normalize_audio},
                      label=f"Audio: master {out.master_volume:g}x"
                            + (", normalized" if out.normalize_audio else ""))


# ---- output format -------------------------------------------------------------
PLATFORM_PRESETS = {
    "tiktok": ("9:16", "crop"),
    "instagram_reels": ("9:16", "crop"),
    "youtube_shorts": ("9:16", "crop"),
    "youtube": ("16:9", "pad"),
    "instagram_feed": ("4:5", "crop"),
    "square": ("1:1", "crop"),
    "original": ("original", "pad"),
}


class OutputFormatArgs(ToolInput):
    platform: Optional[Literal["tiktok", "instagram_reels", "youtube_shorts", "youtube",
                               "instagram_feed", "square", "original"]] = Field(
        None, description="Preset that sets aspect and fit for a platform.")
    aspect: Optional[Literal["original", "9:16", "16:9", "1:1", "4:5"]] = None
    fit: Optional[Literal["pad", "crop"]] = Field(
        None, description="crop = fill the frame (center crop); pad = letterbox with black bars.")
    resolution: Optional[Literal["2160p", "1080p", "720p", "480p"]] = Field(
        None, description="Short-side resolution of the export.")


@registry.register("set_output_format", "Resize the output for a platform (TikTok, Reels, Shorts = 9:16; "
                   "YouTube = 16:9; Instagram feed = 4:5) or set aspect, fit and resolution directly.",
                   OutputFormatArgs, category="edit", mutates=True)
def set_output_format(ctx: ToolContext, a: OutputFormatArgs) -> ToolResult:
    out = ctx.project.plan.output
    if a.platform:
        out.aspect, out.fit = PLATFORM_PRESETS[a.platform]  # type: ignore[assignment]
        out.platform = a.platform
    if a.aspect:
        out.aspect = a.aspect
    if a.fit:
        out.fit = a.fit
    if a.resolution:
        out.resolution = a.resolution
    return ToolResult(out.model_dump(), label=f"Output {out.aspect} {out.fit} {out.resolution}"
                      + (f" for {a.platform}" if a.platform else ""))


# ---- text overlays -------------------------------------------------------------
class _ColorMixin(ToolInput):
    @field_validator("color", check_fields=False)
    @classmethod
    def _color(cls, v):
        if v is not None and not COLOR_RE.match(v.strip().lower()):
            raise ValueError("use a #RRGGBB hex color or a basic name like white, yellow, red")
        return v


class AddTextArgs(_ColorMixin):
    text: str = Field(..., min_length=1, max_length=300)
    start: float = Field(..., ge=0, description="Output-timeline seconds.")
    end: float = Field(..., gt=0, description="Output-timeline seconds.")
    position: Position = "top"
    font_size: int = Field(64, ge=12, le=200, description="Pixels at a 1080-pixel short side.")
    color: str = "white"
    background: bool = Field(True, description="Draw a dark box behind the text for legibility.")

    @model_validator(mode="after")
    def _order(self):
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


@registry.register("add_text_overlay", "Add a text overlay (title, caption, call to action) shown "
                   "between two output-timeline times.", AddTextArgs, category="edit", mutates=True)
def add_text_overlay(ctx: ToolContext, a: AddTextArgs) -> ToolResult:
    ov = TextOverlay(**a.model_dump())
    ctx.project.plan.overlays.append(ov)
    return ToolResult({"overlay_id": ov.id}, label=f"Added text \"{a.text[:30]}\"")


class UpdateTextArgs(_ColorMixin):
    overlay_id: str
    text: Optional[str] = Field(None, min_length=1, max_length=300)
    start: Optional[float] = Field(None, ge=0)
    end: Optional[float] = Field(None, gt=0)
    position: Optional[Position] = None
    font_size: Optional[int] = Field(None, ge=12, le=200)
    color: Optional[str] = None
    background: Optional[bool] = None


@registry.register("update_text_overlay", "Change any property of an existing text overlay.",
                   UpdateTextArgs, category="edit", mutates=True)
def update_text_overlay(ctx: ToolContext, a: UpdateTextArgs) -> ToolResult:
    ov = next((o for o in ctx.project.plan.overlays if o.id == a.overlay_id), None)
    if ov is None:
        raise ToolError(f"No text overlay with id '{a.overlay_id}'.")
    for k, v in a.model_dump(exclude_none=True, exclude={"overlay_id"}).items():
        setattr(ov, k, v)
    if ov.end <= ov.start:
        raise ToolError("end must be greater than start")
    return ToolResult({"overlay_id": ov.id}, label=f"Edited text \"{ov.text[:30]}\"")


class OverlayIdArgs(ToolInput):
    overlay_id: str


@registry.register("remove_text_overlay", "Delete a text overlay.", OverlayIdArgs, category="edit",
                   mutates=True)
def remove_text_overlay(ctx: ToolContext, a: OverlayIdArgs) -> ToolResult:
    before = len(ctx.project.plan.overlays)
    ctx.project.plan.overlays = [o for o in ctx.project.plan.overlays if o.id != a.overlay_id]
    if len(ctx.project.plan.overlays) == before:
        raise ToolError(f"No text overlay with id '{a.overlay_id}'.")
    return ToolResult({"removed": a.overlay_id}, label="Removed text overlay")


# ---- subtitles -----------------------------------------------------------------
class SubtitleArgs(ToolInput):
    enabled: bool = True
    font_size: Optional[int] = Field(None, ge=16, le=200)
    position: Optional[Position] = None
    max_words_per_line: Optional[int] = Field(None, ge=1, le=12)
    uppercase: Optional[bool] = None
    highlight_color: Optional[str] = Field(None, description="Color of the word being spoken; '' disables.")

    @field_validator("highlight_color")
    @classmethod
    def _hl(cls, v):
        if v and not COLOR_RE.match(v.strip().lower()):
            raise ValueError("use a #RRGGBB hex color or a basic color name")
        return v


@registry.register("set_subtitles", "Turn burned-in subtitles on or off and style them. Enabling "
                   "transcribes any timeline source that has no transcript yet (can take a while). "
                   "Subtitles follow the edit automatically after cuts.", SubtitleArgs,
                   category="edit", mutates=True, long_running=True)
def set_subtitles(ctx: ToolContext, a: SubtitleArgs) -> ToolResult:
    st = ctx.project.plan.subtitles
    words = 0
    if a.enabled:
        used = {c.source_id for c in ctx.project.plan.clips}
        for sid in used:
            src = ctx.project.sources[sid]
            if not src.has_audio:
                continue
            ctx.note(f"Transcribing {src.filename}")
            try:
                tr = analysis.transcribe(ctx.project_dir / src.path, ctx.project_dir / "analysis",
                                         on_progress=ctx.job.progress if ctx.job else None,
                                         duration=src.duration)
            except analysis.TranscriptionUnavailable as exc:
                raise ToolError(str(exc)) from exc
            words += sum(len(s.get("words", [])) for s in tr["segments"])
    st.enabled = a.enabled
    for k, v in a.model_dump(exclude_none=True, exclude={"enabled"}).items():
        setattr(st, k, v)
    return ToolResult({"subtitles": st.model_dump(), "transcribed_words": words},
                      label="Subtitles on" if a.enabled else "Subtitles off")


class RestoreArgs(ToolInput):
    version: int = Field(..., ge=1)


@registry.register("restore_version", "Return the edit plan to an earlier version from the history. "
                   "This adds a new version, so it can itself be undone.", RestoreArgs,
                   category="edit", mutates=True)
def restore_version(ctx: ToolContext, a: RestoreArgs) -> ToolResult:
    try:
        ctx.project.plan = ctx.store.load_version(ctx.project.id, a.version)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Version {a.version} does not exist.") from exc
    return ToolResult({"restored": a.version}, label=f"Restored version {a.version}")
