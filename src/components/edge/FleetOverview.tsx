"use client";

import { cn } from "@/lib/utils";
import { Cpu, Cloud, Bot, Monitor, ArrowRightLeft, TrendingUp, Database } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import { Panel, StatCard, StatusDot, formatRelative, formatBytes } from "./edge-ui";
import type { FleetOverview as FleetData } from "@/lib/edge-types";

const KIND_ICON: Record<string, React.ReactNode> = {
  robot: <Bot className="h-4 w-4" />,
  kiosk: <Monitor className="h-4 w-4" />,
  field: <Cpu className="h-4 w-4" />,
};

export default function FleetOverview({ edge }: { edge: EdgeHook }) {
  const data = edge.fleet;

  if (!data) return <Skeleton />;

  // derive per-device cloud contribution directly from fleet data (no effect needed)
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
        <StatCard label="Pending syncs" value={data.devices.reduce((a, d) => a + d.queue_depth, 0)} sub="queued across fleet" accent="amber" icon={<ArrowRightLeft className="h-4 w-4" />} />
        <StatCard label="Open conflicts" value={data.devices.reduce((a, d) => a + d.open_conflicts, 0)} sub="awaiting resolution" accent="rose" icon={<TrendingUp className="h-4 w-4" />} />
      </div>

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

        {/* Cloud panel */}
        <Panel title="Cloud Knowledge Base" desc="Centralized Qdrant Server knowledge (the 'cloud' shard)" className="self-start">
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-foreground">{data.cloud.total_points}</span>
              <span className="text-xs text-muted-foreground">total points</span>
            </div>
            <div className="space-y-2">
              {Object.values(data.cloud.shards).map((s) => (
                <div key={s.name} className="rounded-lg border border-border bg-card/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-foreground">{s.name}</span>
                    <span className="font-mono text-sm tabular-nums text-emerald-400">{s.points}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                    <span>{s.segments} seg</span>
                    <span>{formatBytes(s.disk_bytes)}</span>
                    <span className="truncate">manifest {s.manifest_hash}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <ArrowRightLeft className="h-3.5 w-3.5" />
                <span className="font-mono">edge ↔ cloud sync</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Devices push new knowledge up (dual-write queue) and pull manifest-diff snapshots down. The fleet gets smarter as a whole — a fix verified on one device flows to all others.
              </p>
            </div>
          </div>
        </Panel>
      </div>

      {/* Fleet learning bar */}
      <Panel title="Fleet Knowledge Contribution" desc="How much each device has contributed to the shared cloud knowledge">
        <div className="space-y-3">
          {data.devices.map((d) => {
            const pct = Math.round(((contrib[d.id] ?? 0) / totalContrib) * 100);
            return (
              <div key={d.id} className="flex items-center gap-3">
                <div className="flex w-32 items-center gap-2">
                  <StatusDot online={d.online} />
                  <span className="font-mono text-xs text-foreground">{d.id.replace("device-", "")}</span>
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", d.live ? "bg-emerald-400" : "bg-sky-400")}
                    style={{ width: `${Math.max(pct, 3)}%` }}
                  />
                </div>
                <span className="w-20 text-right font-mono text-xs tabular-nums text-muted-foreground">{contrib[d.id] ?? 0} pts</span>
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
            d.live ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-border bg-muted text-sky-300"
          )}>
            {KIND_ICON[d.kind ?? "field"] ?? <Cpu className="h-4 w-4" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">{d.id}</span>
              {active && <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300">active</span>}
              {!d.live && <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">remote</span>}
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

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-4">
        <Meta label="location" value={d.location} />
        <Meta label="technician" value={d.technician} />
        <Meta label="local pts" value={d.total_points} />
        <Meta label="cloud contrib" value={d.cloud_contributed} accent="emerald" />
        {d.live && <Meta label="queue" value={d.queue_depth} accent={d.queue_depth > 0 ? "amber" : undefined} />}
        {d.live && <Meta label="conflicts" value={d.open_conflicts} accent={d.open_conflicts > 0 ? "rose" : undefined} />}
        <Meta label="last sync" value={formatRelative(d.last_sync_at)} />
      </div>

      {/* shard mini-bars for live devices */}
      {d.live && d.shards.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5">
          {d.shards.map((s) => (
            <div key={s.name} className="flex flex-1 items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-1">
              <Database className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono text-[10px] text-muted-foreground">{s.name.slice(0, 4)}</span>
              <span className="ml-auto font-mono text-[10px] font-semibold tabular-nums text-foreground">{s.points}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "emerald" | "amber" | "rose" }) {
  const color = accent === "emerald" ? "text-emerald-400" : accent === "amber" ? "text-amber-400" : accent === "rose" ? "text-rose-400" : "text-foreground";
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("truncate", color)}>{value}</div>
    </div>
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
