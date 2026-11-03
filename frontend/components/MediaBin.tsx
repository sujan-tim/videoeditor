"use client";

import { useRef, useState } from "react";
import { api, fileUrl, fmtBytes, fmtTime, upload, type Project } from "@/lib/api";
import { Badge, Button, Panel, Progress } from "./ui";

export function MediaBin({ project, onChange, onError }: { project: Project; onChange: () => void; onError: (e: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [drag, setDrag] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!/\.(mp4|mov|m4v)$/i.test(file.name)) {
        onError(`${file.name}: only MP4 and MOV files are supported`);
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
          <>Drop MP4 or MOV files here, or click to browse</>
        )}
        <input ref={input} type="file" accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
      </div>
      <ul className="space-y-2 px-2 pb-2">
        {sources.map((s) => (
          <li key={s.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
            <div className="flex gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(s.thumbnail_url)} alt="" className="h-12 w-20 flex-none rounded bg-zinc-800 object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-zinc-200" title={s.filename}>
                  {s.filename}
                </div>
                <div className="mt-0.5 text-[10px] leading-4 text-zinc-500">
                  {fmtTime(s.duration)} · {s.width}×{s.height} · {Math.round(s.fps)} fps
                  <br />
                  {s.video_codec}
                  {s.has_audio ? ` / ${s.audio_codec}` : " / no audio"} · {fmtBytes(s.size_bytes)}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Button onClick={() => run("add_clip", { source_id: s.id })}>Add to timeline</Button>
              {s.has_audio && !s.has_transcript && <Button onClick={() => run("transcribe", { source_id: s.id })}>Transcribe</Button>}
              {s.has_transcript && <Badge tone="green">transcript</Badge>}
            </div>
          </li>
        ))}
        {!sources.length && <li className="px-1 text-xs text-zinc-500">No footage yet.</li>}
      </ul>
    </Panel>
  );
}
