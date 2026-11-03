"""The project data model.

The EditPlan is the single source of truth for an edit. It only *references*
source footage by id and time range, so every edit is non-destructive and the
plan can be re-rendered, diffed, versioned, or exported to another editor.
"""
from __future__ import annotations

import time
import uuid
from typing import Literal, Optional

from pydantic import BaseModel, Field


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


class Source(BaseModel):
    id: str
    filename: str
    path: str  # relative to the project directory; the original is never modified
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    size_bytes: int = 0
    rotation: int = 0
    uploaded_at: float = Field(default_factory=time.time)


class Clip(BaseModel):
    id: str = Field(default_factory=lambda: new_id("clip"))
    source_id: str
    start: float  # seconds in the source
    end: float  # seconds in the source
    volume: float = 1.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


Position = Literal["top", "center", "bottom"]


class TextOverlay(BaseModel):
    id: str = Field(default_factory=lambda: new_id("text"))
    text: str
    start: float  # seconds on the output timeline
    end: float
    position: Position = "top"
    font_size: int = 64  # pixels at a 1080-pixel short side; scaled for other sizes
    color: str = "white"
    background: bool = True


class SubtitleSettings(BaseModel):
    enabled: bool = False
    font_size: int = 72
    position: Position = "bottom"
    max_words_per_line: int = 4
    uppercase: bool = False
    highlight_color: str = "#FFD400"


AspectPreset = Literal["original", "9:16", "16:9", "1:1", "4:5"]


class OutputSettings(BaseModel):
    aspect: AspectPreset = "original"
    fit: Literal["pad", "crop"] = "crop"
    resolution: Literal["2160p", "1080p", "720p", "480p"] = "1080p"
    master_volume: float = 1.0
    normalize_audio: bool = False
    platform: Optional[str] = None  # informational: tiktok, reels, shorts, youtube...


class EditPlan(BaseModel):
    clips: list[Clip] = Field(default_factory=list)
    overlays: list[TextOverlay] = Field(default_factory=list)
    subtitles: SubtitleSettings = Field(default_factory=SubtitleSettings)
    output: OutputSettings = Field(default_factory=OutputSettings)

    def duration(self) -> float:
        return sum(c.duration for c in self.clips)


class VersionInfo(BaseModel):
    version: int
    label: str
    actor: Literal["user", "agent", "system"]
    tool: Optional[str] = None
    args: Optional[dict] = None
    created_at: float = Field(default_factory=time.time)


class RenderInfo(BaseModel):
    id: str
    mode: Literal["preview", "export"]
    version: int
    path: str  # relative to the project directory
    width: int
    height: int
    duration: float
    quality: str = "standard"
    created_at: float = Field(default_factory=time.time)
    size_bytes: int = 0


class PendingPlan(BaseModel):
    summary: str
    steps: list[str]
    created_at: float = Field(default_factory=time.time)


class Project(BaseModel):
    id: str
    name: str
    created_at: float = Field(default_factory=time.time)
    sources: dict[str, Source] = Field(default_factory=dict)
    plan: EditPlan = Field(default_factory=EditPlan)
    version: int = 0
    history: list[VersionInfo] = Field(default_factory=list)
    renders: list[RenderInfo] = Field(default_factory=list)
    pending_plan: Optional[PendingPlan] = None
