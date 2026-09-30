"use client";

import { useMemo, useState } from "react";
import { Download, Search as SearchIcon, X } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { Panel, Tag, formatTime } from "./edge-ui";

const KIND_TONE: Record<string, "ok" | "warn" | "crit" | "neutral" | "dim"> = {
  write: "ok", sync: "ok", seed: "dim", bootstrap: "neutral", search: "neutral",
  connectivity: "warn", queue: "warn", demo: "dim", conflict: "crit", policy: "neutral", system: "dim",
};

/** meta fields worth surfacing, in priority order */
const META_KEYS = ["shard", "slug", "latency_ms", "queue_depth", "sync_state", "mode", "criticality", "action"] as const;

function metaValue(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return String(v);
  return null;
}

/** Append-only event log: every write, search, sync, link change and decision on this device. */
export default function ActivityLog({ edge }: { edge: EdgeHook }) {
  const [kind, setKind] = useState("all");
  const [text, setText] = useState("");
  const activity = edge.activity;

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of activity) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [activity]);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return activity.filter((e) =>
      (kind === "all" || e.kind === kind) &&
      (!q || `${e.message} ${e.kind} ${e.device} ${JSON.stringify(e.meta ?? {})}`.toLowerCase().includes(q)));
  }, [activity, kind, text]);

  function exportLog() {
    // messages embed caller-supplied slugs/queries: keep one row per event and neutralise formula cells
    const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]/g, " ").replace(/^[=+\-@]/, "'$&");
    const lines = visible.map((e) =>
      [new Date(e.ts).toISOString(), e.device, e.kind, e.message, JSON.stringify(e.meta ?? {})].map(cell).join("\t")
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

  const filtered = kind !== "all" || text.trim() !== "";

  return (
    <Panel
      title="Event log"
      right={
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{filtered ? `${visible.length} of ${activity.length}` : activity.length}</span>
          <Button size="sm" variant="ghost" onClick={exportLog} disabled={visible.length === 0} title="Export the visible events as TSV" className="gap-1.5 text-muted-foreground">
            <Download className="h-4 w-4" /> Export
          </Button>
        </div>
      }
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter by message, device or detail…"
            aria-label="Filter events"
            className="h-8 w-full rounded-md border border-border bg-background pr-7 pl-8 text-sm text-foreground placeholder:text-muted-foreground"
          />
          {text && (
            <button type="button" onClick={() => setText("")} aria-label="Clear filter" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Event kind"
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
        >
          <option value="all">All kinds</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-12 sm:px-5 text-center text-sm text-muted-foreground">
          {activity.length === 0 ? "Events from this device stream in here." : "Nothing matches that filter."}
        </p>
      ) : (
        <ol className="max-h-[560px] divide-y divide-border overflow-y-auto">
          {visible.map((e) => {
            const chips: string[] = [];
            for (const k of META_KEYS) {
              const v = metaValue(e.meta?.[k]);
              if (v !== null) chips.push(`${k} ${v}`);
              if (chips.length >= 2) break;
            }
            return (
              <li key={`${e.ts}-${e.message}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5 text-sm sm:flex-nowrap">
                <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{formatTime(e.ts)}</span>
                <Tag tone={KIND_TONE[e.kind] ?? "dim"} className="w-24 justify-center">{e.kind}</Tag>
                <span className="min-w-0 flex-1 basis-full text-foreground/85 sm:basis-auto">
                  {e.message}
                  {chips.length > 0 && <span className="ml-2 font-mono text-xs text-muted-foreground">{chips.join(" · ")}</span>}
                </span>
                <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:inline">{e.device}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
