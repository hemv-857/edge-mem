"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database, FileText, AlertTriangle, Gauge, HardDrive, Hash,
  PenSquare, Zap, Loader2, CheckCircle2, CircuitBoard, Cloud, Sparkles,
  Search as SearchIcon, Filter, X,
} from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { EdgePoint, MemoryShard, WriteResult } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Panel, CriticalityBadge, SyncStateBadge, formatBytes, formatRelative,
} from "./edge-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const SHARD_ORDER = ["manuals", "incidents", "sensors"] as const;

const SHARD_ICONS: Record<string, React.ReactNode> = {
  manuals: <FileText className="h-4 w-4 text-emerald-400" />,
  incidents: <AlertTriangle className="h-4 w-4 text-amber-400" />,
  sensors: <Gauge className="h-4 w-4 text-sky-400" />,
};

export default function MemoryExplorer({ edge }: { edge: EdgeHook }) {
  const memory = edge.memory;
  const shards = memory?.shards ?? {};
  const shardKeys = SHARD_ORDER.filter((k) => shards[k]) as string[];
  const [selected, setSelected] = useState<string>("manuals");
  // derive the effective shard during render so an invalid selection never
  // cascades into a setState-within-effect.
  const selectedShard = shardKeys.includes(selected)
    ? selected
    : (shardKeys[0] ?? "manuals");

  return (
    <Panel
      title="Memory Explorer"
      desc="Local EdgeShards on device-alpha — embedded vector memory, fully offline"
      right={
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1">
          <CircuitBoard className="h-3.5 w-3.5 text-emerald-400" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            FastEmbed · BM25
          </span>
        </div>
      }
    >
      {!memory ? (
        <MemoryLoadingSkeleton />
      ) : (
        <div className="space-y-5">
          {/* shard cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {shardKeys.map((key) => (
              <ShardCard
                key={key}
                shard={shards[key]}
                active={selectedShard === key}
                onClick={() => setSelected(key)}
              />
            ))}
          </div>

          {/* points + write form */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <PointsList key={selectedShard} edge={edge} shard={selectedShard} />
            </div>
            <div className="lg:col-span-1">
              <WriteForm edge={edge} shard={selectedShard} />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* shard card                                                                  */
/* -------------------------------------------------------------------------- */

function ShardCard({
  shard, active, onClick,
}: {
  shard: MemoryShard;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card/50 p-4 text-left transition-all duration-150 hover:bg-card/70",
        active
          ? "border-emerald-500/40 edge-glow-emerald"
          : "border-border hover:border-border/80",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/60">
            {SHARD_ICONS[shard.name] ?? <Database className="h-4 w-4 text-muted-foreground" />}
          </span>
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
            {shard.name}
          </span>
        </div>
        <SyncStateBadge value={shard.default_sync} />
      </div>

      <p className="mt-2 line-clamp-1 min-h-[16px] text-xs text-muted-foreground">{shard.desc}</p>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">
            {shard.points.toLocaleString()}
          </div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            points
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <HardDrive className="h-3 w-3" />
            {formatBytes(shard.disk_bytes)}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {shard.segments} seg
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-border/60 pt-2.5">
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3 text-emerald-400/70" />
          <span className="truncate">{shard.embedding}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <Hash className="h-3 w-3" />
          <span className="truncate">{shard.manifest_hash.slice(0, 16)}</span>
        </div>
      </div>

      {active && (
        <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20">
          <CheckCircle2 className="h-3 w-3 text-emerald-300" />
        </span>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* points list (fetches via edge API client directly)                          */
/* -------------------------------------------------------------------------- */

function PointsList({ edge, shard }: { edge: EdgeHook; shard: string }) {
  const [points, setPoints] = useState<EdgePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [critFilter, setCritFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    edgeApi
      .points(shard, undefined, 50)
      .then((r) => {
        if (cancelled) return;
        setPoints(r.points);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPoints([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // re-fetch when shard changes or the memory snapshot refreshes (point counts
    // move after a write/sync). the `loading=true` transition on shard change is
    // handled by remount via the parent's `key` prop, so this effect only sets
    // state inside async callbacks (no synchronous setState in the effect body).
  }, [shard, edge.memory]);

  // derive stats + filtered list directly from points (no effect needed)
  const stats = deriveStats(points);
  const filtered = points.filter((p) => {
    if (critFilter && p.criticality !== critFilter) return false;
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      const hay = `${p.slug ?? ""} ${p.title ?? ""} ${p.text ?? ""} ${p.asset_id ?? ""} ${p.origin_device ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const critChips = ["critical", "high", "medium", "low"] as const;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center justify-between border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-emerald-400" />
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
            points
          </span>
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {shard}
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {loading ? "loading…" : `${filtered.length}/${points.length} shown`}
        </span>
      </div>

      {/* stats summary bar */}
      {!loading && points.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatMini label="total" value={stats.total} accent="text-foreground" />
          <StatMini label="critical" value={stats.critical} accent={stats.critical > 0 ? "text-rose-400" : "text-muted-foreground"} />
          <StatMini label="local-only" value={stats.localOnly} accent={stats.localOnly > 0 ? "text-amber-400" : "text-muted-foreground"} />
          <StatMini label="origins" value={stats.origins} accent="text-sky-300" />
        </div>
      )}

      {/* search + filter row */}
      {!loading && points.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by slug, text, asset, origin…"
              className="h-8 w-full rounded-md border border-border bg-background/50 pl-8 pr-7 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-emerald-500/40 focus:outline-none"
            />
            {filter && (
              <button onClick={() => setFilter("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />
            {critChips.map((c) => {
              const count = stats.byCrit[c] ?? 0;
              if (count === 0 && critFilter !== c) return null;
              const isActive = critFilter === c;
              return (
                <button
                  key={c}
                  onClick={() => setCritFilter(isActive ? null : c)}
                  className={cn(
                    "flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors",
                    isActive
                      ? c === "critical" ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                        : c === "high" ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                        : c === "medium" ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                        : "border-zinc-500/40 bg-zinc-500/15 text-zinc-300"
                      : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                  )}
                >
                  {c} <span className="tabular-nums">{count}</span>
                </button>
              );
            })}
            {critFilter && (
              <button onClick={() => setCritFilter(null)} className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">clear</button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
          {error}
        </div>
      ) : points.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center">
          <Database className="h-5 w-5 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            No points on this shard yet.
          </p>
          <p className="font-mono text-[10px] text-muted-foreground/70">
            bootstrap from cloud, or write one →
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
          <SearchIcon className="h-4 w-4 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">No points match the filter.</p>
        </div>
      ) : (
        <ul className="max-h-[520px] space-y-2 overflow-y-auto edge-scroll pr-1">
          {filtered.map((p) => (
            <li
              key={p.id}
              onClick={() => edge.openPoint({ id: p.id, shard, ...p })}
              className="group cursor-pointer rounded-lg border border-border/60 bg-background/40 p-3 transition-colors hover:border-emerald-500/30 hover:bg-background/60"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {p.slug && (
                      <span className="truncate font-mono text-xs font-bold text-foreground">
                        {p.slug}
                      </span>
                    )}
                    {p.title && (
                      <span className="truncate text-xs text-muted-foreground">
                        {p.title}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {p.text}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/80">
                    {p.origin_device && (
                      <span className="rounded bg-muted/60 px-1.5 py-0.5">
                        origin: {p.origin_device}
                      </span>
                    )}
                    <span>· {formatRelative(p.updated_at)}</span>
                    {p.asset_id && (
                      <span className="rounded bg-muted/60 px-1.5 py-0.5">
                        asset: {p.asset_id}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <CriticalityBadge value={p.criticality} />
                  <SyncStateBadge value={p.sync_state} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function deriveStats(points: EdgePoint[]) {
  const byCrit: Record<string, number> = {};
  const origins = new Set<string>();
  let localOnly = 0;
  for (const p of points) {
    const c = p.criticality ?? "medium";
    byCrit[c] = (byCrit[c] ?? 0) + 1;
    if (p.origin_device) origins.add(p.origin_device);
    if (p.sync_state === "local_only") localOnly++;
  }
  return {
    total: points.length,
    critical: byCrit.critical ?? 0,
    localOnly,
    origins: origins.size,
    byCrit,
  };
}

function StatMini({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-md border border-border bg-background/30 px-2 py-1.5">
      <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-sm font-semibold tabular-nums", accent ?? "text-foreground")}>{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* write form                                                                  */
/* -------------------------------------------------------------------------- */

function WriteForm({ edge, shard }: { edge: EdgeHook; shard: string }) {
  const [text, setText] = useState("");
  const [criticality, setCriticality] = useState("medium");
  const [sensitivity, setSensitivity] = useState("internal");
  const [assetId, setAssetId] = useState("");
  const [title, setTitle] = useState("");
  const [writing, setWriting] = useState(false);
  const [decision, setDecision] = useState<WriteResult | null>(null);
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagReason, setAutoTagReason] = useState<string | null>(null);
  const online = edge.syncStatus?.online ?? true;

  const canWrite = text.trim().length > 0 && !writing;

  const handleAutoTag = useCallback(async () => {
    if (!text.trim()) {
      toast({ title: "Enter text first", description: "Type the note text before auto-tagging.", variant: "destructive" });
      return;
    }
    if (!online) {
      toast({ title: "Offline", description: "Cloud LLM auto-tag requires connectivity.", variant: "destructive" });
      return;
    }
    setAutoTagging(true);
    setAutoTagReason(null);
    try {
      const r = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auto_tag", text: text.trim() }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "LLM failed");
      setCriticality(data.criticality);
      setSensitivity(data.sensitivity);
      setAutoTagReason(data.reason);
      toast({ title: "Auto-tagged by cloud LLM", description: `${data.criticality} · ${data.sensitivity} — ${data.reason}` });
    } catch (e) {
      toast({ title: "Auto-tag failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setAutoTagging(false);
    }
  }, [text, online]);

  const handleWrite = useCallback(async () => {
    if (!canWrite) return;
    setWriting(true);
    setDecision(null);
    try {
      // call the edge API directly so we can surface the live policy decision
      // (the hook's write() returns void); then refresh the hook snapshot.
      const result = await edgeApi.write({
        shard,
        text: text.trim(),
        criticality,
        sensitivity,
        asset_id: assetId.trim() || undefined,
        title: title.trim() || undefined,
      });
      setDecision(result);
      toast({
        title: "Point written",
        description: `tagged → ${result.sync_state.toUpperCase()} · ${result.decision.reason}`,
      });
      setText("");
      setTitle("");
      setAssetId("");
      await edge.refresh();
    } catch (e) {
      toast({
        title: "Write failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWriting(false);
    }
  }, [canWrite, shard, text, criticality, sensitivity, assetId, title, edge]);

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center justify-between border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2">
          <PenSquare className="h-3.5 w-3.5 text-emerald-400" />
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
            write to shard
          </span>
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {shard}
          </span>
        </div>
        <button
          onClick={handleAutoTag}
          disabled={!online || autoTagging || !text.trim()}
          title={online ? "Classify criticality & sensitivity via the cloud LLM" : "Cloud LLM requires connectivity"}
          className={cn(
            "flex items-center gap-1 rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-wider transition-colors disabled:opacity-40",
            online ? "border-sky-500/30 bg-sky-500/5 text-sky-300 hover:bg-sky-500/10" : "border-border text-muted-foreground"
          )}
        >
          {autoTagging ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Cloud className="h-2.5 w-2.5" />}
          auto-tag
        </button>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            text <span className="text-rose-400">*</span>
          </Label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a manual excerpt, incident note, or sensor observation…"
            className="min-h-24 resize-y font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              criticality
            </Label>
            <Select value={criticality} onValueChange={setCriticality}>
              <SelectTrigger className="h-8 w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              sensitivity
            </Label>
            <Select value={sensitivity} onValueChange={setSensitivity}>
              <SelectTrigger className="h-8 w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">internal</SelectItem>
                <SelectItem value="restricted">restricted</SelectItem>
                <SelectItem value="public">public</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {autoTagReason && (
          <div className="flex items-center gap-1.5 rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-1.5">
            <Sparkles className="h-3 w-3 shrink-0 text-sky-300" />
            <span className="font-mono text-[10px] text-sky-300">cloud LLM:</span>
            <span className="text-[11px] text-muted-foreground">{autoTagReason}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2.5">
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              title <span className="text-muted-foreground/60">(optional)</span>
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short headline"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              asset_id <span className="text-muted-foreground/60">(optional)</span>
            </Label>
            <Input
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              placeholder="e.g. pump-7, scada-3"
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>

        {/* offline capability note */}
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
          <Zap className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
          <p className="text-[10px] leading-relaxed text-emerald-200/80">
            writes embed locally via FastEmbed + BM25 —{" "}
            <span className="font-mono">zero network</span>. policy tags the point
            in-process; sync happens later if routed.
          </p>
        </div>

        <Button
          onClick={handleWrite}
          disabled={!canWrite}
          className="w-full gap-2 bg-emerald-500/90 font-mono text-xs text-emerald-950 hover:bg-emerald-400"
        >
          {writing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PenSquare className="h-3.5 w-3.5" />
          )}
          {writing ? "embedding…" : "write point"}
        </Button>

        {decision && (
          <div className="animate-in fade-in slide-in-from-bottom-1 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                tagged →
              </span>
              <SyncStateBadge value={decision.sync_state} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {decision.decision.reason}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
              <span className="rounded bg-muted/60 px-1.5 py-0.5">
                slug: {decision.slug}
              </span>
              {decision.decision.matched_rule && (
                <span className="rounded bg-muted/60 px-1.5 py-0.5">
                  rule: {decision.decision.matched_rule}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* loading skeleton                                                            */
/* -------------------------------------------------------------------------- */

function MemoryLoadingSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-96 lg:col-span-2" />
        <Skeleton className="h-96 lg:col-span-1" />
      </div>
    </div>
  );
}
