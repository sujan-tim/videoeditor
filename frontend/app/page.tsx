"use client";

// Public landing page: describe an edit and open the online editor, or download the desktop app.
import { useEffect, useState, type ReactNode } from "react";
import { detectOS, DOWNLOADS, RELEASES_URL, REPO, savePendingPrompt, type Download } from "@/lib/site";

const EXAMPLES = [
  "Remove the pauses and add bold captions",
  "Make it a 9:16 Reel with upbeat music",
  "Cut it down to the best 60 seconds",
  "Add a title at the start and fade out at the end",
];

const TOOLS: { icon: string; title: string; body: string; prompt: string }[] = [
  { icon: "✂", title: "Rough cut in seconds", body: "Silences, ums and dead air are found and cut for you, and captions stay in sync.", prompt: "Remove the silences and filler pauses" },
  { icon: "▯", title: "Reframe for any platform", body: "TikTok, Reels, Shorts, YouTube, 4:5 and square, with fill, black bars or a blurred background.", prompt: "Make it vertical 9:16 for TikTok with a blurred background" },
  { icon: "CC", title: "Captions that pop", body: "Word-by-word captions in five styles, generated from your audio automatically.", prompt: "Add bold highlighted captions" },
  { icon: "♪", title: "Music that ducks", body: "Drop in a track and it fades in, fades out and dips whenever someone speaks.", prompt: "Add the music track under the whole video and duck it under speech" },
  { icon: "FX", title: "One-tap looks", body: "Cinematic, warm, cool, vivid, black and white, plus fine control of exposure and color.", prompt: "Give it a warm cinematic look" },
  { icon: "⧉", title: "B-roll and picture-in-picture", body: "Lay cutaways over your talking head, full frame or as a corner window.", prompt: "Put the second clip as B-roll over the middle of the video" },
  { icon: "»", title: "Speed and transitions", body: "Speed ramps, crossfades, wipes and slides between clips, previewed instantly.", prompt: "Add smooth crossfades between all clips" },
  { icon: "T", title: "Animated titles", body: "Titles, lower thirds and call-outs that pop, slide or type on.", prompt: "Add a title that pops in at the start saying 'My trip'" },
];

const FAQ = [
  { q: "Is it really free?", a: "Yes. The editor, the desktop app and exports are free. The AI editor runs on Groq's free tier, so the online editor costs nothing, and in the desktop app you paste your own free Groq key once." },
  { q: "Does the AI replace editing by hand?", a: "No. The AI does the repetitive work you describe, and every change it makes lands on a normal timeline where you can trim, drag, undo or redo it yourself." },
  { q: "Can I edit my own footage?", a: "Yes, that is what it is for. Upload your clips and music and the editor works on those. Nothing is generated from stock unless you add it." },
  { q: "Where are my videos stored?", a: "In the online editor, on the editor's server while you work. In the desktop app, everything stays on your own computer." },
  { q: "What can I export?", a: "MP4 (H.264 + AAC) at the size of the platform you choose, from 9:16 vertical up to 4K landscape, with captions burned in or as an .srt file." },
  { q: "Why does my computer warn me when I open the app?", a: "The installers are not code-signed yet. On Windows choose More info → Run anyway. On a Mac open the app once, then click Open Anyway in System Settings → Privacy & Security." },
];

