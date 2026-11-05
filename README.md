---
title: AI Video Editor
emoji: 🎬
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 8000
pinned: false
---

# AI Video Editor

Upload footage, edit it on a multi-track timeline with an instant in-browser preview, or describe the
edit in plain language and let the AI editor apply it with real tools (FFmpeg, Whisper, PySceneDetect).
Every edit is non-destructive, versioned and undoable, and exports for TikTok, Reels, Shorts or YouTube.
The AI runs on Groq's free tier, so the whole app can be used without paying for anything.

## What works today

| Area | Features |
| --- | --- |
| Footage | Upload MP4/MOV/WebM video and MP3/WAV/M4A/AAC/OGG audio; originals stored read-only; light proxies, filmstrips and waveforms generated in the background |
| Live preview | Plays the edit instantly in the browser (canvas): cuts, speed, color looks, zoom/reframe, transitions, B-roll, picture-in-picture, animated text, styled captions and music ducking, with no render wait. Drag text on the video to place it |
| Timeline | Text, B-roll, video and music tracks; drag to reorder, drag edges to trim, drag B-roll/music/text to move; snapping, zoom, filmstrips, waveforms; split, delete, undo/redo; keyboard shortcuts |
| Editing | Trim, split, cut ranges, reorder, combine sources, speed 0.25x-4x (pitch kept), 9 color looks plus brightness/contrast/saturation, zoom and focus point for reframing, fades, 12 transitions |
| Audio | Per-clip volume and fades, background music / voice-over / sound effects with fades and automatic ducking under speech, loudness normalization |
| Text and captions | Text with box/outline/shadow/highlight styles and fade/slide/pop/typewriter animations; auto captions in 5 styles (bold highlight, karaoke, boxed, clean, minimal) that follow every cut |
| Formats | 9:16, 16:9, 4:5, 1:1, original; fill (crop), fit with black bars, or fit over a blurred background; 480p to 2160p |
| AI editor | Free: an open model on Groq plans and applies edits through the same validated tools (Claude is an optional paid alternative). Optional "show me the plan first" approval |

## Keyboard shortcuts

Space play/pause · S split at playhead · Delete remove selection · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo ·
Left/Right one frame (Shift = one second) · Home/End · Esc deselect

## Requirements

- Python 3.11+ and Node.js 20+
- FFmpeg 6+ with libass and libfreetype on your PATH (`ffmpeg -filters | grep -E "ass|drawtext"`)
  - macOS: `brew install ffmpeg` · Ubuntu: `sudo apt install ffmpeg` · Windows: `winget install ffmpeg`
