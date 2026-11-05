"use client";

// Multi-track timeline: drag clips to reorder, drag edges to trim, drag B-roll, music and text to move
// them, with snapping, filmstrips and waveforms. Every drag previews live and commits one undoable edit
// when you let go.
import { useEffect, useMemo, useRef, useState } from "react";
import { fileUrl, type Plan, type Project } from "@/lib/api";
import { clock, useClock } from "@/lib/clock";
import { clipDuration, fmtTC, placeClips } from "@/lib/engine";
import { Button } from "./ui";

export type Selection = { kind: "clip" | "broll" | "audio" | "text"; id: string } | null;

type Props = {
  project: Project;
  plan: Plan;
  selection: Selection;
  onSelect: (s: Selection) => void;
  run: (tool: string, args?: Record<string, unknown>) => Promise<boolean>;
  setDraft: (p: Plan | null) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
};

const GUTTER = 76;
const PAD = 12;
const TRACK = { text: 26, broll: 38, video: 66, audio: 38 };
const SOURCE_TONES = ["#7c3aed", "#0284c7", "#059669", "#d97706", "#db2777", "#4f46e5"];

type Drag = {
  kind: "clip" | "broll" | "audio" | "text";
  id: string;
  mode: "move" | "l" | "r";
  x0: number;
  base: Plan;
  moved: boolean;
  result?: Record<string, unknown>;
  insertAt?: number;
  dx?: number;
};

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function Timeline({ project, plan, selection, onSelect, run, setDraft, onUndo, onRedo, onDelete }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  useEffect(() => {
    if (!scroller.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, []);

  const placed = useMemo(() => placeClips(plan), [plan]);
  const duration = placed.length ? placed[placed.length - 1].end : 0;
  const span = Math.max(duration, 5);
  const pps = ((width - GUTTER - PAD * 2 - 40) / span) * zoom;
  const contentW = Math.max(width - GUTTER, span * pps + PAD * 2 + 40);
  const X = (t: number) => PAD + t * pps;
  const tone = useMemo(() => {
    const ids = Object.keys(project.sources);
    return (sid: string) => SOURCE_TONES[Math.max(0, ids.indexOf(sid)) % SOURCE_TONES.length];
  }, [project.sources]);

  const ticks = useMemo(() => {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 64) ?? 600;
    const out: number[] = [];
    for (let t = 0; t <= span + 1e-6; t += step) out.push(t);
    return out;
  }, [pps, span]);

  // ---- snapping ----
  const snapPoints = (excludeId: string) => {
    const pts = [0, clock.time];
    placed.forEach((p) => p.clip.id !== excludeId && pts.push(p.start, p.end));
    plan.broll.forEach((b) => b.id !== excludeId && pts.push(b.timeline_start, b.timeline_start + b.end - b.start));
    plan.audio.forEach((a) => a.id !== excludeId && pts.push(a.timeline_start, a.timeline_start + a.end - a.start));
    plan.overlays.forEach((o) => o.id !== excludeId && pts.push(o.start, o.end));
    return pts;
  };
  const snapTo = (t: number, pts: number[]) => {
    if (!snap) return { t, hit: null as number | null };
    const tol = 8 / pps;
    let best: number | null = null;
    for (const p of pts) if (Math.abs(p - t) < tol && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    return { t: best ?? t, hit: best };
  };
  const [snapLine, setSnapLine] = useState<number | null>(null);

  // ---- drag handling ----
  function startDrag(e: React.PointerEvent, kind: Drag["kind"], id: string, mode: Drag["mode"]) {
    e.stopPropagation();
    if (e.button !== 0) return;
    onSelect({ kind, id });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, id, mode, x0: e.clientX, base: clone(plan), moved: false });
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dxPx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dxPx) < 3) return;
    const dt = dxPx / pps;
    const next = clone(d.base);
    const pts = snapPoints(d.id);
    let hit: number | null = null;
    let result: Record<string, unknown> | undefined;
    let insertAt: number | undefined;

    if (d.kind === "clip") {
      const i = next.clips.findIndex((c) => c.id === d.id);
      const c = next.clips[i];
      const src = project.sources[c.source_id];
      const basePlaced = placeClips(d.base)[i];
      if (d.mode === "move") {
        // reorder: find where the dragged clip's centre lands
        const centre = (basePlaced.start + basePlaced.end) / 2 + dt;
        const others = placeClips(d.base).filter((p) => p.index !== i);
        insertAt = others.filter((p) => (p.start + p.end) / 2 < centre).length;
        result = { tool: "move_clip", args: { clip_id: c.id, index: insertAt } };
        setDrag({ ...d, moved: true, insertAt, dx: dxPx, result });
        setSnapLine(null);
        return;
      }
      if (d.mode === "l") {
        const edge = snapTo(basePlaced.start + dt, pts);
        hit = edge.hit;
        const ns = Math.min(c.end - 0.1, Math.max(0, c.start + (edge.t - basePlaced.start) * c.speed));
        c.start = Math.round(ns * 1000) / 1000;
        result = { tool: "update_clip", args: { clip_id: c.id, start: c.start } };
      } else {
        const edge = snapTo(basePlaced.end + dt, pts);
        hit = edge.hit;
        const ne = Math.max(c.start + 0.1, Math.min(src?.duration ?? c.end, c.end + (edge.t - basePlaced.end) * c.speed));
        c.end = Math.round(ne * 1000) / 1000;
        result = { tool: "update_clip", args: { clip_id: c.id, end: c.end } };
      }
    } else if (d.kind === "broll" || d.kind === "audio") {
      const list = d.kind === "broll" ? next.broll : next.audio;
      const it = list.find((x) => x.id === d.id)!;
      const src = project.sources[it.source_id];
      const len = it.end - it.start;
      if (d.mode === "move") {
        const a = snapTo(it.timeline_start + dt, pts);
        const b = snapTo(it.timeline_start + dt + len, pts);
        let ts = it.timeline_start + dt;
        if (a.hit !== null) {
          ts = a.t;
          hit = a.hit;
        } else if (b.hit !== null) {
          ts = b.t - len;
          hit = b.hit;
        }
        it.timeline_start = Math.max(0, Math.round(ts * 1000) / 1000);
        result = { timeline_start: it.timeline_start };
      } else if (d.mode === "l") {
        const edge = snapTo(it.timeline_start + dt, pts);
        hit = edge.hit;
        let delta = edge.t - it.timeline_start;
        delta = Math.max(-it.start, Math.max(-it.timeline_start, Math.min(delta, len - 0.2)));
        it.timeline_start = Math.round((it.timeline_start + delta) * 1000) / 1000;
        it.start = Math.round((it.start + delta) * 1000) / 1000;
        result = { timeline_start: it.timeline_start, start: it.start };
      } else {
        const edge = snapTo(it.timeline_start + len + dt, pts);
        hit = edge.hit;
        const ne = Math.max(it.start + 0.2, Math.min(src?.duration ?? it.end, it.start + (edge.t - it.timeline_start)));
        it.end = Math.round(ne * 1000) / 1000;
        result = { end: it.end };
      }
      result = d.kind === "broll" ? { tool: "update_broll", args: { broll_id: it.id, ...result } } : { tool: "update_audio", args: { audio_id: it.id, ...result } };
    } else {
      const ov = next.overlays.find((o) => o.id === d.id)!;
      const len = ov.end - ov.start;
      if (d.mode === "move") {
        const a = snapTo(ov.start + dt, pts);
        const b = snapTo(ov.end + dt, pts);
        let s = ov.start + dt;
        if (a.hit !== null) {
          s = a.t;
          hit = a.hit;
        } else if (b.hit !== null) {
          s = b.t - len;
          hit = b.hit;
        }
        s = Math.max(0, s);
        ov.start = Math.round(s * 1000) / 1000;
        ov.end = Math.round((s + len) * 1000) / 1000;
      } else if (d.mode === "l") {
        const edge = snapTo(ov.start + dt, pts);
        hit = edge.hit;
        ov.start = Math.round(Math.max(0, Math.min(ov.end - 0.2, edge.t)) * 1000) / 1000;
      } else {
        const edge = snapTo(ov.end + dt, pts);
        hit = edge.hit;
        ov.end = Math.round(Math.max(ov.start + 0.2, edge.t) * 1000) / 1000;
      }
      result = { tool: "update_text_overlay", args: { overlay_id: ov.id, start: ov.start, end: ov.end } };
    }
    setSnapLine(hit);
    setDraft(next);
    setDrag({ ...d, moved: true, result });
  }

  async function onUp() {
    const d = dragRef.current;
    setDrag(null);
    setSnapLine(null);
    if (!d || !d.moved || !d.result) {
      setDraft(null);
      return;
    }
    const { tool, args } = d.result as { tool: string; args: Record<string, unknown> };
    if (tool === "move_clip" && d.insertAt === d.base.clips.findIndex((c) => c.id === d.id)) {
      setDraft(null);
      return;
    }
    await run(tool, args);
    setDraft(null);
  }

  // ---- scrubbing on the ruler ----
  const scrubbing = useRef(false);
  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left - GUTTER + scroller.current!.scrollLeft - PAD) / pps));
  };

  const sel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const top = { ruler: 0, text: 24, broll: 24 + TRACK.text + 4, video: 24 + TRACK.text + TRACK.broll + 8, audio: 24 + TRACK.text + TRACK.broll + TRACK.video + 12 };
  const totalH = top.audio + TRACK.audio + 8;
  const playheadIn = placed.find((p) => clock.time > p.start + 0.05 && clock.time < p.end - 0.05);

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950" data-testid="timeline">
      <div className="flex items-center gap-1.5 border-b border-zinc-800/80 px-3 py-1.5">
        <Button variant="ghost" title="Undo (Ctrl/Cmd+Z)" onClick={onUndo} disabled={!project.can_undo} aria-label="Undo">
          ↶ Undo
        </Button>
        <Button variant="ghost" title="Redo (Ctrl/Cmd+Shift+Z)" onClick={onRedo} disabled={!project.can_redo} aria-label="Redo">
          ↷ Redo
        </Button>
        <div className="mx-1 h-4 w-px bg-zinc-800" />
        <Button variant="ghost" title="Split at playhead (S)" onClick={() => run("split_clip", { timeline_time: clock.time })} disabled={!playheadIn}>
          ✂ Split
        </Button>
        <Button variant="ghost" title="Delete selection (Delete)" onClick={onDelete} disabled={!selection}>
          🗑 Delete
        </Button>
        <Button variant="ghost" title="Add text at the playhead (T)" disabled={!placed.length} onClick={() => run("add_text_overlay", { text: "Your title", start: clock.time, end: Math.min(clock.time + 3, Math.max(duration, clock.time + 0.5)), position: "center", style: "outline", animation: "pop" })}>
          T+ Text
        </Button>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
          <label className="flex cursor-pointer items-center gap-1" title="Snap edges to the playhead and other clips">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-violet-500" /> Snap
          </label>
          <span>Zoom</span>
          <input type="range" min={1} max={12} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-violet-500" aria-label="Timeline zoom" />
        </div>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden select-none" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="relative" style={{ width: contentW + GUTTER, height: totalH }}>
          {/* track labels */}
          <div className="sticky left-0 z-30 h-full border-r border-zinc-800 bg-zinc-950" style={{ width: GUTTER }}>
            {(["text", "broll", "video", "audio"] as const).map((k) => (
              <div key={k} className="absolute left-0 flex w-full items-center px-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500" style={{ top: top[k], height: TRACK[k] }}>
                {{ text: "Text", broll: "B-roll", video: "Video", audio: "Music" }[k]}
              </div>
            ))}
          </div>

          <div className="absolute top-0" style={{ left: GUTTER, width: contentW, height: totalH }}>
            {/* ruler */}
            <div
              className="absolute inset-x-0 top-0 h-5 cursor-ew-resize border-b border-zinc-800 bg-zinc-900/60"
              onPointerDown={(e) => {
                scrubbing.current = true;
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                clock.pause();
                clock.seek(timeAt(e.clientX));
              }}
              onPointerMove={(e) => scrubbing.current && clock.seek(timeAt(e.clientX))}
              onPointerUp={() => (scrubbing.current = false)}
              data-testid="ruler"
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-zinc-700/70 pl-1 text-[9px] leading-5 text-zinc-500" style={{ left: X(t) }}>
                  {t % 1 ? `${t.toFixed(1)}s` : fmtTC(t).slice(0, 5)}
                </div>
              ))}
            </div>

            {/* track backgrounds; clicking empty space seeks and clears the selection */}
            {(["text", "broll", "video", "audio"] as const).map((k) => (
              <div
                key={k}
                className="absolute inset-x-0 rounded-sm bg-zinc-900/40"
                style={{ top: top[k], height: TRACK[k] }}
                onPointerDown={(e) => {
                  onSelect(null);
                  clock.seek(timeAt(e.clientX));
                }}
              />
            ))}

            {/* text items */}
            {plan.overlays.map((o) => (
              <Item key={o.id} left={X(o.start)} width={(o.end - o.start) * pps} top={top.text} height={TRACK.text} color="#a16207" selected={sel("text", o.id)} onDown={(e, m) => startDrag(e, "text", o.id, m)} testId="text-item">
                <span className="truncate px-1.5 text-[10px] font-medium text-amber-50">T {o.text}</span>
              </Item>
            ))}

            {/* b-roll */}
            {plan.broll.map((b) => {
              const src = project.sources[b.source_id];
              return (
                <Item key={b.id} left={X(b.timeline_start)} width={(b.end - b.start) * pps} top={top.broll} height={TRACK.broll} color="#0e7490" selected={sel("broll", b.id)} onDown={(e, m) => startDrag(e, "broll", b.id, m)} testId="broll-item">
                  {src && <Filmstrip src={src} start={b.start} speed={1} width={(b.end - b.start) * pps} height={TRACK.broll} pps={pps} />}
                  <span className="absolute left-1 top-0.5 rounded bg-black/60 px-1 text-[9px] text-cyan-100">{b.mode === "pip" ? "PiP" : "B-roll"} · {src?.filename}</span>
                </Item>
              );
            })}

            {/* main video track */}
            {placed.map((p) => {
              const c = p.clip;
              const src = project.sources[c.source_id];
              // overlapping clips (transitions) are drawn meeting at the middle of the transition
              const vs = p.start + p.overlapIn / 2;
              const ve = p.end - (placed[p.index + 1]?.overlapIn ?? 0) / 2;
              const w = (ve - vs) * pps;
              const isDragged = drag?.kind === "clip" && drag.id === c.id && drag.mode === "move";
              return (
                <div key={c.id}>
                  <Item
                    left={X(vs) + (isDragged ? drag!.dx ?? 0 : 0)}
                    width={w}
                    top={top.video}
                    height={TRACK.video}
                    color={tone(c.source_id)}
                    selected={sel("clip", c.id)}
                    lifted={isDragged}
                    onDown={(e, m) => startDrag(e, "clip", c.id, m)}
                    testId="clip-item"
                  >
                    {src && <Filmstrip src={src} start={c.start + (p.overlapIn / 2) * c.speed} speed={c.speed} width={w} height={TRACK.video - 20} pps={pps} />}
                    {src?.waveform_url && <Wave url={fileUrl(src.waveform_url)} rate={src.waveform_rate} start={c.start + (p.overlapIn / 2) * c.speed} end={c.end - ((placed[p.index + 1]?.overlapIn ?? 0) / 2) * c.speed} width={w} height={18} className="absolute bottom-0 left-0" color="rgba(255,255,255,0.75)" />}
                    <div className="absolute left-1 top-0.5 flex gap-1">
                      <span className="max-w-[140px] truncate rounded bg-black/60 px-1 text-[9px] text-zinc-100">{src?.filename}</span>
                      {c.speed !== 1 && <span className="rounded bg-amber-500/90 px-1 text-[9px] font-semibold text-black">{c.speed}x</span>}
                      {c.look !== "none" && <span className="rounded bg-fuchsia-500/80 px-1 text-[9px] text-white">{c.look}</span>}
                    </div>
                  </Item>
                  {p.index > 0 && (
                    <button
                      className={`absolute z-20 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-sm border text-[8px] ${c.transition_in ? "rotate-45 border-violet-300 bg-violet-500" : "border-zinc-600 bg-zinc-800 text-zinc-300 opacity-60 hover:opacity-100"}`}
                      style={{ left: X(p.start + p.overlapIn / 2), top: top.video + TRACK.video / 2 - 8 }}
                      title={c.transition_in ? `${c.transition_in.type} transition (click to edit)` : "Add a transition"}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        onSelect({ kind: "clip", id: c.id });
                        if (!c.transition_in) run("set_transition", { clip_id: c.id, type: "fade", duration: 0.5 });
                      }}
                      data-testid="transition-marker"
                    >
                      {c.transition_in ? "" : "+"}
                    </button>
                  )}
                </div>
              );
            })}
            {drag?.kind === "clip" && drag.mode === "move" && drag.insertAt !== undefined && (
              <div
                className="absolute z-30 w-0.5 bg-violet-400"
                style={{
                  top: top.video - 4,
                  height: TRACK.video + 8,
                  left: X((() => {
                    const others = placed.filter((p) => p.clip.id !== drag.id);
                    if (!others.length) return 0;
                    return drag.insertAt! >= others.length ? others[others.length - 1].end : others[drag.insertAt!].start;
                  })()),
                }}
              />
            )}

            {/* music / voice-over */}
            {plan.audio.map((a) => {
              const src = project.sources[a.source_id];
              const w = (a.end - a.start) * pps;
              return (
                <Item key={a.id} left={X(a.timeline_start)} width={w} top={top.audio} height={TRACK.audio} color="#15803d" selected={sel("audio", a.id)} onDown={(e, m) => startDrag(e, "audio", a.id, m)} testId="audio-item">
                  {src?.waveform_url && <Wave url={fileUrl(src.waveform_url)} rate={src.waveform_rate} start={a.start} end={a.end} width={w} height={TRACK.audio} className="absolute inset-0" color="rgba(187,247,208,0.7)" />}
                  <span className="absolute left-1 top-0.5 truncate rounded bg-black/50 px-1 text-[9px] text-emerald-50">
                    ♪ {src?.filename} {a.duck && a.role === "music" ? "· ducks" : ""}
                  </span>
                </Item>
              );
            })}

            {/* captions band */}
            {plan.subtitles.enabled && duration > 0 && (
              <div className="pointer-events-none absolute h-1 rounded bg-yellow-400/60" style={{ left: X(0), width: duration * pps, top: top.video + TRACK.video + 1 }} title="Captions" />
            )}

            {snapLine !== null && <div className="pointer-events-none absolute top-5 z-40 w-px bg-yellow-300" style={{ left: X(snapLine), height: totalH - 20 }} />}
            <Playhead x={X} height={totalH} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Playhead({ x, height }: { x: (t: number) => number; height: number }) {
  const { time } = useClock();
  return (
    <div className="pointer-events-none absolute top-0 z-40" style={{ left: x(time), height }} data-testid="playhead">
      <div className="-ml-[5px] h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-500" />
      <div className="-mt-px h-full w-px bg-red-500" />
    </div>
  );
}