export default function Landing() {
  const [os, setOs] = useState<Download["os"] | null>(null);
  // Which installers the latest GitHub release actually has (null = still checking or unknown).
  const [available, setAvailable] = useState<Set<string> | null>(null);
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    setOs(detectOS());
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : r.status === 404 ? { assets: [] } : null))
      .then((rel) => rel && setAvailable(new Set((rel.assets ?? []).map((a: { name: string }) => a.name))))
      .catch(() => {});
  }, []);
  const ready = (d: Download) => available === null || available.has(d.file);
  const primary = DOWNLOADS.find((d) => d.os === os);

  function start(text: string) {
    if (text.trim()) savePendingPrompt(text.trim());
    window.location.href = "/edit/";
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-zinc-950 text-zinc-100">
      <nav className="sticky top-0 z-30 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3.5">
          <a href="/" className="text-sm font-semibold tracking-tight">
            <span className="text-violet-400">◆</span> AI Video Editor
          </a>
          <div className="ml-auto flex items-center gap-5 text-sm text-zinc-400">
            <a href="#tools" className="hidden hover:text-zinc-100 md:inline">Tools</a>
            <a href="#how" className="hidden hover:text-zinc-100 md:inline">How it works</a>
            <a href="#download" className="hidden hover:text-zinc-100 sm:inline">Download</a>
            <a href="#faq" className="hidden hover:text-zinc-100 md:inline">FAQ</a>
            <a href="/edit/" className="rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900 hover:bg-white">Start editing free</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[520px] max-w-4xl rounded-full bg-violet-700/25 blur-[120px]" />
        <div className="relative mx-auto max-w-6xl px-5 pb-10 pt-14 text-center sm:pt-20">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1 text-xs text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Free AI video editor, online or on your desktop
          </div>
          <h1 className="mx-auto max-w-4xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Describe the edit.
            <br />
            <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-amber-200 bg-clip-text text-transparent">Watch it happen.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-zinc-400 sm:text-lg">
            Type what you want and the AI cuts pauses, adds captions, music and B-roll, and formats for every platform. Then fine-tune anything on a real timeline.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(prompt);
            }}
            className="mx-auto mt-9 max-w-2xl rounded-2xl border border-zinc-700/80 bg-zinc-900/80 p-2 text-left shadow-2xl shadow-violet-950/50 focus-within:border-violet-500"
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  start(prompt);
                }
              }}
              rows={2}
              placeholder="e.g. Remove the pauses, add captions and make it a Reel"
              className="w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-zinc-500 sm:text-base"
              data-testid="hero-prompt"
            />
            <div className="flex items-center gap-2 px-1 pb-1">
              <span className="text-xs text-zinc-500">Next you&apos;ll upload your video.</span>
              <button type="submit" className="ml-auto whitespace-nowrap rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500" data-testid="cta-online">
                Start editing free →
              </button>
            </div>
          </form>
          <div className="mx-auto mt-3 flex max-w-2xl flex-wrap justify-center gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => setPrompt(ex)} className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-400 hover:border-violet-500 hover:text-zinc-200">
                {ex}
              </button>
            ))}
          </div>
          <p className="mt-6 text-sm text-zinc-500">
            Prefer an app?{" "}
            <a href={primary && ready(primary) ? primary.url : "#download"} className="text-zinc-300 underline decoration-zinc-600 underline-offset-4 hover:text-white" data-testid="cta-download">
              {primary ? (ready(primary) ? `Download for ${primary.label}` : `${primary.label} app coming soon`) : "Download the desktop app"}
            </a>
          </p>

          <EditorMockup />
        </div>
      </section>

      {/* Platform strip */}
      <section className="border-y border-zinc-800/70 bg-zinc-900/30 py-5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-5 text-sm text-zinc-500">
          <span className="text-xs uppercase tracking-widest text-zinc-600">Export ready for</span>
          {["TikTok", "Instagram Reels", "YouTube Shorts", "YouTube", "LinkedIn", "Facebook", "X"].map((p) => (
            <span key={p} className="font-medium text-zinc-400">{p}</span>
          ))}
        </div>
      </section>

      {/* Tools grid */}
      <section id="tools" className="mx-auto max-w-6xl scroll-mt-16 px-5 py-20">
        <SectionHead kicker="Tools" title="Every tedious editing job, done by asking" body="Each of these is a real tool the AI uses on your timeline. Click Try it to open the editor with the request ready to send." />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((t) => (
            <div key={t.title} className="group flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 transition hover:border-violet-700/70 hover:bg-zinc-900/80">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/15 text-sm font-semibold text-violet-300">{t.icon}</div>
              <div className="mt-4 text-sm font-semibold text-zinc-100">{t.title}</div>
              <p className="mt-1.5 flex-1 text-sm leading-6 text-zinc-400">{t.body}</p>
              <button onClick={() => start(t.prompt)} className="mt-4 self-start text-sm font-medium text-violet-300 hover:text-violet-200">
                Try it →
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Showcase */}
      <section className="mx-auto max-w-6xl space-y-20 px-5 pb-20">
        <Showcase
          kicker="Edit by talking"
          title="Say it the way you'd tell an editor"
          body="&ldquo;Tighten the intro, add captions and make it a Short.&rdquo; The AI checks your footage, plans the edit, applies it and tells you what changed. Not quite right? Just reply."
          visual={<ChatVisual />}
        />
        <Showcase
          flip
          kicker="Full control"
          title="A real timeline, not a black box"
          body="Every AI change lands on tracks you can see. Drag to reorder, pull edges to trim, split at the playhead, and undo anything. The preview updates the moment you let go."
          visual={<TimelineVisual />}
        />
        <Showcase
          kicker="Instant preview"
          title="No waiting for renders to see your edit"
          body="Cuts, speed, color, transitions, text and captions play live in the browser. Export only when it looks right, at the exact size each platform wants."
          visual={<LooksVisual />}
        />
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-16 border-y border-zinc-800/70 bg-zinc-900/30">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <SectionHead kicker="How it works" title="From raw footage to finished video in three steps" />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              ["1", "Upload", "Drop in your clips, B-roll and music. Long videos get a fast preview copy automatically."],
              ["2", "Describe or edit", "Tell the AI what you want, or edit by hand on the timeline. Mix both as you go."],
              ["3", "Export", "Pick a platform and export an MP4, with captions burned in or as a separate file."],
            ].map(([n, t, b]) => (
              <div key={n} className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold">{n}</div>
                <div className="mt-4 font-semibold">{t}</div>
                <p className="mt-1.5 text-sm leading-6 text-zinc-400">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Use cases */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead kicker="Made for" title="Built for people who post a lot" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["YouTubers", "Turn a long recording into a tight video, then cut Shorts from it."],
            ["Podcasters", "Clip the best moments with captions for every social feed."],
            ["Marketers", "Product demos and ads in every aspect ratio from one edit."],
            ["Teachers", "Clean up lectures and add titles and captions for every student."],
          ].map(([t, b]) => (
            <div key={t} className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-950 p-5">
              <div className="font-semibold">{t}</div>
              <p className="mt-1.5 text-sm leading-6 text-zinc-400">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Download */}
      <section id="download" className="scroll-mt-16 border-y border-zinc-800/70 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-2">
          <div>
            <SectionHead left kicker="Two ways to edit" title="In your browser or on your computer" />
            <div className="mt-6 space-y-5 text-sm leading-6">
              <div>
                <div className="font-medium text-zinc-100">Online editor</div>
                <p className="text-zinc-400">Nothing to install. Your videos are uploaded to the editor&apos;s server and exported there. Best for short clips.</p>
              </div>
              <div>
                <div className="font-medium text-zinc-100">Desktop app</div>
                <p className="text-zinc-400">The same editor running on your computer with FFmpeg built in. Faster for long or 4K videos, handles big files, and keeps your footage private. The AI uses your own free Groq key.</p>
              </div>
            </div>
          </div>
          <div>
            <ul className="divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-950">
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
              The first launch shows a security warning because the installers are not code-signed yet (see the FAQ). All versions are on the{" "}
              <a href={RELEASES_URL} className="underline hover:text-zinc-300">releases page</a>.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-5 py-20">
        <SectionHead kicker="FAQ" title="Questions, answered" />
        <div className="mt-10 divide-y divide-zinc-800 rounded-2xl border border-zinc-800">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium">
                {f.q}
                <span className="text-zinc-500 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-zinc-400">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-5 pb-20">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-violet-800/50 bg-gradient-to-br from-violet-900/60 via-zinc-900 to-zinc-950 px-6 py-14 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your next video is one sentence away</h2>
          <p className="mx-auto mt-3 max-w-xl text-zinc-300">Free, no sign-up. Upload a clip and tell the editor what you want.</p>
          <a href="/edit/" className="mt-7 inline-block rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-200">Start editing free</a>
        </div>
      </section>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-xs text-zinc-500 sm:flex-row">
          <span>◆ AI Video Editor</span>
          <span className="sm:ml-auto">
            Built with FFmpeg, Whisper and open models on Groq.{" "}
            <a href={`https://github.com/${REPO}`} className="underline hover:text-zinc-300">Source code</a>
          </span>
        </div>
      </footer>
    </main>
  );
}

