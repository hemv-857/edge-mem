"use client";

import { Clock, Cloud, Database, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EdgeHook } from "@/hooks/use-edge";
import type { FleetDevice } from "@/lib/edge-types";
import { BigStat, BigStats, Hl, PageHero, Panel, StatusDot, Tag, formatRelative } from "./edge-ui";
import CloudBrowser from "./CloudBrowser";

/** Fleet: every device that shares the cloud, then the cloud itself. */
export default function FleetOverview({ edge }: { edge: EdgeHook }) {
  const data = edge.fleet;
  const totalContrib = data?.devices.reduce((a, d) => a + (d.cloud_contributed ?? 0), 0) || 1;

  const devices = data?.devices ?? [];
  const reachable = devices.filter((d) => deviceStatus(d).ok).length;
  const fleetPoints = devices.reduce((a, d) => a + d.total_points, 0);
  const fleetQueued = devices.reduce((a, d) => a + d.queue_depth, 0);
  const all = devices.length > 0 && reachable === devices.length;

  return (
    <div className="space-y-6">
      <PageHero
        tone={!data || all ? "ok" : "warn"}
        live={!!data && all}
        title={data ? (all ? <>All {devices.length} devices <Hl>reachable.</Hl></> : <><Hl>{reachable} of {devices.length}</Hl> devices reachable.</>) : "Loading fleet…"}
        sub="Every device shares one cloud. A device that drops off keeps working from its own memory."
        stats={
          <BigStats>
            <BigStat icon={<Server />} label="Devices" value={data ? devices.length : "—"} hint={`${reachable} reachable`} tone={data && !all ? "warn" : undefined} />
            <BigStat icon={<Database />} label="Fleet points" value={data ? fleetPoints : "—"} hint="across devices" />
            <BigStat icon={<Cloud />} label="Cloud points" value={data?.cloud.total_points ?? "—"} hint="shared knowledge" />
            <BigStat icon={<Clock />} label="Queued" value={data ? fleetQueued : "—"} tone={fleetQueued > 0 ? "warn" : undefined} hint="fleet-wide" />
          </BigStats>
        }
        footer={data && <Contributions devices={devices} total={totalContrib} />}
      />

      <Panel
        title="Devices"
        right={data && <span className="font-mono text-xs text-muted-foreground">{data.devices.length}</span>}
        flush
      >
        {!data ? (
          <div className="h-40 animate-pulse bg-muted/20" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left font-mono text-[10px] tracking-[0.12em] whitespace-nowrap text-muted-foreground uppercase">
                  <th className="px-4 py-2.5 sm:px-5 font-normal">Device</th>
                  <th className="px-4 py-2.5 sm:px-5 font-normal">Status</th>
                  <th className="px-4 py-2.5 sm:px-5 text-right font-normal">Local</th>
                  <th className="px-4 py-2.5 sm:px-5 text-right font-normal">Queued</th>
                  <th className="px-4 py-2.5 sm:px-5 text-right font-normal">Conflicts</th>
                  <th className="px-4 py-2.5 sm:px-5 font-normal">Shared to cloud</th>
                  <th className="px-4 py-2.5 sm:px-5 text-right font-normal">Last sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.devices.map((d) => (
                  <DeviceRow key={d.id} d={d} active={d.id === data.active_device} share={(d.cloud_contributed ?? 0) / totalContrib} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <CloudBrowser />
    </div>
  );
}

const CONTRIB_FILL = ["bg-emerald-400", "bg-teal-300", "bg-lime-300", "bg-zinc-400"];

/** Who taught the fleet: each device's share of the points it pushed to the cloud. */
function Contributions({ devices, total }: { devices: FleetDevice[]; total: number }) {
  const parts = devices.map((d, i) => ({ id: d.id, n: d.cloud_contributed ?? 0, fill: CONTRIB_FILL[i % CONTRIB_FILL.length] }));
  const sum = parts.reduce((a, p) => a + p.n, 0);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Shared to cloud, by device</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{sum} points</span>
      </div>
      <div role="img" aria-label={parts.map((p) => `${p.id} ${p.n}`).join(", ")} className="flex h-3 overflow-hidden rounded-full bg-muted">
        {sum > 0 && parts.filter((p) => p.n > 0).map((p) => (
          <span key={p.id} title={`${p.id}: ${p.n}`} className={cn("h-full border-r-2 border-card transition-[width] duration-500 ease-[var(--ease-out)] last:border-r-0", p.fill)} style={{ width: `${(p.n / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {parts.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span aria-hidden className={cn("h-2.5 w-2.5 rounded-sm", p.fill)} />
            <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
            <span className="font-mono tabular-nums text-foreground">{p.n}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{Math.round((p.n / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Federated peers are probed live on their own port, so reachability can differ from the static record. */
export function deviceStatus(d: FleetDevice): { text: string; ok: boolean } {
  return d.federated
    ? (d.reachable ? { text: "reachable", ok: true } : { text: "peer down", ok: false })
    : { text: d.online ? "online" : "offline", ok: d.online };
}

function DeviceRow({ d, active, share }: { d: FleetDevice; active: boolean; share: number }) {
  const status = deviceStatus(d);
  const pct = Math.round(share * 100);

  return (
    <tr className={cn(active && "bg-emerald-500/[0.04]")}>
      <td className="px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="font-mono whitespace-nowrap text-foreground">{d.id}</span>
          {active && <Tag tone="ok">this device</Tag>}
          {!d.live && d.federated && <Tag tone="neutral" title="FEDERATED_PEERS member, probed live on its own port">federated</Tag>}
          {!d.live && !d.federated && <Tag tone="dim">remote</Tag>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{d.location} · {d.technician}</div>
      </td>
      <td className="px-4 py-3 sm:px-5">
        <span className={cn("flex items-center gap-2", status.ok ? "text-foreground" : "text-amber-300")}>
          <StatusDot online={status.ok} />{status.text}
        </span>
      </td>
      <td className="px-4 py-3 sm:px-5 text-right font-mono tabular-nums">{d.total_points}</td>
      <td className={cn("px-4 py-3 sm:px-5 text-right font-mono tabular-nums", d.queue_depth > 0 ? "text-amber-300" : "text-muted-foreground")}>{d.queue_depth}</td>
      <td className={cn("px-4 py-3 sm:px-5 text-right font-mono tabular-nums", d.open_conflicts > 0 ? "text-rose-300" : "text-muted-foreground")}>{d.open_conflicts}</td>
      <td className="px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">{d.cloud_contributed ?? 0} · {pct}%</span>
        </div>
      </td>
      <td className="px-4 py-3 sm:px-5 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">{formatRelative(d.last_sync_at)}</td>
    </tr>
  );
}
