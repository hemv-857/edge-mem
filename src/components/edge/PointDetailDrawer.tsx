"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  X, Trash2, Cloud, Loader2, FileText, Hash, Clock, Server,
  ShieldAlert, Tag, Cpu, Gauge, BookOpen, AlertTriangle, Save, GitCompare, Search, Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import type { EdgeHook } from "@/hooks/use-edge";
import type { SearchResult } from "@/lib/edge-types";
import { CriticalityBadge, SyncStateBadge, Tag as Pill, formatBytes, formatRelative, formatTime } from "./edge-ui";

export interface PointRef {
  id: string;
  shard: string;
  slug?: string;
  text?: string;
  title?: string;
  domain?: string;
  criticality?: string;
  sensitivity?: string;
  origin_device?: string;
  sync_state?: string;
  updated_at?: number;
  asset_id?: string;
  sensor_type?: string;
  value?: number;
  unit?: string;
  severity?: string;
}

const DOMAIN_ICON: Record<string, React.ReactNode> = {
  manual: <BookOpen className="h-3 w-3" />,
  incident: <AlertTriangle className="h-3 w-3" />,
  sensor: <Gauge className="h-3 w-3" />,
};

export default function PointDetailDrawer({
  point, onClose, edge,
}: {
  point: PointRef | null;
  onClose: () => void;
  edge: EdgeHook;
}) {
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distilledSop, setDistilledSop] = useState<string | null>(null);
  const [similar, setSimilar] = useState<{ shard: string; results: SearchResult[] }[] | null>(null);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const online = edge.syncStatus?.online ?? true;

  useEffect(() => {
    if (!point) { setFull(null); setDistilledSop(null); setSimilar(null); return; }
    setLoading(true);
    setDistilledSop(null);
    setSimilar(null);
    edgeApi.getPoint(point.shard, point.id)
      .then((p) => setFull(p))
      .catch(() => setFull(null))
      .finally(() => setLoading(false));
  }, [point]);

  // find similar points across all shards using this point's text as the query
  async function handleFindSimilar() {
    if (!p.text) return;
    setLoadingSimilar(true);
    setSimilar(null);
    try {
      const shards = ["manuals", "incidents", "sensors"];
      const results = await Promise.all(
        shards.map(async (sh) => {
          try {
            const r = await edgeApi.search({ shard: sh, query: p.text!, mode: "hybrid", limit: 3 });
            return { shard: sh, results: r.results.filter((x) => x.id !== point!.id).slice(0, 3) };
          } catch { return { shard: sh, results: [] }; }
        })
      );
      setSimilar(results.filter((r) => r.results.length > 0));
    } finally {
      setLoadingSimilar(false);
    }
  }

  // close on Escape
  useEffect(() => {
    if (!point) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [point, onClose]);

  if (!point) return null;

  const p = { ...point, ...(full ?? {}) } as PointRef & Record<string, unknown>;
  // gate the cloud LLM on the stored payload's sensitivity; unknown (not loaded) fails closed
  const srcSensitivity = String(full?.sensitivity ?? "").trim().toLowerCase();
  const restricted = srcSensitivity === "restricted";
  const canDistill = online && !!srcSensitivity && !restricted;

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await edgeApi.deletePoint(point!.shard, point!.id);
      if (!r.ok) throw new Error(r.reason || "delete failed");
      toast({ title: "Point deleted", description: `${point!.slug ?? point!.id.slice(0, 8)} removed from ${point!.shard}` });
      await edge.refresh();
      onClose();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  async function handleDistill() {
    if (!canDistill) {
      toast({ title: "Distill unavailable", description: restricted ? "Restricted notes never leave the device." : "Cloud LLM requires connectivity.", variant: "destructive" });
      return;
    }
    setDistilling(true);
    try {
      const r = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "distill_sop", text: p.text, asset_id: p.asset_id }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || "LLM failed");
      setDistilledSop(data.sop);
      toast({ title: "SOP distilled", description: "Review and save to manuals." });
    } catch (e) {
      toast({ title: "Distill failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setDistilling(false);
    }
  }

  async function handleSaveSop() {
    if (!distilledSop) return;
    try {
      await edge.write({ shard: "manuals", text: distilledSop, criticality: "high", sensitivity: srcSensitivity, asset_id: p.asset_id, title: `SOP distilled from ${p.slug ?? "incident"}`, domain: "manual" });
      toast({ title: "SOP saved to manuals", description: "Queued for fleet sync." });
      setDistilledSop(null);
      onClose();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  }

  // Gather all payload keys (excluding the ones shown in the header)
  const headerKeys = new Set(["_id", "slug", "text", "title", "domain", "criticality", "sensitivity", "origin_device", "sync_state", "updated_at", "asset_id", "sensor_type", "value", "unit", "severity"]);
  const extraKeys = Object.keys(full ?? {}).filter((k) => !headerKeys.has(k));

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-in fade-in"
        onClick={onClose}
      />
      {/* drawer */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-[-16px_0_48px_-16px_rgb(0_0_0/0.6)] animate-in slide-in-from-right duration-200">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{DOMAIN_ICON[p.domain ?? ""] ?? <FileText className="h-3 w-3" />}</span>
              <span className="text-xs text-muted-foreground">{point.shard}</span>
              {p.domain && <span className="text-xs text-muted-foreground">· {p.domain}</span>}
            </div>
            <h2 className="mt-1.5 text-xl leading-tight font-semibold tracking-tight text-balance text-foreground">{p.title || p.slug || point.id.slice(0, 12)}</h2>
            {p.title && p.slug && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{p.slug}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => navigator.clipboard?.writeText(point.id).then(() => toast({ title: "Copied", description: "point ID" }))}
              title="Copy point ID" aria-label="Copy point ID"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            {p.text && (
              <button
                onClick={() => navigator.clipboard?.writeText(p.text ?? "").then(() => toast({ title: "Copied", description: "point text" }))}
                title="Copy text" aria-label="Copy text"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* body — scrollable */}
        <div className="edge-scroll flex-1 overflow-y-auto p-5">
          {/* badges row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <CriticalityBadge value={p.criticality} />
            <SyncStateBadge value={p.sync_state} />
            {p.severity && <Pill tone="dim">severity {p.severity}</Pill>}
          </div>

          {/* metadata grid */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Meta icon={<Hash className="h-3 w-3" />} label="id" value={<span className="break-all text-foreground/80">{point.id.slice(0, 18)}…</span>} />
            <Meta icon={<Clock className="h-3 w-3" />} label="updated" value={<span title={p.updated_at ? new Date(p.updated_at).toLocaleString() : undefined}>{formatRelative(p.updated_at)}{p.updated_at ? ` · ${formatTime(p.updated_at)}` : ""}</span>} />
            <Meta icon={<Server className="h-3 w-3" />} label="origin" value={p.origin_device ?? "—"} accent={p.origin_device === edge.state?.active_device ? "emerald" : undefined} />
            {p.asset_id && <Meta icon={<Tag className="h-3 w-3" />} label="asset" value={p.asset_id} />}
            {p.sensor_type && <Meta icon={<Gauge className="h-3 w-3" />} label="sensor" value={p.sensor_type} />}
            {p.value != null && <Meta icon={<Gauge className="h-3 w-3" />} label="value" value={`${p.value}${p.unit ?? ""}`} />}
            {p.sensitivity && <Meta icon={<ShieldAlert className="h-3 w-3" />} label="sensitivity" value={p.sensitivity} accent={p.sensitivity === "restricted" ? "rose" : undefined} />}
          </div>

          {/* text content */}
          <div className="mt-3">
            <div className="mb-1.5 text-xs text-muted-foreground">
              Content
            </div>
            <div className="rounded-md border border-border bg-background p-3">
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> loading full payload…
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{p.text}</p>
              )}
            </div>
          </div>

          {/* cloud LLM distill (online only) */}
          {p.domain === "incident" && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs text-muted-foreground">
                Cloud LLM
              </div>
              {distilledSop ? (
                <div className="rounded-md border border-border bg-background p-3">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">{distilledSop}</pre>
                  <Button size="sm" onClick={handleSaveSop} disabled={!!edge.busy} className="mt-3 gap-1.5 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">
                    <Save className="h-3 w-3" /> Save to manuals
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDistill}
                    disabled={!canDistill || distilling}
                    title={restricted ? "Restricted notes never leave the device — cloud LLM distill is disabled" : undefined}
                    className="gap-1.5"
                  >
                    {distilling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />}
                    Distill → SOP
                  </Button>
                  {restricted && (
                    <span className="flex items-center gap-1 font-mono text-[10px] text-rose-300">
                      <ShieldAlert className="h-3 w-3" /> restricted — stays on device
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* similar points — semantic "related knowledge" via hybrid search */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Similar points
              </div>
              {similar === null && !loadingSimilar && (
                <button
                  onClick={handleFindSimilar}
                  disabled={!p.text}
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  <Search className="h-3 w-3" /> Find similar
                </button>
              )}
            </div>
            {loadingSimilar && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> searching across all shards…
              </div>
            )}
            {similar && similar.length === 0 && (
              <div className="rounded-lg border border-dashed border-border bg-background/30 p-3 text-center text-xs text-muted-foreground">
                No similar points found.
              </div>
            )}
            {similar && similar.map((group) => (
              <div key={group.shard} className="mb-2">
                <div className="mb-1 text-xs text-muted-foreground">{group.shard}</div>
                <div className="space-y-1">
                  {group.results.map((r) => (
                    <button
                      key={r.id}
                      onClick={(e) => { e.stopPropagation(); edge.openPoint({ ...r, shard: group.shard }); }}
                      className="block w-full rounded-md border border-border bg-background/40 p-2 text-left transition-colors hover:border-emerald-500/30 hover:bg-background/60"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[11px] font-semibold text-foreground">{r.slug ?? r.id.slice(0, 8)}</span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{r.score.toFixed(3)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{r.text}</p>
                      {r.origin_device && <span className="mt-0.5 inline-block font-mono text-xs text-muted-foreground">@{r.origin_device}</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {similar && similar.length > 0 && (
              <button
                onClick={handleFindSimilar}
                className="mt-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Search again
              </button>
            )}
          </div>

          {/* extra payload keys */}
          {extraKeys.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs text-muted-foreground">
                Full payload
              </div>
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <dl className="space-y-1 font-mono text-[11px]">
                  {extraKeys.map((k) => (
                    <div key={k} className="flex items-start gap-2">
                      <dt className="shrink-0 text-muted-foreground">{k}:</dt>
                      <dd className="min-w-0 break-all text-foreground/80">{JSON.stringify((full as Record<string, unknown>)[k])}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>

        {/* footer actions */}
        <div className="flex items-center gap-2 border-t border-border/60 p-3">
          <span className="font-mono text-xs text-muted-foreground">
            {point.shard} · {point.id.slice(0, 8)}…
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDelete}
              disabled={deleting || !!edge.busy}
              className="gap-1.5 border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
            >
              {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Delete
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Meta({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: "emerald" | "rose" }) {
  const color = accent === "emerald" ? "text-emerald-400" : accent === "rose" ? "text-rose-400" : "text-foreground";
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">
        {label}
      </div>
      <div className={cn("truncate font-mono text-sm", color)}>{value}</div>
    </div>
  );
}
