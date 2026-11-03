export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export type Source = {
  id: string;
  filename: string;
  path: string;
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
  thumbnail_url: string;
};

export type Clip = { id: string; source_id: string; start: number; end: number; volume: number };

export type PlacedClip = {
  index: number;
  clip_id: string;
  source_id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  volume: number;
};

export type Position = "top" | "center" | "bottom";

export type TextOverlay = {
  id: string;
  text: string;
  start: number;
  end: number;
  position: Position;
  font_size: number;
  color: string;
  background: boolean;
};

export type Subtitles = {
  enabled: boolean;
  font_size: number;
  position: Position;
  max_words_per_line: number;
  uppercase: boolean;
  highlight_color: string;
};

export type Output = {
  aspect: "original" | "9:16" | "16:9" | "1:1" | "4:5";
  fit: "pad" | "crop";
  resolution: "2160p" | "1080p" | "720p" | "480p";
  master_volume: number;
  normalize_audio: boolean;
  platform?: string | null;
};

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
  plan: { clips: Clip[]; overlays: TextOverlay[]; subtitles: Subtitles; output: Output };
  version: number;
  history: Version[];
  renders: Render[];
  pending_plan: { summary: string; steps: string[] } | null;
  timeline: PlacedClip[];
  duration: number;
  output_size: [number, number];
  preview_size: [number, number];
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

export type Health = { ok: boolean; ffmpeg: string; whisper_installed: boolean; claude_configured: boolean; claude_model: string; tools: number };

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
  restore: (id: string, version: number) => request<Project>(`/api/projects/${id}/versions/${version}/restore`, { method: "POST" }),
  render: (id: string, mode: "preview" | "export", quality = "standard") =>
    request<{ job: Job }>(`/api/projects/${id}/render`, { method: "POST", body: JSON.stringify({ mode, quality }) }),
};

export function upload(projectId: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("add_to_timeline", "true");
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
