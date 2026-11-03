"""Background jobs (renders, transcription, agent runs) with progress and logs."""
from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field

from .models import new_id
from .storage import store

log = logging.getLogger("jobs")


class Job(BaseModel):
    id: str = Field(default_factory=lambda: new_id("job"))
    project_id: str
    kind: str  # render_preview, render_export, transcribe, tool, agent
    title: str
    status: str = "queued"  # queued, running, done, error
    progress: float = 0.0
    messages: list[str] = Field(default_factory=list)
    result: Optional[Any] = None
    error: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    finished_at: Optional[float] = None


class JobContext:
    def __init__(self, job: Job):
        self.job = job

    def progress(self, value: float) -> None:
        self.job.progress = round(max(0.0, min(1.0, value)), 3)

    def note(self, message: str) -> None:
        self.job.messages.append(message)
        if len(self.job.messages) > 200:
            del self.job.messages[:50]


class JobManager:
    def __init__(self, workers: int = 3):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, project_id: str, kind: str, title: str,
               fn: Callable[[JobContext], Any]) -> Job:
        job = Job(project_id=project_id, kind=kind, title=title)
        with self._lock:
            self._jobs[job.id] = job
        store.log(project_id, "job_queued", job_id=job.id, kind=kind, title=title)

        def _run():
            job.status = "running"
            ctx = JobContext(job)
            try:
                job.result = fn(ctx)
                job.status = "done"
                job.progress = 1.0
                store.log(project_id, "job_done", job_id=job.id, kind=kind)
            except Exception as exc:  # noqa: BLE001 - surface every failure to the UI
                job.status = "error"
                job.error = str(exc)
                log.error("job %s failed: %s\n%s", job.id, exc, traceback.format_exc())
                store.log(project_id, "job_error", job_id=job.id, kind=kind, error=str(exc))
            finally:
                job.finished_at = time.time()

        self._pool.submit(_run)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def for_project(self, project_id: str, limit: int = 30) -> list[Job]:
        jobs = [j for j in self._jobs.values() if j.project_id == project_id]
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    def active(self, project_id: str, kind: Optional[str] = None) -> list[Job]:
        return [j for j in self._jobs.values() if j.project_id == project_id
                and j.status in ("queued", "running") and (kind is None or j.kind == kind)]


jobs = JobManager()
