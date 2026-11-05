"""The free AI editor: plans and applies edits with an open model on Groq's free tier.

Groq's free tier allows about 8,000 tokens per minute, so this agent is built to be frugal:
- the tools are described in a compact one-line-per-tool catalogue, not full JSON schemas;
- each round the model returns one JSON object with a short reply and a batch of tool calls,
  instead of one round trip per tool call;
- the project state is summarized, and only the last few chat turns are remembered.

Every tool call still goes through the same validated registry as the dashboard and the Claude agent,
so nothing the model writes is ever executed as code or shell.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .. import config
from ..ai import groq
from ..jobs import JobContext
from ..storage import store
from ..tools import registry
from ..tools.inspect_tools import project_summary

log = logging.getLogger("agent.groq")

# Tools that need images, or full renders, which this agent does not use.
EXCLUDED = ("sample_frames", "probe_source", "render_preview", "validate_render", "get_project")
HISTORY_TURNS = 8
STATE_LIMIT = 7000  # characters of project state per request
RESULT_LIMIT = 900  # characters per tool result

RULES = """You are the AI editor inside a video editing app. You edit by calling tools. Each turn you get \
the PROJECT STATE (sources, timeline clips, B-roll, audio, text, captions, output) and the user's request.

Answer with ONE JSON object and nothing else:
{"reply": "<short message to the user>", "actions": [{"tool": "<tool name>", "args": {...}}], "done": true|false}

- actions run in order. Use only tools from the catalogue, with argument names exactly as listed \
(? = optional). Ids (clip_..., src_..., text_..., broll_..., audio_...) must come from the state.
- Set "done": false only when you need tool results (detect_silence, transcribe, detect_scenes) or when \
later actions depend on new clip ids; you will then get RESULTS and the new state. Otherwise "done": true.
- Output-timeline seconds and source seconds differ; the state shows both for each clip.
- Cuts and silence removal change clip ids: after them, stop ("done": false) before editing single clips.
- reply: 1-3 plain sentences saying what you did (or will check) and the new length. No JSON, no ids.
- If something is impossible with these tools, say so in reply with no actions.
- Social defaults: TikTok/Reels/Shorts = set_output_format platform; captions: set_subtitles enabled \
with style bold_highlight or karaoke; music ducks under speech automatically.

