// Timeline math and drawing shared by the live player. It mirrors backend/app/render/compiler.py so the
// in-browser preview matches the exported file as closely as a browser allows.
import type { Clip, Look, Plan, Project, TextOverlay, Word } from "./api";

export type Placed = { clip: Clip; index: number; start: number; end: number; overlapIn: number };

export const clipDuration = (c: Clip) => Math.max(0, c.end - c.start) / Math.max(c.speed || 1, 0.01);

export function transitionOverlap(clips: Clip[], i: number): number {
  if (i <= 0 || i >= clips.length) return 0;
  const t = clips[i].transition_in;
  if (!t) return 0;
  return Math.max(0, Math.min(t.duration, clipDuration(clips[i - 1]) / 2, clipDuration(clips[i]) / 2));
}

export function placeClips(plan: Plan): Placed[] {
  let t = 0;
  return plan.clips.map((clip, index) => {
    const d = clipDuration(clip);
    const ov = transitionOverlap(plan.clips, index);
    const start = t - ov;
    t = start + d;
    return { clip, index, start, end: start + d, overlapIn: ov };
  });
}

export const planDuration = (plan: Plan) => {
  const p = placeClips(plan);
  return p.length ? p[p.length - 1].end : 0;
};

// ---- color looks ------------------------------------------------------------------
const LOOK_CSS: Record<Look, string> = {
  none: "",
  bw: "grayscale(1) contrast(1.08)",
  warm: "saturate(1.08)",
  cool: "",
  vintage: "sepia(0.35) contrast(0.9) saturate(0.85)",
  vivid: "saturate(1.4) contrast(1.08)",
  faded: "contrast(0.85) brightness(1.04) saturate(0.8)",
  cinematic: "contrast(1.1) saturate(0.9)",
  dramatic: "contrast(1.3) saturate(0.8) brightness(0.97)",
};
const LOOK_TINT: Partial<Record<Look, string>> = {
  warm: "rgba(255,140,40,0.22)",
  cool: "rgba(40,120,255,0.24)",
  cinematic: "rgba(0,150,160,0.22)",
  vintage: "rgba(255,190,110,0.15)",
};

export function lookFilter(look: Look, adjust?: Clip["adjust"]): string {
  const parts = [LOOK_CSS[look] || ""];
  if (adjust) {
    if (adjust.brightness) parts.push(`brightness(${(1 + adjust.brightness * 0.3).toFixed(3)})`);
    if (adjust.contrast) parts.push(`contrast(${(1 + adjust.contrast * 0.5).toFixed(3)})`);
    if (adjust.saturation) parts.push(`saturate(${Math.max(0, 1 + adjust.saturation).toFixed(3)})`);
  }
  return parts.filter(Boolean).join(" ") || "none";
}

// CSS used for look swatches in the inspector
export function lookSwatchStyle(look: Look): React.CSSProperties {
  return { filter: lookFilter(look) };
}

// ---- frame geometry ----------------------------------------------------------------
type Drawable = HTMLVideoElement;

function mediaSize(el: Drawable): [number, number] {
  return [el.videoWidth || 16, el.videoHeight || 9];
}

