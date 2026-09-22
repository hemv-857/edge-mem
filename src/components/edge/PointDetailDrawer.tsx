"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  X, Trash2, Cloud, Loader2, FileText, Hash, Clock, Server,
  ShieldAlert, Tag, Cpu, Gauge, BookOpen, AlertTriangle, Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import type { EdgeHook } from "@/hooks/use-edge";
import { CriticalityBadge, SyncStateBadge, formatBytes, formatRelative, formatTime } from "./edge-ui";

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
  const online = edge.syncStatus?.online ?? true;

  useEffect(() => {
    if (!point) { setFull(null); setDistilledSop(null); return; }
    setLoading(true);
    setDistilledSop(null);
    edgeApi.getPoint(point.shard, point.id)
      .then((p) => setFull(p))
      .catch(() => setFull(null))
      .finally(() => setLoading(false));
  }, [point]);

  // close on Escape
  useEffect(() => {
    if (!point) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [point, onClose]);

  if (!point) return null;

  const p = { ...point, ...(full ?? {}) } as PointRef & Record<string, unknown>;

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
    if (!online) {
      toast({ title: "Offline", description: "Cloud LLM requires connectivity.", variant: "destructive" });
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
      await edge.write({ shard: "manuals", text: distilledSop, criticality: "high", sensitivity: "internal", asset_id: p.asset_id, title: `SOP distilled from ${p.slug ?? "incident"}`, domain: "manual" });
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
        className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm animate-in fade-in"
        onClick={onClose}
      />
      {/* drawer */}
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-card/95 shadow-2xl animate-in slide-in-from-right">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{DOMAIN_ICON[p.domain ?? ""] ?? <FileText className="h-3 w-3" />}</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{point.shard}</span>
              {p.domain && <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{p.domain}</span>}
            </div>
            <h2 className="mt-1 truncate font-mono text-sm font-semibold text-foreground">{p.slug ?? point.id.slice(0, 12)}</h2>
            {p.title && <p className="truncate text-xs text-muted-foreground">{p.title}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body — scrollable */}
        <div className="edge-scroll flex-1 overflow-y-auto p-4">
          {/* badges row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <CriticalityBadge value={p.criticality} />
            <SyncStateBadge value={p.sync_state} />
            {p.severity && <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">sev: {p.severity}</span>}
          </div>

          {/* metadata grid */}
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-background/40 p-3 font-mono text-[11px]">
            <Meta icon={<Hash className="h-3 w-3" />} label="id" value={<span className="break-all text-foreground/80">{point.id.slice(0, 18)}…</span>} />
            <Meta icon={<Clock className="h-3 w-3" />} label="updated" value={formatRelative(p.updated_at)} />
            <Meta icon={<Server className="h-3 w-3" />} label="origin" value={p.origin_device ?? "—"} accent={p.origin_device === edge.state?.active_device ? "emerald" : undefined} />
            {p.asset_id && <Meta icon={<Tag className="h-3 w-3" />} label="asset" value={p.asset_id} />}
            {p.sensor_type && <Meta icon={<Gauge className="h-3 w-3" />} label="sensor" value={p.sensor_type} />}
            {p.value !== undefined && <Meta icon={<Gauge className="h-3 w-3" />} label="value" value={`${p.value}${p.unit ?? ""}`} />}
            {p.sensitivity && <Meta icon={<ShieldAlert className="h-3 w-3" />} label="sensitivity" value={p.sensitivity} accent={p.sensitivity === "restricted" ? "rose" : undefined} />}
            {p.updated_at && <Meta icon={<Clock className="h-3 w-3" />} label="time" value={formatTime(p.updated_at)} />}
          </div>

          {/* text content */}
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <FileText className="h-3 w-3" /> Content
            </div>
            <div className="rounded-lg border border-border bg-background/40 p-3">
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
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <Cloud className="h-3 w-3 text-sky-300" /> Cloud LLM
              </div>
              {distilledSop ? (
                <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">{distilledSop}</pre>
                  <Button size="sm" onClick={handleSaveSop} disabled={!!edge.busy} className="mt-2 gap-1 bg-emerald-500/90 font-mono text-[10px] text-emerald-950 hover:bg-emerald-400">
                    <Save className="h-3 w-3" /> Save to manuals
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={handleDistill} disabled={!online || distilling} className="gap-1.5 border-sky-500/30 bg-sky-500/5 font-mono text-[11px] text-sky-300 hover:bg-sky-500/10">
                  {distilling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />}
                  Distill → SOP
                </Button>
              )}
            </div>
          )}

          {/* extra payload keys */}
          {extraKeys.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <Cpu className="h-3 w-3" /> Full payload
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
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {point.shard} · {point.id.slice(0, 8)}…
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDelete}
              disabled={deleting || !!edge.busy}
              className="gap-1 border-rose-500/30 bg-rose-500/5 font-mono text-[10px] text-rose-300 hover:bg-rose-500/10"
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
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </div>
      <div className={cn("truncate", color)}>{value}</div>
    </div>
  );
}
