"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Database, Layers, Loader2, Save, Search, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import type { EdgeHook } from "@/hooks/use-edge";
import type { SearchMode, SearchResponse, SearchFilterKey, SearchFilters, SearchResult } from "@/lib/edge-types";
import { BigStat, BigStats, Hl, Panel, PageHero, CriticalityBadge, Segmented, Tag, formatRelative } from "./edge-ui";

const SHARDS = ["incidents", "manuals", "sensors"] as const;
const MODES = ["hybrid", "dense", "sparse"] as const;
const MODE_HINT: Record<SearchMode, string> = {
  hybrid: "Dense + BM25, fused with RRF",
  dense: "FastEmbed semantic similarity",
  sparse: "BM25 keyword match",
};

// payload filters pushed down into the Qdrant filter (AND-combined server-side)
const FILTER_DEFS: { key: SearchFilterKey; label: string; options: string[] }[] = [
  { key: "domain", label: "Domain", options: ["manual", "incident", "sensor", "log"] },
  { key: "criticality", label: "Criticality", options: ["low", "medium", "high", "critical"] },
  { key: "sensitivity", label: "Sensitivity", options: ["public", "internal", "restricted"] },
  { key: "origin_device", label: "Origin", options: [] }, // filled from the live fleet below
];
// restricted notes never leave the device — not even to the cloud LLM
const isRestricted = (s: unknown) => String(s ?? "").trim().toLowerCase() === "restricted";
const RESTRICTED_TIP = "Restricted notes never leave the device — cloud LLM distill is disabled";

const NO_FILTERS: SearchFilters = { domain: "", criticality: "", sensitivity: "", origin_device: "" };

export const EXAMPLES = [
  { q: "vibration outer race bearing defect", shard: "incidents" },
  { q: "bearing replacement procedure torque clearance", shard: "manuals" },
  { q: "overheating dust filter kiosk", shard: "incidents" },
  { q: "seal leak gland repacking", shard: "incidents" },
] as const;

type Shard = (typeof SHARDS)[number];
type Recent = { q: string; shard: string; mode: SearchMode; ts: number };

