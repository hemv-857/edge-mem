"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const CRIT_STYLES: Record<string, string> = {
  critical: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  high: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  medium: "bg-sky-500/10 text-sky-300 border-sky-500/25",
  low: "bg-zinc-500/10 text-zinc-300 border-zinc-500/25",
};

export function CriticalityBadge({ value }: { value?: string }) {
  if (!value) return null;
  const cls = CRIT_STYLES[value] ?? CRIT_STYLES.low;
  return (
    <Badge variant="outline" className={cn("border font-mono text-[10px] uppercase tracking-wider", cls)}>
      {value}
    </Badge>
  );
}

const SYNC_STYLES: Record<string, string> = {
  synced: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  queued: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sync_now: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  local_only: "bg-zinc-500/10 text-zinc-400 border-zinc-500/25",
  conflict: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function SyncStateBadge({ value }: { value?: string }) {
  if (!value) return null;
  const cls = SYNC_STYLES[value] ?? "bg-zinc-500/10 text-zinc-400 border-zinc-500/25";
  const label = value === "sync_now" ? "SYNC-NOW" : value === "local_only" ? "LOCAL-ONLY" : value.toUpperCase();
  return (
    <Badge variant="outline" className={cn("border font-mono text-[10px] uppercase tracking-wider", cls)}>
      {label}
    </Badge>
  );
}

export function LatencyBadge({ ms, offline }: { ms: number; offline: boolean }) {
  let cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (offline) cls = "bg-amber-500/15 text-amber-300 border-amber-500/30";
  else if (ms > 200) cls = "bg-rose-500/15 text-rose-300 border-rose-500/30";
  else if (ms > 60) cls = "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return (
    <Badge variant="outline" className={cn("border font-mono text-[10px]", cls)}>
      {offline ? "OFFLINE" : `${ms.toFixed(1)} ms`}
    </Badge>
  );
}

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      <span
        className={cn(
          "absolute inline-flex h-full w-full rounded-full opacity-75",
          online ? "bg-emerald-400 edge-pulse" : "bg-amber-400"
        )}
      />
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", online ? "bg-emerald-400" : "bg-amber-400")} />
    </span>
  );
}

export function StatCard({
  label, value, sub, accent = "default", icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: "default" | "emerald" | "amber" | "rose";
  icon?: React.ReactNode;
}) {
  const ring =
    accent === "emerald" ? "edge-glow-emerald" :
    accent === "amber" ? "edge-glow-amber" :
    accent === "rose" ? "edge-glow-rose" : "";
  return (
    <div className={cn("rounded-lg border border-border bg-card/60 p-4 backdrop-blur-sm", ring)}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Panel({
  title, desc, right, children, className,
}: {
  title: string;
  desc?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card/40 backdrop-blur-sm", className)}>
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
        </div>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
