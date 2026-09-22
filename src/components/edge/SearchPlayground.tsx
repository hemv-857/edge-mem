"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Search, Zap, Wifi, WifiOff, Sparkles, Quote, Cloud, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import type { EdgeHook } from "@/hooks/use-edge";
import type { SearchMode, SearchResponse } from "@/lib/edge-types";
import { Panel, LatencyBadge, CriticalityBadge, formatRelative } from "./edge-ui";

const SHARDS = ["manuals", "incidents", "sensors"] as const;
const MODES: { id: SearchMode; label: string; desc: string }[] = [
  { id: "hybrid", label: "Hybrid", desc: "Dense + BM25, RRF fusion" },
  { id: "dense", label: "Dense", desc: "FastEmbed semantic" },
  { id: "sparse", label: "Sparse", desc: "BM25 keyword" },
];

const EXAMPLES = [
  { q: "vibration outer race bearing defect", shard: "incidents" },
  { q: "bearing replacement procedure torque clearance", shard: "manuals" },
  { q: "motor rebalance ISO G2.5", shard: "manuals" },
  { q: "overheating dust filter kiosk", shard: "incidents" },
  { q: "seal leak gland repacking", shard: "incidents" },
];

export default function SearchPlayground({ edge }: { edge: EdgeHook }) {
  const [query, setQuery] = useState("");
  const [shard, setShard] = useState<string>("incidents");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [limit, setLimit] = useState(5);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [distillId, setDistillId] = useState<string | null>(null);
  const [distilled, setDistilled] = useState<Record<string, { sop: string; saving: boolean }>>({});
  const online = edge.syncStatus?.online ?? true;

  async function run(q?: string) {
    const text = (q ?? query).trim();
    if (!text) {
      toast({ title: "Enter a query", description: "Type a search query first.", variant: "destructive" });
      return;
    }
    if (q) setQuery(q);
    setRunning(true);
    try {
      const r = await edge.search(text, shard, mode, limit);
      setRes(r);
    } catch (e) {
      toast({ title: "Search failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  // Cloud LLM: distill a retrieved incident into a reusable SOP update.
  // Only callable when online — reinforces the edge/cloud division of labor.
  async function distill(id: string, text: string, asset_id?: string) {
    if (!online) {
      toast({ title: "Offline", description: "Cloud LLM synthesis requires connectivity.", variant: "destructive" });
      return;
    }
    setDistillId(id);
    try {
      const r = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "distill_sop", text, asset_id }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "LLM failed");
      setDistilled((p) => ({ ...p, [id]: { sop: data.sop, saving: false } }));
      toast({ title: "SOP distilled by cloud LLM", description: "Review and save to the manuals shard." });
    } catch (e) {
      toast({ title: "Distill failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setDistillId(null);
    }
  }

  async function saveSop(id: string, sop: string, asset_id?: string) {
    setDistilled((p) => ({ ...p, [id]: { sop, saving: true } }));
    try {
      await edge.write({ shard: "manuals", text: sop, criticality: "high", sensitivity: "internal", asset_id, title: `SOP distilled from incident`, domain: "manual" });
      toast({ title: "SOP saved to manuals", description: "Queued for fleet sync — will flow to all devices." });
      setDistilled((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      setDistilled((p) => ({ ...p, [id]: { sop, saving: false } }));
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title="Search Playground"
        desc="On-device hybrid retrieval — dense (FastEmbed) + sparse (BM25) fused via RRF. Runs with the network fully off."
        right={
          <div className="flex items-center gap-2">
            <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1", online ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5")}>
              {online ? <Wifi className="h-3 w-3 text-emerald-400" /> : <WifiOff className="h-3 w-3 text-amber-400" />}
              <span className={cn("font-mono text-[10px] uppercase tracking-wider", online ? "text-emerald-300" : "text-amber-300")}>{online ? "online" : "offline"}</span>
            </div>
          </div>
        }
      >
        {/* query row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Query</Label>
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. seen this vibration pattern before?"
              className="mt-1 min-h-[44px] resize-none border-border bg-card/40 font-mono text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
            />
          </div>
          <Button
            onClick={() => run()}
            disabled={running || !!edge.busy}
            className="gap-2 bg-emerald-500/90 text-emerald-950 hover:bg-emerald-400 sm:w-auto"
          >
            <Search className={cn("h-4 w-4", running && "animate-pulse")} />
            {running ? "Searching…" : "Search"}
          </Button>
        </div>

        {/* controls */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Shard</Label>
            <div className="mt-1 flex gap-1">
              {SHARDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setShard(s)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 font-mono text-[11px] capitalize transition-colors",
                    shard === s ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                  )}
                >{s}</button>
              ))}
            </div>
          </div>
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Mode</Label>
            <div className="mt-1 flex gap-1">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  title={m.desc}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 font-mono text-[11px] transition-colors",
                    mode === m.id ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                  )}
                >{m.label}</button>
              ))}
            </div>
          </div>
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Limit: {limit}</Label>
            <input
              type="range" min={1} max={10} value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="mt-2 w-full accent-emerald-500"
            />
          </div>
        </div>

        {/* examples */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3" /> Example queries
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.q}
                onClick={() => { setShard(ex.shard); run(ex.q); }}
                className="rounded-full border border-border bg-card/40 px-2.5 py-1 text-left font-mono text-[10px] text-muted-foreground transition-colors hover:border-emerald-500/30 hover:text-emerald-300"
              >
                <span className="text-emerald-400/70">{ex.shard}/</span>{ex.q}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {/* results */}
      {res && (
        <Panel
          title="Results"
          desc={`Retrieved from ${res.shard} · ${res.mode} mode`}
          right={
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">{res.results.length} hits</span>
              <LatencyBadge ms={res.latency_ms} offline={res.offline} />
            </div>
          }
        >
          {res.offline && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              <WifiOff className="h-3.5 w-3.5" />
              <span className="font-mono">OFFLINE — retrieved entirely from local EdgeShard memory, zero network calls</span>
            </div>
          )}
          {res.results.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No matches. Try a different query or shard.</div>
          ) : (
            <div className="space-y-2.5">
              {res.results.map((r, i) => {
                const maxScore = res.results[0]?.score ?? 1;
                const pct = Math.max(4, Math.round((r.score / (maxScore || 1)) * 100));
                return (
                  <div key={r.id} className="rounded-lg border border-border bg-card/40 p-3.5">
                    <div className="flex items-start gap-3">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted font-mono text-[10px] text-muted-foreground">{i + 1}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">{r.slug ?? r.id.slice(0, 8)}</span>
                          {r.asset_id && <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{r.asset_id}</span>}
                          {r.origin_device && <span className="font-mono text-[9px] text-sky-300">@{r.origin_device}</span>}
                          <CriticalityBadge value={r.criticality} />
                        </div>
                        <div className="mt-1.5 flex items-start gap-1.5">
                          <Quote className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
                          <p className="text-sm leading-relaxed text-foreground/90">{r.text}</p>
                        </div>
                        <div className="mt-2 flex items-center gap-3">
                          <div className="flex flex-1 items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div className={cn("h-full rounded-full", i === 0 ? "bg-emerald-400" : "bg-emerald-400/60")} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{r.score.toFixed(4)}</span>
                          </div>
                          {r.updated_at && <span className="font-mono text-[10px] text-muted-foreground">{formatRelative(r.updated_at)}</span>}
                          <button
                            onClick={() => distill(r.id, r.text, r.asset_id)}
                            disabled={!online || distillId === r.id}
                            title={online ? "Distill this incident into an SOP via the cloud LLM" : "Cloud LLM requires connectivity"}
                            className={cn(
                              "flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors disabled:opacity-40",
                              online ? "border-sky-500/30 bg-sky-500/5 text-sky-300 hover:bg-sky-500/10" : "border-border text-muted-foreground"
                            )}
                          >
                            {distillId === r.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Cloud className="h-2.5 w-2.5" />}
                            Distill → SOP
                          </button>
                        </div>
                        {distilled[r.id] && (
                          <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/5 p-2.5">
                            <div className="mb-1 flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider text-sky-300">
                              <Cloud className="h-2.5 w-2.5" /> Cloud LLM — distilled SOP
                            </div>
                            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">{distilled[r.id].sop}</pre>
                            <div className="mt-2 flex items-center gap-1.5">
                              <Button
                                size="sm"
                                onClick={() => saveSop(r.id, distilled[r.id].sop, r.asset_id)}
                                disabled={distilled[r.id].saving || !!edge.busy}
                                className="gap-1 bg-emerald-500/90 font-mono text-[10px] text-emerald-950 hover:bg-emerald-400"
                              >
                                {distilled[r.id].saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                Save to manuals shard
                              </Button>
                              <span className="font-mono text-[9px] text-muted-foreground">→ queues for fleet sync</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
            <Zap className="h-3 w-3 text-emerald-400" />
            <span>score: {res.mode === "hybrid" ? "RRF (k=2) of dense + sparse prefetches" : res.mode === "dense" ? "cosine similarity, FastEmbed bge-small-en" : "BM25 term-frequency"}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