export default function SearchPlayground({
  edge, initialQuery, initialResult,
}: {
  edge: EdgeHook;
  initialQuery?: string;
  initialResult?: SearchResponse;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [shard, setShard] = useState<Shard>((initialResult?.shard as Shard) ?? "incidents");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [limit, setLimit] = useState(5);
  const [res, setRes] = useState<SearchResponse | null>(initialResult ?? null);
  const [running, setRunning] = useState(false);
  const [distillId, setDistillId] = useState<string | null>(null);
  const [distilled, setDistilled] = useState<Record<string, { sop: string; saving: boolean; sensitivity: string }>>({});
  const [compare, setCompare] = useState<Record<string, SearchResponse> | null>(null);
  const [comparing, setComparing] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const online = edge.syncStatus?.online ?? true;
  const anyFilter = Object.values(filters).some(Boolean);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("edge-recent-searches");
      if (raw) setRecent(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  function addRecent(q: string, s: string) {
    setRecent((prev) => {
      const next = [{ q, shard: s, mode, ts: Date.now() }, ...prev.filter((r) => r.q !== q)].slice(0, 5);
      try { localStorage.setItem("edge-recent-searches", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function activeFilters(f: SearchFilters): SearchFilters {
    const out: SearchFilters = {};
    for (const [k, v] of Object.entries(f)) if (v) out[k as SearchFilterKey] = v;
    return out;
  }

  async function run(q?: string, s: Shard = shard) {
    const text = (q ?? query).trim();
    if (!text) return;
    if (q) setQuery(q);
    setRunning(true);
    setCompare(null);
    try {
      setRes(await edge.search(text, s, mode, limit, { filters: activeFilters(filters), explain: true }));
      addRecent(text, s);
    } catch (e) {
      toast({ title: "Search failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  // dense / sparse / hybrid side by side — shows what RRF fusion buys
  async function runCompare() {
    const text = query.trim();
    if (!text) return;
    setComparing(true);
    setCompare(null);
    try {
      const results = await Promise.all(
        MODES.map(async (m) => {
          try { return [m, await edge.search(text, shard, m, limit)] as const; } catch { return [m, null] as const; }
        })
      );
      const map: Record<string, SearchResponse> = {};
      for (const [m, r] of results) if (r) map[m] = r;
      setCompare(map);
    } finally {
      setComparing(false);
    }
  }

  // Cloud LLM: distill a retrieved incident into a reusable SOP. Online only.
  async function distill(r0: SearchResult, shardName: string) {
    const { id, text, asset_id } = r0;
    if (!online) {
      toast({ title: "Offline", description: "Cloud LLM synthesis requires connectivity.", variant: "destructive" });
      return;
    }
    setDistillId(id);
    try {
      // search hits may omit sensitivity; read the stored point and fail closed if we can't
      const sensitivity = String(r0.sensitivity ?? (await edgeApi.getPoint(shardName, id)).sensitivity ?? "").trim().toLowerCase();
      if (!sensitivity || isRestricted(sensitivity)) throw new Error(sensitivity ? RESTRICTED_TIP : "Could not verify note sensitivity");
      const r = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "distill_sop", text, asset_id }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "LLM failed");
      setDistilled((p) => ({ ...p, [id]: { sop: data.sop, saving: false, sensitivity } }));
    } catch (e) {
      toast({ title: "Distill failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setDistillId(null);
    }
  }

  async function saveSop(id: string, sop: string, sensitivity: string, asset_id?: string) {
    setDistilled((p) => ({ ...p, [id]: { sop, saving: true, sensitivity } }));
    try {
      // derived SOP inherits the source note's sensitivity (policy decides whether it syncs)
      await edge.write({ shard: "manuals", text: sop, criticality: "high", sensitivity, asset_id, title: `SOP distilled from incident`, domain: "manual" });
      toast({ title: "SOP saved to manuals", description: "It syncs to the fleet with the next sync." });
      setDistilled((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      setDistilled((p) => ({ ...p, [id]: { sop, saving: false, sensitivity } }));
    }
  }

  const selectCls = "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground";

  const n = res?.results.length ?? 0;
  const top = (k: ScoreKey) => Math.max(1e-9, ...(res?.results ?? []).map((r) => (r.scores ? r.scores[k] ?? 0 : k === "fused" ? r.score : 0)));
  const scoreMax = { fused: top("fused"), dense: top("dense"), sparse: top("sparse") };
  const shardPoints = edge.memory?.shards[shard]?.points;

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <PageHero
        className="xl:col-span-12"
        tone={res && n === 0 ? "warn" : "ok"}
        title={res ? <><Hl>{n} {n === 1 ? "match" : "matches"}</Hl> in {res.shard}.</> : <>Ask this device&apos;s <Hl>memory.</Hl></>}
        sub={res
          ? <>Ranked {res.mode === "hybrid" ? "by dense + sparse fusion" : `by ${res.mode} vectors`}, on this device{res.offline ? " with no link" : ""}.</>
          : "Hybrid search runs here on the device — with or without a link."}
        stats={
          <BigStats>
            <BigStat icon={<Database />} label="On device" value={edge.memory?.total_points ?? "—"} hint="points searchable" />
            <BigStat icon={<Layers />} label={`In ${shard}`} value={shardPoints ?? "—"} hint="points in this shard" />
            <BigStat icon={<Timer />} label="Last search" value={res ? `${res.latency_ms.toFixed(res.latency_ms < 10 ? 1 : 0)}ms` : "—"} tone={res ? (res.latency_ms > 200 ? "crit" : res.latency_ms > 60 ? "warn" : "ok") : undefined} hint={res ? (res.offline ? "offline" : "on-device") : "no search yet"} />
          </BigStats>
        }
        footer={
          <div className="space-y-4">
            <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. seen this vibration pattern before?"
                    aria-label="Search query"
                    className="h-12 bg-background pl-11 text-base md:text-base"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={running || !!edge.busy} className="h-12 flex-1 gap-2 bg-emerald-500 px-7 text-base font-semibold text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400 sm:flex-none">
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Search
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => runCompare()}
                    disabled={comparing || !!edge.busy || !query.trim()}
                    title="Run dense, sparse and hybrid side by side"
                    className="h-12"
                  >
                    {comparing && <Loader2 className="h-4 w-4 animate-spin" />}
                    Compare modes
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Segmented label="Shard" value={shard} options={SHARDS} onChange={setShard} />
                <Segmented label="Retrieval mode" value={mode} options={MODES} onChange={setMode}
                  render={(m) => <span title={MODE_HINT[m]} className="capitalize">{m}</span>} />
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Maximum results" className={selectCls}>
                  {[3, 5, 10].map((n) => <option key={n} value={n}>Top {n}</option>)}
                </select>
                <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />
                {FILTER_DEFS.map((f) => {
                  const opts = f.key === "origin_device" ? (edge.state?.devices ?? []).map((d) => d.id) : f.options;
                  return (
                    <select
                      key={f.key}
                      value={filters[f.key] ?? ""}
                      onChange={(e) => setFilters((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      aria-label={`${f.label} filter`}
                      className={cn(selectCls, filters[f.key] && "border-emerald-500/50")}
                    >
                      <option value="">Any {f.label.toLowerCase()}</option>
                      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  );
                })}
                {anyFilter && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)} className="h-8 gap-1 text-muted-foreground">
                    <X className="h-3.5 w-3.5" /> Clear filters
                  </Button>
                )}
              </div>
            </form>

            {!res && (
              <div className="space-y-4 text-sm">
                <ChipRow label="Try">
                  {EXAMPLES.map((ex) => (
                    <Chip key={ex.q} onClick={() => { setShard(ex.shard); void run(ex.q, ex.shard); }}>{ex.q}</Chip>
                  ))}
                </ChipRow>
                {recent.length > 0 && (
                  <ChipRow
                    label="Recent"
                    after={<button type="button" onClick={() => { setRecent([]); try { localStorage.removeItem("edge-recent-searches"); } catch { /* ignore */ } }} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>}
                  >
                    {recent.map((r) => (
                      <Chip key={r.q + r.ts} title={`${r.shard} · ${r.mode}`} onClick={() => { setShard(r.shard as Shard); setMode(r.mode); void run(r.q, r.shard as Shard); }}>{r.q}</Chip>
                    ))}
                  </ChipRow>
                )}
              </div>
            )}
          </div>
        }
      />

      {res && (
        <Panel
          className="xl:col-span-12"
          title="Results"
          desc="best first · bars scaled to the top hit"
          flush
        >
          {res.results.length === 0 ? (
            <p className="px-4 py-10 sm:px-5 text-center text-sm text-muted-foreground">No matches. Try other words, another shard, or fewer filters.</p>
          ) : (
            <ol className="grid gap-px overflow-hidden md:grid-cols-2">
              {res.results.map((r, i) => {
                const restricted = isRestricted(r.sensitivity ?? res.filters?.sensitivity);
                const sop = distilled[r.id];
                return (
                  <li key={r.id} className="group relative flex bg-card px-4 py-4 sm:px-5 md:last:odd:col-span-2 shadow-[0_0_0_1px_var(--color-border)] transition-colors hover:bg-muted/30">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                      <div className="flex h-full min-w-0 flex-1 flex-col">
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={() => edge.openPoint({ ...r, shard: res.shard })}
                            className="min-w-0 text-left text-[15px] font-semibold tracking-tight text-foreground underline-offset-4 after:absolute after:inset-0 hover:underline"
                          >
                            {r.title || r.slug || r.id.slice(0, 8)}
                          </button>
                          <CriticalityBadge value={r.criticality} />
                          {r.updated_at && <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{formatRelative(r.updated_at)}</span>}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                          {[r.title ? r.slug : null, r.asset_id, r.origin_device && `@${r.origin_device}`].filter(Boolean).join(" · ")}
                        </p>
                        <p className="mt-1.5 text-sm leading-relaxed break-words text-foreground/90">{r.text}</p>
                        <ScoreBars r={r} max={scoreMax} />
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <button
                            type="button"
                            onClick={() => distill(r, res.shard)}
                            disabled={!online || restricted || distillId === r.id}
                            title={restricted ? RESTRICTED_TIP : online ? "Distill this incident into an SOP with the cloud LLM" : "Cloud LLM requires connectivity"}
                            className="relative z-10 ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                          >
                            {distillId === r.id && <Loader2 className="h-3 w-3 animate-spin" />}
                            {restricted ? "Restricted · stays on device" : "Distill → SOP"}
                          </button>
                        </div>
                        {sop && (
                          <div className="relative z-10 mt-3 rounded-md border border-border bg-background p-3">
                            <div className="mb-2 text-xs text-muted-foreground">Draft SOP from the cloud LLM</div>
                            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">{sop.sop}</pre>
                            <Button
                              size="sm"
                              onClick={() => saveSop(r.id, sop.sop, sop.sensitivity, r.asset_id)}
                              disabled={sop.saving || !!edge.busy}
                              className="mt-3 gap-1.5 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400"
                            >
                              {sop.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                              Save to manuals
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      )}

      {compare && (
        <Panel
          className="xl:col-span-12"
          title="Mode comparison"
          desc={`top 3 in ${shard}`}
          right={<Button variant="ghost" size="sm" onClick={() => setCompare(null)} className="text-muted-foreground">Close</Button>}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {MODES.map((m) => {
              const r = compare[m];
              return (
                <div key={m}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className={cn("text-sm capitalize", m === "hybrid" ? "text-emerald-300" : "text-foreground")}>{m}</span>
                    {r && <span className="font-mono text-xs text-muted-foreground">{r.latency_ms.toFixed(1)} ms</span>}
                  </div>
                  {!r ? (
                    <p className="text-xs text-rose-300">Failed</p>
                  ) : r.results.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No hits</p>
                  ) : (
                    <ol className="space-y-1.5">
                      {r.results.slice(0, 3).map((hit) => (
                        <li key={hit.id} className="flex items-center justify-between gap-2 font-mono text-xs">
                          <span className="truncate text-foreground/90">{hit.slug ?? hit.id.slice(0, 8)}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{hit.score.toFixed(3)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

const BARS = [["fused", "bg-emerald-400"], ["dense", "bg-teal-300"], ["sparse", "bg-lime-300"]] as const;
type ScoreKey = (typeof BARS)[number][0];

/** Why a hit ranked where it did: fused score and its dense/sparse parts, each scaled to the best in this result set. */
function ScoreBars({ r, max }: { r: SearchResult; max: Record<ScoreKey, number> }) {
  const v: Record<ScoreKey, number | null> = r.scores
    ? { fused: r.scores.fused, dense: r.scores.dense, sparse: r.scores.sparse }
    : { fused: r.score, dense: null, sparse: null };
  return (
    <dl className="mt-auto grid gap-1 pt-3 font-mono text-xs" data-testid="score-breakdown" aria-label="score breakdown">
      {BARS.filter(([k]) => k === "fused" || v[k] !== null).map(([k, c]) => (
        <div key={k} className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-2">
          <dt className="text-muted-foreground">{r.scores ? k : "score"}</dt>
          <dd className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn("h-full origin-left rounded-full transition-transform duration-500 ease-[var(--ease-out)]", c)} style={{ transform: `scaleX(${Math.max(0.02, (v[k] ?? 0) / max[k])})` }} />
          </dd>
          <dd className="text-right tabular-nums text-foreground/85">{fmt(v[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));

function ChipRow({ label, children, after }: { label: string; children: React.ReactNode; after?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
      {after}
    </div>
  );
}

function Chip({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-7 max-w-full truncate rounded-md border border-border bg-background/40 px-2.5 text-xs text-foreground/75 transition-colors hover:border-emerald-500/40 hover:text-foreground"
    >
      {children}
    </button>
  );
}
