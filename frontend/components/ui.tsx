"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles = {
    default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
    primary: "bg-violet-600 hover:bg-violet-500 text-white border border-violet-500",
    ghost: "hover:bg-zinc-800 text-zinc-300",
    danger: "bg-zinc-800 hover:bg-red-900/60 text-red-300 border border-zinc-700",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    />
  );
}

export function Panel({ title, actions, children, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/70 ${className}`}>
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
        <div className="flex items-center gap-1">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "violet" | "green" | "amber" | "red" | "sky" }) {
  const tones = {
    zinc: "bg-zinc-800 text-zinc-300",
    violet: "bg-violet-900/60 text-violet-200",
    green: "bg-emerald-900/60 text-emerald-200",
    amber: "bg-amber-900/60 text-amber-200",
    red: "bg-red-900/60 text-red-200",
    sky: "bg-sky-900/60 text-sky-200",
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${tones}`}>{children}</span>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-zinc-800">
      <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}
