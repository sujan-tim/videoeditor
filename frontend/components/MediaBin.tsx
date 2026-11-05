"use client";

import { useRef, useState } from "react";
import { api, fileUrl, fmtBytes, fmtTime, upload, type Project } from "@/lib/api";
import { clock } from "@/lib/clock";
import { Badge, Button, Panel, Progress } from "./ui";

export function MediaBin({ project, onChange, onError }: { project: Project; onChange: () => void; onError: (e: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [drag, setDrag] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!/\.(mp4|mov|m4v|webm|mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
        onError(`${file.name}: upload MP4, MOV or WebM video, or MP3, WAV, M4A, AAC or OGG audio`);
        continue;
      }
      setUploading({ name: file.name, progress: 0 });
      try {
        await upload(project.id, file, (p) => setUploading({ name: file.name, progress: p }));
      } catch (e) {
        onError((e as Error).message);
      }
    }
    setUploading(null);
    onChange();
  }

  async function run(name: string, args: Record<string, unknown>) {
    try {
      await api.tool(project.id, name, args);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  const sources = Object.values(project.sources);
  return (
    <Panel title="Media" actions={<Button variant="ghost" onClick={() => input.current?.click()}>+ Upload</Button>}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`m-2 cursor-pointer rounded-md border border-dashed px-3 py-4 text-center text-xs transition ${
          drag ? "border-violet-400 bg-violet-950/40 text-violet-200" : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
        }`}
      >
        {uploading ? (
          <div className="space-y-2">
            <div className="truncate text-zinc-300">Uploading {uploading.name}</div>
            <Progress value={uploading.progress} />
          </div>
        ) : (
          <>Drop videos or music here, or click to browse</>
        )}
        <input ref={input} type="file" accept=".mp4,.mov,.m4v,.webm,.mp3,.wav,.m4a,.aac,.ogg,video/*,audio/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
      </div>
      <ul className="space-y-2 px-2 pb-2">
        {sources.map((s) => (
          <li key={s.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
            <div className="flex gap-2">
              {s.kind === "video" && s.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(s.thumbnail_url)} alt="" className="h-12 w-20 flex-none rounded bg-zinc-800 object-cover" />
              ) : (
                <div className="flex h-12 w-20 flex-none items-center justify-center rounded bg-emerald-900/50 text-xl text-emerald-200">♪</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-zinc-200" title={s.filename}>
                  {s.filename}
                </div>
                <div className="mt-0.5 text-[10px] leading-4 text-zinc-500">
                  {fmtTime(s.duration)}
                  {s.kind === "video" ? ` · ${s.width}×${s.height} · ${Math.round(s.fps)} fps` : " · audio"}
                  <br />
                  {s.kind === "video" ? (s.has_audio ? `${s.video_codec} / ${s.audio_codec}` : `${s.video_codec} / no audio`) : s.audio_codec} · {fmtBytes(s.size_bytes)}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {s.kind === "video" && (
                <>
                  <Button onClick={() => run("add_clip", { source_id: s.id })} title="Add to the end of the main video track">+ Timeline</Button>
                  <Button onClick={() => run("add_broll", { source_id: s.id, timeline_start: clock.time, start: 0, end: Math.min(s.duration, 3) })} title="Lay it over the main video at the playhead">+ B-roll</Button>
                </>
              )}
              {s.has_audio && (
                <Button onClick={() => run("add_audio", { source_id: s.id, timeline_start: s.kind === "audio" ? 0 : clock.time, role: "music" })} title="Use as background music">
                  + Music
                </Button>
              )}
              {s.has_audio && s.kind === "video" && !s.has_transcript && <Button onClick={() => run("transcribe", { source_id: s.id })}>Transcribe</Button>}
              {s.has_transcript && <Badge tone="green">transcript</Badge>}
              {s.kind === "video" && !s.filmstrip_url && <Badge tone="amber">preparing…</Badge>}
            </div>
          </li>
        ))}
        {!sources.length && <li className="px-1 text-xs text-zinc-500">No footage yet.</li>}
      </ul>
    </Panel>
  );
}
