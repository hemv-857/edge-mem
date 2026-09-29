"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, DownloadCloud, ArrowUp, ArrowDown, AlertTriangle, Check, GitMerge, FileText, Network, Zap, HardDrive, History, Cloud, Cpu, Timer, Download, Upload, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import type { EdgeHook } from "@/hooks/use-edge";
import type { Conflict, ActivityEntry, SnapshotImportResult } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { Panel, StatCard, formatBytes, formatRelative, formatTime } from "./edge-ui";

export default function SyncConsole({ edge }: { edge: EdgeHook }) {
  const ss = edge.syncStatus;
  const online = ss?.online ?? true;
  const summary = ss?.last_sync_summary;

  // Auto-sync state
  const [autoSync, setAutoSync] = useState(false);
  const [intervalSec, setIntervalSec] = useState(30);
  const lastAutoSyncRef = useRef<number>(0);
  const retryAfterRef = useRef<number>(0); // back off after a failed sync (cloud down)

  // Auto-sync effect: when enabled + online + queue has items, sync on interval
  useEffect(() => {
    if (!autoSync) return;
    const id = setInterval(async () => {
      const now = Date.now();
      const queueDepth = edge.syncStatus?.queue_depth ?? 0;
      const isOnline = edge.syncStatus?.online ?? false;
      if (isOnline && !edge.busy && now >= retryAfterRef.current &&
          (queueDepth > 0 || now - lastAutoSyncRef.current >= intervalSec * 1000)) {
        lastAutoSyncRef.current = now;
        try {
          if (!(await edge.sync())) retryAfterRef.current = now + 30_000;
        } catch { retryAfterRef.current = now + 30_000; }
      }
    }, 2000); // check every 2s
    return () => clearInterval(id);
  }, [autoSync, intervalSec, edge]);

  return (
    <div className="space-y-5">
      {/* top stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Queue depth" value={ss?.queue_depth ?? 0} sub={`${ss?.queue_critical ?? 0} critical`} accent={(ss?.queue_depth ?? 0) > 0 ? "amber" : "default"} icon={<Zap className="h-4 w-4" />} />
        <StatCard label="Last sync" value={formatRelative(ss?.last_sync_at)} sub={summary ? `${summary.pushed}↑ ${summary.pulled}↓` : "never"} icon={<RefreshCw className="h-4 w-4" />} />
        <StatCard label="Pushed (total)" value={formatBytes(ss?.bytes_pushed ?? 0)} sub="edge → cloud" accent="emerald" icon={<ArrowUp className="h-4 w-4" />} />
        <StatCard label="Pulled (total)" value={formatBytes(ss?.bytes_pulled ?? 0)} sub="cloud → edge" icon={<ArrowDown className="h-4 w-4" />} />
      </div>

      {/* auto-sync banner */}
      <div className={cn(
        "flex items-center gap-3 rounded-lg border p-3 transition-colors",
        autoSync ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-card/40"
      )}>
        <Timer className={cn("h-4 w-4", autoSync ? "text-emerald-400 edge-pulse" : "text-muted-foreground")} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">auto-sync</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {autoSync ? (online ? `running · every ${intervalSec}s` : "paused (offline)") : "off"}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">automatically flushes the queue + pulls cloud updates when online</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            disabled={!autoSync}
            aria-label="Auto-sync interval"
            className="h-7 rounded border border-border bg-card/50 px-1.5 font-mono text-[10px] text-foreground disabled:opacity-50"
          >
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={120}>2m</option>
          </select>
          <Switch
            checked={autoSync}
            onCheckedChange={setAutoSync}
            aria-label="Auto-sync when connectivity returns"
            className="data-[state=checked]:bg-emerald-500"
          />
        </div>
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
              <span className={cn((ss?.queue_critical ?? 0) > 0 ? "text-rose-400" : "text-muted-foreground")}>critical: {ss?.queue_critical ?? 0}</span>
            </div>
          </div>

          {/* last sync summary */}
          <div className="mt-3 rounded-lg border border-border bg-card/40 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Last sync summary</div>
            {summary ? (
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                <Row icon={<ArrowUp className="h-3 w-3 text-emerald-400" />} label="pushed" value={summary.pushed} />
                <Row icon={<ArrowDown className="h-3 w-3 text-sky-400" />} label="pulled" value={summary.pulled} />
                <Row icon={<HardDrive className="h-3 w-3 text-emerald-400" />} label="pushed (B)" value={formatBytes(summary.bytes_pushed)} />
                <Row icon={<HardDrive className="h-3 w-3 text-sky-400" />} label="pulled (B)" value={formatBytes(summary.bytes_pulled)} />
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
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Manifest-diff pull (cloud → edge)</span>
                <span className="font-mono text-[9px] text-muted-foreground/70">checked {formatRelative(summary.at)}</span>
              </div>
              <div className="mt-1.5 space-y-1">
                {Object.entries(summary.manifest_diffs).map(([shard, diff]) => (
                  <div key={shard} className={cn("flex items-center gap-2 rounded border px-2 py-1.5 font-mono text-[10px]", diff.changed ? "border-emerald-500/25 bg-emerald-500/5" : "border-border bg-card/40")}>
                    <span className="text-foreground">{shard}</span>
                    <span className={cn("rounded px-1.5 py-0.5 uppercase tracking-wider", diff.changed ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-500/15 text-zinc-300")}>
                      {diff.changed ? "changed" : "unchanged"}
                    </span>
                    {diff.changed ? (
                      <span className="text-emerald-300/70">{diff.last_hash || "—"} → {diff.cloud_hash}</span>
                    ) : (
                      <span className="ml-auto text-muted-foreground">v{diff.cloud_hash}</span>
                    )}
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
                {(ss?.resolved_conflicts ?? []).slice(-4).map((c) => (
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

      {/* Snapshot handoff — export a device's memory, carry it to another device */}
      <SnapshotHandoff edge={edge} />

      {/* Sync History Timeline — visual timeline of past sync/bootstrap/connectivity events */}
      <SyncHistoryTimeline activity={edge.activity} />
    </div>
  );
}

/** Cross-device snapshot handoff: export a portable JSON snapshot from the
 *  active device, carry it over any channel, import it on the target device.
 *  Restricted (local_only) points are stripped server-side and never leave. */
function SnapshotHandoff({ edge }: { edge: EdgeHook }) {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [last, setLast] = useState<SnapshotImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doExport() {
    setBusy("export");
    try {
      const snap = await edgeApi.exportSnapshot();
      const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `edge-snapshot-${snap.device}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Snapshot exported",
        description: `${snap.point_count} points${snap.excluded_local_only ? ` · ${snap.excluded_local_only} restricted held back` : ""}`,
      });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function doImport(file: File) {
    setBusy("import");
    try {
      const snap = JSON.parse(await file.text()) as unknown;
      const r = await edgeApi.importSnapshot({ snapshot: snap as never });
      if (!r.ok) throw new Error(r.reason || "rejected");
      setLast(r);
      await edge.refresh();
      toast({
        title: "Snapshot imported",
        description: `${r.imported} points${r.source_device ? ` from ${r.source_device}` : ""}${r.skipped ? ` · ${r.skipped} skipped` : ""}`,
      });
    } catch (e) {
      toast({ title: "Import failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Panel
      title="Snapshot Handoff"
      desc="Carry a device's memory to another device over any channel — export to a file, import on the target."
      right={<Package className="h-3.5 w-3.5 text-muted-foreground" />}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1 rounded-lg border border-border bg-card/40 p-3">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Download className="h-3 w-3" /> 1 · export
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Snapshot the active device's knowledge. Restricted <span className="font-mono text-amber-300">local_only</span> points are stripped before they leave the device.
          </p>
          <Button size="sm" variant="outline" onClick={doExport} disabled={busy !== null}
            className="mt-2 gap-1.5 font-mono text-xs" data-testid="snapshot-export">
            {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export snapshot
          </Button>
        </div>

        <div className="flex-1 rounded-lg border border-border bg-card/40 p-3">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Upload className="h-3 w-3" /> 2 · import
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Load a snapshot onto the active device. Authorship (<span className="font-mono">origin_device</span>) and timestamps are preserved, so a sync raises no false conflict.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="Import snapshot file"
            data-testid="snapshot-import-input"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }}
            className="mt-2 block w-full font-mono text-[10px] text-muted-foreground file:mr-2 file:cursor-pointer file:rounded file:border file:border-border file:bg-card file:px-2 file:py-1 file:font-mono file:text-[11px] file:text-foreground"
          />
        </div>
      </div>

      {last && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 font-mono text-[11px] text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          <span>imported {last.imported} points from {last.source_device}</span>
          <span className="text-muted-foreground">{Object.entries(last.shards ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span>
          {last.skipped ? <span className="text-amber-300">{last.skipped} skipped</span> : null}
        </div>
      )}
    </Panel>
  );
}

function SyncHistoryTimeline({ activity }: { activity: ActivityEntry[] }) {
  // Filter to sync-relevant events: sync, bootstrap, connectivity, conflict, queue
  const syncEvents = activity.filter(
    (a) => ["sync", "bootstrap", "connectivity", "conflict", "queue"].includes(a.kind)
  ).slice(0, 14);

  return (
    <Panel
      title="Sync History Timeline"
      desc="Chronological edge↔cloud events — syncs, bootstraps, connectivity flips, conflicts"
      right={
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <History className="h-3 w-3" />
          {syncEvents.length} events
        </div>
      }
    >
      {syncEvents.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          No sync history yet. Run a Sync or Bootstrap to populate the timeline.
        </div>
      ) : (
        <div className="relative">
          {/* vertical rail */}
          <div className="absolute left-[11px] top-1 bottom-1 w-px bg-border" />
          <ol className="space-y-2.5">
            {syncEvents.map((e, i) => {
              const meta = e.meta ?? {};
              const pushed = (meta.summary as { pushed?: number })?.pushed ?? (meta.pushed as number);
              const pulled = (meta.summary as { pulled?: number })?.pulled ?? (meta.pulled as number);
              const conflicts = (meta.summary as { new_conflicts?: number })?.new_conflicts ?? (meta.conflicts as number);
              const queueDepth = meta.queue_depth as number;
              return (
                <li key={`${e.ts}-${i}`} className="relative flex items-start gap-3 pl-1">
                  {/* node */}
                  <span className={cn(
                    "relative z-10 mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 border-background",
                    e.kind === "sync" && "bg-emerald-500",
                    e.kind === "bootstrap" && "bg-sky-500",
                    e.kind === "connectivity" && "bg-amber-500",
                    e.kind === "conflict" && "bg-rose-500",
                    e.kind === "queue" && "bg-amber-400",
                  )}>
                    <span className="h-1 w-1 rounded-full bg-white" />
                  </span>
                  {/* content */}
                  <div className="min-w-0 flex-1 pb-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
                        e.kind === "sync" && "bg-emerald-500/15 text-emerald-300",
                        e.kind === "bootstrap" && "bg-sky-500/15 text-sky-300",
                        e.kind === "connectivity" && "bg-amber-500/15 text-amber-300",
                        e.kind === "conflict" && "bg-rose-500/15 text-rose-300",
                        e.kind === "queue" && "bg-amber-400/15 text-amber-300",
                      )}>
                        {e.kind}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground/70">· {formatRelative(e.ts)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-foreground/80">{e.message}</p>
                    {/* metric chips */}
                    {(pushed !== undefined || pulled !== undefined || conflicts !== undefined || queueDepth !== undefined) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {pushed !== undefined && pushed > 0 && (
                          <span className="flex items-center gap-0.5 rounded border border-emerald-500/25 bg-emerald-500/5 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                            <ArrowUp className="h-2.5 w-2.5" />{pushed}
                          </span>
                        )}
                        {pulled !== undefined && pulled > 0 && (
                          <span className="flex items-center gap-0.5 rounded border border-sky-500/25 bg-sky-500/5 px-1.5 py-0.5 font-mono text-[9px] text-sky-300">
                            <ArrowDown className="h-2.5 w-2.5" />{pulled}
                          </span>
                        )}
                        {conflicts !== undefined && conflicts > 0 && (
                          <span className="flex items-center gap-0.5 rounded border border-rose-500/25 bg-rose-500/5 px-1.5 py-0.5 font-mono text-[9px] text-rose-300">
                            <AlertTriangle className="h-2.5 w-2.5" />{conflicts}
                          </span>
                        )}
                        {queueDepth !== undefined && queueDepth > 0 && (
                          <span className="flex items-center gap-0.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 font-mono text-[9px] text-amber-300">
                            <Zap className="h-2.5 w-2.5" />{queueDepth} queued
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Panel>
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

function ConflictCard({ c, onResolve, busy }: { c: Conflict; onResolve: (id: string, r: "local" | "remote" | "merge", t?: string) => Promise<boolean>; busy: string | null }) {
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
        <Side label="local" device={c.local.origin_device} text={c.local.text} other={c.remote.text} ts={c.local.updated_at} accent="amber" />
        <Side label="remote" device={c.remote.origin_device} text={c.remote.text} other={c.local.text} ts={c.remote.updated_at} accent="sky" />
      </div>

      {showMerge && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">3-way merge · edit the resolved text</span>
            <button
              onClick={() => { setMergeText(c.local.text + "\n\n--- merged ---\n\n" + c.remote.text); }}
              className="font-mono text-[9px] uppercase tracking-wider text-sky-300 hover:text-sky-200"
            >combine both</button>
          </div>
          <Textarea
            value={mergeText}
            onChange={(e) => setMergeText(e.target.value)}
            placeholder="Merge both versions into a single resolved text…"
            className="min-h-[80px] border-border bg-card/40 font-mono text-xs"
          />
          <div className="mt-1 flex items-center justify-end font-mono text-[9px] text-muted-foreground">
            {mergeText.length} chars
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "local").then((ok) => ok && toast({ title: "Kept local version" }))}
          className="gap-1 border-amber-500/30 bg-amber-500/5 font-mono text-[10px] text-amber-300 hover:bg-amber-500/10">
          <Check className="h-3 w-3" /> Keep local
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "remote").then((ok) => ok && toast({ title: "Kept remote version" }))}
          className="gap-1 border-sky-500/30 bg-sky-500/5 font-mono text-[10px] text-sky-300 hover:bg-sky-500/10">
          <ArrowDown className="h-3 w-3" /> Keep remote
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (!showMerge) { setMergeText(c.local.text); setShowMerge(true); } else onResolve(c.id, "merge", mergeText).then((ok) => ok && toast({ title: "Merged" })); }}
          className="gap-1 border-emerald-500/30 bg-emerald-500/5 font-mono text-[10px] text-emerald-300 hover:bg-emerald-500/10">
          <GitMerge className="h-3 w-3" /> {showMerge ? "Apply merge" : "Merge…"}
        </Button>
      </div>
    </div>
  );
}

/** Word-level diff: returns segments marked as same/added/removed relative to `other`. */
function diffWords(text: string, other: string): { word: string; type: "same" | "added" | "removed" }[] {
  const a = (other || "").split(/\s+/).filter(Boolean);
  const b = (text || "").split(/\s+/).filter(Boolean);
  // simple LCS-based diff
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: { word: string; type: "same" | "added" | "removed" }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { segs.push({ word: b[j], type: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { segs.push({ word: a[i], type: "removed" }); i++; }
    else { segs.push({ word: b[j], type: "added" }); j++; }
  }
  while (i < n) { segs.push({ word: a[i], type: "removed" }); i++; }
  while (j < m) { segs.push({ word: b[j], type: "added" }); j++; }
  return segs;
}

function Side({ label, device, text, other, ts, accent }: { label: string; device: string; text: string; other: string; ts: number; accent: "amber" | "sky" }) {
  const color = accent === "amber" ? "border-amber-500/30 text-amber-300" : "border-sky-500/30 text-sky-300";
  const segs = diffWords(text, other);
  const addedCount = segs.filter((s) => s.type === "added").length;
  const removedCount = segs.filter((s) => s.type === "removed").length;
  return (
    <div className={cn("rounded border bg-card/30 p-2", color)}>
      <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider opacity-80">
        <span>{label}</span>
        <span>@{device}</span>
      </div>
      <div className="mt-1 flex items-start gap-1">
        <FileText className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-60" />
        <p className="text-[11px] leading-snug text-foreground/80 line-clamp-4">
          {segs.map((s, i) => (
            <span
              key={i}
              className={cn(
                s.type === "added" && "rounded bg-emerald-500/20 text-emerald-200",
                s.type === "removed" && "rounded bg-rose-500/20 text-rose-200 line-through decoration-rose-400/40",
              )}
            >{s.word} </span>
          ))}
        </p>
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
        <span>{formatTime(ts)}</span>
        {(addedCount > 0 || removedCount > 0) && (
          <span className="flex items-center gap-1.5">
            {addedCount > 0 && <span className="text-emerald-400">+{addedCount}</span>}
            {removedCount > 0 && <span className="text-rose-400">-{removedCount}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
