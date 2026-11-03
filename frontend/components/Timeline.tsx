"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtTime, type Project } from "@/lib/api";
import { Badge, Button } from "./ui";

const COLORS = ["bg-violet-600/70 border-violet-400", "bg-sky-600/70 border-sky-400", "bg-emerald-600/70 border-emerald-400", "bg-amber-600/70 border-amber-400", "bg-pink-600/70 border-pink-400"];

type Props = {
  project: Project;
  playhead: number;
  onSeek: (t: number) => void;
  run: (tool: string, args?: Record<string, unknown>) => Promise<void>;
};

export function Timeline({ project, playhead, onSeek, run }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const duration = Math.max(project.duration, 1);
  const pps = ((width - 16) / duration) * zoom;
  const colorOf = useMemo(() => {
    const ids = Object.keys(project.sources);
    return (sid: string) => COLORS[Math.max(0, ids.indexOf(sid)) % COLORS.length];
  }, [project.sources]);

  const ticks = useMemo(() => {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 70) ?? 600;
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(t);
    return out;
  }, [pps, duration]);

  const clip = project.timeline.find((c) => c.clip_id === selected);
  const overlay = project.plan.overlays.find((o) => o.id === selectedText);
  const src = clip ? project.sources[clip.source_id] : undefined;

  function seekFromEvent(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration, (e.clientX - rect.left + e.currentTarget.scrollLeft - 8) / pps)));
  }

  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/70">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Timeline</span>
        <span className="mr-2 font-mono text-xs text-zinc-300">
          {fmtTime(playhead)} / {fmtTime(project.duration)}
        </span>
        <Button onClick={() => run("split_clip", { timeline_time: playhead })} disabled={!project.timeline.length}>
          Split at playhead
        </Button>
        <Button onClick={() => run("remove_silences")} disabled={!project.timeline.length}>
          Remove pauses
        </Button>
        <Button onClick={() => run("set_subtitles", { enabled: !project.plan.subtitles.enabled })} disabled={!project.timeline.length}>
          {project.plan.subtitles.enabled ? "Subtitles off" : "Auto subtitles"}
        </Button>
        <Button
          onClick={() => run("add_text_overlay", { text: "Your title", start: playhead, end: Math.min(playhead + 3, duration), position: "top" })}
          disabled={!project.timeline.length}
        >
          + Text
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
          zoom
          <input type="range" min={1} max={8} step={0.5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-violet-500" />
        </div>
      </div>

      <div ref={box} className="relative select-none overflow-x-auto px-2 pb-2" onClick={seekFromEvent}>
        <div style={{ width: duration * pps + 8 }} className="relative">
          <div className="relative h-5 border-b border-zinc-800 text-[10px] text-zinc-500">
            {ticks.map((t) => (
              <span key={t} className="absolute top-1 border-l border-zinc-700 pl-1" style={{ left: t * pps }}>
                {fmtTime(t).replace(/\.0$/, "")}
              </span>
            ))}
          </div>
          <Track label="Video">
            {project.timeline.map((c) => (
              <div
                key={c.clip_id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(c.clip_id);
                  setSelectedText(null);
                  onSeek(c.timeline_start);
                }}
                title={`${project.sources[c.source_id]?.filename} ${fmtTime(c.source_start)}-${fmtTime(c.source_end)}`}
                className={`absolute top-1 h-10 cursor-pointer overflow-hidden rounded border px-1 text-[10px] text-white ${colorOf(c.source_id)} ${
                  selected === c.clip_id ? "ring-2 ring-white" : ""
                }`}
                style={{ left: c.timeline_start * pps, width: Math.max(2, (c.timeline_end - c.timeline_start) * pps - 1) }}
              >
                <div className="truncate font-medium">{project.sources[c.source_id]?.filename}</div>
                <div className="truncate opacity-80">
                  {fmtTime(c.source_start)}–{fmtTime(c.source_end)}
                  {c.volume !== 1 ? ` · ${c.volume}x` : ""}
                </div>
              </div>
            ))}
          </Track>
          <Track label="Text overlays" small>
            {project.plan.overlays.map((o) => (
              <div
                key={o.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedText(o.id);
                  setSelected(null);
                }}
                className={`absolute top-1 h-5 cursor-pointer truncate rounded border border-fuchsia-400 bg-fuchsia-700/60 px-1 text-[10px] text-white ${
                  selectedText === o.id ? "ring-2 ring-white" : ""
                }`}
                style={{ left: o.start * pps, width: Math.max(4, (o.end - o.start) * pps) }}
              >
                {o.text}
              </div>
            ))}
          </Track>
          <Track label="Subtitles" small>
            {project.plan.subtitles.enabled && (
              <div className="absolute top-1 h-5 rounded border border-teal-500 bg-teal-800/50 px-1 text-[10px] leading-5 text-teal-100" style={{ left: 0, width: duration * pps }}>
                Auto subtitles from transcript, follow every cut
              </div>
            )}
          </Track>
          <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-red-500" style={{ left: playhead * pps }} />
        </div>
      </div>

      {clip && src && (
        <ClipInspector
          key={clip.clip_id + clip.source_start + clip.source_end + clip.volume}
          clip={clip}
          sourceDuration={src.duration}
          count={project.timeline.length}
          run={run}
          onClose={() => setSelected(null)}
        />
      )}
      {overlay && <TextInspector key={JSON.stringify(overlay)} overlay={overlay} run={run} onClose={() => setSelectedText(null)} />}
      {!clip && !overlay && (
        <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
          Tracks: video clips, text overlays, subtitles. Click a block to edit it; click the ruler to move the playhead.{" "}
          {project.plan.subtitles.enabled && <Badge tone="sky">subtitles on</Badge>}
        </div>
      )}
    </div>
  );
}

