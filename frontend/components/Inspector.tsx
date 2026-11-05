"use client";

// Context inspector: shows the controls for whatever is selected on the timeline or canvas.
// Slider moves preview instantly (draft plan) and are saved as one undoable edit shortly after you stop.
import { useEffect, useState, type ReactNode } from "react";
import { CAPTION_STYLES, fileUrl, LOOKS, TEXT_ANIMATIONS, TEXT_STYLES, TRANSITIONS, type Corner, type Plan, type Project } from "@/lib/api";
import { clock } from "@/lib/clock";
import { colorHex, fmtTC, lookFilter, placeClips } from "@/lib/engine";
import type { Selection } from "./Timeline";
import { Button } from "./ui";

type Commit = (tool: string, args: Record<string, unknown>, mutate?: (p: Plan) => void, key?: string) => void;

type Props = {
  project: Project;
  plan: Plan;
  selection: Selection;
  commit: Commit;
  run: (tool: string, args?: Record<string, unknown>) => Promise<boolean>;
  onSelect: (s: Selection) => void;
};

const COLORS = ["white", "yellow", "#FFD400", "red", "orange", "pink", "purple", "cyan", "green", "black"];
const LABEL: Record<string, string> = {
  none: "None", bw: "B&W", warm: "Warm", cool: "Cool", vintage: "Vintage", vivid: "Vivid", faded: "Faded", cinematic: "Cinematic", dramatic: "Dramatic",
  box: "Box", outline: "Outline", shadow: "Shadow", plain: "Plain", highlight: "Highlight",
  fade: "Fade", slide_up: "Slide up", pop: "Pop", typewriter: "Typewriter",
  bold_highlight: "Bold highlight", karaoke: "Karaoke", boxed: "Boxed", clean: "Clean", minimal: "Minimal",
  dissolve: "Dissolve", fadeblack: "Dip to black", fadewhite: "Dip to white", slideleft: "Slide left", slideright: "Slide right", slideup: "Slide up",
  wipeleft: "Wipe left", wiperight: "Wipe right", circleopen: "Circle", zoomin: "Zoom", smoothleft: "Smooth",
};

export function Inspector({ project, plan, selection, commit, run, onSelect }: Props) {
  if (selection?.kind === "clip") {
    const i = plan.clips.findIndex((c) => c.id === selection.id);
    if (i >= 0) return <ClipInspector key={selection.id} project={project} plan={plan} index={i} commit={commit} run={run} onSelect={onSelect} />;
  }
  if (selection?.kind === "text") {
    const ov = plan.overlays.find((o) => o.id === selection.id);
    if (ov) return <TextInspector key={ov.id} plan={plan} id={ov.id} commit={commit} run={run} onSelect={onSelect} />;
  }
  if (selection?.kind === "broll") {
    const b = plan.broll.find((x) => x.id === selection.id);
    if (b) return <BrollInspector key={b.id} project={project} plan={plan} id={b.id} commit={commit} run={run} onSelect={onSelect} />;
  }
  if (selection?.kind === "audio") {
    const a = plan.audio.find((x) => x.id === selection.id);
    if (a) return <AudioInspector key={a.id} project={project} plan={plan} id={a.id} commit={commit} run={run} onSelect={onSelect} />;
  }
  return <ProjectInspector project={project} plan={plan} commit={commit} run={run} />;
}

// ---- building blocks -----------------------------------------------------------------
function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-zinc-800/80 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange, format, testId }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; testId?: string }) {
  return (
    <label className="grid grid-cols-[84px_1fr_44px] items-center gap-2 text-[11px] text-zinc-400">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-violet-500" data-testid={testId} aria-label={label} />
      <span className="text-right font-mono text-zinc-300">{format ? format(value) : value.toFixed(2)}</span>
    </label>
  );
}