- A free Groq API key for the AI editor and fast captions (https://console.groq.com/keys). Everything else works without it
- Without a Groq key, captions use local faster-whisper, which downloads its model from huggingface.co on first use

## Setup

```bash
# backend
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # then put your free key in GROQ_API_KEY
uvicorn app.main:app --port 8000

# frontend (second terminal)
cd frontend
npm install
cp .env.local.example .env.local     # only needed if the backend is not on localhost:8000
npm run dev                          # http://localhost:3000
```

Open http://localhost:3000, drop a video in the Media panel, and try:
"Remove unnecessary pauses, add subtitles, make the video 9:16, and prepare it for Instagram Reels."

Run the backend tests (they generate their own footage and fake the AI, so no key or network is needed):

```bash
cd backend && python -m pytest -q
```

## Deploy as a website

The repo builds into one Docker image: FastAPI serves the API and the static dashboard from the
same address, with FFmpeg included. Set a password so strangers cannot use your copy.

**Render (free tier):**
1. Push this folder to a GitHub repo.
2. On render.com: New > Blueprint, connect GitHub, pick the repo. It reads `render.yaml`.
3. Fill in `GROQ_API_KEY` (free) and `APP_PASSWORD` when asked, then Apply. The first build takes about 10 minutes.
   Already deployed? Add `GROQ_API_KEY` under your service's Environment tab and redeploy.
4. Open the `https://<name>.onrender.com` link and sign in.

The free plan has 0.1 CPU and 512 MB of RAM: fine for short clips, slow for long ones. It sleeps after
15 minutes without visits (the next visit takes about a minute to wake), and files are wiped on every
restart or deploy, so download exports right away. For real use, move the same image to a bigger
plan or a free Oracle Cloud VM (volume at `/data`, port `$PORT`).

Local check of the deployed layout without Docker: `cd frontend && npm run build`, then start the backend
as usual and open http://localhost:8000.

## How it fits together

```
Next.js dashboard ──REST──> FastAPI ──> Tool registry ──> EditPlan (JSON, versioned)
                                 │            │                 │
                       AI agent (Groq/Claude) │                 └──> Renderer: plan -> FFmpeg filter graph
                       (Messages API,         └──> Analysis: ffprobe, silencedetect, Whisper, PySceneDetect
                        tool calling)
```

- **EditPlan** (`backend/app/models.py`): clips reference source ranges; overlays, subtitles and
  output settings sit beside them. Subtitles are derived from transcripts at render time, so they
  stay in sync after any cut.
- **Tool registry** (`backend/app/tools/`): every capability is a Pydantic input model plus a
  handler. Inputs are validated (unknown fields rejected), each call is logged to
  `data/projects/<id>/logs/activity.jsonl`, and mutating tools commit a new version. The UI and
  the AI call the same tools; nothing runs shell commands built from model output.
- **Renderer** (`backend/app/render/compiler.py`): builds one FFmpeg command from the plan.
  User text reaches FFmpeg only through files (`textfile=`, an ASS subtitle file), never through
  the filter graph string.
- **Live preview** (`frontend/lib/engine.ts`, `frontend/components/LivePlayer.tsx`): draws the plan on
  a canvas from the sources (or their proxies) using the same timing, framing, look, transition, text
  and caption rules as the renderer, so editing never waits for FFmpeg.
- **Agent** (`backend/app/agent/`): by default `groq_agent.py`, built for Groq's free tier
  (about 8,000 tokens a minute): a compact tool catalogue, one JSON reply per round with a batch of
  tool calls, a summarized project state and short memory. Set `AI_PROVIDER=anthropic` to use the
  Claude tool-use loop in `agent.py` instead.

### Adding a tool

```python
# backend/app/tools/edit_tools.py
class MuteArgs(ToolInput):
    clip_id: str

@registry.register("mute_clip", "Silence one clip.", MuteArgs, category="edit", mutates=True)
def mute_clip(ctx: ToolContext, a: MuteArgs) -> ToolResult:
    ...  # change ctx.project.plan, then:
    return ToolResult({"clip_id": a.clip_id}, label="Muted clip")
```

The AI, the API (`POST /api/projects/{id}/tools/mute_clip`) and the history pick it up
automatically. If it needs new render behaviour, extend `compile_plan`.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | FFmpeg, Whisper and AI provider status |
| GET | `/api/tools` | Tool list with JSON schemas |
| GET/POST | `/api/projects` | List or create projects |
| GET | `/api/projects/{id}` | Project, plan, timeline, history, renders |
| POST | `/api/projects/{id}/sources` | Upload a video (multipart `file`) |
| POST | `/api/projects/{id}/tools/{name}` | Run a tool (`{"args": {...}}`); long tools return a job |
| POST | `/api/projects/{id}/versions/{n}/restore` | Restore a version |
| POST | `/api/projects/{id}/undo`, `/api/projects/{id}/redo` | Step through edits |
| GET | `/api/projects/{id}/captions` | Caption words on the output timeline (for the live preview) |
| POST | `/api/projects/{id}/render` | `{"mode": "preview" \| "export", "quality": "draft" \| "standard" \| "high"}` |
| GET/POST/DELETE | `/api/projects/{id}/chat` | Read, send to, or reset the AI editor |
| GET | `/api/projects/{id}/jobs`, `/api/jobs/{job_id}`, `/api/projects/{id}/log` | Status and logs |
| GET | `/files/{id}/...` | Sources, renders and frames (supports range requests) |

## Configuration

All settings are environment variables (or `backend/.env`); see `backend/.env.example`.
The API key is only read by the backend and never sent to the browser.

## Known limits

- One shared password, not user accounts: everyone who signs in sees the same projects.
- Single server: jobs run in a thread pool in the API process and are not resumed after a restart.
- Whisper runs on CPU by default; set `WHISPER_DEVICE=cuda` with a GPU, or `WHISPER_MODEL=base` for speed.
- Previews re-render the whole timeline at 540p; very long projects will want segment caching.
- The free Groq models cannot look at video frames, so framing decisions by the AI use the focus
  controls and the transcript rather than vision. Claude (paid) can sample frames.
- Groq's free tier allows a few requests a minute; long multi-step requests may pause briefly for the
  rate limit, which the editor waits out automatically.
- The live preview is close to the export but not pixel identical (fonts and color math differ
  slightly); "Rendered file" shows the exact FFmpeg result.

## Next steps (stage 2: a smarter AI editor)

Highlight and hook detection from the transcript, filler-word removal ("um", "uh"), face-tracking
auto-reframe, music beat sync, automatic B-roll suggestions, a self-review pass on the rendered file,
an MCP server over the same registry, and a DaVinci Resolve handoff.
