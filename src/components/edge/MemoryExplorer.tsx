"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { EdgePoint, WriteResult } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FillScroll, Hl, PageHero, Panel, CriticalityBadge, SyncStateBadge, formatRelative } from "./edge-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SHARD_ORDER = ["manuals", "incidents", "sensors"] as const;
const CRITS = ["critical", "high", "medium", "low"] as const;

// pre-fill the form with realistic field data
const TEMPLATES = [
  { label: "Vibration incident", title: "P-201 Vibration Spike", criticality: "critical", asset_id: "P-201", text: "P-201 drive-end vibration spiked to 9.2mm/s, BPFO peak at 142Hz — confirmed outer race bearing defect. Isolating pump pending bearing swap per SOP-12." },
  { label: "Overheat incident", title: "M-15 Overheat", criticality: "high", asset_id: "M-15", text: "Motor M-15 winding temperature reached 95C, cooling fan tripped. Cleaned filter, verified airflow. Monitoring for recurrence." },
  { label: "Manual excerpt", title: "Seal Replacement Procedure", criticality: "high", asset_id: "P-300", text: "Mechanical seal replacement for P-300 high-pressure pumps. Vent system, remove seal housing, inspect shaft sleeve for wear, install new cartridge seal, align to within 0.05mm TIR, flush and pressure-test before restart." },
  { label: "Sensor reading", title: "TT-09 Temp Drift", criticality: "medium", asset_id: "TT-09", text: "Temperature sensor TT-09 drift detected — reading 2.3C high vs reference at 50C point. Recalibrated against NIST-traceable reference, offset corrected." },
] as const;

export default function MemoryExplorer({ edge }: { edge: EdgeHook }) {
  const shards = edge.memory?.shards ?? {};
  const shardKeys = SHARD_ORDER.filter((k) => shards[k]) as string[];
  const [selected, setSelected] = useState<string>("incidents");
  // derive during render so an invalid selection never cascades into setState-in-effect
  const shard = shardKeys.includes(selected) ? selected : (shardKeys[0] ?? "incidents");
  const def = shards[shard];

  const total = edge.memory?.total_points ?? 0;

  return (
    <div className="space-y-6">
      <PageHero
        title={edge.memory ? <><Hl>{total} {total === 1 ? "note" : "notes"}</Hl> on this device.</> : "Loading memory…"}
        sub="Pick a shard to browse it, or write a note — the policy decides whether it syncs."
        stats={
          <div role="group" aria-label="Shard" className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
            {shardKeys.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={shard === k}
                onClick={() => setSelected(k)}
                className={cn(
                  "relative min-w-0 px-4 py-4 text-left transition-colors sm:min-w-40 sm:px-5 sm:py-5",
                  "after:absolute after:inset-x-0 after:top-0 after:h-0.5",
                  shard === k ? "bg-muted after:bg-emerald-400" : "bg-background/95 hover:bg-muted/50",
                )}
              >
                <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:text-[11px]">{k}</span>
                <span className="mt-1.5 block text-3xl font-semibold tabular-nums tracking-[-0.03em] text-foreground sm:text-4xl">{shards[k].points}</span>
                <span className="mt-1.5 hidden sm:block"><SyncStateBadge value={shards[k].default_sync} /></span>
              </button>
            ))}
          </div>
        }
      />

      {!edge.memory ? (
        <div className="h-96 animate-pulse rounded-lg bg-card" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <PointsList key={shard} edge={edge} shard={shard} desc={def?.desc} className="h-full lg:col-span-2" />
          <WriteForm edge={edge} shard={shard} />
        </div>
      )}
    </div>
  );
}