function Chips<T extends string | number>({ options, value, onPick, render }: { options: readonly T[]; value: T; onPick: (v: T) => void; render?: (v: T) => ReactNode }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onPick(o)}
          className={`rounded-md border px-2 py-1 text-[11px] transition ${value === o ? "border-violet-400 bg-violet-600/30 text-violet-100" : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"}`}
        >
          {render ? render(o) : LABEL[String(o)] ?? String(o)}
        </button>
      ))}
    </div>
  );
}

function Header({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-b border-zinc-800 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-100">{title}</div>
        {sub && <div className="text-[11px] text-zinc-500">{sub}</div>}
      </div>
      {children}
      <button onClick={onClose} className="rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Deselect (Esc)">
        ✕
      </button>
    </div>
  );
}

// ---- clip -------------------------------------------------------------------------------
function ClipInspector({ project, plan, index, commit, run, onSelect }: { project: Project; plan: Plan; index: number; commit: Commit; run: Props["run"]; onSelect: Props["onSelect"] }) {
  const c = plan.clips[index];
  const src = project.sources[c.source_id];
  const placed = placeClips(plan)[index];
  const upd = (args: Record<string, unknown>, mutate: (cl: typeof c) => void) =>
    commit("update_clip", { clip_id: c.id, ...args }, (p) => {
      const cl = p.clips.find((x) => x.id === c.id);
      if (cl) mutate(cl);
    }, `clip:${c.id}:${Object.keys(args).join(",")}`);
  const thumb = src?.thumbnail_url ? fileUrl(src.thumbnail_url) : null;
  return (
    <div data-testid="clip-inspector">
      <Header title={src?.filename ?? "Clip"} sub={`Clip ${index + 1} · ${fmtTC(placed.start)} – ${fmtTC(placed.end)} · source ${c.start.toFixed(2)}–${c.end.toFixed(2)}s`} onClose={() => onSelect(null)} />
      <Section title="Speed">
        <Chips options={[0.25, 0.5, 1, 1.5, 2, 3] as const} value={c.speed as never} onPick={(v) => upd({ speed: v }, (cl) => (cl.speed = v))} render={(v) => `${v}x`} />
        <Slider label="Custom" value={c.speed} min={0.25} max={4} step={0.05} onChange={(v) => upd({ speed: v }, (cl) => (cl.speed = v))} format={(v) => `${v.toFixed(2)}x`} />
      </Section>
      <Section title="Color">
        <div className="grid grid-cols-3 gap-1.5">
          {LOOKS.map((l) => (
            <button key={l} onClick={() => upd({ look: l }, (cl) => (cl.look = l))} className={`overflow-hidden rounded-md border text-[10px] ${c.look === l ? "border-violet-400 ring-1 ring-violet-400" : "border-zinc-700 hover:border-zinc-500"}`} data-testid={`look-${l}`}>
              <div className="h-10 bg-zinc-800 bg-cover bg-center" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: lookFilter(l) }} />
              <div className="py-0.5 text-zinc-300">{LABEL[l]}</div>
            </button>
          ))}
        </div>
        <Slider label="Brightness" value={c.adjust.brightness} min={-1} max={1} step={0.05} onChange={(v) => upd({ brightness: v }, (cl) => (cl.adjust.brightness = v))} />
        <Slider label="Contrast" value={c.adjust.contrast} min={-1} max={1} step={0.05} onChange={(v) => upd({ contrast: v }, (cl) => (cl.adjust.contrast = v))} />
        <Slider label="Saturation" value={c.adjust.saturation} min={-1} max={1} step={0.05} onChange={(v) => upd({ saturation: v }, (cl) => (cl.adjust.saturation = v))} />
        <Button variant="ghost" onClick={() => run("set_color", { look: c.look, brightness: c.adjust.brightness, contrast: c.adjust.contrast, saturation: c.adjust.saturation })}>
          Apply this color to all clips
        </Button>
      </Section>
      <Section title="Framing">
        <Slider label="Zoom" value={c.zoom} min={1} max={3} step={0.05} onChange={(v) => upd({ zoom: v }, (cl) => (cl.zoom = v))} format={(v) => `${Math.round(v * 100)}%`} testId="zoom-slider" />
        <Slider label="Left ↔ right" value={c.focus_x} min={0} max={1} step={0.01} onChange={(v) => upd({ focus_x: v }, (cl) => (cl.focus_x = v))} />
        <Slider label="Top ↕ bottom" value={c.focus_y} min={0} max={1} step={0.01} onChange={(v) => upd({ focus_y: v }, (cl) => (cl.focus_y = v))} />
      </Section>
      <Section title="Audio">
        <Slider label="Volume" value={c.volume} min={0} max={2} step={0.05} onChange={(v) => upd({ volume: v }, (cl) => (cl.volume = v))} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Fade in" value={c.fade_in} min={0} max={3} step={0.1} onChange={(v) => upd({ fade_in: v }, (cl) => (cl.fade_in = v))} format={(v) => `${v.toFixed(1)}s`} />
        <Slider label="Fade out" value={c.fade_out} min={0} max={3} step={0.1} onChange={(v) => upd({ fade_out: v }, (cl) => (cl.fade_out = v))} format={(v) => `${v.toFixed(1)}s`} />
      </Section>
      {index > 0 && (
        <Section title="Transition from previous clip" right={c.transition_in && <Button variant="ghost" onClick={() => run("set_transition", { clip_id: c.id, type: "none" })}>Remove</Button>}>
          <select
            value={c.transition_in?.type ?? "none"}
            onChange={(e) => run("set_transition", { clip_id: c.id, type: e.target.value, duration: c.transition_in?.duration ?? 0.5 })}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
            data-testid="transition-select"
          >
            <option value="none">Hard cut</option>
            {TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                {LABEL[t]}
              </option>
            ))}
          </select>
          {c.transition_in && (
            <Slider
              label="Length"
              value={c.transition_in.duration}
              min={0.1}
              max={2}
              step={0.05}
              onChange={(v) =>
                commit("set_transition", { clip_id: c.id, type: c.transition_in!.type, duration: v }, (p) => {
                  const cl = p.clips.find((x) => x.id === c.id);
                  if (cl?.transition_in) cl.transition_in.duration = v;
                }, `tr:${c.id}`)
              }
              format={(v) => `${v.toFixed(2)}s`}
            />
          )}
          <Button variant="ghost" onClick={() => run("set_transition", { type: c.transition_in?.type ?? "fade", duration: c.transition_in?.duration ?? 0.5 })}>
            Use on every cut
          </Button>
        </Section>
      )}
      <div className="flex gap-1.5 px-3 py-3">
        <Button onClick={() => run("split_clip", { timeline_time: clock.time })}>✂ Split at playhead</Button>
        <Button variant="danger" onClick={() => run("delete_clip", { clip_id: c.id }).then((ok) => ok && onSelect(null))}>
          Delete clip
        </Button>
      </div>
    </div>
  );
}

