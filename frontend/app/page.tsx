"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { Inspector } from "@/components/Inspector";
import { LivePlayer } from "@/components/LivePlayer";
import { MediaBin } from "@/components/MediaBin";
import { Player } from "@/components/Player";
import { ActivityPanel, ExportPanel, HistoryPanel } from "@/components/SidePanels";
import { Timeline, type Selection } from "@/components/Timeline";
import { Badge, Button } from "@/components/ui";
import { api, type ChatMessage, type Health, type Job, type LogEntry, type Plan, type Project, type ProjectListItem, type Word } from "@/lib/api";
import { clock } from "@/lib/clock";
import { placeClips } from "@/lib/engine";

type Tab = "edit" | "chat" | "export" | "activity";
type LeftTab = "media" | "history";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<Tab>("edit");
  const [leftTab, setLeftTab] = useState<LeftTab>("media");
  const [view, setView] = useState<"live" | "rendered">("live");
  const [toast, setToast] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<Plan | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const showError = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  }, []);

  // ---- boot ---------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const session = await api.session();
        if (session.auth_required && !session.authenticated) {
          setNeedLogin(true);
          return;
        }
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
    setSelection(null);
    setDraft(null);
    clock.pause();
    clock.seek(0);
    refresh();
  }, [projectId, refresh]);

  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    const id = setInterval(refresh, active ? 1500 : 5000);
    return () => clearInterval(id);
  }, [refresh, active]);

  // caption words for the live preview, mapped onto the timeline by the backend
  const subsOn = project?.plan.subtitles.enabled;
  useEffect(() => {
    if (!project || !subsOn) {
      setWords([]);
      return;
    }
    api.captions(project.id).then(setWords).catch(() => setWords([]));
  }, [project?.id, project?.version, subsOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan: Plan | null = draft ?? project?.plan ?? null;

  const run = useCallback(
    async (tool: string, args: Record<string, unknown> = {}): Promise<boolean> => {
      if (!projectId) return false;
      try {
        const res = await api.tool(projectId, tool, args);
        if (res.project) setProject(res.project);
        refresh();
        return true;
      } catch (e) {
        showError((e as Error).message);
        refresh();
        return false;
      }
    },
    [projectId, refresh, showError],
  );

  // Inspector edits: show instantly on the draft plan, save once the control settles.
  const planRef = useRef(plan);
  planRef.current = plan;
  const commit = useCallback(
    (tool: string, args: Record<string, unknown>, mutate?: (p: Plan) => void, key = tool) => {
      if (mutate && planRef.current) {
        const next = clone(planRef.current);
        mutate(next);
        setDraft(next);
      }
      const timers = pending.current;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(
        key,
        setTimeout(async () => {
          timers.delete(key);
          await run(tool, args);
          if (!timers.size) setDraft(null);
        }, 450),
      );
    },
    [run],
  );

  const undo = useCallback(async () => {
    if (!project) return;
    try {
      setProject(await api.undo(project.id));
      setDraft(null);
      refresh();
    } catch (e) {
      showError((e as Error).message);
    }
  }, [project, refresh, showError]);
  const redo = useCallback(async () => {
    if (!project) return;
    try {
      setProject(await api.redo(project.id));
      setDraft(null);
      refresh();
    } catch (e) {
      showError((e as Error).message);
    }
  }, [project, refresh, showError]);

  const deleteSelection = useCallback(async () => {
    if (!selection) return;
    const tool = { clip: "delete_clip", broll: "remove_broll", audio: "remove_audio", text: "remove_text_overlay" }[selection.kind];
    const key = { clip: "clip_id", broll: "broll_id", audio: "audio_id", text: "overlay_id" }[selection.kind];
    if (await run(tool, { [key]: selection.id })) setSelection(null);
  }, [selection, run]);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === " ") {
        e.preventDefault();
        clock.toggle();
      } else if (e.key === "s" || e.key === "S") {
        if (plan && placeClips(plan).some((p) => clock.time > p.start + 0.05 && clock.time < p.end - 0.05)) run("split_clip", { timeline_time: clock.time });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        clock.pause();
        clock.seek(clock.time + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30));
      } else if (e.key === "Home") clock.seek(0);
      else if (e.key === "End") clock.seek(clock.duration);
      else if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, run, deleteSelection, plan]);

  // drop a selection that no longer exists (after undo, AI edits...)
  useEffect(() => {
    if (!selection || !plan) return;
    const list = { clip: plan.clips, broll: plan.broll, audio: plan.audio, text: plan.overlays }[selection.kind] as { id: string }[];
    if (!list.some((x) => x.id === selection.id)) setSelection(null);
  }, [plan, selection]);

  const select = useCallback((s: Selection) => {
    setSelection(s);
    if (s) setTab("edit");
  }, []);

  async function newProject() {
    const name = prompt("Project name", "Untitled project");
    if (!name) return;
    const p = await api.createProject(name);
    setProjects(await api.listProjects());
    setProjectId(p.id);
  }

  const runningCount = useMemo(() => jobs.filter((j) => j.status === "queued" || j.status === "running").length, [jobs]);

  if (needLogin) return <Login />;
  if (backendDown && !project) {
    return (
      <main className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-300">
        <div className="max-w-md space-y-2 text-sm">
          <h1 className="text-lg font-semibold text-zinc-100">Backend not reachable</h1>
          <p>
            Start it with <code className="rounded bg-zinc-800 px-1">uvicorn app.main:app --port 8000</code> in <code>backend/</code>, then reload. This page expects it at{" "}
            <code>{process.env.NEXT_PUBLIC_API_URL || "the same address as this page"}</code>.
          </p>
        </div>
      </main>
    );
  }
  if (!project || !plan) return <main className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">Loading…</main>;

  const agentJob = jobs.find((j) => j.kind === "agent");
  const previewJob = jobs.find((j) => j.kind === "render_preview");
  const aiReady = !!health?.ai_configured;

  return (
    <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)_minmax(220px,34vh)] bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <div className="text-sm font-semibold tracking-tight">
          <span className="text-violet-400">◆</span> AI Video Editor
        </div>
        <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs" aria-label="Project">
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
          {runningCount > 0 ? <Badge tone="amber">{runningCount} job{runningCount > 1 ? "s" : ""} running</Badge> : <Badge tone="green">saved · v{project.version}</Badge>}
          <Badge tone={aiReady ? "violet" : "zinc"}>{aiReady ? `AI: ${health?.ai_model}` : "AI not set up"}</Badge>
          <Button variant="primary" onClick={() => setTab("export")}>
            Export
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)_360px]">
        <aside className="flex min-h-0 flex-col border-r border-zinc-800">
          <nav className="flex border-b border-zinc-800 text-xs">
            {(["media", "history"] as LeftTab[]).map((t) => (
              <button key={t} onClick={() => setLeftTab(t)} className={`flex-1 px-3 py-2 capitalize ${leftTab === t ? "border-b-2 border-violet-500 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
                {t === "media" ? "Media" : `History`}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {leftTab === "media" ? (
              <MediaBin project={project} onChange={refresh} onError={showError} />
            ) : (
              <HistoryPanel project={project} onRestore={(v) => api.restore(project.id, v).then(setProject).then(refresh).catch((e) => showError(e.message))} />
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center gap-1 border-b border-zinc-800 px-3 py-1 text-[11px]">
            {(["live", "rendered"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`rounded px-2 py-1 ${view === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
                {v === "live" ? "Live preview" : "Rendered file"}
              </button>
            ))}
            <span className="ml-auto text-zinc-600">{view === "live" ? "Plays your edit instantly in the browser; drag text on the video to move it" : "Exactly what FFmpeg produces"}</span>
          </div>
          {view === "live" ? (
            <LivePlayer
              project={project}
              plan={plan}
              words={words}
              selectedText={selection?.kind === "text" ? selection.id : null}
              onSelectText={(id) => select(id ? { kind: "text", id } : null)}
              onMoveText={(id, x, y) => run("update_text_overlay", { overlay_id: id, x, y })}
            />
          ) : (
            <div className="flex min-h-0 flex-1 p-2">
              <Player ref={video} project={project} previewJob={previewJob} onRender={() => api.render(project.id, "preview").then(refresh).catch((e) => showError(e.message))} onTime={() => {}} />
            </div>
          )}
        </section>

        <aside className="flex min-h-0 flex-col border-l border-zinc-800">
          <nav className="flex border-b border-zinc-800 text-xs">
            {(["edit", "chat", "export", "activity"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-2 ${tab === t ? "border-b-2 border-violet-500 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
                {{ edit: "Edit", chat: "AI editor", export: "Export", activity: `Status${runningCount ? ` (${runningCount})` : ""}` }[t]}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {tab === "edit" && <Inspector project={project} plan={plan} selection={selection} commit={commit} run={run} onSelect={select} />}
            {tab === "chat" && <ChatPanel project={project} chat={chat} agentJob={agentJob} aiReady={aiReady} onSent={refresh} onError={showError} />}
            {tab === "export" && <ExportPanel project={project} jobs={jobs} run={run} onError={showError} onChange={refresh} />}
            {tab === "activity" && <ActivityPanel jobs={jobs} log={log} />}
          </div>
        </aside>
      </div>

      <Timeline project={project} plan={plan} selection={selection} onSelect={select} run={run} setDraft={setDraft} onUndo={undo} onRedo={redo} onDelete={deleteSelection} />

      {toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-100 shadow-lg">{toast}</div>}
    </main>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-200">
      <form
        className="w-full max-w-xs space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.login(password);
            window.location.reload();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="text-sm font-semibold">
          <span className="text-violet-400">◆</span> AI Video Editor
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-violet-500"
        />
        {error && <div className="text-xs text-red-300">{error}</div>}
        <Button variant="primary" className="w-full py-2" disabled={busy || !password}>
          {busy ? "Checking…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