function SectionHead({ kicker, title, body, left }: { kicker: string; title: string; body?: string; left?: boolean }) {
  return (
    <div className={left ? "" : "mx-auto max-w-2xl text-center"}>
      <div className="text-xs font-semibold uppercase tracking-widest text-violet-400">{kicker}</div>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {body && <p className="mt-3 text-zinc-400">{body}</p>}
    </div>
  );
}

function Showcase({ kicker, title, body, visual, flip }: { kicker: string; title: string; body: string; visual: ReactNode; flip?: boolean }) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div className={flip ? "lg:order-2" : ""}>
        <SectionHead left kicker={kicker} title={title} />
        <p className="mt-4 leading-7 text-zinc-400" dangerouslySetInnerHTML={{ __html: body }} />
        <a href="/edit/" className="mt-6 inline-block text-sm font-medium text-violet-300 hover:text-violet-200">Try it free →</a>
      </div>
      <div className={flip ? "lg:order-1" : ""}>{visual}</div>
    </div>
  );
}

/* ---------- Illustrations (pure CSS, no media files) ---------- */

function Frame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-xl shadow-black/40 ${className}`}>{children}</div>;
}

function FakeVideo({ caption, tint = "from-indigo-500/50 via-fuchsia-500/30 to-amber-400/40", tall }: { caption?: string; tint?: string; tall?: boolean }) {
  return (
    <div className={`relative overflow-hidden rounded-lg bg-gradient-to-br ${tint} ${tall ? "aspect-[9/16]" : "aspect-video"}`}>
      <div className="absolute bottom-[18%] left-1/2 h-[46%] w-[34%] -translate-x-1/2 rounded-t-full bg-zinc-950/40" />
      <div className="absolute bottom-[58%] left-1/2 h-[22%] w-[20%] -translate-x-1/2 rounded-full bg-zinc-950/40" />
      {caption && (
        <div className="absolute inset-x-0 bottom-[8%] text-center text-[11px] font-extrabold uppercase tracking-wide text-white drop-shadow sm:text-sm">
          {caption.split(" ").map((w, i) => (
            <span key={i} className={i === 1 ? "mx-0.5 rounded bg-yellow-300 px-1 text-zinc-900" : "mx-0.5"}>{w}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function EditorMockup() {
  return (
    <div className="relative mx-auto mt-14 max-w-5xl text-left">
      <div className="absolute -inset-4 rounded-3xl bg-gradient-to-b from-violet-600/20 to-transparent blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
          <span className="ml-3 text-xs text-zinc-500">my-vlog.mp4 · 9:16 Reel</span>
          <span className="ml-auto rounded bg-violet-600 px-2 py-0.5 text-[10px] font-semibold">Export</span>
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-[1fr_auto_1fr]">
          <div className="hidden space-y-2 md:block">
            {["Clip 1 · 0:42", "B-roll · 0:08", "Music · 2:10"].map((m, i) => (
              <div key={m} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2">
                <div className={`h-8 w-12 rounded bg-gradient-to-br ${["from-indigo-500/60 to-fuchsia-500/40", "from-emerald-500/50 to-sky-500/40", "from-amber-500/50 to-rose-500/40"][i]}`} />
                <span className="text-xs text-zinc-400">{m}</span>
              </div>
            ))}
          </div>
          <div className="mx-auto w-40 sm:w-48">
            <FakeVideo tall caption="This is huge" />
          </div>
          <div className="space-y-2 text-xs">
            <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-violet-600 px-3 py-2 text-white">Remove the pauses, add captions and make it a Reel</div>
            <div className="max-w-[90%] rounded-xl rounded-bl-sm border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-300">
              <div className="mb-1.5 space-y-1 text-[11px] text-zinc-500">
                <div><span className="text-emerald-400">✓</span> Removed 14 pauses</div>
                <div><span className="text-emerald-400">✓</span> Captions: bold highlight</div>
                <div><span className="text-emerald-400">✓</span> Format: Instagram Reel 9:16</div>
              </div>
              Done. Your video went from 2:31 to 1:48.
            </div>
          </div>
        </div>
        <div className="border-t border-zinc-800 p-3">
          <TimelineRows />
        </div>
      </div>
    </div>
  );
}

function TimelineRows() {
  const row = (label: string, blocks: [number, number, string][]) => (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[10px] text-zinc-500">{label}</span>
      <div className="relative h-6 flex-1 rounded bg-zinc-900">
        {blocks.map(([l, w, c], i) => (
          <div key={i} className={`absolute top-0.5 bottom-0.5 rounded ${c}`} style={{ left: `${l}%`, width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
  return (
    <div className="relative space-y-1.5">
      {row("Text", [[2, 18, "bg-amber-500/70"], [62, 14, "bg-amber-500/70"]])}
      {row("B-roll", [[34, 16, "bg-emerald-500/60"]])}
      {row("Video", [[0, 24, "bg-indigo-500/70"], [24.5, 30, "bg-indigo-500/70"], [55, 22, "bg-indigo-500/70"], [77.5, 22, "bg-indigo-500/70"]])}
      {row("Music", [[0, 100, "bg-rose-500/40"]])}
      <div className="pointer-events-none absolute -top-1 -bottom-1 left-[48%] w-0.5 animate-pulse bg-white" />
    </div>
  );
}

function ChatVisual() {
  return (
    <Frame className="space-y-3 text-sm">
      <div className="ml-auto max-w-[80%] rounded-xl rounded-br-sm bg-violet-600 px-3 py-2 text-white">Tighten the intro and make it a YouTube Short</div>
      <div className="max-w-[85%] rounded-xl rounded-bl-sm border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-300">
        I cut the first 6 seconds of setup, removed 3 pauses and switched to 9:16 with a blurred background. It&apos;s now 54 seconds.
      </div>
      <div className="ml-auto max-w-[80%] rounded-xl rounded-br-sm bg-violet-600 px-3 py-2 text-white">Add music and a title that pops in</div>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" /> Adding music track…
      </div>
    </Frame>
  );
}

function TimelineVisual() {
  return (
    <Frame>
      <div className="mb-3 flex gap-2 text-[11px] text-zinc-500">
        {["Split", "Undo", "Redo", "Snap"].map((b) => (
          <span key={b} className="rounded border border-zinc-800 px-2 py-0.5">{b}</span>
        ))}
        <span className="ml-auto font-mono">00:31.5</span>
      </div>
      <TimelineRows />
    </Frame>
  );
}

function LooksVisual() {
  const looks: [string, string][] = [
    ["Original", ""],
    ["Cinematic", "contrast-125 saturate-75 sepia-[.15]"],
    ["Warm", "sepia-[.35] saturate-150"],
    ["B&W", "grayscale"],
  ];
  return (
    <Frame className="grid grid-cols-2 gap-3">
      {looks.map(([name, f]) => (
        <div key={name}>
          <div className={f}>
            <FakeVideo />
          </div>
          <div className="mt-1.5 text-xs text-zinc-400">{name}</div>
        </div>
      ))}
    </Frame>
  );
}
