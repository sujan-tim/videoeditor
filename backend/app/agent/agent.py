"""The Claude editing agent: a tool-use loop over the controlled tool registry.

The conversation is persisted per project (append-only, exactly as the API
returned it) so revision requests continue the same session.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .. import config
from ..jobs import JobContext
from ..models import new_id
from ..storage import store
from ..tools import registry
from .prompts import SYSTEM_PROMPT

log = logging.getLogger("agent")

_chat_locks: dict[str, threading.Lock] = {}


def _agent_dir(project_id: str) -> Path:
    d = store.project_dir(project_id) / "agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return default
    return default


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


# ---- chat transcript shown in the UI -------------------------------------------
def read_chat(project_id: str) -> list[dict]:
    return _read_json(_agent_dir(project_id) / "chat.json", [])


def append_chat(project_id: str, role: str, text: str = "", **extra: Any) -> dict:
    path = _agent_dir(project_id) / "chat.json"
    lock = _chat_locks.setdefault(project_id, threading.Lock())
    with lock:
        chat = _read_json(path, [])
        entry = {"id": new_id("msg"), "role": role, "text": text, "ts": time.time(), **extra}
        chat.append(entry)
        _write_json(path, chat)
    return entry


def _summarize(data: dict, limit: int = 220) -> str:
    keys = ["message", "removed_count", "removed_seconds", "new_duration", "timeline_duration",
            "count", "issues", "size", "duration", "status", "new_version"]
    picked = {k: data[k] for k in keys if k in data}
    text = json.dumps(picked or data, default=str)
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---- the loop ------------------------------------------------------------------
def _image_block(path: Path) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.b64encode(path.read_bytes()).decode()}}


def _tool_result_block(tool_use_id: str, outcome) -> dict:
    if not outcome.ok:
        return {"type": "tool_result", "tool_use_id": tool_use_id, "is_error": True,
                "content": outcome.error or "error"}
    text = json.dumps(outcome.data, default=str)
    if len(text) > 40000:
        text = text[:40000] + "... (truncated)"
    content: list[dict] = [{"type": "text", "text": text}]
    content += [_image_block(p) for p in outcome.images]
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


def _repair_dangling(messages: list[dict]) -> list[dict]:
    """If a previous run stopped between a tool call and its result, close it out."""
    if messages and messages[-1]["role"] == "assistant":
        pending = [b for b in messages[-1]["content"] if b.get("type") == "tool_use"]
        if pending:
            return [{"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                     "content": "Interrupted before this tool ran."} for b in pending]
    return []


def _client():
    import anthropic

    return anthropic.Anthropic()


def run_agent(project_id: str, user_text: str, require_approval: bool, job: JobContext) -> dict:
    import anthropic

    conv_path = _agent_dir(project_id) / "conversation.json"
    messages: list[dict] = _read_json(conv_path, [])

    with store.edit(project_id) as project:
        project.pending_plan = None

    if not config.anthropic_configured():
        msg = ("Claude is not configured. Set ANTHROPIC_API_KEY in backend/.env (or the environment) "
               "and restart the backend. Manual editing tools still work.")
        append_chat(project_id, "error", msg)
        return {"ok": False, "error": msg}

    content: list[dict] = _repair_dangling(messages)
    text = user_text
    if require_approval:
        text += "\n\n(The user wants to approve a plan before any edits: use propose_plan first.)"
    content.append({"type": "text", "text": text})
    if messages and messages[-1]["role"] == "user":
        # the previous request failed before Claude answered; keep one user turn
        messages[-1]["content"].extend(content)
    else:
        messages.append({"role": "user", "content": content})
    _write_json(conv_path, messages)

    client = _client()
    tools = registry.claude_tools()
    fallbacks = os.environ.get("CLAUDE_FALLBACKS", "default")
    extra: dict[str, Any] = {}
    if fallbacks != "off":
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

    for round_no in range(config.AGENT_MAX_ROUNDS):
        job.note(f"Thinking (step {round_no + 1})")
        try:
            response = client.beta.messages.create(
                model=config.CLAUDE_MODEL,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                tools=tools,
                messages=messages,
                thinking={"type": "adaptive"},
                output_config={"effort": config.CLAUDE_EFFORT},
                cache_control={"type": "ephemeral"},
                **extra,
            )
        except anthropic.AuthenticationError:
            msg = "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY."
            append_chat(project_id, "error", msg)
            return {"ok": False, "error": msg}
        except anthropic.RateLimitError:
            msg = "Claude is rate limited right now; try again in a minute."
            append_chat(project_id, "error", msg)
            return {"ok": False, "error": msg}
        except anthropic.APIStatusError as exc:
            msg = f"Claude API error {exc.status_code}: {exc.message}"
            append_chat(project_id, "error", msg)
            return {"ok": False, "error": msg}
        except anthropic.APIConnectionError:
            msg = "Could not reach the Claude API (network error)."
            append_chat(project_id, "error", msg)
            return {"ok": False, "error": msg}

        blocks = [b.model_dump(mode="json", exclude_none=True) for b in response.content]
        messages.append({"role": "assistant", "content": blocks})
        _write_json(conv_path, messages)

        said = "\n\n".join(b["text"] for b in blocks if b.get("type") == "text" and b.get("text"))
        if said.strip():
            append_chat(project_id, "assistant", said.strip())

        if response.stop_reason == "refusal":
            append_chat(project_id, "error", "Claude declined this request.")
            return {"ok": False, "error": "refusal"}
        if response.stop_reason == "pause_turn":
            continue
        tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
        if response.stop_reason != "tool_use" or not tool_uses:
            if response.stop_reason == "max_tokens":
                append_chat(project_id, "error", "The reply hit the length limit.")
            return {"ok": True, "rounds": round_no + 1}

        results = []
        for tu in tool_uses:
            name, args = tu["name"], tu.get("input") or {}
            job.note(f"Running {name}")
            outcome = registry.execute(project_id, name, args, actor="agent", job=job)
            append_chat(project_id, "tool", tool=name, args=args, ok=outcome.ok,
                        summary=outcome.error if not outcome.ok else _summarize(outcome.data),
                        images=[f"frames/{p.name}" for p in outcome.images])
            results.append(_tool_result_block(tu["id"], outcome))
        messages.append({"role": "user", "content": results})
        _write_json(conv_path, messages)

    append_chat(project_id, "error",
                f"Stopped after {config.AGENT_MAX_ROUNDS} tool steps. Send a follow-up to continue.")
    return {"ok": True, "rounds": config.AGENT_MAX_ROUNDS, "stopped": True}


def reset_conversation(project_id: str) -> None:
    d = _agent_dir(project_id)
    for name in ("conversation.json", "chat.json"):
        (d / name).unlink(missing_ok=True)
