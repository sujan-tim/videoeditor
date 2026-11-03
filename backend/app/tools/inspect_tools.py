"""Inspection, analysis, render and control tools."""
from __future__ import annotations

from typing import Optional

from pydantic import Field

from ..media import analysis, ffmpeg
from ..models import PendingPlan
from ..render import compiler
from ..render.compiler import output_dimensions, place_clips
from .registry import ToolContext, ToolError, ToolInput, ToolResult, registry


def project_summary(ctx_project, project_dir) -> dict:
    p = ctx_project
    plan = p.plan
    w, h = output_dimensions(p, plan)
    cache = project_dir / "analysis"
    sources = []
    for s in p.sources.values():
        sources.append({
            "id": s.id, "filename": s.filename, "duration": s.duration,
            "size": f"{s.width}x{s.height}", "fps": s.fps, "has_audio": s.has_audio,
            "has_transcript": analysis.load_transcript(cache, project_dir / s.path) is not None,
        })
    clips = [{
        "index": pc.index, "clip_id": pc.clip_id, "source_id": pc.source_id,
        "source_range": [pc.source_start, pc.source_end],
        "timeline_range": [pc.timeline_start, pc.timeline_end], "volume": pc.volume,
    } for pc in place_clips(plan)]
    latest = p.renders[-1] if p.renders else None
    return {
        "project": p.name, "version": p.version, "timeline_duration": round(plan.duration(), 3),
        "sources": sources, "clips": clips,
        "text_overlays": [o.model_dump() for o in plan.overlays],
        "subtitles": plan.subtitles.model_dump(),
        "output": {**plan.output.model_dump(), "export_size": f"{w}x{h}"},
        "latest_render": latest.model_dump() if latest else None,
        "recent_history": [{"version": v.version, "label": v.label, "actor": v.actor}
                           for v in p.history[-8:]],
    }


class NoArgs(ToolInput):
    pass


@registry.register("get_project", "Get the full project state: sources (with ids, durations, whether a "
                   "transcript exists), timeline clips with source and output-timeline ranges, text "
                   "overlays, subtitle and output settings, latest render and recent history. Call this "
                   "first.", NoArgs, category="inspect")
def get_project(ctx: ToolContext, a: NoArgs) -> ToolResult:
    return ToolResult(project_summary(ctx.project, ctx.project_dir))


class SourceArgs(ToolInput):
    source_id: str


def _source(ctx: ToolContext, sid: str):
    src = ctx.project.sources.get(sid)
    if src is None:
        raise ToolError(f"No source with id '{sid}'.")
    return src


@registry.register("probe_source", "Full technical metadata of a source file (codecs, bitrate, "
                   "rotation, audio sample rate).", SourceArgs, category="inspect")
def probe_source(ctx: ToolContext, a: SourceArgs) -> ToolResult:
    src = _source(ctx, a.source_id)
    return ToolResult(ffmpeg.summarize_probe(ffmpeg.probe(ctx.project_dir / src.path)))


class SilenceArgs(ToolInput):
    source_id: str
    noise_db: float = Field(-35, ge=-80, le=-10)
    min_silence: float = Field(0.6, ge=0.2, le=10)


@registry.register("detect_silence", "List silent intervals in a source (source seconds) without "
                   "changing anything. Use to decide on remove_silences settings.", SilenceArgs,
                   category="inspect", long_running=True)
def detect_silence(ctx: ToolContext, a: SilenceArgs) -> ToolResult:
    src = _source(ctx, a.source_id)
    if not src.has_audio:
        raise ToolError("This source has no audio track.")
    iv = analysis.detect_silence(ctx.project_dir / src.path, src.duration,
                                 ctx.project_dir / "analysis", a.noise_db, a.min_silence)
    total = sum(e - s for s, e in iv)
    return ToolResult({"count": len(iv), "total_silence_seconds": round(total, 2),
                       "source_duration": src.duration, "intervals": iv[:150],
                       "truncated": len(iv) > 150})


class TranscribeArgs(ToolInput):
    source_id: str
    language: Optional[str] = Field(None, description="ISO code like 'en'; omit to auto-detect.")


@registry.register("transcribe", "Transcribe a source's speech with Whisper (word timestamps, cached). "
                   "Returns timestamped segments in source seconds.", TranscribeArgs,
                   category="inspect", long_running=True)
def transcribe(ctx: ToolContext, a: TranscribeArgs) -> ToolResult:
    src = _source(ctx, a.source_id)
    if not src.has_audio:
        raise ToolError("This source has no audio track.")
    ctx.note(f"Transcribing {src.filename}")
    try:
        tr = analysis.transcribe(ctx.project_dir / src.path, ctx.project_dir / "analysis",
                                 language=a.language, duration=src.duration,
                                 on_progress=ctx.job.progress if ctx.job else None)
    except analysis.TranscriptionUnavailable as exc:
        raise ToolError(str(exc)) from exc
    segs, chars = [], 0
    for s in tr["segments"]:
        chars += len(s["text"])
        if chars > 15000:
            break
        segs.append({"start": s["start"], "end": s["end"], "text": s["text"]})
    return ToolResult({"language": tr.get("language"), "segment_count": len(tr["segments"]),
                       "segments": segs, "truncated": len(segs) < len(tr["segments"])})


class SceneArgs(ToolInput):
    source_id: str
    threshold: float = Field(27.0, ge=5, le=80, description="Lower = more sensitive.")


@registry.register("detect_scenes", "Find shot boundaries in a source with PySceneDetect. Returns "
                   "[start, end] scenes in source seconds.", SceneArgs, category="inspect",
                   long_running=True)