// ---- text -----------------------------------------------------------------------------
function TextInspector({ plan, id, commit, run, onSelect }: { plan: Plan; id: string; commit: Commit; run: Props["run"]; onSelect: Props["onSelect"] }) {
  const ov = plan.overlays.find((o) => o.id === id)!;
  const [text, setText] = useState(ov.text);
  useEffect(() => setText(ov.text), [ov.text]);
  const upd = (args: Record<string, unknown>, mutate: (o: typeof ov) => void) =>
    commit("update_text_overlay", { overlay_id: id, ...args }, (p) => {
      const o = p.overlays.find((x) => x.id === id);
      if (o) mutate(o);
    }, `text:${id}:${Object.keys(args).join(",")}`);
  return (
    <div data-testid="text-inspector">
      <Header title="Text" sub={`${fmtTC(ov.start)} – ${fmtTC(ov.end)} · drag it on the video to move`} onClose={() => onSelect(null)} />
      <Section title="Words">
        <textarea
          value={text}
          rows={3}
          maxLength={300}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) upd({ text: e.target.value }, (o) => (o.text = e.target.value));
          }}
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-violet-500"
          data-testid="text-input"
        />
      </Section>
      <Section title="Style">
        <Chips options={TEXT_STYLES} value={ov.style} onPick={(v) => upd({ style: v }, (o) => (o.style = v))} />
        <div className="flex flex-wrap gap-1.5">
          {COLORS.map((c) => (
            <button key={c} title={c} onClick={() => upd({ color: c }, (o) => (o.color = c))} className={`h-6 w-6 rounded-full border-2 ${ov.color === c ? "border-violet-400" : "border-zinc-700"}`} style={{ background: colorHex(c) }} />
          ))}
        </div>
        <Slider label="Size" value={ov.font_size} min={16} max={200} step={2} onChange={(v) => upd({ font_size: v }, (o) => (o.font_size = v))} format={(v) => `${v}`} />
      </Section>
      <Section title="Animation">
        <Chips options={TEXT_ANIMATIONS} value={ov.animation} onPick={(v) => upd({ animation: v }, (o) => (o.animation = v))} />
      </Section>
      <Section title="Position">
        <Chips options={["top", "center", "bottom"] as const} value={(ov.x == null ? ov.position : "custom") as never} onPick={(v) => upd({ position: v }, (o) => ((o.position = v), (o.x = null), (o.y = null)))} render={(v) => String(v)[0].toUpperCase() + String(v).slice(1)} />
      </Section>
      <div className="flex gap-1.5 px-3 py-3">
        <Button onClick={() => run("update_text_overlay", { overlay_id: id, start: clock.time, end: clock.time + (ov.end - ov.start) })}>Move to playhead</Button>
        <Button variant="danger" onClick={() => run("remove_text_overlay", { overlay_id: id }).then((ok) => ok && onSelect(null))}>
          Delete text
        </Button>
      </div>
    </div>
  );
}

