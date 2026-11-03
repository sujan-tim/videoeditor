# AI Video Editor

Upload footage, describe the edit in plain language, and let Claude plan and apply it with real
editing tools (FFmpeg, Whisper, PySceneDetect). Every edit is non-destructive and versioned, so you
can preview, revise, or roll back at any point, and export for TikTok, Reels, Shorts or YouTube.

Architecture and roadmap: see the "AI Video Editor: Architecture and Roadmap" doc in the project
(https://claude.ai/artifact/25wX2a92NZq7T8WYPmfJUu).

## What works today

| Area | Features |
| --- | --- |
| Footage | Upload MP4/MOV/M4V (drag and drop), metadata and thumbnails, originals stored read-only |
| Editing | Trim, split, cut a time range, delete, reorder, combine clips from several sources, per-clip and master volume, loudness normalization |
| Analysis | Silence detection, Whisper transcription with word timestamps, scene detection, frame sampling (Claude sees the frames), render validation (duration, streams, black frames, clipping) |
| Automatic edits | Remove pauses, burned-in subtitles with the spoken word highlighted, text overlays |
| Formats | 9:16 (TikTok, Reels, Shorts), 16:9 (YouTube), 4:5, 1:1, original; crop to fill or letterbox; 480p to 2160p |
| AI editor | Chat with Claude, optional "show me the plan first" approval, tool calls visible in chat, revisions continue the same conversation |
| Dashboard | Preview player, timeline with clip/text/subtitle tracks and inspectors, version history with restore, export settings and downloads, job status and processing log |

## Requirements

- Python 3.11+ and Node.js 20+
- FFmpeg 6+ with libass and libfreetype on your PATH (`ffmpeg -filters | grep -E "ass|drawtext"`)
  - macOS: `brew install ffmpeg` · Ubuntu: `sudo apt install ffmpeg` · Windows: `winget install ffmpeg`
- An Anthropic API key for the AI editor (everything else works without one)
- Internet on first transcription: faster-whisper downloads its model (about 500 MB for `small`) from huggingface.co

## Setup

```bash
# backend
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # then put your key in ANTHROPIC_API_KEY
uvicorn app.main:app --port 8000

# frontend (second terminal)
cd frontend
npm install
cp .env.local.example .env.local     # only needed if the backend is not on localhost:8000
npm run dev                          # http://localhost:3000
```

Open http://localhost:3000, drop a video in the Media panel, and try:
"Remove unnecessary pauses, add subtitles, make the video 9:16, and prepare it for Instagram Reels."

Run the backend tests (they generate their own footage and do not call Claude):

```bash
cd backend && python -m pytest -q
```

## How it fits together

```
Next.js dashboard ──REST──> FastAPI ──> Tool registry ──> EditPlan (JSON, versioned)
                                 │            │                 │
                       Claude agent loop      │                 └──> Renderer: plan -> FFmpeg filter graph
                       (Messages API,         └──> Analysis: ffprobe, silencedetect, Whisper, PySceneDetect
                        tool calling)
```

- **EditPlan** (`backend/app/models.py`): clips reference source ranges; overlays, subtitles and
  output settings sit beside them. Subtitles are derived from transcripts at render time, so they
  stay in sync after any cut.
- **Tool registry** (`backend/app/tools/`): every capability is a Pydantic input model plus a
  handler. Inputs are validated (unknown fields rejected), each call is logged to
  `data/projects/<id>/logs/activity.jsonl`, and mutating tools commit a new version. The UI and
  Claude call the same tools; nothing runs shell commands built from model output.
- **Renderer** (`backend/app/render/compiler.py`): builds one FFmpeg command from the plan.
  User text reaches FFmpeg only through files (`textfile=`, an ASS subtitle file), never through
  the filter graph string.
- **Agent** (`backend/app/agent/`): a manual tool-use loop on `claude-opus-5-5` with adaptive
  thinking. The conversation is saved per project, so revision requests keep context.

### Adding a tool

```python
# backend/app/tools/edit_tools.py
class SpeedArgs(ToolInput):
    clip_id: str
    factor: float = Field(..., ge=0.25, le=4)

@registry.register("set_clip_speed", "Speed a clip up or down.", SpeedArgs, category="edit", mutates=True)
def set_clip_speed(ctx: ToolContext, a: SpeedArgs) -> ToolResult:
    ...  # change ctx.project.plan, then:
    return ToolResult({"clip_id": a.clip_id}, label=f"Speed {a.factor}x")
```

Claude, the API (`POST /api/projects/{id}/tools/set_clip_speed`) and the history pick it up
automatically. If it needs new render behaviour, extend `compile_plan`.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | FFmpeg, Whisper and Claude status |
| GET | `/api/tools` | Tool list with JSON schemas |
| GET/POST | `/api/projects` | List or create projects |
| GET | `/api/projects/{id}` | Project, plan, timeline, history, renders |
| POST | `/api/projects/{id}/sources` | Upload a video (multipart `file`) |
| POST | `/api/projects/{id}/tools/{name}` | Run a tool (`{"args": {...}}`); long tools return a job |
| POST | `/api/projects/{id}/versions/{n}/restore` | Restore a version |
| POST | `/api/projects/{id}/render` | `{"mode": "preview" \| "export", "quality": "draft" \| "standard" \| "high"}` |
| GET/POST/DELETE | `/api/projects/{id}/chat` | Read, send to, or reset the AI editor |
| GET | `/api/projects/{id}/jobs`, `/api/jobs/{job_id}`, `/api/projects/{id}/log` | Status and logs |
| GET | `/files/{id}/...` | Sources, renders and frames (supports range requests) |

## Configuration

All settings are environment variables (or `backend/.env`); see `backend/.env.example`.
The API key is only read by the backend and never sent to the browser.

## Known limits

- Single-user and local: jobs run in a thread pool in the API process and are not resumed after a restart.
- Whisper runs on CPU by default; set `WHISPER_DEVICE=cuda` with a GPU, or `WHISPER_MODEL=base` for speed.
- Previews re-render the whole timeline at 540p; very long projects will want segment caching.
- Frames Claude looks at are kept in the conversation history, which raises token use on long sessions.

## Next steps (Phase 5)

MCP server over the same registry (so Claude Desktop and Claude Code can drive projects), a
DaVinci Resolve handoff, filler-word removal from transcripts, style presets, highlight
extraction, B-roll and music with beat sync, and subject-tracking auto-reframe.
