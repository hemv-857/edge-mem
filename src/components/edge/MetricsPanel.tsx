"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { GitMerge, RefreshCw, Search, Timer } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { ActivityEntry } from "@/lib/edge-types";
import { BigStat, BigStats, Hl, PageHero, Panel, Readout, Tag } from "./edge-ui";

/** Top of the Activity tab: live engine counters and on-device search latency. */
export default function MetricsPanel({ edge }: { edge: EdgeHook }) {
  const h = lastHour(edge.activity);
  const lat = extractSearchLatency(edge.activity).map((x) => x.latencyMs);
  const open = edge.syncStatus?.open_conflicts.length ?? 0;
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  return (
    <div className="grid gap-6 lg:grid-cols-3 xl:grid-cols-12">
      <PageHero
        className="lg:col-span-3 xl:col-span-12"
        tone={open > 0 ? "crit" : "ok"}
        title={<><Hl>{h.total} {h.total === 1 ? "event" : "events"}</Hl> in the last hour.</>}
        sub="Every write, search, sync and link change on this device, as it happens."
        stats={
          <BigStats>
            <BigStat icon={<Search />} label="Searches" value={h.search} hint="last hour" />
            <BigStat icon={<Timer />} label="Avg search" value={avg === null ? "—" : `${avg.toFixed(0)}ms`} tone={avg === null ? undefined : avg < 50 ? "ok" : avg > 200 ? "crit" : "warn"} hint={`last ${lat.length || 0} searches`} />
            <BigStat icon={<RefreshCw />} label="Syncs" value={h.sync} hint="last hour" />
            <BigStat icon={<GitMerge />} label="Conflicts" value={h.conflict} tone={open > 0 ? "crit" : undefined} hint={open > 0 ? `${open} still open` : "last hour, resolved"} />
          </BigStats>
        }
      />
      <LiveMetrics className="xl:col-span-4" />
      <SearchLatency activity={edge.activity} className="lg:col-span-2 xl:col-span-8" />
    </div>
  );
}

function lastHour(activity: ActivityEntry[]) {
  const since = Date.now() - 60 * 60 * 1000;
  const out = { total: 0, search: 0, sync: 0, conflict: 0 };
  for (const e of activity) {
    if (e.ts < since) continue;
    out.total++;
    if (e.kind === "search") out.search++;
    else if (e.kind === "sync") out.sync++;
    else if (e.kind === "conflict") out.conflict++;
  }
  return out;
}

interface LiveSnap {
  ts: number;
  local_points: number;
  cloud_points: number;
  devices: number;
  federated_reachable: number;
  queue_depth: number;
  open_conflicts: number;
}

/** Fed by the SSE relay at /api/edge/stream; keeps the last frame (marked stale) if the stream drops. */
function LiveMetrics({ className }: { className?: string }) {
  const [snap, setSnap] = useState<LiveSnap | null>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "stale">("connecting");

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      const id = setTimeout(() => setConn("stale"), 0);
      return () => clearTimeout(id);
    }
    const es = new EventSource("/api/edge/stream");
    es.addEventListener("metrics", (ev) => {
      try {
        setSnap(JSON.parse((ev as MessageEvent).data) as LiveSnap);
        setConn("live");
      } catch { /* ignore malformed frame */ }
    });
    es.onerror = () => setConn("stale");
    return () => es.close();
  }, []);

  const v = (n: number | undefined) => (n === undefined ? "—" : n);

  return (
    <Panel
      title="Live"
      className={cn("h-full", className)}
      flush
      fill
      right={
        <span data-testid="sse-status" data-conn={conn}>
          <Tag tone={conn === "live" ? "ok" : conn === "connecting" ? "warn" : "dim"} title={snap ? `last frame ${new Date(snap.ts).toLocaleTimeString()}` : undefined}>
            {conn === "live" ? "streaming" : conn === "connecting" ? "connecting" : "stale"}
          </Tag>
        </span>
      }
    >
      {/* hairline grid of counters that fills the row height set by the latency chart */}
      <dl className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-border/70 sm:grid-cols-3 lg:grid-cols-2 lg:grid-rows-3 [&>div]:flex [&>div]:flex-col [&>div]:justify-center [&>div]:bg-card [&>div]:px-5 [&>div]:py-3">
        <Readout large label="Local points" value={v(snap?.local_points)} />
        <Readout large label="Cloud points" value={v(snap?.cloud_points)} />
        <Readout large label="Devices" value={v(snap?.devices)} />
        <Readout large label="Peers up" value={v(snap?.federated_reachable)} />
        <Readout large label="Queued" value={v(snap?.queue_depth)} tone={(snap?.queue_depth ?? 0) > 0 ? "warn" : undefined} />
        <Readout large label="Conflicts" value={v(snap?.open_conflicts)} tone={(snap?.open_conflicts ?? 0) > 0 ? "crit" : undefined} />
      </dl>
    </Panel>
  );
}

