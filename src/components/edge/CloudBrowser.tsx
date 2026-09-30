"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Search, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import type { CloudCollectionsResponse, CloudPointsResponse, SearchMode } from "@/lib/edge-types";
import { Panel, CriticalityBadge, Segmented, formatBytes, formatRelative } from "./edge-ui";

const MODES = ["hybrid", "dense", "sparse"] as const;
const PAGE = 25;

/** The centralized Qdrant Server knowledge base: browse, search and delete, independent of local shards. */
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

  const maxPts = Math.max(1, ...(cols?.collections ?? []).map((c) => c.points));
  const backend = cols ? (cols.backend === "qdrant-server" ? "Qdrant Server" : "embedded cloud") : null;

  return (
    <div className="space-y-6" data-testid="cloud-browser">
      {error && (
        <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 sm:px-5 text-sm text-rose-200">
          Cloud unreachable: <span className="font-mono text-xs">{error}</span>
        </p>
      )}

      <Panel
        title="Cloud knowledge"
        desc={backend && <>{backend} · <span className="font-mono">{cols?.total_points}</span> points</>}
        right={
          <Button size="sm" variant="ghost" onClick={() => { void loadCollections(); void loadPoints(); }} disabled={busy} className="gap-1.5 text-muted-foreground">
            <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} /> Refresh
          </Button>
        }
        flush
      >
        {/* collections as a selector strip: one tile each, share of the cloud as a bar */}
        <div role="group" aria-label="Cloud collection" className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
          {(cols?.collections ?? []).map((c) => (
            <button
              key={c.collection}
              type="button"
              data-testid="cloud-collection-row"
              aria-pressed={c.collection === sel}
              onClick={() => { setSel(c.collection); setQ(""); }}
              className={cn(
                "relative min-w-0 px-5 py-4 text-left transition-colors after:absolute after:inset-x-0 after:top-0 after:h-0.5",
                c.collection === sel ? "bg-muted after:bg-emerald-400" : "bg-card hover:bg-muted/50",
              )}
            >
              <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{c.collection}</span>
              <span className="mt-1.5 block text-3xl font-semibold tabular-nums tracking-[-0.03em] text-foreground">{c.points}</span>
              <span className="mt-2 block h-1 overflow-hidden rounded-full bg-background" aria-hidden>
                <span className="block h-full rounded-full bg-emerald-400/80" style={{ width: `${(c.points / maxPts) * 100}%` }} />
              </span>
              <span className="mt-2 block truncate font-mono text-xs text-muted-foreground">{formatBytes(c.disk_bytes)} · {c.manifest_hash}</span>
            </button>
          ))}
          {!cols && !error && <p className="bg-card px-5 py-6 text-sm text-muted-foreground sm:col-span-3">Loading collections…</p>}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void runSearch(); }} className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${sel} across the whole fleet…`}
            aria-label="Cloud collection query"
            data-testid="cloud-search-input"
            className="h-9 min-w-48 flex-1"
          />
          <Segmented label="Retrieval mode" value={mode} options={MODES} onChange={setMode} />
          <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-9 gap-1.5" data-testid="cloud-search-button">
            <Search className="h-4 w-4" /> Search
          </Button>
          {pts && <span className="font-mono text-xs text-muted-foreground">{pts.query ? `matches for “${pts.query}” · ` : ""}{pts.points.length} of {pts.total}</span>}
        </form>

        {/* points as an even card grid: rows share one height; ring dividers so a short last row leaves no hole */}
        {pts && pts.points.length > 0 && (
          <ul className="grid gap-px overflow-hidden md:grid-cols-2 2xl:grid-cols-3">
            {pts.points.map((p) => (
              <li key={p.id} className="group flex min-w-0 flex-col bg-card px-4 py-3 sm:px-5 md:max-2xl:last:odd:col-span-2 shadow-[0_0_0_1px_var(--color-border)]" data-testid="cloud-point-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-foreground">{p.slug ?? p.id.slice(0, 8)}</span>
                  <CriticalityBadge value={p.criticality ?? undefined} />
                  {typeof p.score === "number" && <span className="font-mono text-xs tabular-nums text-muted-foreground">{p.score.toFixed(3)}</span>}
                </div>
                {p.text && <p className="mt-1 line-clamp-3 text-sm break-words text-foreground/85">{p.text}</p>}
                <div className="mt-auto flex items-center gap-2 pt-2">
                  <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {[p.origin_device && `@${p.origin_device}`, p.domain, p.sensitivity, formatRelative(p.updated_at ?? null)].filter(Boolean).join(" · ")}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(p.id, p.slug)}
                    disabled={busy}
                    aria-label={`Delete ${p.slug ?? p.id}`}
                    className="h-7 shrink-0 gap-1.5 text-rose-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-rose-500/10 hover:text-rose-200 focus-visible:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {pts && pts.points.length === 0 && (
          <p className="px-4 py-10 sm:px-5 text-center text-sm text-muted-foreground">{pts.query ? "No matches in this collection." : "This collection is empty."}</p>
        )}
        {!pts && !error && <p className="px-4 py-10 sm:px-5 text-center text-sm text-muted-foreground">Loading points…</p>}
      </Panel>
    </div>
  );
}
