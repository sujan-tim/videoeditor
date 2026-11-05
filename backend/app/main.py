"""FastAPI application: REST API for the dashboard and the agent."""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config
from .agent import agent
from .jobs import jobs
from .media import analysis, ffmpeg, prep
from .models import Source, new_id
from .render import compiler
from .storage import NotFound, store
from .tools import registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")

app = FastAPI(title="AI Video Editor", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])
app.add_middleware(auth.AuthMiddleware)
app.include_router(auth.router)
app.mount("/files", StaticFiles(directory=store.root), name="files")


@app.exception_handler(NotFound)
async def _not_found(_, exc: NotFound):
    return JSONResponse(status_code=404, content={"detail": f"Not found: {exc}"})


def _project_view(project_id: str) -> dict:
    project = store.load(project_id)
    pdir = store.project_dir(project_id)
    plan = project.plan
    ow, oh = compiler.output_dimensions(project, plan)
    pw, ph = compiler.output_dimensions(project, plan, preview=True)
    data = project.model_dump()
    data["timeline"] = [pc.__dict__ for pc in compiler.place_clips(plan)]
    data["can_undo"] = project.undo_index > 0
    data["can_redo"] = 0 <= project.undo_index < len(project.undo_stack) - 1
    data["duration"] = round(plan.duration(), 3)
    data["output_size"] = [ow, oh]
    data["preview_size"] = [pw, ph]
    for sid, src in project.sources.items():
        data["sources"][sid]["has_transcript"] = analysis.load_transcript(
            pdir / "analysis", pdir / src.path) is not None
        data["sources"][sid]["url"] = f"/files/{project_id}/{src.path}"
        data["sources"][sid]["thumbnail_url"] = (f"/files/{project_id}/frames/thumb_{sid}.jpg"
                                                 if src.kind == "video" else None)
        data["sources"][sid]["proxy_url"] = f"/files/{project_id}/{src.proxy_path}" if src.proxy_path else None
        data["sources"][sid]["filmstrip_url"] = (f"/files/{project_id}/{src.filmstrip_path}"
                                                 if src.filmstrip_path else None)
        data["sources"][sid]["waveform_url"] = (f"/files/{project_id}/{src.waveform_path}"
                                                if src.waveform_path else None)
    for r in data["renders"]:
        r["url"] = f"/files/{project_id}/{r['path']}"
    return data


# ---- health & tools -----------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    try:
        ver = ffmpeg.run(["-version"]).stdout.splitlines()[0]
    except Exception as exc:  # noqa: BLE001
        ver = f"unavailable: {exc}"
    try:
        import faster_whisper  # noqa: F401
        whisper = True
    except ImportError:
        whisper = False
    return {"ok": True, "ffmpeg": ver, "whisper_installed": whisper,
            "whisper_model": config.WHISPER_MODEL, "ai_provider": config.ai_provider(),
            "ai_configured": config.ai_configured(), "ai_model": config.ai_model(),
            "claude_configured": config.anthropic_configured(), "claude_model": config.CLAUDE_MODEL,
            "overlay_font": config.overlay_font(),
            "tools": len(registry.all())}


@app.get("/api/tools")
def list_tools() -> list[dict]:
    return registry.describe()


# ---- projects ------------------------------------------------------------------
class CreateProject(BaseModel):
    name: str = Field("Untitled project", max_length=120)


@app.get("/api/projects")
def list_projects() -> list[dict]:
    return [{"id": p.id, "name": p.name, "created_at": p.created_at, "version": p.version,
             "sources": len(p.sources), "duration": round(p.plan.duration(), 2)}
            for p in store.list()]


@app.post("/api/projects")
def create_project(body: CreateProject) -> dict:
    return _project_view(store.create(body.name).id)


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    return _project_view(project_id)


