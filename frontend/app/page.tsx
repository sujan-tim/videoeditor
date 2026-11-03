"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { MediaBin } from "@/components/MediaBin";
import { Player } from "@/components/Player";
import { ActivityPanel, ExportPanel, HistoryPanel } from "@/components/SidePanels";
import { Timeline } from "@/components/Timeline";
import { Badge, Button, Panel } from "@/components/ui";
import { api, type ChatMessage, type Health, type Job, type LogEntry, type Project, type ProjectListItem } from "@/lib/api";

type Tab = "chat" | "export" | "activity";

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<Tab>("chat");
  const [playhead, setPlayhead] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [autoPreview, setAutoPreview] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const attempted = useRef<number>(-1);

  const showError = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  }, []);

  // ---- boot ---------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        setHealth(await api.health());
        const list = await api.listProjects();
        setProjects(list);
        const saved = typeof window !== "undefined" ? localStorage.getItem("ve.project") : null;
        const pick = list.find((p) => p.id === saved)?.id ?? list[0]?.id;
        if (pick) setProjectId(pick);
        else {
          const p = await api.createProject("My first edit");
          setProjects([{ id: p.id, name: p.name, created_at: Date.now() / 1000, version: p.version, sources: 0, duration: 0 }]);
          setProjectId(p.id);
        }
      } catch {
        setBackendDown(true);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, j, c, l] = await Promise.all([api.getProject(projectId), api.jobs(projectId), api.chat(projectId), api.log(projectId)]);
      setProject(p);
      setJobs(j);
      setChat(c);
      setLog(l);
      setBackendDown(false);
    } catch {
      setBackendDown(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem("ve.project", projectId);
    } catch {}
    attempted.current = -1;
    refresh();
  }, [projectId, refresh]);

  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    const id = setInterval(refresh, active ? 1200 : 4000);
    return () => clearInterval(id);
  }, [refresh, active]);

  // Re-render the preview automatically once the plan settles on a new version.
  useEffect(() => {
    if (!project || !autoPreview || active || !project.timeline.length) return;
    const latest = [...project.renders].reverse().find((r) => r.mode === "preview");
    if (latest?.version === project.version || attempted.current === project.version) return;
    attempted.current = project.version;
    api.render(project.id, "preview").then(refresh).catch((e) => showError(e.message));
  }, [project, active, autoPreview, refresh, showError]);

  const run = useCallback(
    async (tool: string, args: Record<string, unknown> = {}) => {
      if (!projectId) return;
      try {
        const res = await api.tool(projectId, tool, args);
        if (res.project) setProject(res.project);
        await refresh();
      } catch (e) {
        showError((e as Error).message);
      }
    },
    [projectId, refresh, showError],
  );

  const seek = (t: number) => {
    setPlayhead(t);
    const latest = project && [...project.renders].reverse().find((r) => r.mode === "preview");
    if (video.current && latest) video.current.currentTime = t;
  };

  async function newProject() {
    const name = prompt("Project name", "Untitled project");
    if (!name) return;
    const p = await api.createProject(name);
    setProjects(await api.listProjects());
    setProjectId(p.id);
  }

  if (backendDown && !project) {
    return (
      <main className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-300">
        <div className="max-w-md space-y-2 text-sm">
          <h1 className="text-lg font-semibold text-zinc-100">Backend not reachable</h1>
          <p>
            Start it with <code className="rounded bg-zinc-800 px-1">uvicorn app.main:app --port 8000</code> in <code>backend/</code>, then reload. This page expects it at{" "}
            <code>{process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}</code>.
          </p>
        </div>
      </main>
    );
  }
  if (!project) return <main className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">Loading…</main>;

  const agentJob = jobs.find((j) => j.kind === "agent");
  const previewJob = jobs.find((j) => j.kind === "render_preview");
  const runningCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;

  return (
    <main className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <div className="text-sm font-semibold tracking-tight">
          <span className="text-violet-400">◆</span> AI Video Editor
        </div>
        <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={newProject}>
          + New project
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-400">
          {backendDown && <Badge tone="red">backend offline</Badge>}
          {runningCount > 0 ? <Badge tone="amber">{runningCount} job{runningCount > 1 ? "s" : ""} running</Badge> : <Badge tone="green">idle</Badge>}
          <Badge tone={health?.claude_configured ? "violet" : "zinc"}>{health?.claude_configured ? health.claude_model : "Claude not configured"}</Badge>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={autoPreview} onChange={(e) => setAutoPreview(e.target.checked)} className="accent-violet-500" />
            auto preview
          </label>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_380px] gap-2 p-2">
        <div className="flex min-h-0 flex-col gap-2">
          <MediaBin project={project} onChange={refresh} onError={showError} />
          <Panel title={`History · v${project.version}`} className="max-h-[45%]">
            <HistoryPanel project={project} onRestore={(v) => api.restore(project.id, v).then(setProject).then(refresh).catch((e) => showError(e.message))} />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <Player ref={video} project={project} previewJob={previewJob} onRender={() => api.render(project.id, "preview").then(refresh).catch((e) => showError(e.message))} onTime={setPlayhead} />
          <Timeline project={project} playhead={playhead} onSeek={seek} run={run} />
        </div>

        <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/70">
          <nav className="flex border-b border-zinc-800 text-xs">
            {(["chat", "export", "activity"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 px-3 py-2 capitalize ${tab === t ? "border-b-2 border-violet-500 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
                {t === "chat" ? "AI editor" : t === "activity" ? `Status${runningCount ? ` (${runningCount})` : ""}` : "Export"}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {tab === "chat" && <ChatPanel project={project} chat={chat} agentJob={agentJob} claudeReady={!!health?.claude_configured} onSent={refresh} onError={showError} />}
            {tab === "export" && <ExportPanel project={project} jobs={jobs} run={run} onError={showError} onChange={refresh} />}
            {tab === "activity" && <ActivityPanel jobs={jobs} log={log} />}
          </div>
        </section>
      </div>

      {toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-100 shadow-lg">{toast}</div>}
    </main>
  );
}