function Item({
  left,
  width,
  top,
  height,
  color,
  selected,
  lifted,
  onDown,
  children,
  testId,
}: {
  left: number;
  width: number;
  top: number;
  height: number;
  color: string;
  selected: boolean;
  lifted?: boolean;
  onDown: (e: React.PointerEvent, mode: "move" | "l" | "r") => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={`group absolute z-10 cursor-grab overflow-hidden rounded-md border active:cursor-grabbing ${selected ? "border-white ring-2 ring-violet-400" : "border-black/40"} ${lifted ? "z-30 opacity-80 shadow-xl" : ""}`}
      style={{ left, width: Math.max(4, width - 1), top, height, background: color }}
      onPointerDown={(e) => onDown(e, "move")}
      data-testid={testId}
    >
      {children}
      <div className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/30" onPointerDown={(e) => onDown(e, "l")} data-testid="trim-left" />
      <div className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/30" onPointerDown={(e) => onDown(e, "r")} data-testid="trim-right" />
    </div>
  );
}

function Filmstrip({ src, start, speed, width, height, pps }: { src: Project["sources"][string]; start: number; speed: number; width: number; height: number; pps: number }) {
  if (!src.filmstrip_url || !src.filmstrip_interval || !src.width) {
    return src.thumbnail_url ? <div className="absolute inset-0 opacity-60" style={{ backgroundImage: `url(${fileUrl(src.thumbnail_url)})`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }} /> : null;
  }
  const count = Math.max(1, Math.round(src.duration / src.filmstrip_interval));
  const tw = (height * src.width) / src.height;
  const n = Math.min(400, Math.ceil(width / tw));
  const url = fileUrl(src.filmstrip_url);
  return (
    <div className="absolute left-0 top-0 flex opacity-90" style={{ height }}>
      {Array.from({ length: n }, (_, k) => {
        const t = start + ((k * tw + tw / 2) / pps) * speed;
        const idx = Math.max(0, Math.min(count - 1, Math.floor(t / src.filmstrip_interval)));
        return <div key={k} style={{ width: tw, height, flex: "none", backgroundImage: `url(${url})`, backgroundSize: `${count * tw}px ${height}px`, backgroundPosition: `${-idx * tw}px 0` }} />;
      })}
    </div>
  );
}

const peaksCache = new Map<string, Promise<number[]>>();
function loadPeaks(url: string) {
  if (!peaksCache.has(url)) peaksCache.set(url, fetch(url, { credentials: "include" }).then((r) => (r.ok ? r.json() : [])).catch(() => []));
  return peaksCache.get(url)!;
}

function Wave({ url, rate, start, end, width, height, className, color }: { url: string; rate: number; start: number; end: number; width: number; height: number; className?: string; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    loadPeaks(url).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = Math.max(1, Math.min(8000, Math.floor(width)));
    c.width = w;
    c.height = height;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = color;
    const a = start * rate;
    const b = end * rate;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + ((b - a) * x) / w);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 1)) / w));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const h = Math.max(1, m * (height - 2));
      ctx.fillRect(x, (height - h) / 2, 1, h);
    }
  }, [peaks, width, height, start, end, rate, color]);
  return <canvas ref={ref} className={`pointer-events-none ${className ?? ""}`} style={{ width, height }} />;
}

export { clipDuration };