/** Draw a video frame into ctx (W x H) the way the renderer fits it: crop / pad / blur, then zoom at focus. */
export function drawFitted(
  ctx: CanvasRenderingContext2D,
  el: Drawable,
  W: number,
  H: number,
  fit: "pad" | "crop" | "blur",
  opts: { fx?: number; fy?: number; zoom?: number; filter?: string; tint?: string } = {},
) {
  const [vw, vh] = mediaSize(el);
  const fx = opts.fx ?? 0.5;
  const fy = opts.fy ?? 0.5;
  const z = Math.max(1, opts.zoom ?? 1);
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(z, 0, 0, z, -W * (z - 1) * fx, -H * (z - 1) * fy);
  const filter = opts.filter && opts.filter !== "none" ? opts.filter : "";
  if (fit === "blur") {
    const s = Math.max(W / vw, H / vh);
    ctx.filter = `blur(${Math.round(Math.min(W, H) / 40)}px) brightness(0.9) ${filter}`.trim();
    ctx.drawImage(el, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  }
  ctx.filter = filter || "none";
  if (fit === "crop") {
    const s = Math.max(W / vw, H / vh);
    const sw = vw * s;
    const sh = vh * s;
    ctx.drawImage(el, -(sw - W) * fx, -(sh - H) * fy, sw, sh);
  } else {
    const s = Math.min(W / vw, H / vh);
    ctx.drawImage(el, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  }
  ctx.restore();
  if (opts.tint) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = opts.tint;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

export const lookTint = (look: Look) => LOOK_TINT[look];

// ---- transitions -------------------------------------------------------------------
/** Composite layer A (outgoing) and B (incoming) at progress p (0..1). */
export function drawTransition(ctx: CanvasRenderingContext2D, type: string, a: CanvasImageSource, b: CanvasImageSource, p: number, W: number, H: number) {
  ctx.save();
  const ease = p;
  switch (type) {
    case "fadeblack":
    case "fadewhite": {
      const color = type === "fadeblack" ? "#000" : "#fff";
      if (p < 0.5) {
        ctx.drawImage(a, 0, 0);
        ctx.globalAlpha = p * 2;
      } else {
        ctx.drawImage(b, 0, 0);
        ctx.globalAlpha = (1 - p) * 2;
      }
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "slideleft":
      ctx.drawImage(a, -ease * W, 0);
      ctx.drawImage(b, (1 - ease) * W, 0);
      break;
    case "slideright":
      ctx.drawImage(a, ease * W, 0);
      ctx.drawImage(b, -(1 - ease) * W, 0);
      break;
    case "slideup":
      ctx.drawImage(a, 0, -ease * H);
      ctx.drawImage(b, 0, (1 - ease) * H);
      break;
    case "wipeleft":
    case "smoothleft":
      ctx.drawImage(a, 0, 0);
      ctx.beginPath();
      ctx.rect(W * (1 - ease), 0, W * ease, H);
      ctx.clip();
      ctx.drawImage(b, 0, 0);
      break;
    case "wiperight":
      ctx.drawImage(a, 0, 0);
      ctx.beginPath();
      ctx.rect(0, 0, W * ease, H);
      ctx.clip();
      ctx.drawImage(b, 0, 0);
      break;
    case "circleopen":
      ctx.drawImage(a, 0, 0);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, Math.hypot(W, H) * 0.5 * ease, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(b, 0, 0);
      break;
    case "zoomin": {
      const z = 1 + ease * 0.6;
      ctx.drawImage(b, 0, 0);
      ctx.globalAlpha = 1 - ease;
      ctx.drawImage(a, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
      break;
    }
    default: // fade, dissolve
      ctx.drawImage(a, 0, 0);
      ctx.globalAlpha = ease;
      ctx.drawImage(b, 0, 0);
  }
  ctx.restore();
}

// ---- text ----------------------------------------------------------------------------
export const FONT_STACK = '"DejaVu Sans", Verdana, Arial, sans-serif';
const NAMED: Record<string, string> = {
  white: "#FFFFFF", black: "#000000", yellow: "#FFD400", red: "#FF3B30", green: "#34C759", blue: "#0A84FF",
  orange: "#FF9500", pink: "#FF2D92", purple: "#AF52DE", cyan: "#32D2F5", gray: "#8E8E93", grey: "#8E8E93",
};
export const colorHex = (c: string) => NAMED[c?.toLowerCase?.()] ?? (/^#[0-9a-f]{6}$/i.test(c) ? c : "#FFFFFF");

export function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > maxChars) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Draw a text overlay at time t; returns its bounding box (for hit-testing and dragging). */
export function drawOverlay(ctx: CanvasRenderingContext2D, ov: TextOverlay, t: number, W: number, H: number): Rect | null {
  if (t < ov.start || t >= ov.end) return null;
  const scale = Math.min(W, H) / 1080;
  const base = Math.max(10, Math.floor(ov.font_size * scale));
  const s = ov.start;
  const e = ov.end;
  const dur = Math.max(0.05, e - s);
  const a = Math.min(0.3, dur / 3);
  let alpha = 1;
  let size = base;
  let dy = 0;
  if (ov.animation !== "none") alpha = Math.min(1, Math.max(0, Math.min((t - s) / a, (e - t) / a)));
  if (ov.animation === "slide_up") dy = H * 0.04 * Math.max(0, 1 - (t - s) / 0.35);
  if (ov.animation === "pop") size = base * Math.min(1, 0.6 + (0.4 * Math.max(0, t - s)) / 0.18);
  const maxChars = Math.max(8, Math.floor((W * 0.88) / (base * 0.58)));
  let lines = wrapText(ov.text, maxChars);
  if (ov.animation === "typewriter") {
    const words = lines.join(" ").split(" ");
    if (words.length > 1 && words.length <= 16) {
      const reveal = Math.min(dur * 0.6, 0.12 * words.length);
      const n = Math.min(words.length, Math.floor(((t - s) / reveal) * words.length) + 1);
      lines = wrapText(words.slice(0, n).join(" "), maxChars);
    }
  }
  ctx.save();
  ctx.font = `bold ${size}px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  const lineH = size * 1.17;
  const spacing = Math.floor(base * 0.25);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const tw = Math.max(...widths, 1);
  const th = lines.length * lineH + (lines.length - 1) * spacing;
  const x = ov.x != null ? W * ov.x - tw / 2 : (W - tw) / 2;
  let y = ov.y != null ? H * ov.y - th / 2 : ov.position === "top" ? H * 0.08 : ov.position === "center" ? (H - th) / 2 : H * 0.78 - th;
  y += dy;
  ctx.globalAlpha = alpha;
  let fill = colorHex(ov.color);
  if (ov.style === "box" || ov.style === "highlight") {
    // one box per line, as the renderer (libass) draws it
    const pad = Math.max(4, Math.floor(base * (ov.style === "box" ? 0.35 : 0.3)));
    ctx.fillStyle = ov.style === "box" ? "rgba(0,0,0,0.55)" : fill;
    lines.forEach((_, i) => {
      const lx = ov.x != null ? x + (tw - widths[i]) / 2 : (W - widths[i]) / 2;
      ctx.fillRect(lx - pad, y + i * (lineH + spacing) - pad * 0.4, widths[i] + pad * 2, lineH + pad * 0.8);
    });
    if (ov.style === "highlight") fill = fill.toUpperCase() === "#000000" ? "#FFFFFF" : "#000000";
  }
  if (ov.style === "shadow") {
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, Math.floor(base * 0.05));
  }
  lines.forEach((line, i) => {
    const lx = ov.x != null ? x + (tw - widths[i]) / 2 : (W - widths[i]) / 2;
    const ly = y + i * (lineH + spacing);
    if (ov.style === "outline") {
      ctx.lineWidth = Math.max(2, Math.floor(base * 0.08)) * 2;
      ctx.strokeStyle = "#000";
      ctx.lineJoin = "round";
      ctx.strokeText(line, lx, ly);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, lx, ly);
  });
  ctx.restore();
  return { x, y, w: tw, h: th };
}

// ---- captions (mirrors group_cues / build_ass) -----------------------------------------
export type Cue = { words: Word[]; end: number };

export function groupCues(words: Word[], maxWords: number): Cue[] {
  const cues: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur[cur.length - 1].end;
      const tooLong = w.end - cur[0].start > 3.5;
      const endsSentence = /[.?!]$/.test(cur[cur.length - 1].word);
      if (cur.length >= maxWords || gap > 0.7 || tooLong || endsSentence) {
        cues.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);
  return cues.map((ws, i) => {
    let end = ws[ws.length - 1].end;
    if (i + 1 < cues.length) end = Math.min(Math.max(end, end + 0.25), cues[i + 1][0].start);
    return { words: ws, end };
  });
}

const CAPTION_LOOK: Record<string, { box: boolean; outline: number; shadow: number; highlight: boolean; pop: boolean; factor: number; bold: boolean }> = {
  bold_highlight: { box: false, outline: 0.08, shadow: 0, highlight: true, pop: false, factor: 1, bold: true },
  karaoke: { box: false, outline: 0.09, shadow: 0, highlight: true, pop: true, factor: 1, bold: true },
  boxed: { box: true, outline: 0, shadow: 0, highlight: true, pop: false, factor: 0.9, bold: true },
  clean: { box: false, outline: 0.05, shadow: 0.03, highlight: false, pop: false, factor: 0.85, bold: false },
  minimal: { box: false, outline: 0, shadow: 0.05, highlight: false, pop: false, factor: 0.7, bold: false },
};

export function drawCaptions(ctx: CanvasRenderingContext2D, plan: Plan, cues: Cue[], t: number, W: number, H: number) {
  const st = plan.subtitles;
  if (!st.enabled) return;
  const cue = cues.find((c) => t >= c.words[0].start && t < c.end);
  if (!cue) return;
  const look = CAPTION_LOOK[st.style] ?? CAPTION_LOOK.bold_highlight;
  const size = Math.max(12, Math.floor(st.font_size * (Math.min(W, H) / 1080) * look.factor));
  const font = `${look.bold ? "bold " : ""}${size}px ${FONT_STACK}`;
  const active = look.highlight ? cue.words.findIndex((w, i) => t >= (i === 0 ? cue.words[0].start : w.start) && (i + 1 < cue.words.length ? t < cue.words[i + 1].start : true)) : -1;
  const texts = cue.words.map((w) => (st.uppercase ? w.word.toUpperCase() : w.word));
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const space = ctx.measureText(" ").width;
  const maxW = W * 0.88;
  // wrap into lines of words
  const lines: number[][] = [[]];
  let lw = 0;
  texts.forEach((tx, i) => {
    const w = ctx.measureText(tx).width;
    if (lines[lines.length - 1].length && lw + space + w > maxW) {
      lines.push([]);
      lw = 0;
    }
    lines[lines.length - 1].push(i);
    lw += (lw ? space : 0) + w;
  });
  const lineH = size * 1.2;
  const blockH = lines.length * lineH;
  const marginV = H * (st.position === "bottom" ? 0.14 : 0.1);
  const top = st.position === "bottom" ? H - marginV - blockH : st.position === "top" ? marginV : (H - blockH) / 2;
  const hl = colorHex(st.highlight_color || "#FFFFFF");
  lines.forEach((idxs, li) => {
    const widths = idxs.map((i) => ctx.measureText(texts[i]).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (idxs.length - 1);
    let x = (W - total) / 2;
    const baseY = top + li * lineH + size;
    if (look.box) {
      const pad = size * 0.18;
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.fillRect(x - pad, baseY - size - pad * 0.2, total + pad * 2, lineH + pad * 0.4);
    }
    idxs.forEach((i, k) => {
      const isActive = i === active;
      ctx.save();
      const w = widths[k];
      if (isActive && look.pop) {
        ctx.translate(x + w / 2, baseY - size / 2);
        ctx.scale(1.12, 1.12);
        ctx.translate(-(x + w / 2), -(baseY - size / 2));
      }
      if (look.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.7)";
        ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, size * look.shadow);
      }
      if (look.outline) {
        ctx.lineWidth = Math.max(2, size * look.outline) * 2;
        ctx.strokeStyle = "#000";
        ctx.lineJoin = "round";
        ctx.strokeText(texts[i], x, baseY);
      }
      ctx.fillStyle = isActive ? hl : "#FFFFFF";
      ctx.fillText(texts[i], x, baseY);
      ctx.restore();
      x += w + space;
    });
  });
  ctx.restore();
}

// ---- output size ---------------------------------------------------------------------
export function previewSize(project: Project, plan: Plan, short = 540): [number, number] {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  const out = plan.output;
  if (out.aspect === "original") {
    const first = plan.clips.map((c) => project.sources[c.source_id]).find((s) => s && s.width);
    const [sw, sh] = first ? [first.width, first.height] : [1920, 1080];
    const ss = Math.min(short, Math.min(sw, sh));
    const k = ss / Math.min(sw, sh);
    return [even(sw * k), even(sh * k)];
  }
  const [rw, rh] = { "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5] }[out.aspect] as [number, number];
  return rw <= rh ? [even(short), even((short * rh) / rw)] : [even((short * rw) / rh), even(short)];
}

export function fmtTC(t: number, fps = 30): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
