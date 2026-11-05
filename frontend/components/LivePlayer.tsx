"use client";

// Real-time preview: plays the edit plan straight from the source files (or their light proxies) on a
// canvas, with cuts, speed, looks, framing, transitions, B-roll, text, captions and music applied live.
// No render is needed to see a change; the exported file is rendered by FFmpeg from the same plan.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { fileUrl, type Plan, type Project, type Word } from "@/lib/api";
import { clock, useClock } from "@/lib/clock";
import { drawCaptions, drawFitted, drawOverlay, drawTransition, fmtTC, groupCues, lookFilter, lookTint, placeClips, previewSize, type Rect } from "@/lib/engine";

type Props = {
  project: Project;
  plan: Plan; // may include unsaved drafts from the inspector
  words: Word[];
  selectedText: string | null;
  onSelectText: (id: string | null) => void;
  onMoveText: (id: string, x: number, y: number) => void;
};

type MediaEl = HTMLVideoElement | HTMLAudioElement;

export function LivePlayer({ project, plan, words, selectedText, onSelectText, onMoveText }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layers = useRef<HTMLCanvasElement[]>([]);
  const pool = useRef(new Map<string, MediaEl>());
  const boxes = useRef(new Map<string, Rect>());
  const drag = useRef<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const planRef = useRef(plan);
  const { playing } = useClock();
  const [W, H] = useMemo(() => previewSize(project, plan), [project, plan]);
  const placed = useMemo(() => placeClips(plan), [plan]);
  const duration = placed.length ? placed[placed.length - 1].end : 0;
  const cues = useMemo(() => groupCues(words, plan.subtitles.max_words_per_line), [words, plan.subtitles.max_words_per_line]);
  const state = useRef({ placed, cues, W, H, project, selectedText, words, duration });
  state.current = { placed, cues, W, H, project, selectedText, words, duration };
  planRef.current = plan;
  clock.duration = duration;

  const mediaFor = useCallback((key: string, sourceId: string, audioOnly = false): MediaEl | null => {
    const src = state.current.project.sources[sourceId];
    if (!src) return null;
    const url = fileUrl(src.proxy_url || src.url);
    let el = pool.current.get(key);
    if (!el) {
      el = audioOnly ? new Audio() : document.createElement("video");
      el.preload = "auto";
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.addEventListener("seeked", () => requestDraw());
      el.addEventListener("loadeddata", () => requestDraw());
      pool.current.set(key, el);
    }
    if (el.dataset.url !== url) {
      el.dataset.url = url;
      el.src = url;
    }
    return el;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drawPending = useRef(false);
  const requestDraw = useCallback(() => {
    if (drawPending.current) return;
    drawPending.current = true;
    requestAnimationFrame(() => {
      drawPending.current = false;
      draw();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keep a media element at the right moment: seek when paused or drifting, play/pause with the clock. */
  function sync(el: MediaEl, target: number, rate: number, active: boolean, volume: number) {
    const isPlaying = clock.playing;
    if (!active) {
      if (!el.paused) el.pause();
      return;
    }
    const tol = isPlaying ? 0.25 : 1 / 60;
    if (el.readyState >= 1 && Math.abs(el.currentTime - target) > tol) {
      try {
        el.currentTime = Math.max(0, target);
      } catch {}
    }
    const r = Math.min(4, Math.max(0.25, rate));
    if (el.playbackRate !== r) el.playbackRate = r;
    el.volume = Math.max(0, Math.min(1, volume));
    el.muted = volume <= 0.001;
    if (isPlaying && el.paused) el.play().catch(() => {});
    if (!isPlaying && !el.paused) el.pause();
  }

  function layer(i: number, W: number, H: number) {
    let c = layers.current[i];
    if (!c) {
      c = document.createElement("canvas");
      layers.current[i] = c;
    }
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    return c;
  }

  function draw() {
    const cv = canvas.current;
    if (!cv) return;
    const { placed, cues, W, H, selectedText, words, duration } = state.current;
    const plan = planRef.current;
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext("2d")!;
    const t = clock.now();
    const master = plan.output.master_volume;
    const fit = plan.output.aspect === "original" ? "pad" : plan.output.fit;
    const used = new Set<string>();
    let waiting = false;

    // which main clips are on screen (two during a transition)
    const activeIdx = placed.filter((p) => t >= p.start && t < p.end).map((p) => p.index);
    if (!activeIdx.length && placed.length && t >= placed[placed.length - 1].end - 0.001) activeIdx.push(placed.length - 1);

    // words being spoken right now (for ducking music)
    const speaking = words.some((w) => t >= w.start - 0.1 && t < w.end + 0.15);

    const drawClipLayer = (idx: number, li: number, volume: number) => {
      const p = placed[idx];
      const c = p.clip;
      const key = `${c.source_id}:${idx % 2}`;
      used.add(key);
      const el = mediaFor(key, c.source_id) as HTMLVideoElement | null;
      const lc = layer(li, W, H);
      const lctx = lc.getContext("2d")!;
      if (!el) {
        lctx.fillStyle = "#000";
        lctx.fillRect(0, 0, W, H);
        return lc;
      }
      const local = Math.min(Math.max(0, t - p.start), p.end - p.start);
      const target = c.start + local * c.speed;
      // per-clip fades
      let fade = 1;
      if (c.fade_in > 0) fade = Math.min(fade, local / c.fade_in);
      if (c.fade_out > 0) fade = Math.min(fade, (p.end - p.start - local) / c.fade_out);
      fade = Math.max(0, Math.min(1, fade));
      sync(el, target, c.speed, true, volume * c.volume * master * fade);
      if (el.readyState >= 2) {
        drawFitted(lctx, el, W, H, fit, { fx: c.focus_x, fy: c.focus_y, zoom: c.zoom, filter: lookFilter(c.look, c.adjust), tint: lookTint(c.look) });
      } else {
        waiting = true;
        if (!el.videoWidth) {
          lctx.fillStyle = "#000";
          lctx.fillRect(0, 0, W, H);
        }
      }
      if (fade < 1) {
        lctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
        lctx.fillRect(0, 0, W, H);
      }
      return lc;
    };

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (activeIdx.length === 1) {
      const lc = drawClipLayer(activeIdx[0], 0, 1);
      ctx.drawImage(lc, 0, 0);
    } else if (activeIdx.length >= 2) {
      const [ia, ib] = activeIdx;
      const pb = placed[ib];
      const p = Math.min(1, Math.max(0, (t - pb.start) / Math.max(0.01, pb.overlapIn)));
      const la = drawClipLayer(ia, 0, 1 - p);
      const lb = drawClipLayer(ib, 1, p);
      drawTransition(ctx, pb.clip.transition_in?.type ?? "fade", la, lb, p, W, H);
    }

    // preload the next clip a moment before it starts
    for (const p of placed) {
      if (activeIdx.includes(p.index)) continue;
      if (p.start > t && p.start - t < 1.5) {
        const key = `${p.clip.source_id}:${p.index % 2}`;
        if (!used.has(key)) {
          const el = mediaFor(key, p.clip.source_id);
          if (el && !used.has(key)) {
            used.add(key);
            if (!el.paused) el.pause();
            if (el.readyState >= 1 && Math.abs(el.currentTime - p.clip.start) > 0.05) el.currentTime = p.clip.start;
          }
        }
      }
    }

    // B-roll
    plan.broll.forEach((b, k) => {
      const key = `b:${b.id}`;
      const end = b.timeline_start + (b.end - b.start);
      const active = t >= b.timeline_start && t < end;
      const near = !active && b.timeline_start > t && b.timeline_start - t < 1.5;
      if (!active && !near) return;
      const el = mediaFor(key, b.source_id) as HTMLVideoElement | null;
      if (!el) return;
      used.add(key);
      if (near) {
        if (!el.paused) el.pause();
        if (el.readyState >= 1 && Math.abs(el.currentTime - b.start) > 0.05) el.currentTime = b.start;
        return;
      }
      const local = t - b.timeline_start;
      const fd = Math.min(b.fade, (end - b.timeline_start) / 3);
      const alpha = fd > 0 ? Math.max(0, Math.min(1, local / fd, (end - t) / fd)) : 1;
      sync(el, b.start + local, 1, true, b.volume * master);
      if (el.readyState < 2) {
        waiting = true;
        return;
      }
      const lc = layer(2 + k, W, H);
      const lctx = lc.getContext("2d")!;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (b.mode === "pip") {
        const pw = W * b.pip_scale;
        const ph = (pw * (el.videoHeight || 9)) / (el.videoWidth || 16);
        const mx = W * 0.04;
        const my = H * 0.04;
        const x = b.pip_corner.endsWith("left") ? mx : W - pw - mx;
        const y = b.pip_corner.startsWith("top") ? my : H - ph - my;
        ctx.filter = lookFilter(b.look);
        ctx.drawImage(el, x, y, pw, ph);
      } else {
        drawFitted(lctx, el, W, H, plan.output.aspect === "original" ? "pad" : "crop", { filter: lookFilter(b.look), tint: lookTint(b.look) });
        ctx.drawImage(lc, 0, 0);
      }
      ctx.restore();
    });

    // music, voice-over, sound effects
    for (const a of plan.audio) {
      const key = `a:${a.id}`;
      const end = a.timeline_start + (a.end - a.start);
      const active = t >= a.timeline_start && t < Math.min(end, duration);
      const near = !active && a.timeline_start > t && a.timeline_start - t < 1.5;
      if (!active && !near) continue;
      const el = mediaFor(key, a.source_id, true);
      if (!el) continue;
      used.add(key);
      if (near) {
        if (!el.paused) el.pause();
        if (el.readyState >= 1 && Math.abs(el.currentTime - a.start) > 0.05) el.currentTime = a.start;
        continue;
      }
      const local = t - a.timeline_start;
      const len = Math.min(end, duration) - a.timeline_start;
      let gain = a.volume * master;
      if (a.fade_in > 0) gain *= Math.min(1, local / Math.min(a.fade_in, len / 2));
      if (a.fade_out > 0) gain *= Math.min(1, (len - local) / Math.min(a.fade_out, len / 2));
      if (a.duck && a.role === "music" && speaking) gain *= 0.3;
      sync(el, a.start + local, 1, true, Math.max(0, gain));
    }

    // pause everything not in use
    pool.current.forEach((el, key) => {
      if (!used.has(key) && !el.paused) el.pause();
    });

    // text and captions
    boxes.current.clear();
    for (const ov of plan.overlays) {
      const r = drawOverlay(ctx, ov, t, W, H);
      if (r) {
        boxes.current.set(ov.id, r);
        if (ov.id === selectedText) {
          ctx.save();
          ctx.strokeStyle = "#8b5cf6";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(r.x - 8, r.y - 8, r.w + 16, r.h + 16);
          ctx.restore();
        }
      }
    }
    drawCaptions(ctx, plan, cues, t, W, H);

    if (waiting && clock.playing) clock.stall();
    if (!placed.length) {
      ctx.fillStyle = "#71717a";
      ctx.font = `${Math.round(Math.min(W, H) / 22)}px ${"system-ui"}`;
      ctx.textAlign = "center";
      ctx.fillText("Add a video to start editing", W / 2, H / 2);
    }
  }

  // redraw on every clock tick and whenever the plan changes
  useEffect(() => clock.subscribe(requestDraw), [requestDraw]);
  useEffect(() => {
    requestDraw();
  }, [plan, words, W, H, selectedText, project, requestDraw]);
  useEffect(() => {
    const p = pool.current;
    return () => {
      clock.pause();
      p.forEach((el) => {
        el.pause();
        el.removeAttribute("src");
        el.load();
      });
      p.clear();
    };
  }, [project.id]);

  // ---- drag text on the canvas ----
  const toCanvas = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const [x, y] = toCanvas(e);
    const hit = [...boxes.current.entries()].reverse().find(([, b]) => x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 10);
    if (!hit) {
      onSelectText(null);
      return;
    }
    const [id, b] = hit;
    onSelectText(id);
    drag.current = { id, dx: x - (b.x + b.w / 2), dy: y - (b.y + b.h / 2), x: (b.x + b.w / 2) / W, y: (b.y + b.h / 2) / H };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const [x, y] = toCanvas(e);
    const nx = Math.min(0.98, Math.max(0.02, (x - drag.current.dx) / W));
    const ny = Math.min(0.98, Math.max(0.02, (y - drag.current.dy) / H));
    drag.current.x = nx;
    drag.current.y = ny;
    const ov = planRef.current.overlays.find((o) => o.id === drag.current!.id);
    if (ov) {
      ov.x = nx; // live feedback; committed on release
      ov.y = ny;
      requestDraw();
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) onMoveText(d.id, Math.round(d.x * 1000) / 1000, Math.round(d.y * 1000) / 1000);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[radial-gradient(circle_at_center,#18181b,#09090b)] p-3">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => clock.toggle()}
          className="max-h-full max-w-full rounded-md bg-black shadow-2xl shadow-black/60"
          style={{ aspectRatio: `${W} / ${H}` }}
          data-testid="live-canvas"
        />
      </div>
      <Transport duration={duration} playing={playing} />
    </div>
  );
}

function Transport({ duration, playing }: { duration: number; playing: boolean }) {
  const { time } = useClock();
  return (
    <div className="flex items-center justify-center gap-3 border-t border-zinc-800/80 px-3 py-1.5 text-xs">
      <button className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Back to start (Home)" onClick={() => clock.seek(0)}>
        ⏮
      </button>
      <button className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Back 1 frame (←)" onClick={() => clock.seek(clock.time - 1 / 30)}>
        ‹
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white"
        title="Play / pause (Space)"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => clock.toggle()}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Forward 1 frame (→)" onClick={() => clock.seek(clock.time + 1 / 30)}>
        ›
      </button>
      <span className="font-mono tabular-nums text-zinc-300">
        {fmtTC(time)} <span className="text-zinc-600">/ {fmtTC(duration)}</span>
      </span>
    </div>
  );
}
