"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { RefreshCw, DownloadCloud, ArrowUp, ArrowDown, AlertTriangle, Check, GitMerge, FileText, Network, Zap, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import type { EdgeHook } from "@/hooks/use-edge";
import type { Conflict } from "@/lib/edge-types";
import { Panel, StatCard, formatBytes, formatRelative, formatTime } from "./edge-ui";

export default function SyncConsole({ edge }: { edge: EdgeHook }) {
  const ss = edge.syncStatus;
  const online = ss?.online ?? true;
  const summary = ss?.last_sync_summary;

  return (
    <div className="space-y-5">
      {/* top stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Queue depth" value={ss?.queue_depth ?? 0} sub={`${ss?.queue_critical ?? 0} critical`} accent={(ss?.queue_depth ?? 0) > 0 ? "amber" : "default"} icon={<Zap className="h-4 w-4" />} />
        <StatCard label="Last sync" value={formatRelative(ss?.last_sync_at)} sub={summary ? `${summary.pushed}↑ ${summary.pulled}↓` : "never"} icon={<RefreshCw className="h-4 w-4" />} />
        <StatCard label="Pushed (total)" value={formatBytes(ss?.bytes_pushed ?? 0)} sub="edge → cloud" accent="emerald" icon={<ArrowUp className="h-4 w-4" />} />
        <StatCard label="Pulled (total)" value={formatBytes(ss?.bytes_pulled ?? 0)} sub="cloud → edge" icon={<ArrowDown className="h-4 w-4" />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Sync engine */}
        <Panel
          title="Sync Engine"
          desc="Dual-write push queue + manifest-diff pull. Survives intermittent connectivity."
          right={
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => edge.bootstrap()} disabled={!!edge.busy || !online} className="gap-1.5 font-mono text-xs">
                <DownloadCloud className="h-3.5 w-3.5" /> Bootstrap
              </Button>
              <Button size="sm" onClick={() => edge.sync()} disabled={!!edge.busy || !online} className="gap-1.5 bg-emerald-500/90 font-mono text-xs text-emerald-950 hover:bg-emerald-400">
                <RefreshCw className={cn("h-3.5 w-3.5", edge.busy === "sync" && "animate-spin")} /> Sync now
              </Button>
            </div>
          }
        >
          {!online && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              <Network className="h-3.5 w-3.5" />
              <span className="font-mono">Device offline — sync blocked. Queue is retained and will flush on reconnect.</span>
            </div>
          )}

          {/* queue */}
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Push queue (edge → cloud)</span>
              <span className="font-mono text-xs tabular-nums text-foreground">{ss?.queue_depth ?? 0} pending</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full transition-all", (ss?.queue_critical ?? 0) > 0 ? "bg-rose-400" : "bg-amber-400")} style={{ width: `${Math.min(100, ((ss?.queue_depth ?? 0) / 10) * 100)}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
              <span>normal: {(ss?.queue_depth ?? 0) - (ss?.queue_critical ?? 0)}</span>
              <span className="text-rose-400">critical: {ss?.queue_critical ?? 0}</span>
            </div>
          </div>

          {/* last sync summary */}
          <div className="mt-3 rounded-lg border border-border bg-card/40 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Last sync summary</div>
            {summary ? (
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                <Row icon={<ArrowUp className="h-3 w-3 text-emerald-400" />} label="pushed" value={summary.pushed} />
                <Row icon={<ArrowDown className="h-3 w-3 text-sky-400" />} label="pulled" value={summary.pulled} />
                <Row icon={<HardDrive className="h-3 w-3 text-emerald-400" />} label="bytes↑" value={formatBytes(summary.bytes_pushed)} />
                <Row icon={<HardDrive className="h-3 w-3 text-sky-400" />} label="bytes↓" value={formatBytes(summary.bytes_pulled)} />
                <Row icon={<AlertTriangle className="h-3 w-3 text-rose-400" />} label="conflicts" value={summary.new_conflicts} accent={summary.new_conflicts > 0 ? "rose" : undefined} />
                <Row icon={<RefreshCw className="h-3 w-3 text-muted-foreground" />} label="at" value={formatTime(summary.at)} />
              </div>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">No sync yet — run Bootstrap or Sync.</div>
            )}
          </div>

          {/* manifest diffs */}
          {summary?.manifest_diffs && (
            <div className="mt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Manifest-diff pull (cloud → edge)</div>
              <div className="mt-1.5 space-y-1">
                {Object.entries(summary.manifest_diffs).map(([shard, diff]) => (
                  <div key={shard} className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
                    <span className="text-foreground">{shard}</span>
                    <span className={cn("rounded px-1.5 py-0.5 uppercase tracking-wider", diff.changed ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>
                      {diff.changed ? "changed" : "unchanged"}
                    </span>
                    <span className="ml-auto text-muted-foreground">{diff.last_hash || "—"} → {diff.cloud_hash}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>

        {/* Conflicts */}
        <Panel
          title="Conflicts"
          desc="Divergent edits across devices — never silently overwritten."
          right={<span className="font-mono text-[10px] text-muted-foreground">{ss?.open_conflicts.length ?? 0} open</span>}
        >
          {ss && ss.open_conflicts.length === 0 && (ss.resolved_conflicts?.length ?? 0) === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Check className="mx-auto h-6 w-6 text-emerald-400/60" />
              <p className="mt-2 text-sm text-muted-foreground">No conflicts. All synced knowledge is consistent.</p>
              <Button
                variant="outline" size="sm"
                onClick={() => edge.demoConflict().then(() => toast({ title: "Conflict manufactured", description: "SOP-12 edited on alpha & beta. Run Sync to surface it." }))}
                disabled={!!edge.busy}
                className="mt-3 gap-1.5 font-mono text-xs"
              >
                <AlertTriangle className="h-3.5 w-3.5" /> Manufacture a conflict (demo)
              </Button>
            </div>
          )}

          {(ss?.open_conflicts ?? []).map((c) => (
            <ConflictCard key={c.id} c={c} onResolve={edge.resolveConflict} busy={edge.busy} />
          ))}

          {(ss?.resolved_conflicts ?? []).length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Resolved</div>
              <div className="space-y-1">
                {(ss.resolved_conflicts ?? []).slice(-4).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 font-mono text-[10px]">
                    <Check className="h-3 w-3 text-emerald-400" />
                    <span className="text-foreground">{c.slug}</span>
                    <span className="text-muted-foreground">→ {c.resolution}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: "rose" }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("ml-auto tabular-nums", accent === "rose" ? "text-rose-400" : "text-foreground")}>{value}</span>
    </div>
  );
}

function ConflictCard({ c, onResolve, busy }: { c: Conflict; onResolve: (id: string, r: "local" | "remote" | "merge", t?: string) => Promise<void>; busy: string | null }) {
  const [mergeText, setMergeText] = useState("");
  const [showMerge, setShowMerge] = useState(false);

  return (
    <div className="mb-2.5 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 edge-glow-rose">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
        <span className="font-mono text-xs font-semibold text-foreground">{c.slug}</span>
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{c.shard}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{formatRelative(c.created_at)}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Side label="local" device={c.local.origin_device} text={c.local.text} ts={c.local.updated_at} accent="amber" />
        <Side label="remote" device={c.remote.origin_device} text={c.remote.text} ts={c.remote.updated_at} accent="sky" />
      </div>

      {showMerge && (
        <div className="mt-2">
          <Textarea
            value={mergeText}
            onChange={(e) => setMergeText(e.target.value)}
            placeholder="Merge both versions into a single resolved text…"
            className="min-h-[60px] border-border bg-card/40 font-mono text-xs"
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "local").then(() => toast({ title: "Kept local version" }))}
          className="gap-1 border-amber-500/30 bg-amber-500/5 font-mono text-[10px] text-amber-300 hover:bg-amber-500/10">
          <Check className="h-3 w-3" /> Keep local
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "remote").then(() => toast({ title: "Kept remote version" }))}
          className="gap-1 border-sky-500/30 bg-sky-500/5 font-mono text-[10px] text-sky-300 hover:bg-sky-500/10">
          <ArrowDown className="h-3 w-3" /> Keep remote
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (!showMerge) { setMergeText(c.local.text); setShowMerge(true); } else onResolve(c.id, "merge", mergeText).then(() => toast({ title: "Merged & synced" })); }}
          className="gap-1 border-emerald-500/30 bg-emerald-500/5 font-mono text-[10px] text-emerald-300 hover:bg-emerald-500/10">
          <GitMerge className="h-3 w-3" /> {showMerge ? "Apply merge" : "Merge…"}
        </Button>
      </div>
    </div>
  );
}

function Side({ label, device, text, ts, accent }: { label: string; device: string; text: string; ts: number; accent: "amber" | "sky" }) {
  const color = accent === "amber" ? "border-amber-500/30 text-amber-300" : "border-sky-500/30 text-sky-300";
  return (
    <div className={cn("rounded border bg-card/30 p-2", color)}>
      <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider opacity-80">
        <span>{label}</span>
        <span>@{device}</span>
      </div>
      <div className="mt-1 flex items-start gap-1">
        <FileText className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-60" />
        <p className="text-[11px] leading-snug text-foreground/80 line-clamp-3">{text}</p>
      </div>
      <div className="mt-1 font-mono text-[9px] text-muted-foreground">{formatTime(ts)}</div>
    </div>
  );
}