function Track({ label, small, children }: { label: string; small?: boolean; children: React.ReactNode }) {
  return (
    <div title={label} className={`relative border-b border-zinc-800/70 ${small ? "h-7" : "h-12"}`}>
      {children}
    </div>
  );
}

function ClipInspector({
  clip,
  sourceDuration,
  count,
  run,
  onClose,
}: {
  clip: Project["timeline"][number];
  sourceDuration: number;
  count: number;
  run: Props["run"];
  onClose: () => void;
}) {
  const [start, setStart] = useState(clip.source_start);
  const [end, setEnd] = useState(clip.source_end);
  const [vol, setVol] = useState(clip.volume);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-300">
      <Badge tone="violet">Clip {clip.index + 1}</Badge>
      <label className="flex items-center gap-1">
        in
        <input type="number" step={0.1} min={0} max={sourceDuration} value={start} onChange={(e) => setStart(Number(e.target.value))} className="w-20 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5" />
      </label>
      <label className="flex items-center gap-1">
        out
        <input type="number" step={0.1} min={0} max={sourceDuration} value={end} onChange={(e) => setEnd(Number(e.target.value))} className="w-20 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5" />
      </label>
      <Button onClick={() => run("trim_clip", { clip_id: clip.clip_id, start, end })}>Apply trim</Button>
      <label className="ml-2 flex items-center gap-1">
        volume
        <input type="range" min={0} max={2} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} className="w-24 accent-violet-500" />
        <span className="w-8 font-mono">{vol.toFixed(2)}</span>
      </label>
      <Button onClick={() => run("set_clip_volume", { clip_id: clip.clip_id, volume: vol })}>Set</Button>
      <div className="ml-auto flex gap-1">
        <Button onClick={() => run("move_clip", { clip_id: clip.clip_id, index: Math.max(0, clip.index - 1) })} disabled={clip.index === 0}>
          ←
        </Button>
        <Button onClick={() => run("move_clip", { clip_id: clip.clip_id, index: clip.index + 1 })} disabled={clip.index >= count - 1}>
          →
        </Button>
        <Button variant="danger" onClick={() => run("delete_clip", { clip_id: clip.clip_id }).then(onClose)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function TextInspector({ overlay, run, onClose }: { overlay: Project["plan"]["overlays"][number]; run: Props["run"]; onClose: () => void }) {
  const [o, setO] = useState(overlay);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-300">
      <Badge tone="violet">Text</Badge>
      <input value={o.text} onChange={(e) => setO({ ...o, text: e.target.value })} className="w-56 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5" />
      <label className="flex items-center gap-1">
        from
        <input type="number" step={0.1} value={o.start} onChange={(e) => setO({ ...o, start: Number(e.target.value) })} className="w-16 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5" />
      </label>
      <label className="flex items-center gap-1">
        to
        <input type="number" step={0.1} value={o.end} onChange={(e) => setO({ ...o, end: Number(e.target.value) })} className="w-16 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5" />
      </label>
      <select value={o.position} onChange={(e) => setO({ ...o, position: e.target.value as typeof o.position })} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5">
        <option value="top">top</option>
        <option value="center">center</option>
        <option value="bottom">bottom</option>
      </select>
      <input type="color" value={o.color.startsWith("#") ? o.color : "#ffffff"} onChange={(e) => setO({ ...o, color: e.target.value })} className="h-6 w-8 rounded bg-transparent" />
      <label className="flex items-center gap-1">
        size
        <input type="number" min={12} max={200} value={o.font_size} onChange={(e) => setO({ ...o, font_size: Number(e.target.value) })} className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5" />
      </label>
      <Button
        onClick={() =>
          run("update_text_overlay", { overlay_id: o.id, text: o.text, start: o.start, end: o.end, position: o.position, color: o.color, font_size: o.font_size })
        }
      >
        Apply
      </Button>
      <Button variant="danger" className="ml-auto" onClick={() => run("remove_text_overlay", { overlay_id: o.id }).then(onClose)}>
        Delete
      </Button>
    </div>
  );
}