@app.post("/api/projects/{project_id}/sources")
async def upload_source(project_id: str, file: UploadFile = File(...),
                        add_to_timeline: bool = Form(True)) -> dict:
    pdir = store.project_dir(project_id)
    store.load(project_id)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in config.ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{ext}'. Upload MP4, MOV or WebM video, "
                                 "or MP3, WAV, M4A, AAC or OGG audio.")
    sid = new_id("src")
    rel = f"sources/{sid}{ext}"
    dest = pdir / rel
    size = 0
    with open(dest, "wb") as fh:
        while chunk := await file.read(4 * 1024 * 1024):
            size += len(chunk)
            if size > config.MAX_UPLOAD_BYTES:
                fh.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "File is larger than the upload limit.")
            fh.write(chunk)
    try:
        meta = ffmpeg.summarize_probe(ffmpeg.probe(dest))
    except ffmpeg.MediaError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read the file: {exc}") from exc
    dest.chmod(0o444)  # originals are read-only from here on
    source = Source(id=sid, filename=file.filename or dest.name, path=rel, kind=meta["kind"],
                    duration=meta["duration"],
                    width=meta["width"], height=meta["height"], fps=meta["fps"],
                    has_audio=meta["has_audio"], video_codec=meta["video_codec"],
                    audio_codec=meta["audio_codec"], size_bytes=size, rotation=meta["rotation"])
    if source.kind == "video":
        try:
            ffmpeg.extract_frame(dest, min(1.0, meta["duration"] / 2), pdir / "frames" / f"thumb_{sid}.jpg",
                                 width=320)
        except ffmpeg.MediaError:
            pass
    with store.edit(project_id) as project:
        project.sources[sid] = source
    store.log(project_id, "upload", source_id=sid, filename=source.filename, bytes=size, kind=source.kind)
    if add_to_timeline:
        if source.kind == "video":
            registry.execute(project_id, "add_clip", {"source_id": sid}, actor="user")
        elif store.load(project_id).plan.clips:
            registry.execute(project_id, "add_audio", {"source_id": sid}, actor="user")
    _start_prep(project_id, sid)
    return {"source": source.model_dump(), "project": _project_view(project_id)}


def _start_prep(project_id: str, sid: str):
    def work(ctx):
        src = store.load(project_id).sources[sid]
        fields = prep.prepare(store.project_dir(project_id), src, on_note=ctx.note)
        with store.edit(project_id) as project:
            if sid in project.sources:
                for k, v in fields.items():
                    setattr(project.sources[sid], k, v)
        return fields
    return jobs.submit(project_id, "prep", "Preparing media", work)


@app.post("/api/projects/{project_id}/undo")
def undo(project_id: str) -> dict:
    store.step(project_id, -1)
    store.log(project_id, "undo")
    return _project_view(project_id)


@app.post("/api/projects/{project_id}/redo")
def redo(project_id: str) -> dict:
    store.step(project_id, +1)
    store.log(project_id, "redo")
    return _project_view(project_id)


@app.get("/api/projects/{project_id}/captions")
def captions(project_id: str) -> list[dict]:
    """Subtitle words already mapped onto the output timeline, for the live preview."""
    project = store.load(project_id)
    words, _ = compiler.timeline_words(project, project.plan, store.project_dir(project_id))
    return words