// ---- b-roll -----------------------------------------------------------------------------
function BrollInspector({ project, plan, id, commit, run, onSelect }: { project: Project; plan: Plan; id: string; commit: Commit; run: Props["run"]; onSelect: Props["onSelect"] }) {
  const b = plan.broll.find((x) => x.id === id)!;
  const src = project.sources[b.source_id];
  const upd = (args: Record<string, unknown>, mutate: (x: typeof b) => void) =>
    commit("update_broll", { broll_id: id, ...args }, (p) => {
      const x = p.broll.find((y) => y.id === id);
      if (x) mutate(x);
    }, `broll:${id}:${Object.keys(args).join(",")}`);
  return (
    <div data-testid="broll-inspector">
      <Header title={src?.filename ?? "B-roll"} sub={`B-roll at ${fmtTC(b.timeline_start)} for ${(b.end - b.start).toFixed(1)}s`} onClose={() => onSelect(null)} />
      <Section title="Layout">
        <Chips options={["full", "pip"] as const} value={b.mode} onPick={(v) => upd({ mode: v }, (x) => (x.mode = v))} render={(v) => (v === "full" ? "Full screen" : "Picture in picture")} />
        {b.mode === "pip" && (
          <>
            <Chips options={["top_left", "top_right", "bottom_left", "bottom_right"] as Corner[]} value={b.pip_corner} onPick={(v) => upd({ pip_corner: v }, (x) => (x.pip_corner = v))} render={(v) => String(v).replace("_", " ")} />
            <Slider label="Size" value={b.pip_scale} min={0.15} max={0.8} step={0.01} onChange={(v) => upd({ pip_scale: v }, (x) => (x.pip_scale = v))} format={(v) => `${Math.round(v * 100)}%`} />
          </>
        )}
      </Section>
      <Section title="Look and sound">
        <select value={b.look} onChange={(e) => upd({ look: e.target.value }, (x) => (x.look = e.target.value as typeof b.look))} className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs">
          {LOOKS.map((l) => (
            <option key={l} value={l}>
              {LABEL[l]}
            </option>
          ))}
        </select>
        <Slider label="Volume" value={b.volume} min={0} max={2} step={0.05} onChange={(v) => upd({ volume: v }, (x) => (x.volume = v))} format={(v) => `${Math.round(v * 100)}%`} />
      </Section>
      <div className="px-3 py-3">
        <Button variant="danger" onClick={() => run("remove_broll", { broll_id: id }).then((ok) => ok && onSelect(null))}>
          Remove B-roll
        </Button>
      </div>
    </div>
  );
}

