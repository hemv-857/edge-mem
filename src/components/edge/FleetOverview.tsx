"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Cpu, Cloud, Bot, Monitor, ArrowRightLeft, TrendingUp, Database,
  BookOpen, AlertTriangle, Activity as ActivityIcon, Gauge, Server,
  PlayCircle, Check, X, WifiOff, Search as SearchIcon, RefreshCw, CloudOff,
} from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import { Panel, StatCard, StatusDot, formatRelative, formatBytes } from "./edge-ui";
import type { FleetOverview as FleetData, ActivityEntry } from "@/lib/edge-types";
import { toast } from "@/hooks/use-toast";

const KIND_ICON: Record<string, React.ReactNode> = {
  robot: <Bot className="h-4 w-4" />,
  kiosk: <Monitor className="h-4 w-4" />,
  field: <Cpu className="h-4 w-4" />,
};

// shard visual identity (icon + accent color)
const SHARD_META: Record<string, { icon: React.ReactNode; accent: string; ring: string }> = {
  manuals:   { icon: <BookOpen className="h-3.5 w-3.5" />, accent: "text-sky-300",   ring: "border-sky-500/25 bg-sky-500/5" },
  incidents: { icon: <AlertTriangle className="h-3.5 w-3.5" />, accent: "text-amber-300", ring: "border-amber-500/25 bg-amber-500/5" },
  sensors:   { icon: <Gauge className="h-3.5 w-3.5" />, accent: "text-emerald-300", ring: "border-emerald-500/25 bg-emerald-500/5" },
};

const ACT_COLOR: Record<string, string> = {
  write: "bg-emerald-400", search: "bg-sky-400", sync: "bg-emerald-400",
  connectivity: "bg-amber-400", conflict: "bg-rose-400", queue: "bg-amber-400",
  policy: "bg-zinc-400", demo: "bg-amber-400", seed: "bg-emerald-400", system: "bg-zinc-500",
  bootstrap: "bg-emerald-400",
};

