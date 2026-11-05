"""The project data model.

The EditPlan is the single source of truth for an edit. It only *references*
source media by id and time range, so every edit is non-destructive and the
plan can be re-rendered, previewed live in the browser, diffed, versioned, or
exported to another editor.

Timeline layout:
    clips      main video track, played in order; a clip's transition overlaps the previous clip
    broll      cutaways / picture-in-picture placed at absolute timeline times over the main track
    audio      music, voice-over and sound effects placed at absolute timeline times
    overlays   text placed at absolute timeline times
    subtitles  burned-in captions derived from transcripts at render time
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
    kind: Literal["video", "audio", "image"] = "video"
    duration: float
    width: int = 0
    height: int = 0
    fps: float = 0
    has_audio: bool = True
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    size_bytes: int = 0
    rotation: int = 0
    uploaded_at: float = Field(default_factory=time.time)
    proxy_path: Optional[str] = None  # small H.264 copy for smooth in-browser playback
    filmstrip_path: Optional[str] = None  # horizontal sprite of thumbnails
    filmstrip_interval: float = 0.0  # seconds between filmstrip frames
    waveform_path: Optional[str] = None  # JSON list of peaks (0..1), waveform_rate per second
    waveform_rate: int = 0


Look = Literal["none", "bw", "warm", "cool", "vintage", "vivid", "faded", "cinematic", "dramatic"]
TransitionType = Literal["fade", "fadeblack", "fadewhite", "dissolve", "slideleft", "slideright",
                         "slideup", "wipeleft", "wiperight", "circleopen", "zoomin", "smoothleft"]


class Transition(BaseModel):
    type: TransitionType = "fade"
    duration: float = 0.5


class ColorAdjust(BaseModel):
    brightness: float = 0.0  # -1..1
    contrast: float = 0.0  # -1..1
    saturation: float = 0.0  # -1..1


class Clip(BaseModel):
    id: str = Field(default_factory=lambda: new_id("clip"))
    source_id: str
    start: float  # seconds in the source
    end: float  # seconds in the source
    volume: float = 1.0
    speed: float = 1.0
    look: Look = "none"
    adjust: ColorAdjust = Field(default_factory=ColorAdjust)
    zoom: float = 1.0  # punch-in, 1 = none
    focus_x: float = 0.5  # 0..1, where the frame is centred when cropping or zooming
    focus_y: float = 0.5
    transition_in: Optional[Transition] = None  # transition from the previous clip
    fade_in: float = 0.0  # fade from black at the very start (first clip) or audio/video fade
    fade_out: float = 0.0

    @property
    def source_duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def duration(self) -> float:
        """Duration on the output timeline (after speed change)."""
        return self.source_duration / max(self.speed, 0.01)


class BrollClip(BaseModel):
    id: str = Field(default_factory=lambda: new_id("broll"))
    source_id: str
    timeline_start: float
    start: float  # in the source
    end: float
    mode: Literal["full", "pip"] = "full"
    pip_corner: Literal["top_left", "top_right", "bottom_left", "bottom_right"] = "top_right"
    pip_scale: float = 0.35
    volume: float = 0.0  # b-roll is usually silent under the main audio
    look: Look = "none"
    fade: float = 0.2

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


class AudioClip(BaseModel):
    id: str = Field(default_factory=lambda: new_id("audio"))
    source_id: str
    timeline_start: float
    start: float  # in the source
    end: float
    volume: float = 0.6
    fade_in: float = 1.0
    fade_out: float = 1.5
    duck: bool = True  # lower automatically while the main track has speech
    role: Literal["music", "voiceover", "sfx"] = "music"

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


Position = Literal["top", "center", "bottom"]
TextStyle = Literal["box", "outline", "shadow", "plain", "highlight"]
TextAnimation = Literal["none", "fade", "slide_up", "pop", "typewriter"]


class TextOverlay(BaseModel):
    id: str = Field(default_factory=lambda: new_id("text"))
    text: str
    start: float  # seconds on the output timeline
    end: float
    position: Position = "top"
    x: Optional[float] = None  # 0..1 centre; overrides position when set
    y: Optional[float] = None
    font_size: int = 64  # pixels at a 1080-pixel short side; scaled for other sizes
    color: str = "white"
    background: bool = True  # kept for compatibility; style decides the look
    style: TextStyle = "box"
    animation: TextAnimation = "fade"


CaptionStyle = Literal["bold_highlight", "clean", "boxed", "karaoke", "minimal"]


class SubtitleSettings(BaseModel):
    enabled: bool = False
    style: CaptionStyle = "bold_highlight"
    font_size: int = 72
    position: Position = "bottom"
    max_words_per_line: int = 4
    uppercase: bool = False
    highlight_color: str = "#FFD400"


AspectPreset = Literal["original", "9:16", "16:9", "1:1", "4:5"]


class OutputSettings(BaseModel):
    aspect: AspectPreset = "original"
    fit: Literal["pad", "crop", "blur"] = "crop"  # blur = fit with a blurred copy behind
    resolution: Literal["2160p", "1080p", "720p", "480p"] = "1080p"
    master_volume: float = 1.0
    normalize_audio: bool = False
    platform: Optional[str] = None  # informational: tiktok, reels, shorts, youtube...
    background_color: str = "black"


class EditPlan(BaseModel):
    clips: list[Clip] = Field(default_factory=list)
    broll: list[BrollClip] = Field(default_factory=list)
    audio: list[AudioClip] = Field(default_factory=list)
    overlays: list[TextOverlay] = Field(default_factory=list)
    subtitles: SubtitleSettings = Field(default_factory=SubtitleSettings)
    output: OutputSettings = Field(default_factory=OutputSettings)

    def transition_overlap(self, i: int) -> float:
        """Seconds clip i overlaps the previous clip (0 for the first clip)."""
        if i == 0 or i >= len(self.clips):
            return 0.0
        t = self.clips[i].transition_in
        if t is None:
            return 0.0
        prev, cur = self.clips[i - 1], self.clips[i]
        return max(0.0, min(t.duration, prev.duration / 2, cur.duration / 2))

    def duration(self) -> float:
        total = 0.0
        for i, c in enumerate(self.clips):
            total += c.duration - self.transition_overlap(i)
        return total


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
    # undo/redo walks this list of versions; a new edit drops everything after undo_index
    undo_stack: list[int] = Field(default_factory=list)
    undo_index: int = -1
    renders: list[RenderInfo] = Field(default_factory=list)
    pending_plan: Optional[PendingPlan] = None