// ---- audio ------------------------------------------------------------------------------
function AudioInspector({ project, plan, id, commit, run, onSelect }: { project: Project; plan: Plan; id: string; commit: Commit; run: Props["run"]; onSelect: Props["onSelect"] }) {
  const a = plan.audio.find((x) => x.id === id)!;
  const src = project.sources[a.source_id];
  const upd = (args: Record<string, unknown>, mutate: (x: typeof a) => void) =>
    commit("update_audio", { audio_id: id, ...args }, (p) => {
      const x = p.audio.find((y) => y.id === id);
      if (x) mutate(x);
    }, `audio:${id}:${Object.keys(args).join(",")}`);
  return (
    <div data-testid="audio-inspector">
      <Header title={src?.filename ?? "Audio"} sub={`${a.role} at ${fmtTC(a.timeline_start)} for ${(a.end - a.start).toFixed(1)}s`} onClose={() => onSelect(null)} />
      <Section title="Type">
        <Chips options={["music", "voiceover", "sfx"] as const} value={a.role} onPick={(v) => upd({ role: v }, (x) => (x.role = v))} render={(v) => ({ music: "Music", voiceover: "Voice-over", sfx: "Sound effect" })[v]} />
      </Section>
      <Section title="Level">
        <Slider label="Volume" value={a.volume} min={0} max={2} step={0.05} onChange={(v) => upd({ volume: v }, (x) => (x.volume = v))} format={(v) => `${Math.round(v * 100)}%`} />
        {a.role === "music" && (
          <label className="flex items-center gap-2 text-[11px] text-zinc-300">
            <input type="checkbox" checked={a.duck} onChange={(e) => upd({ duck: e.target.checked }, (x) => (x.duck = e.target.checked))} className="accent-violet-500" />
            Lower the music while someone speaks (auto-duck)
          </label>
        )}
        <Slider label="Fade in" value={a.fade_in} min={0} max={10} step={0.1} onChange={(v) => upd({ fade_in: v }, (x) => (x.fade_in = v))} format={(v) => `${v.toFixed(1)}s`} />
        <Slider label="Fade out" value={a.fade_out} min={0} max={10} step={0.1} onChange={(v) => upd({ fade_out: v }, (x) => (x.fade_out = v))} format={(v) => `${v.toFixed(1)}s`} />
      </Section>
      <div className="px-3 py-3">
        <Button variant="danger" onClick={() => run("remove_audio", { audio_id: id }).then((ok) => ok && onSelect(null))}>
          Remove audio
        </Button>
      </div>
    </div>
  );
}

