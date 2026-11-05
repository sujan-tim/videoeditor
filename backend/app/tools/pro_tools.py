"""Pro editing tools: speed, color looks, framing, transitions, fades, music/voice-over and B-roll.

Like every tool, these only change the JSON EditPlan. The browser preview and the FFmpeg renderer
both read the same plan, so what you see while editing is what gets exported.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field, model_validator

from ..models import AudioClip, BrollClip, ColorAdjust, Look, Transition, TransitionType
from .edit_tools import MIN_CLIP, _clip_index, _fmt
from .registry import ToolContext, ToolError, ToolInput, ToolResult, registry


def _targets(ctx: ToolContext, clip_id: Optional[str]):
    plan = ctx.project.plan
    if clip_id:
        return [plan.clips[_clip_index(plan, clip_id)]]
    if not plan.clips:
        raise ToolError("The timeline is empty.")
    return list(plan.clips)


# ---- one-call clip update (used by the timeline UI and by the agent) --------------
class UpdateClipArgs(ToolInput):
    clip_id: str
    start: Optional[float] = Field(None, ge=0, description="In point, source seconds.")
    end: Optional[float] = Field(None, gt=0, description="Out point, source seconds.")
    volume: Optional[float] = Field(None, ge=0, le=4)
    speed: Optional[float] = Field(None, ge=0.25, le=4, description="0.5 = slow motion, 2 = double speed.")
    look: Optional[Look] = None
    brightness: Optional[float] = Field(None, ge=-1, le=1)
    contrast: Optional[float] = Field(None, ge=-1, le=1)
    saturation: Optional[float] = Field(None, ge=-1, le=1)
    zoom: Optional[float] = Field(None, ge=1, le=3, description="Punch-in, 1 = none.")
    focus_x: Optional[float] = Field(None, ge=0, le=1, description="0 = keep left edge, 1 = right edge.")
    focus_y: Optional[float] = Field(None, ge=0, le=1, description="0 = keep top, 1 = bottom.")
    fade_in: Optional[float] = Field(None, ge=0, le=5)
    fade_out: Optional[float] = Field(None, ge=0, le=5)


@registry.register("update_clip", "Change several properties of one timeline clip at once: in/out points, "
                   "volume, speed, color look and adjustments, zoom and framing, fades.",
                   UpdateClipArgs, category="edit", mutates=True)
def update_clip(ctx: ToolContext, a: UpdateClipArgs) -> ToolResult:
    plan = ctx.project.plan
    clip = plan.clips[_clip_index(plan, a.clip_id)]
    src = ctx.project.sources[clip.source_id]
    ch = a.model_dump(exclude_none=True, exclude={"clip_id"})
    start = ch.pop("start", clip.start)
    end = min(ch.pop("end", clip.end), src.duration)
    if end - start < MIN_CLIP:
        raise ToolError("The clip would be empty; start must be before end.")
    clip.start, clip.end = round(start, 3), round(end, 3)
    for k in ("brightness", "contrast", "saturation"):
        if k in ch:
            setattr(clip.adjust, k, round(ch.pop(k), 3))
    for k, v in ch.items():
        setattr(clip, k, round(v, 3) if isinstance(v, float) else v)
    changed = ", ".join(a.model_dump(exclude_none=True, exclude={"clip_id"})) or "nothing"
    return ToolResult({"clip_id": clip.id, "clip": clip.model_dump()},
                      label=f"Clip {plan.clips.index(clip) + 1}: {changed}")


class SpeedArgs(ToolInput):
    speed: float = Field(..., ge=0.25, le=4, description="0.5 = half speed (slow motion), 2 = twice as fast.")
    clip_id: Optional[str] = Field(None, description="One clip; omit for every clip.")


@registry.register("set_clip_speed", "Speed clips up or slow them down (audio pitch is preserved).",
                   SpeedArgs, category="edit", mutates=True)
def set_clip_speed(ctx: ToolContext, a: SpeedArgs) -> ToolResult:
    clips = _targets(ctx, a.clip_id)
    for c in clips:
        c.speed = round(a.speed, 3)
    return ToolResult({"updated": len(clips), "new_duration": round(ctx.project.plan.duration(), 2)},
                      label=f"Speed {a.speed:g}x on {'1 clip' if a.clip_id else 'all clips'}")


class LookArgs(ToolInput):
    look: Optional[Look] = Field(None, description="Color preset: none, bw, warm, cool, vintage, vivid, "
                                                   "faded, cinematic (teal/orange), dramatic.")
    brightness: Optional[float] = Field(None, ge=-1, le=1)
    contrast: Optional[float] = Field(None, ge=-1, le=1)
    saturation: Optional[float] = Field(None, ge=-1, le=1)
    clip_id: Optional[str] = Field(None, description="One clip; omit for every clip.")


@registry.register("set_color", "Apply a color look and/or brightness, contrast and saturation "
                   "adjustments to one clip or all clips.", LookArgs, category="edit", mutates=True)
def set_color(ctx: ToolContext, a: LookArgs) -> ToolResult:
    clips = _targets(ctx, a.clip_id)
    for c in clips:
        if a.look is not None:
            c.look = a.look
        for k in ("brightness", "contrast", "saturation"):
            v = getattr(a, k)
            if v is not None:
                setattr(c.adjust, k, round(v, 3))
    what = a.look or "adjustments"
    return ToolResult({"updated": len(clips)}, label=f"Color {what} on {'1 clip' if a.clip_id else 'all clips'}")


class FramingArgs(ToolInput):
    clip_id: Optional[str] = Field(None, description="One clip; omit for every clip.")
    zoom: Optional[float] = Field(None, ge=1, le=3, description="Punch-in amount, 1 = none.")
    focus_x: Optional[float] = Field(None, ge=0, le=1, description="Horizontal centre of interest, 0..1.")
    focus_y: Optional[float] = Field(None, ge=0, le=1, description="Vertical centre of interest, 0..1.")


@registry.register("set_framing", "Reframe clips: punch in (zoom) and choose which part of the picture to "
                   "keep when cropping to 9:16 or another aspect. Use sample_frames to find the subject.",
                   FramingArgs, category="edit", mutates=True)
def set_framing(ctx: ToolContext, a: FramingArgs) -> ToolResult:
    clips = _targets(ctx, a.clip_id)
    for c in clips:
        for k in ("zoom", "focus_x", "focus_y"):
            v = getattr(a, k)
            if v is not None:
                setattr(c, k, round(v, 3))
    return ToolResult({"updated": len(clips)}, label=f"Reframed {'1 clip' if a.clip_id else 'all clips'}")


class TransitionArgs(ToolInput):
    type: Literal["none", "fade", "fadeblack", "fadewhite", "dissolve", "slideleft", "slideright", "slideup",
                  "wipeleft", "wiperight", "circleopen", "zoomin", "smoothleft"] = "fade"
    duration: float = Field(0.5, ge=0.1, le=2)
    clip_id: Optional[str] = Field(None, description="The clip the transition leads INTO. Omit to put the "
                                                     "same transition between every pair of clips.")


@registry.register("set_transition", "Add, change or remove (type none) the transition into a clip, or "
                   "between all clips.", TransitionArgs, category="edit", mutates=True)
def set_transition(ctx: ToolContext, a: TransitionArgs) -> ToolResult:
    plan = ctx.project.plan
    if a.clip_id:
        i = _clip_index(plan, a.clip_id)
        if i == 0:
            raise ToolError("The first clip has nothing before it; use update_clip fade_in instead.")
        idx = [i]
    else:
        idx = list(range(1, len(plan.clips)))
        if not idx:
            raise ToolError("Transitions need at least two clips on the timeline.")
    for i in idx:
        plan.clips[i].transition_in = None if a.type == "none" else Transition(type=a.type, duration=a.duration)
    label = "Removed transitions" if a.type == "none" else f"{a.type} transition ({a.duration:g}s)"
    return ToolResult({"updated": len(idx), "new_duration": round(plan.duration(), 2)},
                      label=f"{label} on {len(idx)} cut{'s' if len(idx) != 1 else ''}")


# ---- audio track -------------------------------------------------------------------
class AddAudioArgs(ToolInput):
    source_id: str = Field(..., description="An uploaded audio file (or a video whose sound you want).")
    timeline_start: float = Field(0.0, ge=0, description="Where it starts on the output timeline.")
    start: float = Field(0.0, ge=0, description="In point in the source, seconds.")
    end: Optional[float] = Field(None, gt=0, description="Out point in the source; default = to the end "
                                 "of the video or the source, whichever is shorter.")
    role: Literal["music", "voiceover", "sfx"] = "music"
    volume: float = Field(0.5, ge=0, le=4)
    duck: bool = Field(True, description="Music only: dip automatically while someone speaks.")
    fade_in: float = Field(1.0, ge=0, le=10)
    fade_out: float = Field(2.0, ge=0, le=10)


@registry.register("add_audio", "Add background music, a voice-over or a sound effect on the audio track. "
                   "Music ducks under speech automatically.", AddAudioArgs, category="edit", mutates=True)
def add_audio(ctx: ToolContext, a: AddAudioArgs) -> ToolResult:
    src = ctx.project.sources.get(a.source_id)
    if src is None:
        raise ToolError(f"No source with id '{a.source_id}'.")
    if not src.has_audio:
        raise ToolError(f"{src.filename} has no sound.")
    room = max(MIN_CLIP, ctx.project.plan.duration() - a.timeline_start)
    end = a.end if a.end is not None else a.start + room
    end = min(end, src.duration)
    if end - a.start < MIN_CLIP:
        raise ToolError("That range of the source is empty.")
    item = AudioClip(source_id=src.id, timeline_start=round(a.timeline_start, 3), start=round(a.start, 3),
                     end=round(end, 3), volume=a.volume, role=a.role, duck=a.duck,
                     fade_in=a.fade_in, fade_out=a.fade_out)
    ctx.project.plan.audio.append(item)
    return ToolResult({"audio_id": item.id, "duration": round(item.duration, 2)},
                      label=f"Added {a.role} {src.filename} at {_fmt(a.timeline_start)}")


class UpdateAudioArgs(ToolInput):
    audio_id: str
    timeline_start: Optional[float] = Field(None, ge=0)
    start: Optional[float] = Field(None, ge=0)
    end: Optional[float] = Field(None, gt=0)
    volume: Optional[float] = Field(None, ge=0, le=4)
    duck: Optional[bool] = None
    fade_in: Optional[float] = Field(None, ge=0, le=10)
    fade_out: Optional[float] = Field(None, ge=0, le=10)
    role: Optional[Literal["music", "voiceover", "sfx"]] = None


@registry.register("update_audio", "Move, trim, re-level or change fades/ducking of an audio track item.",
                   UpdateAudioArgs, category="edit", mutates=True)
def update_audio(ctx: ToolContext, a: UpdateAudioArgs) -> ToolResult:
    item = next((x for x in ctx.project.plan.audio if x.id == a.audio_id), None)
    if item is None:
        raise ToolError(f"No audio item with id '{a.audio_id}'.")
    src = ctx.project.sources[item.source_id]
    for k, v in a.model_dump(exclude_none=True, exclude={"audio_id"}).items():
        setattr(item, k, round(v, 3) if isinstance(v, float) else v)
    item.end = min(item.end, src.duration)
    if item.end - item.start < MIN_CLIP:
        raise ToolError("The audio item would be empty.")
    return ToolResult({"audio_id": item.id}, label=f"Edited {item.role} {src.filename}")


class AudioIdArgs(ToolInput):
    audio_id: str


@registry.register("remove_audio", "Remove an item from the audio track.", AudioIdArgs, category="edit",
                   mutates=True)
def remove_audio(ctx: ToolContext, a: AudioIdArgs) -> ToolResult:
    plan = ctx.project.plan
    before = len(plan.audio)
    plan.audio = [x for x in plan.audio if x.id != a.audio_id]
    if len(plan.audio) == before:
        raise ToolError(f"No audio item with id '{a.audio_id}'.")
    return ToolResult({"removed": a.audio_id}, label="Removed audio")


# ---- b-roll / picture-in-picture -----------------------------------------------------
class AddBrollArgs(ToolInput):
    source_id: str
    timeline_start: float = Field(..., ge=0, description="When the cutaway starts on the output timeline.")
    start: float = Field(0.0, ge=0, description="In point in the B-roll source.")
    end: Optional[float] = Field(None, gt=0, description="Out point; default start + 3 seconds.")
    mode: Literal["full", "pip"] = Field("full", description="full = cut away to it; pip = small window.")
    pip_corner: Literal["top_left", "top_right", "bottom_left", "bottom_right"] = "top_right"
    pip_scale: float = Field(0.35, ge=0.15, le=0.8)
    volume: float = Field(0.0, ge=0, le=4, description="B-roll sound level; 0 keeps only the main audio.")


@registry.register("add_broll", "Lay a B-roll cutaway or picture-in-picture over the main video at a "
                   "timeline time. The main audio keeps playing underneath.", AddBrollArgs,
                   category="edit", mutates=True)
def add_broll(ctx: ToolContext, a: AddBrollArgs) -> ToolResult:
    src = ctx.project.sources.get(a.source_id)
    if src is None:
        raise ToolError(f"No source with id '{a.source_id}'.")
    if src.kind != "video":
        raise ToolError(f"{src.filename} has no picture.")
    end = min(a.end if a.end is not None else a.start + 3.0, src.duration)
    if end - a.start < MIN_CLIP:
        raise ToolError("That range of the source is empty.")
    total = ctx.project.plan.duration()
    if a.timeline_start >= total:
        raise ToolError(f"The video is only {total:.2f}s long.")
    item = BrollClip(**a.model_dump(exclude={"end"}), end=round(end, 3))
    ctx.project.plan.broll.append(item)
    return ToolResult({"broll_id": item.id}, label=f"B-roll {src.filename} at {_fmt(a.timeline_start)}")


class UpdateBrollArgs(ToolInput):
    broll_id: str
    timeline_start: Optional[float] = Field(None, ge=0)
    start: Optional[float] = Field(None, ge=0)
    end: Optional[float] = Field(None, gt=0)
    mode: Optional[Literal["full", "pip"]] = None
    pip_corner: Optional[Literal["top_left", "top_right", "bottom_left", "bottom_right"]] = None
    pip_scale: Optional[float] = Field(None, ge=0.15, le=0.8)
    volume: Optional[float] = Field(None, ge=0, le=4)
    look: Optional[Look] = None


@registry.register("update_broll", "Move, trim or restyle a B-roll item.", UpdateBrollArgs,
                   category="edit", mutates=True)
def update_broll(ctx: ToolContext, a: UpdateBrollArgs) -> ToolResult:
    item = next((x for x in ctx.project.plan.broll if x.id == a.broll_id), None)
    if item is None:
        raise ToolError(f"No B-roll with id '{a.broll_id}'.")
    src = ctx.project.sources[item.source_id]
    for k, v in a.model_dump(exclude_none=True, exclude={"broll_id"}).items():
        setattr(item, k, round(v, 3) if isinstance(v, float) else v)
    item.end = min(item.end, src.duration)
    if item.end - item.start < MIN_CLIP:
        raise ToolError("The B-roll would be empty.")
    return ToolResult({"broll_id": item.id}, label=f"Edited B-roll {src.filename}")


class BrollIdArgs(ToolInput):
    broll_id: str


@registry.register("remove_broll", "Remove a B-roll item.", BrollIdArgs, category="edit", mutates=True)
def remove_broll(ctx: ToolContext, a: BrollIdArgs) -> ToolResult:
    plan = ctx.project.plan
    before = len(plan.broll)
    plan.broll = [x for x in plan.broll if x.id != a.broll_id]
    if len(plan.broll) == before:
        raise ToolError(f"No B-roll with id '{a.broll_id}'.")
    return ToolResult({"removed": a.broll_id}, label="Removed B-roll")