def detect_scenes(ctx: ToolContext, a: SceneArgs) -> ToolResult:
    src = _source(ctx, a.source_id)
    scenes = analysis.detect_scenes(ctx.project_dir / src.path, ctx.project_dir / "analysis",
                                    a.threshold)
    return ToolResult({"count": len(scenes), "scenes": scenes[:200]})


class FramesArgs(ToolInput):
    times: Optional[list[float]] = Field(None, max_length=8, description="Output-timeline seconds; "
                                         "omit to sample evenly.")
    count: int = Field(4, ge=1, le=8, description="Frames to sample evenly when times is omitted.")
    source_id: Optional[str] = Field(None, description="Sample a raw source (source seconds) instead "
                                     "of the edited timeline.")


@registry.register("sample_frames", "Look at the footage: returns still frames as images (from the edited "
                   "timeline by default, or from a raw source). Use to judge content, framing for a "
                   "crop, or where text would be readable.", FramesArgs, category="inspect")
def sample_frames(ctx: ToolContext, a: FramesArgs) -> ToolResult:
    pdir = ctx.project_dir
    targets: list[tuple[float, str, float]] = []  # (label time, source path, source time)
    if a.source_id:
        src = _source(ctx, a.source_id)
        times = a.times or [src.duration * (i + 0.5) / a.count for i in range(a.count)]
        targets = [(t, src.path, min(t, max(0, src.duration - 0.05))) for t in times]
    else:
        pcs = place_clips(ctx.project.plan)
        if not pcs:
            raise ToolError("The timeline is empty.")
        total = pcs[-1].timeline_end
        times = a.times or [total * (i + 0.5) / a.count for i in range(a.count)]
        for t in times:
            pc = next((p for p in pcs if p.timeline_start <= t < p.timeline_end), pcs[-1])
            st = min(pc.source_end - 0.05, pc.source_start + max(0.0, t - pc.timeline_start))
            targets.append((t, ctx.project.sources[pc.source_id].path, st))
    images, labels = [], []
    for k, (t, path, st) in enumerate(targets):
        out = pdir / "frames" / f"frame_{k}_{int(st * 1000)}.jpg"
        ffmpeg.extract_frame(pdir / path, st, out)
        images.append(out)
        labels.append({"image": k + 1, "time": round(t, 2)})
    return ToolResult({"frames": labels, "basis": "source" if a.source_id else "timeline"},
                      images=images)


# ---- render & validation -------------------------------------------------------
class RenderArgs(ToolInput):
    pass


@registry.register("render_preview", "Render a fast low-resolution preview of the current plan so the "
                   "user can watch it. Call after a set of edits.", RenderArgs, category="render",
                   long_running=True)
def render_preview(ctx: ToolContext, a: RenderArgs) -> ToolResult:
    ctx.note("Rendering preview")
    info, warnings = compiler.render(ctx.project, ctx.project_dir, "preview",
                                     on_progress=ctx.job.progress if ctx.job else None)
    ctx.project.renders.append(info)
    return ToolResult({"render_id": info.id, "duration": info.duration,
                       "size": f"{info.width}x{info.height}", "warnings": warnings}, save=True)


class ValidateArgs(ToolInput):
    render_id: Optional[str] = Field(None, description="Defaults to the latest render.")


@registry.register("validate_render", "Check a render: duration matches the plan, video and audio "
                   "streams exist, size is right, and look for black frames and clipping or silent "
                   "audio. Returns a list of issues.", ValidateArgs, category="render",
                   long_running=True)
def validate_render(ctx: ToolContext, a: ValidateArgs) -> ToolResult:
    renders = ctx.project.renders
    r = next((x for x in renders if x.id == a.render_id), None) if a.render_id else (
        renders[-1] if renders else None)
    if r is None:
        raise ToolError("No render found; call render_preview first.")
    path = ctx.project_dir / r.path
    meta = ffmpeg.summarize_probe(ffmpeg.probe(path))
    checks = analysis.quality_check(path, meta["has_audio"])
    issues = []
    if abs(meta["duration"] - r.duration) > 0.5:
        issues.append(f"duration {meta['duration']:.2f}s differs from plan {r.duration:.2f}s")
    if (meta["width"], meta["height"]) != (r.width, r.height):
        issues.append(f"size {meta['width']}x{meta['height']} != expected {r.width}x{r.height}")
    if not meta["has_audio"]:
        issues.append("no audio stream")
    if checks["max_volume_db"] is not None and checks["max_volume_db"] >= -0.1:
        issues.append("audio peaks at 0 dB and may be clipping")
    if checks["mean_volume_db"] is not None and checks["mean_volume_db"] < -45:
        issues.append("audio is nearly silent")
    black = sum(e - s for s, e in checks["black_segments"])
    if black > 1.0:
        issues.append(f"{black:.1f}s of black frames")
    stale = r.version != ctx.project.version
    return ToolResult({"render_id": r.id, "render_version": r.version, "is_current": not stale,
                       "metadata": meta, "checks": checks, "issues": issues, "ok": not issues})


class ProposePlanArgs(ToolInput):
    summary: str = Field(..., max_length=800, description="One or two sentences on the goal.")
    steps: list[str] = Field(..., min_length=1, max_length=20,
                             description="The edits you intend to make, in order, in plain language.")


@registry.register("propose_plan", "Show the user a structured editing plan and wait for approval "
                   "before editing. After calling it, end your turn with a short summary.",
                   ProposePlanArgs, category="control")
def propose_plan(ctx: ToolContext, a: ProposePlanArgs) -> ToolResult:
    ctx.project.pending_plan = PendingPlan(summary=a.summary, steps=a.steps)
    return ToolResult({"status": "awaiting_user_approval",
                       "instruction": "Stop here. Do not make edits until the user approves."},
                      save=True)