// ---- nothing selected: project-wide settings -------------------------------------------------
function ProjectInspector({ project, plan, commit, run }: { project: Project; plan: Plan; commit: Commit; run: Props["run"] }) {
  const st = plan.subtitles;
  const out = plan.output;
  const hasClips = plan.clips.length > 0;
  const sub = (args: Record<string, unknown>, mutate: (s: typeof st) => void) => commit("set_subtitles", { enabled: st.enabled, ...args }, (p) => mutate(p.subtitles), `subs:${Object.keys(args).join(",")}`);
  return (
    <div data-testid="project-inspector">
      <div className="border-b border-zinc-800 px-3 py-2.5">
        <div className="text-sm font-medium text-zinc-100">Project</div>
        <div className="text-[11px] text-zinc-500">Select a clip, text, B-roll or music on the timeline to edit it.</div>
      </div>
      <Section title="Format">
        <Chips
          options={["tiktok", "instagram_reels", "youtube_shorts", "youtube", "instagram_feed", "square"] as const}
          value={(out.platform ?? "") as never}
          onPick={(v) => run("set_output_format", { platform: v })}
          render={(v) => ({ tiktok: "TikTok", instagram_reels: "Reels", youtube_shorts: "Shorts", youtube: "YouTube", instagram_feed: "IG feed 4:5", square: "Square" })[v as string]}
        />
        <Chips options={["crop", "blur", "pad"] as const} value={out.fit} onPick={(v) => run("set_output_format", { fit: v })} render={(v) => ({ crop: "Fill", blur: "Blur background", pad: "Black bars" })[v]} />
      </Section>
      <Section title="Captions" right={<Button variant={st.enabled ? "primary" : "default"} disabled={!hasClips} onClick={() => run("set_subtitles", { enabled: !st.enabled })} data-testid="captions-toggle">{st.enabled ? "On" : "Auto captions"}</Button>}>
        <Chips options={CAPTION_STYLES} value={st.style} onPick={(v) => sub({ style: v }, (s) => (s.style = v))} />
        <Slider label="Size" value={st.font_size} min={24} max={160} step={2} onChange={(v) => sub({ font_size: v }, (s) => (s.font_size = v))} format={(v) => `${v}`} />
        <Slider label="Words / line" value={st.max_words_per_line} min={1} max={8} step={1} onChange={(v) => sub({ max_words_per_line: v }, (s) => (s.max_words_per_line = v))} format={(v) => `${v}`} />
        <Chips options={["top", "center", "bottom"] as const} value={st.position} onPick={(v) => sub({ position: v }, (s) => (s.position = v))} render={(v) => v[0].toUpperCase() + v.slice(1)} />
        <div className="flex items-center gap-1.5">
          {["#FFD400", "#34C759", "#32D2F5", "#FF2D92", "#FF9500", "#FFFFFF"].map((c) => (
            <button key={c} onClick={() => sub({ highlight_color: c }, (s) => (s.highlight_color = c))} className={`h-6 w-6 rounded-full border-2 ${st.highlight_color.toUpperCase() === c ? "border-violet-400" : "border-zinc-700"}`} style={{ background: c }} title="Highlight color" />
          ))}
          <label className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={st.uppercase} onChange={(e) => sub({ uppercase: e.target.checked }, (s) => (s.uppercase = e.target.checked))} className="accent-violet-500" />
            CAPS
          </label>
        </div>
      </Section>
      <Section title="Whole video">
        <div className="flex flex-wrap gap-1.5">
          <Button disabled={!hasClips} onClick={() => run("remove_silences")}>Remove pauses</Button>
          <Button disabled={plan.clips.length < 2} onClick={() => run("set_transition", { type: "fade", duration: 0.4 })}>Fade every cut</Button>
          <Button disabled={plan.clips.length < 2} onClick={() => run("set_transition", { type: "none" })}>Hard cuts</Button>
        </div>
        <Slider label="Master volume" value={out.master_volume} min={0} max={2} step={0.05} onChange={(v) => commit("set_audio", { master_volume: v }, (p) => (p.output.master_volume = v), "master")} format={(v) => `${Math.round(v * 100)}%`} />
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={out.normalize_audio} onChange={(e) => run("set_audio", { normalize: e.target.checked })} className="accent-violet-500" />
          Even out loudness for social apps (-14 LUFS, applied on export)
        </label>
      </Section>
      <div className="px-3 py-3 text-[11px] leading-5 text-zinc-500">
        Shortcuts: Space play/pause · S split · Delete remove · ⌘/Ctrl+Z undo · ⇧⌘/Ctrl+Shift+Z redo · ←/→ frame (⇧ = 1s) · Esc deselect · {Object.keys(project.sources).length} source files
      </div>
    </div>
  );
}
