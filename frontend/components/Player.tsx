"use client";

import { forwardRef } from "react";
import { fileUrl, type Job, type Project } from "@/lib/api";
import { Badge, Button, Progress } from "./ui";

type Props = {
  project: Project;
  previewJob: Job | undefined;
  onRender: () => void;
  onTime: (t: number) => void;
};

export const Player = forwardRef<HTMLVideoElement, Props>(function Player({ project, previewJob, onRender, onTime }, ref) {
  const preview = [...project.renders].reverse().find((r) => r.mode === "preview");
  const firstSource = project.timeline[0] ? project.sources[project.timeline[0].source_id] : Object.values(project.sources)[0];
  const src = preview ? fileUrl(preview.url) : firstSource ? fileUrl(firstSource.url) : null;
  const stale = preview && preview.version !== project.version;
  const busy = previewJob && (previewJob.status === "queued" || previewJob.status === "running");
  const [w, h] = project.output_size;

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-black">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-wider text-zinc-400">Preview</span>
          {preview ? (
            stale ? <Badge tone="amber">version {preview.version}, edits since</Badge> : <Badge tone="green">up to date · v{preview.version}</Badge>
          ) : firstSource ? (
            <Badge>raw source, not rendered</Badge>
          ) : null}
          <span className="text-zinc-500">
            {project.plan.output.aspect} · export {w}×{h}
          </span>
        </div>
        <Button variant="primary" onClick={onRender} disabled={!project.timeline.length || !!busy}>
          {busy ? "Rendering…" : "Render preview"}
        </Button>
      </div>
      {busy && (
        <div className="px-3 pt-2">
          <Progress value={previewJob!.progress} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {src ? (
          <video
            ref={ref}
            key={src}
            src={src}
            controls
            className="max-h-full max-w-full rounded bg-zinc-950"
            onTimeUpdate={(e) => preview && onTime((e.target as HTMLVideoElement).currentTime)}
          />
        ) : (
          <div className="text-sm text-zinc-500">Upload a video to start editing.</div>
        )}
      </div>
    </div>
  );
});
