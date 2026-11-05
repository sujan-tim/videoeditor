"""Local project storage with an append-only version history.

Layout of one project:
    data/projects/<id>/project.json     current state
    data/projects/<id>/sources/         uploaded originals (never written after upload)
    data/projects/<id>/versions/N.json  snapshot of the EditPlan at version N
    data/projects/<id>/renders/         preview and export renders
    data/projects/<id>/analysis/        cached probe, silence, scene and transcript data
    data/projects/<id>/frames/          sampled frames
    data/projects/<id>/agent/           Claude conversation + chat transcript
    data/projects/<id>/logs/            activity log (jsonl)
"""
from __future__ import annotations

import json
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import config
from .models import EditPlan, Project, VersionInfo, new_id

SUBDIRS = ["sources", "versions", "renders", "analysis", "frames", "agent", "logs", "cache"]
_ID_RE = re.compile(r"^[a-z]+_[0-9a-f]{8}$")


class NotFound(Exception):
    pass


class ProjectStore:
    def __init__(self, root: Path | None = None):
        self.root = (root or config.DATA_DIR) / "projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    # ---- paths -------------------------------------------------------------
    def project_dir(self, project_id: str) -> Path:
        if not _ID_RE.match(project_id):
            raise NotFound(project_id)
        return self.root / project_id

    def lock(self, project_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(project_id, threading.RLock())

    # ---- CRUD --------------------------------------------------------------
    def create(self, name: str) -> Project:
        project = Project(id=new_id("proj"), name=name.strip() or "Untitled project")
        pdir = self.project_dir(project.id)
        for sub in SUBDIRS:
            (pdir / sub).mkdir(parents=True, exist_ok=True)
        self._commit(project, "Project created", "system", None, None, undo_move=True)
        project.undo_stack, project.undo_index = [project.version], 0
        self.save(project)
        return project

    def list(self) -> list[Project]:
        projects = []
        for pfile in sorted(self.root.glob("*/project.json")):
            try:
                projects.append(Project.model_validate_json(pfile.read_text()))
            except Exception:  # noqa: BLE001 - skip corrupt projects in listings
                continue
        projects.sort(key=lambda p: p.created_at, reverse=True)
        return projects

    def load(self, project_id: str) -> Project:
        pfile = self.project_dir(project_id) / "project.json"
        if not pfile.exists():
            raise NotFound(project_id)
        return Project.model_validate_json(pfile.read_text())

    def save(self, project: Project) -> None:
        pfile = self.project_dir(project.id) / "project.json"
        tmp = pfile.with_suffix(".json.tmp")
        tmp.write_text(project.model_dump_json(indent=2))
        tmp.replace(pfile)

    @contextmanager
    def edit(self, project_id: str) -> Iterator[Project]:
        """Load, yield for mutation, and save under the project's lock."""
        with self.lock(project_id):
            project = self.load(project_id)
            yield project
            self.save(project)

    # ---- versions ----------------------------------------------------------
    def _commit(self, project: Project, label: str, actor: str, tool: str | None,
                args: dict | None, undo_move: bool = False) -> VersionInfo:
        if not undo_move:
            # A fresh edit: drop any redo states and push this one.
            if not project.undo_stack:
                project.undo_stack = [project.version]
                project.undo_index = 0
            project.undo_stack = project.undo_stack[: project.undo_index + 1] + [project.version + 1]
            project.undo_stack = project.undo_stack[-200:]
            project.undo_index = len(project.undo_stack) - 1
        project.version += 1
        info = VersionInfo(version=project.version, label=label, actor=actor, tool=tool, args=args)
        project.history.append(info)
        vfile = self.project_dir(project.id) / "versions" / f"{project.version}.json"
        vfile.write_text(project.plan.model_dump_json(indent=2))
        self.save(project)
        return info

    def commit(self, project: Project, label: str, actor: str, tool: str | None = None,
               args: dict | None = None) -> VersionInfo:
        with self.lock(project.id):
            return self._commit(project, label, actor, tool, args)

    def load_version(self, project_id: str, version: int) -> EditPlan:
        vfile = self.project_dir(project_id) / "versions" / f"{int(version)}.json"
        if int(version) == 0 and not vfile.exists():
            return EditPlan()
        if not vfile.exists():
            raise NotFound(f"version {version}")
        return EditPlan.model_validate_json(vfile.read_text())

    def restore(self, project_id: str, version: int, actor: str = "user") -> Project:
        with self.lock(project_id):
            project = self.load(project_id)
            project.plan = self.load_version(project_id, version)
            self._commit(project, f"Restored version {version}", actor, "restore_version",
                         {"version": version})
            return project

    def step(self, project_id: str, direction: int, actor: str = "user") -> Project:
        """Undo (direction -1) or redo (+1). Each step is recorded as a new version so the
        history stays append-only, while the undo pointer walks the edit states."""
        with self.lock(project_id):
            project = self.load(project_id)
            target = project.undo_index + direction
            if not project.undo_stack or target < 0 or target >= len(project.undo_stack):
                raise NotFound("nothing to " + ("undo" if direction < 0 else "redo"))
            # Label with the edit being undone or redone.
            moved = project.undo_stack[project.undo_index if direction < 0 else target]
            what = next((h.label for h in project.history if h.version == moved), f"version {moved}")
            project.plan = self.load_version(project_id, project.undo_stack[target])
            project.undo_index = target
            self._commit(project, ("Undo: " if direction < 0 else "Redo: ") + what, actor,
                         "undo" if direction < 0 else "redo", None, undo_move=True)
            return project

    # ---- logs --------------------------------------------------------------
    def log(self, project_id: str, event: str, **data: Any) -> None:
        entry = {"ts": time.time(), "event": event, **data}
        try:
            with open(self.project_dir(project_id) / "logs" / "activity.jsonl", "a") as fh:
                fh.write(json.dumps(entry, default=str) + "\n")
        except FileNotFoundError:
            pass

    def read_log(self, project_id: str, limit: int = 200) -> list[dict]:
        lfile = self.project_dir(project_id) / "logs" / "activity.jsonl"
        if not lfile.exists():
            return []
        lines = lfile.read_text().splitlines()[-limit:]
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out


store = ProjectStore()
