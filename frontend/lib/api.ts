// Empty = same origin (the deployed single-service build). Set NEXT_PUBLIC_API_URL for `npm run dev`.
function defaultApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  // `npm run dev` serves on :3000 while the backend runs on :8000
  if (typeof window !== "undefined" && window.location.port === "3000") return `${window.location.protocol}//${window.location.hostname}:8000`;
  return "";
}
export const API_BASE = defaultApiBase().replace(/\/$/, "");

export type Source = {
  id: string;
  filename: string;
  path: string;
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  video_codec?: string;
  audio_codec?: string;
  size_bytes: number;
  has_transcript: boolean;
  url: string;
  thumbnail_url: string | null;
  proxy_url: string | null;
  filmstrip_url: string | null;
  filmstrip_interval: number;
  waveform_url: string | null;
  waveform_rate: number;
};

export const LOOKS = ["none", "bw", "warm", "cool", "vintage", "vivid", "faded", "cinematic", "dramatic"] as const;
export type Look = (typeof LOOKS)[number];
export const TRANSITIONS = ["fade", "dissolve", "fadeblack", "fadewhite", "slideleft", "slideright", "slideup", "wipeleft", "wiperight", "circleopen", "zoomin", "smoothleft"] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export type Clip = {
  id: string;
  source_id: string;
  start: number;
  end: number;
  volume: number;
  speed: number;
  look: Look;
  adjust: { brightness: number; contrast: number; saturation: number };
  zoom: number;
  focus_x: number;
  focus_y: number;
  transition_in: { type: TransitionType; duration: number } | null;
  fade_in: number;
  fade_out: number;
};

export type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right";

export type Broll = {
  id: string;
  source_id: string;
  timeline_start: number;
  start: number;
  end: number;
  mode: "full" | "pip";
  pip_corner: Corner;
  pip_scale: number;
  volume: number;
  look: Look;
  fade: number;
};

export type AudioItem = {
  id: string;
  source_id: string;
  timeline_start: number;
  start: number;
  end: number;
  volume: number;
  fade_in: number;
  fade_out: number;
  duck: boolean;
  role: "music" | "voiceover" | "sfx";
};

export type PlacedClip = {
  index: number;
  clip_id: string;
  source_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  volume: number;
  speed: number;
  overlap_in: number;
};

export type Position = "top" | "center" | "bottom";
export const TEXT_STYLES = ["box", "outline", "shadow", "plain", "highlight"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];
export const TEXT_ANIMATIONS = ["none", "fade", "slide_up", "pop", "typewriter"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

export type TextOverlay = {
  id: string;
  text: string;
  start: number;
  end: number;
  position: Position;
  x: number | null;
  y: number | null;
  font_size: number;
  color: string;
  background: boolean;
  style: TextStyle;
  animation: TextAnimation;
};

export const CAPTION_STYLES = ["bold_highlight", "karaoke", "boxed", "clean", "minimal"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export type Subtitles = {
  enabled: boolean;
  style: CaptionStyle;
  font_size: number;
  position: Position;
  max_words_per_line: number;
  uppercase: boolean;
  highlight_color: string;
};

export type Output = {
  aspect: "original" | "9:16" | "16:9" | "1:1" | "4:5";
  fit: "pad" | "crop" | "blur";
  resolution: "2160p" | "1080p" | "720p" | "480p";
  master_volume: number;
  normalize_audio: boolean;
  platform?: string | null;
  background_color?: string;
};

export type Plan = { clips: Clip[]; broll: Broll[]; audio: AudioItem[]; overlays: TextOverlay[]; subtitles: Subtitles; output: Output };

export type Word = { start: number; end: number; word: string };

export type Version = { version: number; label: string; actor: "user" | "agent" | "system"; tool?: string; created_at: number };

export type Render = {
  id: string;
  mode: "preview" | "export";
  version: number;
  path: string;
  width: number;
  height: number;
  duration: number;
  quality: string;
  created_at: number;
  size_bytes: number;
  url: string;
};

export type Project = {
  id: string;
  name: string;
  sources: Record<string, Source>;
  plan: Plan;
  version: number;
  history: Version[];
  renders: Render[];
  pending_plan: { summary: string; steps: string[] } | null;
  timeline: PlacedClip[];
  duration: number;
  output_size: [number, number];
  preview_size: [number, number];
  can_undo: boolean;
  can_redo: boolean;
};

export type ProjectListItem = { id: string; name: string; created_at: number; version: number; sources: number; duration: number };

export type Job = {
  id: string;
  kind: string;
  title: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  messages: string[];
  result: unknown;
  error: string | null;
  created_at: number;
  finished_at: number | null;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  ts: number;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  images?: string[];
};

export type Health = {
  ok: boolean;
  ffmpeg: string;
  whisper_installed: boolean;
  ai_configured: boolean;
  ai_provider: string;
  ai_model: string;
  desktop?: boolean;
  tools: number;
};

export type LogEntry = { ts: number; event: string; tool?: string; actor?: string; error?: string; [k: string]: unknown };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  session: () => request<{ auth_required: boolean; authenticated: boolean }>("/api/session"),
  login: (password: string) => request<{ ok: boolean }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  health: () => request<Health>("/api/health"),
  listProjects: () => request<ProjectListItem[]>("/api/projects"),
  createProject: (name: string) => request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  jobs: (id: string) => request<Job[]>(`/api/projects/${id}/jobs`),
  log: (id: string) => request<LogEntry[]>(`/api/projects/${id}/log?limit=120`),
  chat: (id: string) => request<ChatMessage[]>(`/api/projects/${id}/chat`),
  sendChat: (id: string, message: string, require_approval: boolean) =>
    request<{ job: Job }>(`/api/projects/${id}/chat`, { method: "POST", body: JSON.stringify({ message, require_approval }) }),
  clearChat: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/chat`, { method: "DELETE" }),
  tool: (id: string, name: string, args: Record<string, unknown> = {}) =>
    request<{ result?: unknown; project?: Project; job?: Job }>(`/api/projects/${id}/tools/${name}`, {
      method: "POST",
      body: JSON.stringify({ args }),
    }),
  saveSettings: (groq_api_key: string) => request<{ ok: boolean; ai_configured: boolean }>("/api/settings", { method: "POST", body: JSON.stringify({ groq_api_key }) }),
  undo: (id: string) => request<Project>(`/api/projects/${id}/undo`, { method: "POST" }),
  redo: (id: string) => request<Project>(`/api/projects/${id}/redo`, { method: "POST" }),
  captions: (id: string) => request<Word[]>(`/api/projects/${id}/captions`),
  restore: (id: string, version: number) => request<Project>(`/api/projects/${id}/versions/${version}/restore`, { method: "POST" }),
  render: (id: string, mode: "preview" | "export", quality = "standard") =>
    request<{ job: Job }>(`/api/projects/${id}/render`, { method: "POST", body: JSON.stringify({ mode, quality }) }),
};

export function upload(projectId: string, file: File, onProgress: (p: number) => void, addToTimeline = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("add_to_timeline", addToTimeline ? "true" : "false");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/projects/${projectId}/sources`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      try {
        reject(new Error(JSON.parse(xhr.responseText).detail));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed: backend not reachable"));
    xhr.send(form);
  });
}

export const fileUrl = (path: string) => `${API_BASE}${path}`;

export function fmtTime(t: number): string {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