export default function FleetOverview({ edge }: { edge: EdgeHook }) {
  const data = edge.fleet;

  if (!data) return <Skeleton />;

  const contrib: Record<string, number> = {};
  for (const d of data.devices) contrib[d.id] = d.cloud_contributed ?? 0;
  const totalContrib = Object.values(contrib).reduce((a, b) => a + b, 0) || 1;

  const live = data.devices.filter((d) => d.live);
  const remote = data.devices.filter((d) => !d.live);

  return (
    <div className="space-y-5">
      {/* top stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Fleet devices" value={data.devices.length} sub={`${live.length} live · ${remote.length} remote`} icon={<Cpu className="h-4 w-4" />} />
        <StatCard label="Cloud knowledge" value={data.cloud.total_points} sub="shared across fleet" accent="emerald" icon={<Cloud className="h-4 w-4" />} />
        <StatCard label="Pending syncs" value={data.devices.reduce((a, d) => a + d.queue_depth, 0)} sub="queued across fleet" accent={(data.devices.reduce((a, d) => a + d.queue_depth, 0)) > 0 ? "amber" : "default"} icon={<ArrowRightLeft className="h-4 w-4" />} />
        <StatCard label="Open conflicts" value={data.devices.reduce((a, d) => a + d.open_conflicts, 0)} sub="awaiting resolution" accent={(data.devices.reduce((a, d) => a + d.open_conflicts, 0)) > 0 ? "rose" : "default"} icon={<TrendingUp className="h-4 w-4" />} />
      </div>

      {/* demo walkthrough */}
      <DemoWalkthrough edge={edge} />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Device cards */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Fleet members</h3>
            <span className="font-mono text-[10px] text-muted-foreground">active: <span className="text-emerald-400">{data.active_device}</span></span>
          </div>
          {data.devices.map((d) => (
            <DeviceCard key={d.id} d={d} active={d.id === data.active_device} />
          ))}
        </div>

        {/* Right column: cloud + mini activity feed */}
        <div className="space-y-5">
          <Panel title="Cloud Knowledge Base" desc="Centralized Qdrant Server knowledge" className="self-start">
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums text-foreground">{data.cloud.total_points}</span>
                <span className="text-xs text-muted-foreground">total points</span>
              </div>
              <div className="space-y-2">
                {Object.values(data.cloud.shards).map((s) => {
                  const meta = SHARD_META[s.name] ?? { icon: <Database className="h-3.5 w-3.5" />, accent: "text-muted-foreground", ring: "border-border bg-card/40" };
                  return (
                    <div key={s.name} className={cn("rounded-lg border p-3", meta.ring)}>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-foreground">
                          <span className={meta.accent}>{meta.icon}</span>
                          {s.name}
                        </span>
                        <span className="font-mono text-sm tabular-nums text-emerald-400">{s.points}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                        <span>{s.segments} seg</span>
                        <span>{formatBytes(s.disk_bytes)}</span>
                        <span className="truncate text-muted-foreground/70">v{s.manifest_hash}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div className="flex items-center gap-2 text-xs text-emerald-300">
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  <span className="font-mono">edge ↔ cloud sync</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Dual-write push queue + manifest-diff pull. The fleet gets smarter as a whole.
                </p>
              </div>
            </div>
          </Panel>

          {/* Mini activity feed — fills the empty space below the cloud panel */}
          <MiniActivityFeed activity={edge.activity.slice(0, 8)} />
        </div>
      </div>

      {/* Fleet learning bar */}
      <Panel title="Fleet Knowledge Contribution" desc="How much each device has contributed to the shared cloud knowledge">
        <div className="space-y-3">
          {data.devices.map((d) => {
            const pts = contrib[d.id] ?? 0;
            const pct = Math.round((pts / totalContrib) * 100);
            const isEmpty = pts === 0;
            return (
              <div key={d.id} className="flex items-center gap-3">
                <div className="flex w-32 items-center gap-2">
                  <StatusDot online={d.online} />
                  <span className="font-mono text-xs text-foreground">{d.id.replace("device-", "")}</span>
                  {!d.live && <span className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[8px] uppercase text-muted-foreground">rmt</span>}
                </div>
                <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  {isEmpty ? (
                    <div className="flex h-full items-center rounded-full border border-dashed border-muted-foreground/30 px-2">
                      <span className="font-mono text-[9px] text-muted-foreground/60">no contributions yet</span>
                    </div>
                  ) : (
                    <div
                      className={cn("h-full rounded-full transition-all", d.live ? "bg-emerald-400" : "bg-sky-400")}
                      style={{ width: `${Math.max(pct, 4)}%` }}
                    />
                  )}
                </div>
                <span className="w-24 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {pts} pts {pts > 0 && <span className="text-muted-foreground/60">· {pct}%</span>}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function DeviceCard({ d, active }: { d: FleetData["devices"][number]; active: boolean }) {
  return (
    <div className={cn(
      "rounded-xl border bg-card/40 p-4 backdrop-blur-sm transition-colors",
      active ? "border-emerald-500/40 edge-glow-emerald" : "border-border hover:border-border/80"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg border",
            d.live ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-sky-500/30 bg-sky-500/10 text-sky-300"
          )}>
            {KIND_ICON[d.kind ?? "field"] ?? <Cpu className="h-4 w-4" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">{d.id}</span>
              {active && <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300">active</span>}
              {!d.live && <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-sky-300">remote</span>}
            </div>
            <div className="text-xs text-muted-foreground">{d.name.replace(/^.*?— /, "")}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <StatusDot online={d.online} />
          <span className={cn("font-mono text-[10px] uppercase tracking-wider", d.online ? "text-emerald-300" : "text-amber-300")}>
            {d.online ? "online" : "offline"}
          </span>
        </div>
      </div>

      {d.live ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-4">
            <Meta label="location" value={d.location} />
            <Meta label="technician" value={d.technician} />
            <Meta label="local pts" value={d.total_points} />
            <Meta label="cloud contrib" value={d.cloud_contributed} accent={d.cloud_contributed > 0 ? "emerald" : undefined} />
            <Meta label="queue" value={d.queue_depth} accent={d.queue_depth > 0 ? "amber" : undefined} />
            <Meta label="conflicts" value={d.open_conflicts} accent={d.open_conflicts > 0 ? "rose" : undefined} />
            <Meta label="last sync" value={formatRelative(d.last_sync_at)} />
            <Meta label="pushed" value={formatBytes(d.bytes_pushed)} accent={d.bytes_pushed > 0 ? "emerald" : undefined} />
          </div>
          {d.shards.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5">
              {d.shards.map((s) => {
                const meta = SHARD_META[s.name];
                return (
                  <div key={s.name} className={cn("flex flex-1 items-center gap-1.5 rounded border px-2 py-1", meta?.ring ?? "border-border bg-muted/40")}>
                    <span className={meta?.accent ?? "text-muted-foreground"}>{meta?.icon ?? <Database className="h-3 w-3" />}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{s.name.slice(0, 4)}</span>
                    <span className="ml-auto font-mono text-[10px] font-semibold tabular-nums text-foreground">{s.points}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        // Remote device: show contribution + last sync + kind, no empty live-only fields
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-3">
          <Meta label="location" value={d.location} />
          <Meta label="technician" value={d.technician} />
          <Meta label="kind" value={d.kind ?? "remote"} />
          <Meta label="cloud contrib" value={d.cloud_contributed} accent={d.cloud_contributed > 0 ? "emerald" : undefined} />
          <Meta label="last sync" value={formatRelative(d.last_sync_at)} />
          <Meta label="status" value={d.online ? "reachable" : "unreachable"} accent={d.online ? "emerald" : "amber"} />
          {d.cloud_contributed > 0 && (
            <div className="col-span-2 sm:col-span-3 mt-1 flex items-center gap-2 rounded border border-sky-500/20 bg-sky-500/5 px-2 py-1.5">
              <Server className="h-3 w-3 text-sky-300" />
              <span className="font-mono text-[10px] text-sky-300">knowledge hosted in cloud</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">{d.cloud_contributed} pts shared</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "emerald" | "amber" | "rose" }) {
  const color = accent === "emerald" ? "text-emerald-400" : accent === "amber" ? "text-amber-400" : accent === "rose" ? "text-rose-400" : "text-foreground";
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("truncate", color)}>{value}</div>
    </div>
  );
}

function MiniActivityFeed({ activity }: { activity: ActivityEntry[] }) {
  return (
    <Panel
      title="Recent Activity"
      desc="Live fleet event stream"
      right={<ActivityIcon className="h-3.5 w-3.5 text-emerald-400" />}
    >
      {activity.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">Awaiting activity…</div>
      ) : (
        <ol className="max-h-[280px] space-y-1.5 overflow-y-auto edge-scroll pr-1">
          {activity.map((a, i) => (
            <li key={`${a.ts}-${i}`} className="flex items-start gap-2 text-[11px]">
              <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", ACT_COLOR[a.kind] ?? "bg-zinc-500")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{a.kind}</span>
                  <span className="font-mono text-[9px] text-muted-foreground/60">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                </div>
                <p className="truncate text-foreground/80">{a.message}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-card/40" />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card/40 lg:col-span-2" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card/40" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* demo walkthrough — guided golden path                                       */
/* -------------------------------------------------------------------------- */

const DEMO_STEPS = [
  { id: "bootstrap", icon: <Cloud className="h-3.5 w-3.5" />, title: "Bootstrap from cloud", desc: "Pull the full cloud snapshot (12 points) into device-alpha's local EdgeShard memory.", action: "bootstrap" },
  { id: "offline", icon: <WifiOff className="h-3.5 w-3.5" />, title: "Go offline", desc: "Toggle connectivity off — the device keeps operating from local memory.", action: "offline" },
  { id: "search", icon: <SearchIcon className="h-3.5 w-3.5" />, title: "Search offline", desc: "Run a hybrid query — sub-50ms retrieval with zero network calls.", action: "search" },
  { id: "write", icon: <AlertTriangle className="h-3.5 w-3.5" />, title: "Log an incident", desc: "Write a critical anomaly note — it jumps the sync queue.", action: "write" },
  { id: "online", icon: <Cloud className="h-3.5 w-3.5" />, title: "Reconnect + sync", desc: "Go online + sync — the incident pushes up, fleet fixes pull down.", action: "online" },
  { id: "conflict", icon: <RefreshCw className="h-3.5 w-3.5" />, title: "Manufacture + resolve a conflict", desc: "Surface a divergent edit and resolve it (merge).", action: "conflict" },
] as const;

function DemoWalkthrough({ edge }: { edge: EdgeHook }) {
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState<number>(-1);
  const [done, setDone] = useState<Set<number>>(new Set());

  const memory = edge.memory;
  const totalPoints = memory?.total_points ?? 0;
  const online = edge.syncStatus?.online ?? true;
  const queueDepth = edge.syncStatus?.queue_depth ?? 0;
  const conflicts = edge.syncStatus?.open_conflicts.length ?? 0;

  // auto-detect completion state from live data
  const autoDone = new Set<number>();
  if (totalPoints > 0) autoDone.add(0);
  if (!online) autoDone.add(1);
  if (queueDepth > 0) autoDone.add(3);
  if (online && queueDepth === 0 && totalPoints > 0) autoDone.add(4);
  if (conflicts > 0 || (edge.syncStatus?.resolved_conflicts.length ?? 0) > 0) autoDone.add(5);
  const allDone = new Set([...done, ...autoDone]);

  async function runStep(idx: number) {
    const step = DEMO_STEPS[idx];
    setActiveStep(idx);
    setRunning(true);
    try {
      switch (step.action) {
        case "bootstrap":
          await edge.bootstrap();
          toast({ title: "Bootstrapped", description: "Pulled 12 points from cloud" });
          break;
        case "offline":
          await edge.setOnline(false);
          toast({ title: "Offline", description: "Device now in local-only mode" });
          break;
        case "search":
          toast({ title: "→ Search tab", description: "Run a query to see offline hybrid retrieval" });
          break;
        case "write":
          await edge.write({ shard: "incidents", text: "P-201 drive-end vibration 9.2mm/s, BPFO 142Hz — suspected outer race defect. Isolating pump.", criticality: "critical", asset_id: "P-201", title: "P-201 Vibration Spike" });
          toast({ title: "Incident written", description: "Critical → sync_now (jumps queue)" });
          break;
        case "online":
          await edge.setOnline(true);
          await new Promise((r) => setTimeout(r, 500));
          await edge.sync();
          toast({ title: "Synced", description: "Incident pushed up, fleet fixes pulled down" });
          break;
        case "conflict":
          await edge.demoConflict();
          await new Promise((r) => setTimeout(r, 500));
          await edge.sync();
          toast({ title: "Conflict surfaced", description: "Go to Sync tab to resolve it" });
          break;
      }
      setDone((prev) => new Set([...prev, idx]));
    } catch (e) {
      toast({ title: "Step failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
      setActiveStep(-1);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlayCircle className="h-4 w-4 text-emerald-400" />
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">Demo Walkthrough</h3>
          <span className="font-mono text-[10px] text-muted-foreground">— the golden edge↔cloud path</span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{allDone.size}/{DEMO_STEPS.length} done</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DEMO_STEPS.map((step, i) => {
          const isDone = allDone.has(i);
          const isActive = activeStep === i;
          return (
            <button
              key={step.id}
              onClick={() => runStep(i)}
              disabled={running}
              className={cn(
                "group flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all disabled:opacity-50",
                isDone ? "border-emerald-500/30 bg-emerald-500/[0.04]"
                  : isActive ? "border-emerald-500/50 bg-emerald-500/10 edge-glow-emerald"
                  : "border-border bg-background/40 hover:border-border/80"
              )}
            >
              <span className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                isDone ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-border bg-muted text-muted-foreground"
              )}>
                {isDone ? <Check className="h-3 w-3" /> : <span className="font-mono text-[10px] tabular-nums">{i + 1}</span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn("shrink-0", isDone ? "text-emerald-300" : "text-muted-foreground")}>{step.icon}</span>
                  <span className="truncate font-mono text-[11px] font-semibold text-foreground">{step.title}</span>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{step.desc}</p>
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        <X className="h-3 w-3 text-muted-foreground/40" />
        <span>steps auto-check as you complete them · switch tabs anytime · the walkthrough persists</span>
      </div>
    </div>
  );
}
