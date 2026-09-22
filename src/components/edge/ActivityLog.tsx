"use client";

import { useMemo, useState } from "react";
import { Activity, Radio, Inbox, Search as SearchIcon, X, Download, BarChart3 } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { ActivityEntry } from "@/lib/edge-types";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Panel, formatTime } from "./edge-ui";

type KindFilter =
  | "all" | "write" | "search" | "sync" | "connectivity"
  | "conflict" | "policy" | "demo" | "seed" | "system";

const KIND_FILTERS: KindFilter[] = [
  "all", "write", "search", "sync", "connectivity",
  "conflict", "policy", "demo", "seed", "system",
];

/** dot + badge color per kind — emerald=sync/write, amber=connectivity/queue,
 *  rose=conflict, zinc=system/policy. sky used sparingly for search. */
const KIND_STYLE: Record<string, { dot: string; badge: string; label: string }> = {
  write:        { dot: "bg-emerald-400", badge: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10", label: "WRITE" },
  sync:         { dot: "bg-emerald-400", badge: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10", label: "SYNC" },
  seed:         { dot: "bg-emerald-400", badge: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10", label: "SEED" },
  search:       { dot: "bg-sky-400",     badge: "text-sky-300 border-sky-500/30 bg-sky-500/10",             label: "SEARCH" },
  connectivity: { dot: "bg-amber-400",   badge: "text-amber-300 border-amber-500/30 bg-amber-500/10",       label: "CONNECT" },
  queue:        { dot: "bg-amber-400",   badge: "text-amber-300 border-amber-500/30 bg-amber-500/10",       label: "QUEUE" },
  demo:         { dot: "bg-amber-400",   badge: "text-amber-300 border-amber-500/30 bg-amber-500/10",       label: "DEMO" },
  conflict:     { dot: "bg-rose-400",    badge: "text-rose-300 border-rose-500/30 bg-rose-500/10",          label: "CONFLICT" },
  policy:       { dot: "bg-zinc-400",    badge: "text-zinc-300 border-zinc-500/30 bg-zinc-500/10",          label: "POLICY" },
  system:       { dot: "bg-zinc-400",    badge: "text-zinc-300 border-zinc-500/30 bg-zinc-500/10",          label: "SYSTEM" },
};

const DEFAULT_STYLE = KIND_STYLE.system;

function styleFor(kind: string) {
  return KIND_STYLE[kind] ?? DEFAULT_STYLE;
}

/** meta fields we surface as mono chips (in priority order). */
const META_KEYS = ["shard", "slug", "latency_ms", "queue_depth", "sync_state", "mode", "criticality", "action"] as const;

function metaValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

export default function ActivityLog({ edge }: { edge: EdgeHook }) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const [textFilter, setTextFilter] = useState("");
  const activity = edge.activity;

  const visible = useMemo(() => {
    let v = filter === "all" ? activity : activity.filter((e) => e.kind === filter);
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase();
      v = v.filter((e) =>
        `${e.message} ${e.kind} ${e.device} ${JSON.stringify(e.meta ?? {})}`.toLowerCase().includes(q)
      );
    }
    return v;
  }, [activity, filter, textFilter]);

  // counts per kind for chip badges
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of activity) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [activity]);

  // top 4 kinds for stats summary
  const topKinds = useMemo(() => {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [counts]);

  function exportLog() {
    const lines = visible.map((e) =>
      `${new Date(e.ts).toISOString()}\t${e.device}\t${e.kind}\t${e.message}\t${JSON.stringify(e.meta ?? {})}`
    ).join("\n");
    const blob = new Blob([`timestamp\tdevice\tkind\tmessage\tmeta\n${lines}`], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `edge-activity-${Date.now()}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${visible.length} events as TSV` });
  }

  return (
    <Panel
      title="Activity Log"
      desc="Append-only edge event stream — writes, connectivity, policy decisions, sync, conflicts"
      right={
        <div className="flex items-center gap-2">
          <button
            onClick={exportLog}
            disabled={visible.length === 0}
            title="Export visible events as TSV"
            className="flex items-center gap-1 rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Download className="h-3 w-3" /> export
          </button>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1">
            <Radio className={cn(
              "h-3.5 w-3.5",
              edge.loading ? "text-amber-400 edge-pulse" : "text-emerald-400",
            )} />
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {visible.length}{textFilter || filter !== "all" ? `/${activity.length}` : ""} events
            </span>
          </div>
        </div>
      }
    >
      {/* stats summary */}
      {topKinds.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {topKinds.map(([kind, count]) => {
            const s = styleFor(kind);
            const pct = activity.length > 0 ? Math.round((count / activity.length) * 100) : 0;
            return (
              <div key={kind} className="rounded-md border border-border bg-background/30 px-2 py-1.5">
                <div className="flex items-center justify-between">
                  <span className={cn("flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider", s.badge.split(" ")[0])}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />{s.label}
                  </span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{count}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", s.dot)} style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* filter row */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {KIND_FILTERS.map((k) => {
          const active = filter === k;
          const count = k === "all" ? activity.length : counts[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                active
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-border bg-card/40 text-muted-foreground hover:border-border/80 hover:text-foreground",
              )}
            >
              {k}
              {k !== "all" && count > 0 && (
                <span className={cn(
                  "rounded-full px-1.5 text-[9px] tabular-nums",
                  active ? "bg-emerald-500/20 text-emerald-200" : "bg-muted text-muted-foreground",
                )}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* text search */}
      <div className="relative mb-3">
        <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="search events by message, kind, device, meta…"
          className="h-8 w-full rounded-md border border-border bg-background/50 pl-8 pr-7 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-emerald-500/40 focus:outline-none"
        />
        {textFilter && (
          <button onClick={() => setTextFilter("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* timeline */}
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <Inbox className="h-6 w-6 text-muted-foreground/40" />
          <p className="font-mono text-xs text-muted-foreground">{activity.length === 0 ? "Awaiting activity…" : "No events match the filter."}</p>
          <p className="text-[10px] text-muted-foreground/70">
            {activity.length === 0 ? "events from device-alpha will stream here in real time" : "try clearing the search or filter"}
          </p>
        </div>
      ) : (
        <ol className="max-h-[560px] space-y-1.5 overflow-y-auto edge-scroll pr-1">
          {visible.map((entry) => (
            <ActivityRow key={`${entry.ts}-${entry.message}`} entry={entry} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* row                                                                         */
/* -------------------------------------------------------------------------- */

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const s = styleFor(entry.kind);

  // pick up to 2 most relevant meta chips
  const metaChips: { k: string; v: string }[] = [];
  for (const k of META_KEYS) {
    const v = metaValue(entry.meta[k]);
    if (v !== null && v !== "") {
      metaChips.push({ k, v });
      if (metaChips.length >= 2) break;
    }
  }

  return (
    <li className="animate-in fade-in slide-in-from-top-1 flex items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-border/60 hover:bg-card/40">
      {/* left rail dot */}
      <div className="mt-1.5 flex flex-col items-center">
        <span className={cn("h-2 w-2 rounded-full", s.dot)} />
        <span className="mt-1 h-full w-px bg-border/40" />
      </div>

      {/* body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatTime(entry.ts)}
          </span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
              s.badge,
            )}
          >
            {s.label}
          </span>
          {entry.device && (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {entry.device}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground/90">
          {entry.message}
        </p>
        {metaChips.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {metaChips.map((c) => (
              <span
                key={c.k}
                className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                <span className="text-muted-foreground/60">{c.k}:</span>{" "}
                <span className="text-foreground/80">{c.v}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
