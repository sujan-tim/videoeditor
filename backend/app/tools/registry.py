"""The controlled editing-tool registry.

Every capability the agent (or the UI) can use is a registered Tool with a
Pydantic input model. Arguments are validated before anything runs, unknown
fields are rejected, every call is logged, and mutating tools commit a new
plan version so any change can be undone. Nothing here executes shell
commands or code taken from model output.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import BaseModel, ConfigDict, ValidationError

from ..jobs import JobContext
from ..models import Project
from ..storage import ProjectStore, store

log = logging.getLogger("tools")


class ToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolError(Exception):
    """An expected failure with a message safe to show the user and the model."""


@dataclass
class ToolResult:
    data: dict[str, Any]
    label: Optional[str] = None  # for mutating tools: the history label of the new version
    images: list[Path] = field(default_factory=list)
    save: bool = False  # persist non-versioned project changes (renders, pending plan)


@dataclass
class ToolContext:
    project: Project
    project_dir: Path
    actor: str
    store: ProjectStore
    job: Optional[JobContext] = None

    def note(self, message: str) -> None:
        if self.job:
            self.job.note(message)


@dataclass
class Tool:
    name: str
    description: str
    input_model: type[ToolInput]
    handler: Callable[[ToolContext, Any], ToolResult]
    category: str  # inspect, edit, render, control
    mutates: bool = False
    long_running: bool = False

    def input_schema(self) -> dict:
        schema = self.input_model.model_json_schema()
        return _clean_schema(schema)


@dataclass
class ToolOutcome:
    ok: bool
    tool: str
    data: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    version: Optional[int] = None
    images: list[Path] = field(default_factory=list)

    def public(self) -> dict:
        return {"ok": self.ok, "tool": self.tool, "data": self.data, "error": self.error,
                "version": self.version, "images": [str(p.name) for p in self.images]}


def _clean_schema(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _clean_schema(v) for k, v in node.items() if k != "title"}
    if isinstance(node, list):
        return [_clean_schema(v) for v in node]
    return node


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors()[:6]:
        loc = ".".join(str(x) for x in err.get("loc", ())) or "input"
        parts.append(f"{loc}: {err.get('msg')}")
    return "Invalid arguments: " + "; ".join(parts)


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, name: str, description: str, input_model: type[ToolInput], *,
                 category: str, mutates: bool = False, long_running: bool = False):
        def decorator(fn: Callable[[ToolContext, Any], ToolResult]):
            if name in self._tools:
                raise ValueError(f"duplicate tool {name}")
            self._tools[name] = Tool(name, description, input_model, fn, category, mutates,
                                     long_running)
            return fn
        return decorator

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def claude_tools(self) -> list[dict]:
        return [{"name": t.name, "description": t.description, "input_schema": t.input_schema()}
                for t in self._tools.values()]

    def compact_catalog(self, exclude: tuple[str, ...] = ()) -> str:
        """One line per tool: name(arg:type=default, ...) - first sentence of the description.
        Small enough for models with tight token budgets (Groq free tier)."""
        lines = []
        for t in self._tools.values():
            if t.name in exclude:
                continue
            schema = t.input_schema()
            props = schema.get("properties", {})
            required = set(schema.get("required", []))
            args = []
            for name, spec in props.items():
                args.append(name + ("" if name in required else "?") + ":" + _short_type(spec, schema))
            desc = t.description.split(". ")[0].rstrip(".")
            lines.append(f"{t.name}({', '.join(args)}) - {desc}")
        return "\n".join(lines)

    def describe(self) -> list[dict]:
        return [{"name": t.name, "description": t.description, "category": t.category,
                 "mutates": t.mutates, "long_running": t.long_running,
                 "input_schema": t.input_schema()} for t in self._tools.values()]

    def execute(self, project_id: str, name: str, raw_args: Optional[dict], actor: str,
                job: Optional[JobContext] = None, st: ProjectStore = store) -> ToolOutcome:
        started = time.time()
        tool = self._tools.get(name)
        if tool is None:
            return ToolOutcome(False, name, error=f"Unknown tool '{name}'.")
        try:
            args = tool.input_model.model_validate(raw_args or {})
        except ValidationError as exc:
            msg = _format_validation_error(exc)
            st.log(project_id, "tool_rejected", tool=name, actor=actor, args=raw_args, error=msg)
            return ToolOutcome(False, name, error=msg)

        args_dump = args.model_dump(exclude_none=True)
        try:
            with st.lock(project_id):
                project = st.load(project_id)
                ctx = ToolContext(project, st.project_dir(project_id), actor, st, job)
                result = tool.handler(ctx, args)
                version = None
                if tool.mutates and result.label:
                    version = st.commit(project, result.label, actor, name, args_dump).version
                elif result.save:
                    st.save(project)
        except ToolError as exc:
            st.log(project_id, "tool_error", tool=name, actor=actor, args=args_dump, error=str(exc))
            return ToolOutcome(False, name, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - report, never crash the agent loop
            log.exception("tool %s crashed", name)
            st.log(project_id, "tool_error", tool=name, actor=actor, args=args_dump, error=repr(exc))
            return ToolOutcome(False, name, error=f"{type(exc).__name__}: {exc}")

        st.log(project_id, "tool_call", tool=name, actor=actor, args=args_dump,
               version=version, ms=int((time.time() - started) * 1000))
        data = dict(result.data)
        if version is not None:
            data["new_version"] = version
        return ToolOutcome(True, name, data=data, version=version, images=result.images)


def _short_type(spec: dict, root: dict) -> str:
    if "$ref" in spec:
        ref = spec["$ref"].split("/")[-1]
        spec = root.get("$defs", {}).get(ref, {})
    if "anyOf" in spec:
        parts = [_short_type(s, root) for s in spec["anyOf"] if s.get("type") != "null"]
        return "|".join(parts) if parts else "null"
    if "enum" in spec:
        return "|".join(str(v) for v in spec["enum"])
    if "const" in spec:
        return str(spec["const"])
    typ = spec.get("type", "any")
    rng = ""
    if "minimum" in spec or "maximum" in spec or "exclusiveMinimum" in spec:
        lo = spec.get("minimum", spec.get("exclusiveMinimum", ""))
        hi = spec.get("maximum", "")
        rng = f"[{lo}..{hi}]"
    return {"number": "num", "integer": "int", "boolean": "bool", "string": "str"}.get(typ, typ) + rng


registry = ToolRegistry()