interface SearchSample {
  ts: number;
  latencyMs: number;
  offline: boolean;
}

function extractSearchLatency(activity: ActivityEntry[]): SearchSample[] {
  const samples: SearchSample[] = [];
  for (const a of activity) {
    if (a.kind !== "search") continue;
    const m = a.meta ?? {};
    if (typeof m.latency_ms !== "number") continue;
    samples.push({ ts: a.ts, latencyMs: m.latency_ms, offline: Boolean(m.offline) });
  }
  return samples.sort((a, b) => a.ts - b.ts).slice(-20);
}

function SearchLatency({ activity, className }: { activity: ActivityEntry[]; className?: string }) {
  const samples = extractSearchLatency(activity);
  const lat = samples.map((s) => s.latencyMs);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;

  return (
    <Panel
      title="Search latency"
      desc={lat.length > 0 ? `last ${lat.length} searches` : undefined}
      className={className}
      fill
    >
      {lat.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Latency appears here after the first search.</p>
      ) : (
        <>
          <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-3">
            <Readout label="Average" value={`${avg.toFixed(1)} ms`} tone={avg < 50 ? "ok" : avg > 200 ? "crit" : "warn"} />
            <Readout label="Fastest" value={`${Math.min(...lat).toFixed(1)} ms`} />
            <Readout label="Slowest" value={`${Math.max(...lat).toFixed(1)} ms`} />
            <Readout label="Offline" value={samples.filter((s) => s.offline).length} />
          </dl>
          <LatencyChart samples={samples} />
        </>
      )}
    </Panel>
  );
}

function LatencyChart({ samples, className }: { samples: SearchSample[]; className?: string }) {
  const maxLat = Math.max(...samples.map((s) => s.latencyMs), 1);
  const w = 100;
  const h = 40;
  const stepX = samples.length > 1 ? w / (samples.length - 1) : 0;
  const pts = samples.map((s, i) => ({ x: i * stepX, y: h - (s.latencyMs / maxLat) * (h - 4) - 2, s }));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  return (
    <figure className={cn("mt-auto flex flex-col", className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full sm:h-32" preserveAspectRatio="none" role="img" aria-label={`Search latency, max ${maxLat.toFixed(1)} ms`}>
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="currentColor" strokeWidth="0.2" className="text-border" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" strokeWidth="1.5" className="stroke-emerald-400" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-2 flex h-2 gap-px" aria-hidden>
        {samples.map((s, i) => <span key={i} className={cn("flex-1 rounded-sm", s.offline ? "bg-amber-400/70" : "bg-emerald-400/40")} />)}
      </div>
      <figcaption className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>older</span>
        <span className="flex gap-4">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-400/40" /> online</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-amber-400/70" /> offline</span>
        </span>
        <span>newer</span>
      </figcaption>
    </figure>
  );
}
