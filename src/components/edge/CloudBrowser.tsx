"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Database, Search, Trash2, Server, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import type { CloudCollectionsResponse, CloudPointsResponse, SearchMode } from "@/lib/edge-types";
import { Panel, StatCard, CriticalityBadge, formatBytes, formatRelative } from "./edge-ui";

const MODES: SearchMode[] = ["hybrid", "dense", "sparse"];
const PAGE = 25;

/** Cloud Collections browser — reads the centralized Qdrant Server knowledge
 *  base directly (browse + hybrid search + delete), independent of the local
 *  device shards. */
export default function CloudBrowser() {
  const [cols, setCols] = useState<CloudCollectionsResponse | null>(null);
  const [sel, setSel] = useState("edge-incidents");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [pts, setPts] = useState<CloudPointsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCollections = useCallback(async () => {
    try {
      setCols(await edgeApi.cloudCollections());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadPoints = useCallback(async () => {
    setBusy(true);
    try {
      setPts(await edgeApi.cloudPoints({ collection: sel, limit: PAGE }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sel]);

  useEffect(() => { void loadCollections(); }, [loadCollections]);
  useEffect(() => { void loadPoints(); }, [loadPoints]);

  async function runSearch() {
    const text = q.trim();
    if (!text) return void loadPoints();
    setBusy(true);
    try {
      const r = await edgeApi.cloudSearch({ collection: sel, query: text, mode, limit: PAGE });
      setPts({ ...r, query: text, total: r.points.length });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, slug?: string | null) {
    if (!window.confirm(`Delete ${slug ?? id.slice(0, 8)} from ${sel}? This removes it from the cloud for the whole fleet.`)) return;
    setBusy(true);
    try {
      await edgeApi.cloudDelete({ collection: sel, id });
      toast({ title: "Point deleted", description: `${slug ?? id.slice(0, 8)} removed from ${sel}` });
      await loadCollections();
      await loadPoints();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const active = cols?.collections.find((c) => c.collection === sel);

  return (
    <div className="space-y-5" data-testid="cloud-browser">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Cloud points"
          value={cols?.total_points ?? "—"}
          sub="shared across fleet"
          accent="emerald"
          icon={<Database className="h-4 w-4" />}
        />
        <StatCard
          label="Collections"
          value={cols?.collections.length ?? "—"}
          sub="edge-* in Qdrant Server"
          icon={<Server className="h-4 w-4" />}
        />
        <StatCard
          label="Backend"
          value={cols?.backend === "qdrant-server" ? "Qdrant Server" : "embedded"}
          sub={cols?.url ?? "local"}
          icon={<Server className="h-4 w-4" />}
        />
        <StatCard
          label="Selected"
          value={active ? active.points : "—"}
          sub={sel}
          icon={<Database className="h-4 w-4" />}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span className="font-mono text-xs">{error}</span>
        </div>
      )}

      <Panel
        title="Collections"
        desc="Centralized knowledge base — every device pushes here and pulls from here."
        right={
          <Button size="sm" variant="outline" onClick={() => { void loadCollections(); void loadPoints(); }} disabled={busy}
            className="gap-1.5 font-mono text-xs">
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> Refresh
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border/60 text-[9px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-medium">collection</th>
                <th className="py-2 pr-3 text-right font-medium">points</th>
                <th className="py-2 pr-3 text-right font-medium">segments</th>
                <th className="py-2 pr-3 text-right font-medium">disk</th>
                <th className="py-2 pr-3 font-medium">manifest</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(cols?.collections ?? []).map((c) => (
                <tr
                  key={c.collection}
                  className={cn(
                    "cursor-pointer border-b border-border/40 transition-colors hover:bg-card/60",
                    c.collection === sel && "bg-emerald-500/[0.06]"
                  )}
                  onClick={() => { setSel(c.collection); setQ(""); }}
                  data-testid="cloud-collection-row"
                >
                  <td className="py-2 pr-3">
                    <span className={cn("flex items-center gap-1.5", c.collection === sel ? "text-emerald-300" : "text-foreground")}>
                      <Database className="h-3 w-3" />
                      {c.collection}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{c.points}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{c.segments}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{formatBytes(c.disk_bytes)}</td>
                  <td className="py-2 pr-3 text-muted-foreground/70">v{c.manifest_hash}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); setSel(c.collection); setQ(""); }}
                      aria-label={`View ${c.collection}`}
                      aria-pressed={c.collection === sel}
                      className={cn("rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider", c.collection === sel ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground hover:text-foreground")}
                    >
                      {c.collection === sel ? "viewing" : "view"}
                    </button>
                  </td>
                </tr>
              ))}
              {!cols && (
                <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">Loading collections…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={`Points · ${sel}`}
        desc={pts?.query ? `Vector search for "${pts.query}" (${mode})` : "Full collection listing — click a row to open the point"}
        right={
          <span className="font-mono text-[10px] text-muted-foreground">
            {pts ? `${pts.points.length} of ${pts.total}` : "—"}
          </span>
        }
      >
        {/* search bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Search cloud collection</Label>
            <div className="mt-1 flex gap-2">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="semantic query against the whole fleet's knowledge…"
                aria-label="Cloud collection query"
                data-testid="cloud-search-input"
                className="border-border bg-card/40 font-mono text-sm"
                onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              />
              <Button onClick={() => void runSearch()} disabled={busy}
                className="shrink-0 gap-1.5 bg-emerald-500/90 font-mono text-xs text-emerald-950 hover:bg-emerald-400" data-testid="cloud-search-button">
                <Search className="h-3.5 w-3.5" /> Search
              </Button>
            </div>
          </div>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md border px-2 py-1.5 font-mono text-[11px] transition-colors",
                  mode === m ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                )}
              >{m}</button>
            ))}
          </div>
        </div>

        {/* point list */}
        <div className="mt-4 space-y-2">
          {(pts?.points ?? []).map((p) => (
            <div key={p.id} className="group rounded-lg border border-border bg-card/40 p-3 transition-colors hover:border-emerald-500/30" data-testid="cloud-point-row">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">{p.slug ?? p.id.slice(0, 8)}</span>
                    <CriticalityBadge value={p.criticality ?? undefined} />
                    {p.origin_device && <span className="font-mono text-[9px] text-sky-300">@{p.origin_device}</span>}
                    {typeof p.score === "number" && (
                      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-emerald-300">
                        {p.score.toFixed(4)}
                      </span>
                    )}
                  </div>
                  {p.text && <p className="mt-1 break-words text-[11px] leading-relaxed text-foreground/85">{p.text}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 font-mono text-[9px] text-muted-foreground">
                    <span>{p.id.slice(0, 8)}…</span>
                    {p.domain && <span>{p.domain}</span>}
                    {p.sensitivity && <span>sens: {p.sensitivity}</span>}
                    <span>{formatRelative(p.updated_at ?? null)}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void remove(p.id, p.slug)}
                  disabled={busy}
                  aria-label={`Delete ${p.slug ?? p.id}`}
                  className="shrink-0 gap-1 border-rose-500/30 bg-rose-500/5 font-mono text-[10px] text-rose-300 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-rose-500/10"
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          ))}
          {pts && pts.points.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {pts.query ? "No matches in this collection." : "Collection is empty."}
            </div>
          )}
          {!pts && !error && (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading points…</div>
          )}
        </div>

        <div className="mt-3 font-mono text-[10px] text-muted-foreground">
          listing capped at {PAGE} rows — use search to reach the rest
        </div>
      </Panel>
    </div>
  );
}