function PointsList({ edge, shard, desc, className }: { edge: EdgeHook; shard: string; desc?: string; className?: string }) {
  const [points, setPoints] = useState<EdgePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [crit, setCrit] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    edgeApi.points(shard, undefined, 50)
      .then((r) => { if (!cancelled) { setPoints(r.points); setError(null); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setPoints([]); setLoading(false); } });
    return () => { cancelled = true; };
    // re-fetch when the memory snapshot refreshes (counts move after a write/sync);
    // a shard change remounts via the parent's `key`
  }, [shard, edge.memory]);

  const byCrit: Record<string, number> = {};
  for (const p of points) byCrit[p.criticality ?? "medium"] = (byCrit[p.criticality ?? "medium"] ?? 0) + 1;
  const q = filter.trim().toLowerCase();
  const visible = points.filter((p) =>
    (!crit || p.criticality === crit) &&
    (!q || `${p.slug ?? ""} ${p.title ?? ""} ${p.text ?? ""} ${p.asset_id ?? ""} ${p.origin_device ?? ""}`.toLowerCase().includes(q)));

  return (
    <Panel
      title={<>Notes <span className="font-normal text-muted-foreground">in {shard}</span></>}
      desc={desc}
      className={className}
      flush
      fill
      right={!loading && <span className="font-mono text-xs text-muted-foreground">{visible.length === points.length ? points.length : `${visible.length} of ${points.length}`}</span>}
    >
      {!loading && points.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by slug, text, asset, origin…"
              aria-label="Filter points"
              className="h-8 w-full rounded-md border border-border bg-background pr-7 pl-8 text-sm text-foreground placeholder:text-muted-foreground"
            />
            {filter && (
              <button type="button" onClick={() => setFilter("")} aria-label="Clear filter" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {CRITS.filter((c) => byCrit[c] || crit === c).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={crit === c}
              onClick={() => setCrit(crit === c ? null : c)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                crit === c ? "border-foreground/30 bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {c} <span className="font-mono tabular-nums">{byCrit[c] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-px p-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded bg-muted/40" />)}</div>
      ) : error ? (
        <p role="alert" className="px-4 py-6 sm:px-5 text-sm text-rose-300">{error}</p>
      ) : points.length === 0 ? (
        <p className="px-4 py-12 sm:px-5 text-center text-sm text-muted-foreground">No points on this shard yet. Bootstrap from the cloud, or write the first one.</p>
      ) : visible.length === 0 ? (
        <p className="px-4 py-12 sm:px-5 text-center text-sm text-muted-foreground">Nothing matches that filter.</p>
      ) : (
        <FillScroll>
        <ul className="divide-y divide-border">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => edge.openPoint({ ...p, shard })}
                className="flex w-full items-start gap-4 px-4 py-3 sm:px-5 text-left transition-colors hover:bg-muted/30"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{p.title || p.slug || p.id.slice(0, 8)}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{p.text}</p>
                  <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground/80">
                    {[p.slug, p.asset_id, p.origin_device && `@${p.origin_device}`, formatRelative(p.updated_at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <CriticalityBadge value={p.criticality} />
                  <SyncStateBadge value={p.sync_state} />
                </div>
              </button>
            </li>
          ))}
        </ul>
        </FillScroll>
      )}
    </Panel>
  );
}

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
  const tagBlocked = sensitivity === "restricted" ? "Restricted notes never leave the device" : !online ? "Auto-tag needs the link" : null;

  const handleAutoTag = useCallback(async () => {
    if (!text.trim() || tagBlocked) return;
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
      // never lower a user-selected restricted (they may have switched while the call was in flight)
      setSensitivity((prev) => (prev === "restricted" ? prev : data.sensitivity));
      setAutoTagReason(data.reason);
    } catch (e) {
      toast({ title: "Auto-tag failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setAutoTagging(false);
    }
  }, [text, tagBlocked]);

  const handleWrite = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setWriting(true);
    setDecision(null);
    try {
      // call the API directly to surface the live policy decision, then refresh the hook snapshot
      const result = await edgeApi.write({
        shard, text: text.trim(), criticality, sensitivity,
        asset_id: assetId.trim() || undefined,
        title: title.trim() || undefined,
      });
      setDecision(result);
      setText(""); setTitle(""); setAssetId(""); setAutoTagReason(null);
      await edge.refresh();
    } catch (err) {
      toast({ title: "Write failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setWriting(false);
    }
  }, [canWrite, shard, text, criticality, sensitivity, assetId, title, edge]);

  return (
    <Panel title={<>New note <span className="font-normal text-muted-foreground">in {shard}</span></>}>
      <form onSubmit={handleWrite} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="note-text">Note</Label>
          <Textarea
            id="note-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a manual excerpt, incident note, or sensor observation…"
            className="min-h-[120px] resize-y text-sm leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Example:</span>
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => { setText(t.text); setTitle(t.title); setCriticality(t.criticality); setAssetId(t.asset_id); }}
                className="underline-offset-2 hover:text-foreground hover:underline"
              >{t.label.toLowerCase()}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Criticality</Label>
            <Select value={criticality} onValueChange={setCriticality}>
              <SelectTrigger className="h-9 w-full" aria-label="Criticality"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["low", "medium", "high", "critical"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Sensitivity</Label>
            <Select value={sensitivity} onValueChange={setSensitivity}>
              <SelectTrigger className="h-9 w-full" aria-label="Sensitivity"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["internal", "restricted", "public"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAutoTag}
            disabled={autoTagging || !text.trim() || !!tagBlocked}
            title={tagBlocked ?? "Let the cloud LLM set criticality and sensitivity"}
            className="gap-1.5"
          >
            {autoTagging && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Auto-tag
          </Button>
          {autoTagReason && <p className="min-w-0 text-xs text-muted-foreground">{autoTagReason}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="note-title">Title</Label>
            <Input id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note-asset">Asset</Label>
            <Input id="note-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="e.g. P-201" className="h-9 font-mono" />
          </div>
        </div>

        <Button type="submit" disabled={!canWrite} className="w-full gap-2 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">
          {writing && <Loader2 className="h-4 w-4 animate-spin" />}
          {writing ? "Embedding…" : "Save note"}
        </Button>

        {decision && (
          <div role="status" className="space-y-1.5 border-t border-border pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">{decision.slug}</span>
              <span className="text-muted-foreground">saved →</span>
              <SyncStateBadge value={decision.sync_state} />
            </div>
            <p className="text-muted-foreground">
              {decision.decision.reason}
              {decision.decision.matched_rule && <span className="font-mono text-xs"> ({decision.decision.matched_rule})</span>}
            </p>
          </div>
        )}
      </form>
    </Panel>
  );
}