# ---- tools ---------------------------------------------------------------------
class ToolCall(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/projects/{project_id}/tools/{tool_name}")
def call_tool(project_id: str, tool_name: str, body: ToolCall) -> dict:
    store.load(project_id)
    tool = registry.get(tool_name)
    if tool is None:
        raise HTTPException(404, f"Unknown tool {tool_name}")
    if tool.long_running:
        job = jobs.submit(project_id, "tool", f"{tool_name}",
                          lambda ctx: _raise_on_error(registry.execute(
                              project_id, tool_name, body.args, actor="user", job=ctx)))
        return {"job": job.model_dump()}
    outcome = registry.execute(project_id, tool_name, body.args, actor="user")
    if not outcome.ok:
        raise HTTPException(400, outcome.error)
    return {"result": outcome.public(), "project": _project_view(project_id)}


def _raise_on_error(outcome):
    if not outcome.ok:
        raise RuntimeError(outcome.error)
    return outcome.public()


@app.post("/api/projects/{project_id}/versions/{version}/restore")
def restore(project_id: str, version: int) -> dict:
    outcome = registry.execute(project_id, "restore_version", {"version": version}, actor="user")
    if not outcome.ok:
        raise HTTPException(400, outcome.error)
    return _project_view(project_id)


# ---- render --------------------------------------------------------------------
class RenderRequest(BaseModel):
    mode: Literal["preview", "export"] = "preview"
    quality: Literal["draft", "standard", "high"] = "standard"


KEEP_PREVIEWS = 3


def _render_job(project_id: str, mode: str, quality: str):
    def fn(ctx):
        project = store.load(project_id)
        pdir = store.project_dir(project_id)
        ctx.note(f"Rendering {mode} of version {project.version}")
        info, warnings = compiler.render(project, pdir, mode, quality, on_progress=ctx.progress)
        for w in warnings:
            ctx.note(w)
        with store.edit(project_id) as p:
            p.renders.append(info)
            previews = [r for r in p.renders if r.mode == "preview"]
            for old in previews[:-KEEP_PREVIEWS]:
                (pdir / old.path).unlink(missing_ok=True)
                p.renders.remove(old)
        store.log(project_id, "render", mode=mode, render_id=info.id, version=info.version)
        return {"render": info.model_dump(), "url": f"/files/{project_id}/{info.path}",
                "warnings": warnings}
    return fn


@app.post("/api/projects/{project_id}/render")
def render(project_id: str, body: RenderRequest) -> dict:
    project = store.load(project_id)
    if not project.plan.clips:
        raise HTTPException(400, "The timeline is empty.")
    kind = f"render_{body.mode}"
    if body.mode == "preview":
        queued = [j for j in jobs.active(project_id, kind) if j.status == "queued"]
        if queued:
            return {"job": queued[0].model_dump()}
    title = "Preview render" if body.mode == "preview" else f"Export ({body.quality})"
    job = jobs.submit(project_id, kind, title, _render_job(project_id, body.mode, body.quality))
    return {"job": job.model_dump()}


# ---- jobs & logs ---------------------------------------------------------------
@app.get("/api/projects/{project_id}/jobs")
def project_jobs(project_id: str) -> list[dict]:
    return [j.model_dump() for j in jobs.for_project(project_id)]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.model_dump()


@app.get("/api/projects/{project_id}/log")
def activity_log(project_id: str, limit: int = 200) -> list[dict]:
    store.load(project_id)
    return store.read_log(project_id, limit)


# ---- chat / agent --------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    require_approval: bool = False


@app.get("/api/projects/{project_id}/chat")
def get_chat(project_id: str) -> list[dict]:
    store.load(project_id)
    return agent.read_chat(project_id)


@app.post("/api/projects/{project_id}/chat")
def post_chat(project_id: str, body: ChatRequest) -> dict:
    store.load(project_id)
    if jobs.active(project_id, "agent"):
        raise HTTPException(409, "The editor is still working on the previous request.")
    agent.append_chat(project_id, "user", body.message)
    job = jobs.submit(project_id, "agent", "AI editor",
                      lambda ctx: agent.run_agent(project_id, body.message, body.require_approval, ctx))
    return {"job": job.model_dump()}


@app.delete("/api/projects/{project_id}/chat")
def clear_chat(project_id: str) -> dict:
    store.load(project_id)
    if jobs.active(project_id, "agent"):
        raise HTTPException(409, "The editor is busy.")
    agent.reset_conversation(project_id)
    return {"ok": True}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    pdir = store.project_dir(project_id)
    store.load(project_id)
    if jobs.active(project_id):
        raise HTTPException(409, "Wait for running jobs to finish.")
    for f in (pdir / "sources").glob("*"):
        f.chmod(0o644)
    shutil.rmtree(pdir)
    return {"ok": True}


# ---- dashboard -----------------------------------------------------------------
# In a deployment the static Next.js build is served from the same origin.
_FRONTEND = Path(config.FRONTEND_DIR)
if (_FRONTEND / "index.html").exists():
    app.mount("/", StaticFiles(directory=_FRONTEND, html=True), name="dashboard")
