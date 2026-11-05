"use client";

// Public landing page: edit in the browser, or download the desktop app that does everything locally.
import { useEffect, useState } from "react";
import { detectOS, DOWNLOADS, RELEASES_URL, REPO, type Download } from "@/lib/site";

const FEATURES = [
  { title: "Instant preview", body: "Cuts, speed, color, transitions, text and captions play the moment you make them. No waiting for renders." },
  { title: "Real timeline", body: "Text, B-roll, video and music tracks. Drag to reorder, drag edges to trim, snap, split, undo." },
  { title: "Tell the AI what you want", body: "\"Remove the pauses, add captions and make it a Reel.\" The AI editor plans the edit and applies it with real tools." },
  { title: "Captions that pop", body: "Automatic word-by-word captions in five styles, kept in sync after every cut." },
  { title: "Music that behaves", body: "Background music fades in and out and dips automatically whenever someone speaks." },
  { title: "Every platform", body: "TikTok, Reels, Shorts, YouTube, 4:5 feed and square, with fill, black bars or blurred background." },
];

export default function Landing() {
  const [os, setOs] = useState<Download["os"] | null>(null);
  // Which installers the latest GitHub release actually has (null = still checking or unknown).
  const [available, setAvailable] = useState<Set<string> | null>(null);
  useEffect(() => {
    setOs(detectOS());
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : r.status === 404 ? { assets: [] } : null))
      .then((rel) => rel && setAvailable(new Set((rel.assets ?? []).map((a: { name: string }) => a.name))))
      .catch(() => {});
  }, []);
  const ready = (d: Download) => available === null || available.has(d.file);
  const primary = DOWNLOADS.find((d) => d.os === os);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-5">
        <div className="text-sm font-semibold tracking-tight">
          <span className="text-violet-400">◆</span> AI Video Editor
        </div>
        <div className="ml-auto flex items-center gap-5 text-sm text-zinc-400">
          <a href="#download" className="hover:text-zinc-100">
            Download
          </a>
          <a href="#features" className="hidden hover:text-zinc-100 sm:inline">
            Features
          </a>
          <a href="/edit/" className="rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900 hover:bg-white">
            Open editor
          </a>
        </div>
      </nav>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 text-center sm:pt-24">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
          Edit videos by hand, or just <span className="text-violet-400">say what you want</span>.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-zinc-400 sm:text-lg">
          A free video editor with an instant preview, a real timeline and an AI editor that cuts pauses, adds captions, music and B-roll, and formats for every platform.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href="/edit/" className="w-full rounded-lg bg-violet-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 hover:bg-violet-500 sm:w-auto" data-testid="cta-online">
            Edit online now
          </a>
          <a href={primary && ready(primary) ? primary.url : "#download"} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-6 py-3 text-sm font-semibold hover:border-zinc-500 sm:w-auto" data-testid="cta-download">
            {primary ? (ready(primary) ? `Download for ${primary.label}` : `${primary.label} app coming soon`) : "Download the app"}
          </a>
        </div>
        <p className="mt-3 text-xs text-zinc-500">Free. The desktop app edits on your own computer, so your footage never leaves it.</p>
      </section>

      <section id="download" className="border-y border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Two ways to edit</h2>
            <div className="mt-6 space-y-5 text-sm leading-6 text-zinc-300">
              <div>
                <div className="font-medium text-zinc-100">In your browser</div>
                <p className="text-zinc-400">Nothing to install. Your videos are uploaded to the editor&apos;s server and exported there. Best for short clips.</p>
              </div>
              <div>
                <div className="font-medium text-zinc-100">Desktop app</div>
                <p className="text-zinc-400">
                  The same editor, running on your computer with FFmpeg built in. Faster for long or 4K videos, works with big files, and keeps your footage private. The AI editor uses your own free Groq key.
                </p>
              </div>
            </div>
          </div>
          <div>
            <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-950">
              {DOWNLOADS.map((d) => (
                <li key={d.os} className="flex items-center gap-4 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {d.label} {d.os === os && <span className="ml-1 rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] text-violet-200">your system</span>}
                    </div>
                    <div className="text-xs text-zinc-500">{d.detail}</div>
                  </div>
                  {ready(d) ? (
                    <a href={d.url} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium hover:border-violet-400 hover:text-violet-200" data-testid={`dl-${d.os}`}>
                      Download
                    </a>
                  ) : (
                    <span className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">Coming soon</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-5 text-zinc-500">
              The installers are not code-signed yet, so the first launch shows a warning. On Windows choose <em>More info → Run anyway</em>. On a Mac, open the app once, then go to <em>System Settings → Privacy &amp; Security</em> and click <em>Open Anyway</em>. All versions are on the{" "}
              <a href={RELEASES_URL} className="underline hover:text-zinc-300">
                releases page
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">What you can do</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="text-sm font-medium text-zinc-100">{f.title}</div>
              <p className="mt-1.5 text-sm leading-6 text-zinc-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-xs text-zinc-500 sm:flex-row">
          <span>AI Video Editor</span>
          <span className="sm:ml-auto">
            Built with FFmpeg, Whisper and open models on Groq.{" "}
            <a href={`https://github.com/sujan-tim/videoeditor`} className="underline hover:text-zinc-300">
              Source code
            </a>
          </span>
        </div>
      </footer>
    </main>
  );
}