TOOLS:
"""


def _history_path(project_id: str) -> Path:
    d = store.project_dir(project_id) / "agent"
    d.mkdir(parents=True, exist_ok=True)
    return d / "groq_history.json"


def _read_history(project_id: str) -> list[dict]:
    p = _history_path(project_id)
    try:
        return json.loads(p.read_text()) if p.exists() else []
    except json.JSONDecodeError:
        return []


def _write_history(project_id: str, history: list[dict]) -> None:
    _history_path(project_id).write_text(json.dumps(history[-HISTORY_TURNS * 2:]))


def compact_state(project_id: str) -> str:
    project = store.load(project_id)
    s = project_summary(project, store.project_dir(project_id))
    s.pop("latest_render", None)
    s["recent_history"] = [h["label"] for h in s.get("recent_history", [])[-4:]]
    s["sources"] = [{k: v for k, v in src.items() if k in ("id", "filename", "kind", "duration", "has_audio",
                                                          "has_transcript", "size")} for src in s["sources"]]
    for o in s.get("text_overlays", []):
        for k in ("background", "x", "y", "color", "font_size"):
            o.pop(k, None)
    out = json.dumps(s, separators=(",", ":"), default=str)
    if len(out) > STATE_LIMIT and len(s["clips"]) > 30:
        clips = s["clips"]
        s["clips"] = clips[:15] + [{"note": f"{len(clips) - 25} more clips omitted"}] + clips[-10:]
        out = json.dumps(s, separators=(",", ":"), default=str)
    return out[:STATE_LIMIT * 2]


def _result_text(outcome) -> str:
    if not outcome.ok:
        return f"ERROR: {outcome.error}"
    data = dict(outcome.data)
    if "segments" in data:  # transcripts: keep the words, drop the noise
        lines = [f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in data["segments"]]
        text = "\n".join(lines)
        return "ok: transcript (source seconds):\n" + (text[:3000] + ("\n..." if len(text) > 3000 else ""))
    text = json.dumps(data, separators=(",", ":"), default=str)
    return "ok: " + (text[:RESULT_LIMIT] + "..." if len(text) > RESULT_LIMIT else text)


def _parse(content: str) -> dict:
    content = (content or "").strip()
    if content.startswith("```"):
        content = content.strip("`")
        content = content[content.find("{"):]
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in the reply")
    data = json.loads(content[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("reply is not an object")
    actions = data.get("actions") or []
    if not isinstance(actions, list):
        actions = []
    clean = []
    for a in actions[:20]:
        if isinstance(a, dict) and isinstance(a.get("tool"), str):
            args = a.get("args") if isinstance(a.get("args"), dict) else {}
            clean.append({"tool": a["tool"], "args": args})
    return {"reply": str(data.get("reply") or "").strip(), "actions": clean, "done": data.get("done", True) is not False}


def run(project_id: str, user_text: str, require_approval: bool, job: JobContext, append_chat, summarize) -> dict:
    if not groq.configured():
        msg = ("The AI editor is not set up. Create a free key at console.groq.com/keys and set GROQ_API_KEY "
               "in your Render environment (or backend/.env), then restart. Manual editing still works.")
        append_chat(project_id, "error", msg)
        return {"ok": False, "error": msg}

    history = _read_history(project_id)
    system = RULES + registry.compact_catalog(EXCLUDED)
    request = user_text
    if require_approval:
        request += "\n(The user wants to approve first: respond only with a propose_plan action and done true.)"
    turn: list[dict] = [{"role": "user", "content": f"PROJECT STATE:\n{compact_state(project_id)}\n\nREQUEST: {request}"}]
    final_reply = ""
    applied: list[str] = []

    def waiting(seconds: float):
        job.note(f"Free tier rate limit: waiting {seconds:.0f}s")

    for round_no in range(config.GROQ_MAX_ROUNDS):
        job.note(f"Thinking (step {round_no + 1})")
        messages = [{"role": "system", "content": system}, *history, *turn]
        parsed = None
        for attempt in range(2):
            try:
                resp = groq.chat(messages, config.GROQ_MODEL, reasoning_effort=config.GROQ_REASONING, on_wait=waiting)
            except groq.GroqError as exc:
                msg = {401: "The Groq API key was rejected. Check GROQ_API_KEY.",
                       429: "Groq's free tier is busy right now (rate limit). Wait a minute and send again."}.get(
                    exc.status, f"Groq error: {exc}")
                append_chat(project_id, "error", msg)
                return {"ok": False, "error": msg}
            content = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
            try:
                parsed = _parse(content)
                break
            except (ValueError, json.JSONDecodeError):
                messages = messages + [{"role": "assistant", "content": content[:2000]},
                                       {"role": "user", "content": "That was not valid JSON. Reply with only the JSON object."}]
        if parsed is None:
            append_chat(project_id, "error", "The AI reply could not be understood. Try rephrasing the request.")
            return {"ok": False, "error": "bad json"}

        turn.append({"role": "assistant", "content": json.dumps(parsed, separators=(",", ":"))})
        if parsed["reply"]:
            final_reply = parsed["reply"]

        results, errors = [], 0
        for a in parsed["actions"]:
            name, args = a["tool"], a["args"]
            if name in EXCLUDED and name != "get_project":
                outcome_text = f"ERROR: {name} is not available here."
                errors += 1
                results.append(f"{name}: {outcome_text}")
                continue
            if name == "get_project":
                results.append("get_project: see PROJECT STATE below")
                continue
            job.note(f"Running {name}")
            outcome = registry.execute(project_id, name, args, actor="agent", job=job)
            append_chat(project_id, "tool", tool=name, args=args, ok=outcome.ok,
                        summary=outcome.error if not outcome.ok else summarize(outcome.data), images=[])
            if outcome.ok and outcome.version:
                applied.append(name)
            if not outcome.ok:
                errors += 1
            results.append(f"{name}: {_result_text(outcome)}")
            if name == "propose_plan" and outcome.ok:
                break

        stop = (parsed["done"] and not errors) or not parsed["actions"] or any(
            a["tool"] == "propose_plan" for a in parsed["actions"])
        if stop or round_no == config.GROQ_MAX_ROUNDS - 1:
            break
        turn.append({"role": "user", "content": "RESULTS:\n" + "\n".join(results)
                     + f"\n\nPROJECT STATE:\n{compact_state(project_id)}\n\nContinue. Fix any errors."})

    if final_reply:
        append_chat(project_id, "assistant", final_reply)
    elif applied:
        append_chat(project_id, "assistant", f"Done: {', '.join(dict.fromkeys(applied))}.")
    history += [{"role": "user", "content": user_text},
                {"role": "assistant", "content": (final_reply or "(no reply)")
                 + (f" [applied: {', '.join(dict.fromkeys(applied))}]" if applied else "")}]
    _write_history(project_id, history)
    return {"ok": True, "applied": applied}


def reset(project_id: str) -> None:
    _history_path(project_id).unlink(missing_ok=True)
