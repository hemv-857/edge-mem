"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Clock, Download, DownloadCloud, GitMerge, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import type { EdgeHook } from "@/hooks/use-edge";
import type { Conflict, ActivityEntry, SnapshotImportResult } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { BigStat, BigStats, FillScroll, Hl, PageHero, Panel, Tag, formatBytes, formatRelative, formatTime } from "./edge-ui";

export default function SyncConsole({ edge }: { edge: EdgeHook }) {
  const ss = edge.syncStatus;
  const online = ss?.online ?? true;
  const summary = ss?.last_sync_summary;
  const queued = ss?.queue_depth ?? 0;
  const critical = ss?.queue_critical ?? 0;
  const open = ss?.open_conflicts ?? [];

  const [autoSync, setAutoSync] = useState(false);
  const [intervalSec, setIntervalSec] = useState(30);
  const lastAutoSyncRef = useRef<number>(0);
  const retryAfterRef = useRef<number>(0); // back off after a failed sync (cloud down)

  // when enabled + online: flush the queue promptly, otherwise pull on the interval
  useEffect(() => {
    if (!autoSync) return;
    const id = setInterval(async () => {
      const now = Date.now();
      const depth = edge.syncStatus?.queue_depth ?? 0;
      const isOnline = edge.syncStatus?.online ?? false;
      if (isOnline && !edge.busy && now >= retryAfterRef.current &&
          (depth > 0 || now - lastAutoSyncRef.current >= intervalSec * 1000)) {
        lastAutoSyncRef.current = now;
        try {
          if (!(await edge.sync())) retryAfterRef.current = now + 30_000;
        } catch { retryAfterRef.current = now + 30_000; }
      }
    }, 2000);
    return () => clearInterval(id);
  }, [autoSync, intervalSec, edge]);

  const tone = open.length > 0 ? "crit" : !online || queued > 0 ? "warn" : "ok";
  const title = open.length > 0
    ? <><Hl>{open.length} {open.length === 1 ? "conflict" : "conflicts"}</Hl> to resolve.</>
    : !online ? <><Hl>Offline.</Hl> Queue held on device.</>
    : queued > 0 ? <><Hl>{queued} {queued === 1 ? "note" : "notes"}</Hl> queued.</>
    : <>In <Hl>sync.</Hl></>;
  const sub = open.length > 0
    ? "Two devices edited the same note. Nothing is overwritten until you pick."
    : !online ? "Notes keep queueing here and go up when the link returns."
    : <>Last sync <span className="font-mono">{formatRelative(ss?.last_sync_at)}</span>{summary ? <> · {summary.pushed} up, {summary.pulled} down</> : null}.</>;

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <PageHero
        className="xl:col-span-12"
        tone={tone}
        live={tone === "ok" && !!ss}
        title={title}
        sub={sub}
        action={
          <>
            <Button onClick={() => edge.sync()} disabled={!!edge.busy || !online} className="gap-1.5 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">
              <RefreshCw className={cn("h-4 w-4", edge.busy === "sync" && "animate-spin")} /> Sync now
            </Button>
            <Button variant="outline" onClick={() => edge.bootstrap()} disabled={!!edge.busy || !online} title="Pull the full cloud snapshot into local memory" className="gap-1.5">
              <DownloadCloud className="h-4 w-4" /> Bootstrap
            </Button>
            <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />
            <span className="flex items-center gap-2 text-sm">
              <Switch id="autosync" checked={autoSync} onCheckedChange={setAutoSync} aria-label="Auto-sync when connectivity returns" className="data-[state=checked]:bg-emerald-500" />
              <label htmlFor="autosync" className="text-foreground">Auto-sync</label>
              <select
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
                disabled={!autoSync}
                aria-label="Auto-sync interval"
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
              >
                <option value={15}>every 15s</option>
                <option value={30}>every 30s</option>
                <option value={60}>every 60s</option>
                <option value={120}>every 2m</option>
              </select>
              {autoSync && <span className="text-muted-foreground">{online ? "running" : "paused"}</span>}
            </span>
          </>
        }
        stats={
          <BigStats>
            <BigStat icon={<Clock />} label="Queued" value={queued} tone={queued > 0 ? "warn" : undefined} hint={critical > 0 ? `${critical} critical first` : "waiting to go up"} />
            <BigStat icon={<GitMerge />} label="Conflicts" value={open.length} tone={open.length > 0 ? "crit" : undefined} hint="need a decision" />
            <BigStat icon={<ArrowUp />} label="Pushed" value={summary?.pushed ?? "—"} hint={summary ? formatBytes(summary.bytes_pushed) : "last run"} />
            <BigStat icon={<ArrowDown />} label="Pulled" value={summary?.pulled ?? "—"} hint={summary ? formatBytes(summary.bytes_pulled) : "last run"} />
          </BigStats>
        }
      />

      <div className="flex flex-col gap-6 xl:col-span-7">
      {/* conflicts */}
      <Panel
        title="Conflicts"
        className={open.length > 0 ? "border-rose-500/40" : undefined}
        right={<span className={cn("font-mono text-xs", open.length > 0 ? "text-rose-300" : "text-muted-foreground")}>{open.length} open</span>}
        flush
      >
        {open.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5 text-sm text-muted-foreground">
            <span>No conflicts. Every synced note agrees across devices.</span>
            <Button
              variant="ghost" size="sm"
              onClick={() => edge.demoConflict().then(() => toast({ title: "Conflict staged", description: "SOP-12 edited on alpha and beta. Sync to surface it." }))}
              disabled={!!edge.busy}
              className="text-muted-foreground"
            >
              Stage a demo conflict
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {open.map((c) => <ConflictCard key={c.id} c={c} onResolve={edge.resolveConflict} busy={edge.busy} />)}
          </div>
        )}
        {(ss?.resolved_conflicts ?? []).length > 0 && (
          <div className="border-t border-border px-4 py-3 sm:px-5">
            <div className="mb-1.5 text-xs text-muted-foreground">Recently resolved</div>
            <ul className="space-y-1 text-sm">
              {(ss?.resolved_conflicts ?? []).slice(-4).reverse().map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground/90">{c.slug}</span>
                  <span className="text-muted-foreground">{c.resolution === "merge" ? "merged" : `kept ${c.resolution}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

        <SyncHistory activity={edge.activity} className="flex-1" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2 xl:col-span-5 xl:flex xl:flex-col">
        <Panel title="Last sync" right={summary && <span className="font-mono text-xs text-muted-foreground">{formatTime(summary.at)}</span>} flush>
          {!summary ? (
            <p className="px-4 py-6 sm:px-5 text-sm text-muted-foreground">No sync yet. Bootstrap or sync to start.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                <Row label="Pushed" value={`${summary.pushed} · ${formatBytes(summary.bytes_pushed)}`} />
                <Row label="Pulled" value={`${summary.pulled} · ${formatBytes(summary.bytes_pulled)}`} />
                <Row label="New conflicts" value={summary.new_conflicts} tone={summary.new_conflicts > 0 ? "text-rose-300" : undefined} />
                {Object.entries(summary.manifest_diffs ?? {}).map(([shard, d]) => (
                  <Row
                    key={shard}
                    label={shard}
                    value={d.changed ? <span className="text-emerald-300">changed · {d.last_hash || "—"} → {d.cloud_hash}</span> : <span className="text-muted-foreground">unchanged · {d.cloud_hash}</span>}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <SnapshotHandoff edge={edge} className="xl:flex-1" />
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <tr>
      <th scope="row" className="px-4 py-2 sm:px-5 text-left font-normal text-muted-foreground">{label}</th>
      <td className={cn("px-4 py-2 sm:px-5 text-right font-mono text-xs tabular-nums", tone ?? "text-foreground")}>{value}</td>
    </tr>
  );
}

/** Carry a device's memory to another device over any channel. Restricted points are stripped server-side. */
function SnapshotHandoff({ edge, className }: { edge: EdgeHook; className?: string }) {
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
    } catch (e) {
      toast({ title: "Import failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Panel title="Snapshot handoff" className={className}>
      <p className="text-sm text-muted-foreground">
        Move this device&apos;s memory to another device as a file. Restricted notes are left out; authorship and timestamps are kept.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={doExport} disabled={busy !== null} className="gap-1.5" data-testid="snapshot-export">
          {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="Import snapshot file"
          data-testid="snapshot-import-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }}
          className="min-w-0 flex-1 text-sm text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-transparent file:px-3 file:text-sm file:text-foreground hover:file:bg-muted"
        />
      </div>
      {last && (
        <p role="status" className="mt-3 text-sm text-emerald-300">
          Imported {last.imported} points from <span className="font-mono">{last.source_device}</span>
          {last.skipped ? <span className="text-amber-300"> · {last.skipped} skipped</span> : null}
        </p>
      )}
    </Panel>
  );
}

const HISTORY_TONE: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  sync: "ok", bootstrap: "neutral", connectivity: "warn", conflict: "crit", queue: "warn",
};

function SyncHistory({ activity, className }: { activity: ActivityEntry[]; className?: string }) {
  const events = activity.filter((a) => a.kind in HISTORY_TONE).slice(0, 30);
  return (
    <Panel title="History" className={className} flush fill>
      {events.length === 0 ? (
        <p className="px-4 py-6 sm:px-5 text-sm text-muted-foreground">Syncs, bootstraps, link changes and conflicts show up here.</p>
      ) : (
        <FillScroll at="xl">
        <ol className="divide-y divide-border">
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="flex items-baseline gap-3 px-4 py-2.5 sm:px-5 text-sm">
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{formatTime(e.ts)}</span>
              <Tag tone={HISTORY_TONE[e.kind]} className="w-24 justify-center">{e.kind}</Tag>
              <span className="min-w-0 flex-1 text-foreground/85">{e.message}</span>
            </li>
          ))}
        </ol>
        </FillScroll>
      )}
    </Panel>
  );
}

function ConflictCard({ c, onResolve, busy }: { c: Conflict; onResolve: (id: string, r: "local" | "remote" | "merge", t?: string) => Promise<boolean>; busy: string | null }) {
  const [mergeText, setMergeText] = useState("");
  const [showMerge, setShowMerge] = useState(false);

  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-foreground">{c.slug}</span>
        <Tag tone="dim">{c.shard}</Tag>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{formatRelative(c.created_at)}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Side label="This device" device={c.local.origin_device} text={c.local.text} other={c.remote.text} ts={c.local.updated_at} />
        <Side label="Cloud" device={c.remote.origin_device} text={c.remote.text} other={c.local.text} ts={c.remote.updated_at} />
      </div>

      {showMerge && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <label htmlFor={`merge-${c.id}`}>Merged text</label>
            <button type="button" onClick={() => setMergeText(c.local.text + "\n\n" + c.remote.text)} className="hover:text-foreground">Combine both</button>
          </div>
          <Textarea id={`merge-${c.id}`} value={mergeText} onChange={(e) => setMergeText(e.target.value)} className="min-h-[96px] text-sm" />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "local").then((ok) => ok && toast({ title: "Kept this device's version" }))}>
          Keep local
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onResolve(c.id, "remote").then((ok) => ok && toast({ title: "Kept the cloud version" }))}>
          Keep remote
        </Button>
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() => { if (!showMerge) { setMergeText(c.local.text); setShowMerge(true); } else onResolve(c.id, "merge", mergeText).then((ok) => ok && toast({ title: "Merged" })); }}
          className="bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400"
        >
          {showMerge ? "Apply merge" : "Merge…"}
        </Button>
      </div>
    </div>
  );
}

/** Word-level diff: segments marked same/added/removed relative to `other`. */
function diffWords(text: string, other: string): { word: string; type: "same" | "added" | "removed" }[] {
  const a = (other || "").split(/\s+/).filter(Boolean);
  const b = (text || "").split(/\s+/).filter(Boolean);
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

function Side({ label, device, text, other, ts }: { label: string; device: string; text: string; other: string; ts: number }) {
  const segs = diffWords(text, other);
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="text-foreground">{label}</span>
        <span className="font-mono text-muted-foreground">@{device} · {formatTime(ts)}</span>
      </div>
      <p className="text-sm leading-relaxed text-foreground/85">
        {segs.map((s, i) => (
          <span
            key={i}
            className={cn(
              s.type === "added" && "rounded-sm bg-emerald-500/20 text-emerald-100",
              s.type === "removed" && "rounded-sm bg-rose-500/15 text-rose-200/80 line-through decoration-rose-400/50",
            )}
          >{s.word} </span>
        ))}
      </p>
    </div>
  );
}
