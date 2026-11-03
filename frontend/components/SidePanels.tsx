"use client";

import { useState } from "react";
import { api, fileUrl, fmtBytes, fmtTime, type Job, type LogEntry, type Output, type Project } from "@/lib/api";
import { Badge, Button, Progress } from "./ui";

const ago = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts * 1000).toLocaleString();
};

export function HistoryPanel({ project, onRestore }: { project: Project; onRestore: (v: number) => void }) {
  return (
    <ul className="divide-y divide-zinc-800 text-xs">
      {[...project.history].reverse().map((v) => (
        <li key={v.version} className="flex items-center gap-2 px-3 py-1.5">
          <span className="w-7 font-mono text-zinc-500">v{v.version}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-zinc-200" title={v.label}>
              {v.label}
            </div>
            <div className="text-[10px] text-zinc-500">
              <Badge tone={v.actor === "agent" ? "violet" : v.actor === "user" ? "sky" : "zinc"}>{v.actor === "agent" ? "AI" : v.actor}</Badge> {ago(v.created_at)}
            </div>
          </div>
          {v.version === project.version ? (
            <Badge tone="green">current</Badge>
          ) : (
            <Button variant="ghost" onClick={() => onRestore(v.version)}>
              Restore
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const PLATFORMS: { id: string; label: string; aspect: Output["aspect"] }[] = [
  { id: "tiktok", label: "TikTok", aspect: "9:16" },
  { id: "instagram_reels", label: "Reels", aspect: "9:16" },
  { id: "youtube_shorts", label: "Shorts", aspect: "9:16" },
  { id: "youtube", label: "YouTube", aspect: "16:9" },
  { id: "instagram_feed", label: "IG feed", aspect: "4:5" },
  { id: "square", label: "Square", aspect: "1:1" },
  { id: "original", label: "Original", aspect: "original" },
];

export function ExportPanel({
  project,
  jobs,
  run,
  onError,
  onChange,
}: {
  project: Project;
  jobs: Job[];
  run: (tool: string, args?: Record<string, unknown>) => Promise<void>;
  onError: (e: string) => void;
  onChange: () => void;
}) {
  const out = project.plan.output;
  const [quality, setQuality] = useState("standard");
  const [vol, setVol] = useState(out.master_volume);
  const exporting = jobs.find((j) => j.kind === "render_export" && (j.status === "queued" || j.status === "running"));
  const exports = project.renders.filter((r) => r.mode === "export").reverse();
  const [w, h] = project.output_size;

  return (
    <div className="space-y-4 p-3 text-xs text-zinc-300">
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">Format</div>
        <div className="grid grid-cols-4 gap-1">
          {PLATFORMS.map((p) => (
            <Button key={p.id} variant={out.platform === p.id ? "primary" : "default"} onClick={() => run("set_output_format", { platform: p.id })} title={p.aspect}>
              {p.label}
            </Button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={out.aspect} onChange={(e) => run("set_output_format", { aspect: e.target.value })} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-1">
            {["original", "9:16", "16:9", "1:1", "4:5"].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select value={out.fit} onChange={(e) => run("set_output_format", { fit: e.target.value })} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-1">
            <option value="crop">fill (crop)</option>
            <option value="pad">fit (black bars)</option>
          </select>
          <select value={out.resolution} onChange={(e) => run("set_output_format", { resolution: e.target.value })} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-1">
            {["2160p", "1080p", "720p", "480p"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <span className="text-zinc-500">
            {w}×{h}
          </span>
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">Audio</div>
        <div className="flex items-center gap-2">
          master
          <input type="range" min={0} max={2} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} className="w-28 accent-violet-500" />
          <span className="w-8 font-mono">{vol.toFixed(2)}</span>
          <Button onClick={() => run("set_audio", { master_volume: vol })}>Set</Button>
        </div>
        <label className="mt-2 flex items-center gap-1.5">
          <input type="checkbox" checked={out.normalize_audio} onChange={(e) => run("set_audio", { normalize: e.target.checked })} className="accent-violet-500" />
          Normalize loudness to -14 LUFS
        </label>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">Export</div>
        <div className="flex items-center gap-2">
          <select value={quality} onChange={(e) => setQuality(e.target.value)} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-1">
            <option value="draft">Draft (fast)</option>
            <option value="standard">Standard</option>
            <option value="high">High</option>
          </select>
          <Button
            variant="primary"
            disabled={!project.timeline.length || !!exporting}
            onClick={() =>
              api
                .render(project.id, "export", quality)
                .then(onChange)
                .catch((e) => onError(e.message))
            }
          >
            {exporting ? "Exporting…" : `Export MP4 (${fmtTime(project.duration)})`}
          </Button>
        </div>
        {exporting && (
          <div className="mt-2">
            <Progress value={exporting.progress} />
          </div>
        )}
        <ul className="mt-3 space-y-1">
          {exports.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1">
              <span className="font-mono text-zinc-500">v{r.version}</span>
              <span>
                {r.width}×{r.height} · {fmtTime(r.duration)} · {fmtBytes(r.size_bytes)} · {r.quality}
              </span>
              <a href={fileUrl(r.url)} download className="ml-auto text-violet-300 hover:underline">
                Download
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ActivityPanel({ jobs, log }: { jobs: Job[]; log: LogEntry[] }) {
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="space-y-1.5">
        {jobs.map((j) => (
          <div key={j.id} className="rounded border border-zinc-800 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <Badge tone={j.status === "done" ? "green" : j.status === "error" ? "red" : "amber"}>{j.status}</Badge>
              <span className="text-zinc-200">{j.title}</span>
              <span className="ml-auto text-[10px] text-zinc-500">{ago(j.created_at)}</span>
            </div>
            {(j.status === "running" || j.status === "queued") && (
              <div className="mt-1">
                <Progress value={j.progress} />
              </div>
            )}
            {j.messages.length > 0 && <div className="mt-1 truncate text-[10px] text-zinc-500">{j.messages.at(-1)}</div>}
            {j.error && <div className="mt-1 whitespace-pre-wrap text-[10px] text-red-300">{j.error}</div>}
          </div>
        ))}
        {!jobs.length && <div className="text-zinc-500">No jobs yet.</div>}
      </div>
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">Processing log</div>
        <ul className="space-y-0.5 font-mono text-[10px] text-zinc-500">
          {[...log].reverse().map((e, i) => (
            <li key={i} className={e.event.includes("error") || e.event.includes("rejected") ? "text-red-300" : ""}>
              {new Date(e.ts * 1000).toLocaleTimeString()} {e.event} {e.tool ?? ""} {e.actor ? `(${e.actor})` : ""} {e.error ? `: ${e.error}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
