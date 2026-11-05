"use client";

import { useEffect, useRef, useState } from "react";
import { api, fileUrl, type ChatMessage, type Job, type Project } from "@/lib/api";
import { Badge, Button } from "./ui";

const SUGGESTIONS = [
  "Remove unnecessary pauses, add subtitles, make the video 9:16, and prepare it for Instagram Reels.",
  "Trim the first 3 seconds and add a title \"Day 1\" at the top for the first 4 seconds.",
  "Look at the footage and tell me what it shows and how you would cut it.",
  "Lower the volume to 70% and normalize the audio for YouTube.",
];

type Props = {
  project: Project;
  chat: ChatMessage[];
  agentJob: Job | undefined;
  aiReady: boolean;
  desktop?: boolean;
  onKeySaved?: () => void;
  onSent: () => void;
  onError: (e: string) => void;
};

export function ChatPanel({ project, chat, agentJob, aiReady, desktop, onKeySaved, onSent, onError }: Props) {
  const [text, setText] = useState("");
  const [approval, setApproval] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const working = agentJob && (agentJob.status === "queued" || agentJob.status === "running");

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length, working]);

  async function send(message: string) {
    if (!message.trim() || working) return;
    try {
      await api.sendChat(project.id, message.trim(), approval);
      setText("");
      onSent();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!aiReady && desktop && <KeyForm onSaved={onKeySaved} onError={onError} />}
        {!aiReady && !desktop && (
          <div className="rounded-md border border-amber-800 bg-amber-950/40 p-2 text-xs leading-5 text-amber-200">
            The AI editor needs a free Groq key. Create one at <a className="underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>, then set <code>GROQ_API_KEY</code> in your Render environment (or <code>backend/.env</code>) and restart. Manual editing works without it.
          </div>
        )}
        {!chat.length && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">Tell the editor what you want. It inspects the footage, plans the edit, applies it with real tools and renders a preview. Every change is saved in History.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => setText(s)} className="block w-full rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-left text-xs text-zinc-300 hover:border-violet-600">
                {s}
              </button>
            ))}
          </div>
        )}
        {chat.map((m) => (
          <Message key={m.id} m={m} projectId={project.id} />
        ))}
        {project.pending_plan && !working && (
          <div className="rounded-md border border-violet-700 bg-violet-950/40 p-3 text-xs">
            <div className="mb-1 font-semibold text-violet-200">Proposed plan</div>
            <p className="mb-2 text-zinc-300">{project.pending_plan.summary}</p>
            <ol className="mb-3 list-decimal space-y-0.5 pl-4 text-zinc-300">
              {project.pending_plan.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => send("Approved. Apply the plan.")}>
                Approve and apply
              </Button>
              <Button onClick={() => setText("Change the plan: ")}>Request changes</Button>
            </div>
          </div>
        )}
        {working && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            {agentJob!.messages.at(-1) ?? "Working"}…
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-zinc-800 p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          rows={3}
          placeholder={working ? "The editor is working…" : "Describe an edit, or ask for a revision"}
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
        />
        <div className="mt-1 flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} className="accent-violet-500" />
            Show me the plan before editing
          </label>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              onClick={async () => {
                if (confirm("Clear the conversation? Edits and history are kept.")) {
                  await api.clearChat(project.id).catch((e) => onError(e.message));
                  onSent();
                }
              }}
              disabled={!!working || !chat.length}
            >
              Clear
            </Button>
            <Button variant="primary" onClick={() => send(text)} disabled={!!working || !text.trim()}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({ m, projectId }: { m: ChatMessage; projectId: string }) {
  if (m.role === "user") {
    return <div className="ml-6 rounded-lg bg-violet-700/40 px-3 py-2 text-sm text-zinc-100 whitespace-pre-wrap">{m.text}</div>;
  }
  if (m.role === "assistant") {
    return <div className="mr-4 rounded-lg bg-zinc-800/70 px-3 py-2 text-sm text-zinc-100 whitespace-pre-wrap">{m.text}</div>;
  }
  if (m.role === "error") {
    return <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">{m.text}</div>;
  }
  return (
    <details className="group rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-400">
      <summary className="flex cursor-pointer list-none items-center gap-1.5">
        <span className={m.ok ? "text-emerald-400" : "text-red-400"}>{m.ok ? "✓" : "✗"}</span>
        <span className="font-mono text-zinc-300">{m.tool}</span>
        <span className="truncate">{m.summary}</span>
      </summary>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px] text-zinc-500">{JSON.stringify(m.args, null, 1)}</pre>
      {!!m.images?.length && (
        <div className="mt-1 grid grid-cols-4 gap-1">
          {m.images.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p} src={fileUrl(`/files/${projectId}/${p}`)} alt="sampled frame" className="rounded" />
          ))}
        </div>
      )}
      {!m.ok && <Badge tone="red">the agent saw this error and can retry</Badge>}
    </details>
  );
}

function KeyForm({ onSaved, onError }: { onSaved?: () => void; onError: (e: string) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2 rounded-md border border-violet-800 bg-violet-950/30 p-3 text-xs leading-5 text-zinc-300"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.saveSettings(key);
          setKey("");
          onSaved?.();
        } catch (err) {
          onError((err as Error).message);
        }
        setBusy(false);
      }}
    >
      <div className="font-medium text-zinc-100">Turn on the AI editor (free)</div>
      <p>
        Create a free key at{" "}
        <a className="underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          console.groq.com/keys
        </a>{" "}
        and paste it here. It is saved only on this computer.
      </p>
      <div className="flex gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="gsk_..." className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 outline-none focus:border-violet-500" data-testid="groq-key" />
        <Button variant="primary" disabled={busy || !key.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
