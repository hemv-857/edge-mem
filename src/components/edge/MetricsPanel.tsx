"use client";

import { cn } from "@/lib/utils";
import {
  LineChart, Zap, Activity as ActivityIcon, Search, Database,
  RefreshCw, Cloud, TrendingUp, Clock, Cpu, ArrowUpRight, ArrowDownRight, Gauge,
} from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { ActivityEntry } from "@/lib/edge-types";
import { Panel, StatCard } from "./edge-ui";

export default function MetricsPanel({ edge }: { edge: EdgeHook }) {
  const activity = edge.activity;
  const memory = edge.memory;
  const ss = edge.syncStatus;

  // derive search latency samples from the activity log (kind=search with latency_ms in meta)
  const searchSamples = extractSearchLatency(activity);
  const latencies = searchSamples.map((s) => s.latencyMs);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const maxLatency = latencies.length ? Math.max(...latencies) : 0;
  const minLatency = latencies.length ? Math.min(...latencies) : 0;

  // count event kinds
  const counts = countKinds(activity);
  const totalEvents = activity.length;

  // offline vs online search breakdown
  const offlineSearches = searchSamples.filter((s) => s.offline).length;
  const onlineSearches = searchSamples.length - offlineSearches;

  // per-shard point counts
  const shards = memory ? Object.values(memory.shards) : [];
  const totalPoints = memory?.total_points ?? 0;

  return (
    <div className="space-y-5">
      {/* top stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Avg search latency"
          value={avgLatency > 0 ? `${avgLatency.toFixed(1)} ms` : "—"}
          sub={latencies.length > 0 ? `${latencies.length} samples` : "run a search"}
          accent={avgLatency > 0 && avgLatency < 50 ? "emerald" : avgLatency > 200 ? "rose" : "default"}
          icon={<Zap className="h-4 w-4" />}
        />
        <StatCard
          label="Min / Max"
          value={latencies.length > 0 ? `${minLatency.toFixed(1)} / ${maxLatency.toFixed(1)}` : "—"}
          sub="latency range (ms)"
          icon={<Gauge className="h-4 w-4" />}
        />
        <StatCard
          label="Offline searches"
          value={offlineSearches}
          sub={`${onlineSearches} online`}
          accent={offlineSearches > 0 ? "amber" : "default"}
          icon={<Cloud className="h-4 w-4" />}
        />
        <StatCard
          label="Total events"
          value={totalEvents}
          sub="logged actions"
          icon={<ActivityIcon className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* latency chart */}
        <Panel
          title="Search Latency Trend"
          desc="On-device hybrid retrieval latency over recent searches"
          className="lg:col-span-2"
          right={<LineChart className="h-3.5 w-3.5 text-emerald-400" />}
        >
          {latencies.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
              <LineChart className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No search samples yet.</p>
              <p className="font-mono text-[10px] text-muted-foreground/70">Run searches in the Search tab to populate the chart.</p>
            </div>
          ) : (
            <LatencyChart samples={searchSamples} />
          )}
        </Panel>

        {/* event kind breakdown */}
        <Panel title="Event Breakdown" desc="Action distribution across the fleet">
          <div className="space-y-2">
            {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => {
              const pct = totalEvents > 0 ? Math.round((count / totalEvents) * 100) : 0;
              const color = KIND_COLOR[kind] ?? "bg-zinc-500";
              return (
                <div key={kind}>
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="uppercase tracking-wider text-muted-foreground">{kind}</span>
                    <span className="tabular-nums text-foreground">{count}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                </div>
              );
            })}
            {totalEvents === 0 && (
              <div className="py-6 text-center text-xs text-muted-foreground">No events logged.</div>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* per-shard point distribution */}
        <Panel title="Shard Distribution" desc="Point counts across local EdgeShards">
          <div className="space-y-3">
            {shards.map((s) => {
              const pct = totalPoints > 0 ? Math.round((s.points / totalPoints) * 100) : 0;
              return (
                <div key={s.name}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono text-xs text-foreground">{s.name}</span>
                      <span className="font-mono text-[9px] text-muted-foreground/60">{s.default_sync}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs tabular-nums text-foreground">{s.points}</span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
                    </div>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full transition-all",
                        s.name === "manuals" ? "bg-sky-400" : s.name === "incidents" ? "bg-amber-400" : "bg-emerald-400")}
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {shards.length === 0 && <div className="py-6 text-center text-xs text-muted-foreground">No memory data.</div>}
          </div>
        </Panel>

        {/* sync throughput */}
        <Panel title="Sync Throughput" desc="Bytes pushed and pulled across syncs">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-emerald-300">
                <ArrowUpRight className="h-3 w-3" /> pushed
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{formatBytes(ss?.bytes_pushed ?? 0)}</div>
              <div className="text-[10px] font-mono text-muted-foreground">edge → cloud</div>
            </div>
            <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-sky-300">
                <ArrowDownRight className="h-3 w-3" /> pulled
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{formatBytes(ss?.bytes_pulled ?? 0)}</div>
              <div className="text-[10px] font-mono text-muted-foreground">cloud → edge</div>
            </div>
            <div className="col-span-2 rounded-lg border border-border bg-card/40 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <Clock className="h-3 w-3" /> last sync
                </div>
                <span className="font-mono text-[11px] text-foreground">{ss?.last_sync_at ? new Date(ss.last_sync_at).toLocaleTimeString() : "never"}</span>
              </div>
              {ss?.last_sync_summary && (
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <div>
                    <div className="text-muted-foreground">pushed</div>
                    <div className="text-emerald-400">{ss.last_sync_summary.pushed}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">pulled</div>
                    <div className="text-sky-400">{ss.last_sync_summary.pulled}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">conflicts</div>
                    <div className={ss.last_sync_summary.new_conflicts > 0 ? "text-rose-400" : "text-muted-foreground"}>{ss.last_sync_summary.new_conflicts}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {/* engine info */}
      <Panel title="Engine Configuration" desc="The on-device vector engine powering this edge intelligence">
        <div className="grid grid-cols-2 gap-3 font-mono text-[11px] sm:grid-cols-4">
          <InfoItem icon={<Cpu className="h-3 w-3" />} label="engine" value="Qdrant Edge (EdgeShard)" />
          <InfoItem icon={<Zap className="h-3 w-3" />} label="dense" value="FastEmbed bge-small-en (384d)" />
          <InfoItem icon={<Search className="h-3 w-3" />} label="sparse" value="BM25 (on-device)" />
          <InfoItem icon={<TrendingUp className="h-3 w-3" />} label="fusion" value="RRF (k=2)" />
          <InfoItem icon={<Database className="h-3 w-3" />} label="shards" value={`${shards.length} local + cloud`} />
          <InfoItem icon={<RefreshCw className="h-3 w-3" />} label="sync" value="dual-write + manifest-diff" />
          <InfoItem icon={<Cloud className="h-3 w-3" />} label="cloud LLM" value="z-ai-web-dev-sdk (glm-4-plus)" />
          <InfoItem icon={<Cpu className="h-3 w-3" />} label="runtime" value="single-threaded http.server" />
        </div>
      </Panel>
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  write: "bg-emerald-400",
  search: "bg-sky-400",
  sync: "bg-emerald-400",
  bootstrap: "bg-sky-400",
  connectivity: "bg-amber-400",
  conflict: "bg-rose-400",
  queue: "bg-amber-400",
  policy: "bg-zinc-400",
  demo: "bg-amber-400",
  seed: "bg-emerald-400",
  system: "bg-zinc-500",
};

interface SearchSample {
  ts: number;
  latencyMs: number;
  offline: boolean;
  shard: string;
  mode: string;
  hits: number;
}

function extractSearchLatency(activity: ActivityEntry[]): SearchSample[] {
  const samples: SearchSample[] = [];
  for (const a of activity) {
    if (a.kind !== "search") continue;
    const m = a.meta ?? {};
    const latency = typeof m.latency_ms === "number" ? m.latency_ms : undefined;
    if (latency === undefined) continue;
    samples.push({
      ts: a.ts,
      latencyMs: latency,
      offline: Boolean(m.offline),
      shard: typeof m.shard === "string" ? m.shard : "?",
      mode: typeof m.mode === "string" ? m.mode : "?",
      hits: typeof m.hits === "number" ? m.hits : 0,
    });
  }
  return samples.sort((a, b) => a.ts - b.ts).slice(-20);
}

function countKinds(activity: ActivityEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of activity) {
    counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  }
  return counts;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function InfoItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card/30 p-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </div>
      <div className="mt-0.5 truncate text-foreground/90">{value}</div>
    </div>
  );
}

function LatencyChart({ samples }: { samples: SearchSample[] }) {
  const maxLat = Math.max(...samples.map((s) => s.latencyMs), 1);
  const w = 100; // viewBox width units
  const h = 48;
  const stepX = samples.length > 1 ? w / (samples.length - 1) : 0;
  const points = samples.map((s, i) => {
    const x = i * stepX;
    const y = h - (s.latencyMs / maxLat) * (h - 4) - 2;
    return { x, y, s };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${path} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div>
      <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
        <span>{samples.length} samples · newest last</span>
        <span>max {maxLat.toFixed(1)} ms</span>
      </div>
      <div className="mt-2 relative">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: "160px" }} preserveAspectRatio="none">
          {/* grid lines */}
          <line x1="0" y1={h * 0.25} x2={w} y2={h * 0.25} stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/20" />
          <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/20" />
          <line x1="0" y1={h * 0.75} x2={w} y2={h * 0.75} stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/20" />
          {/* area */}
          <path d={areaPath} className="fill-emerald-500/10" />
          {/* line */}
          <path d={path} fill="none" strokeWidth="0.6" className="stroke-emerald-400" />
          {/* dots */}
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="0.8"
              className={p.s.offline ? "fill-amber-400" : "fill-emerald-400"}
            />
          ))}
        </svg>
        {/* legend */}
        <div className="mt-2 flex items-center gap-4 font-mono text-[9px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> online</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> offline</span>
        </div>
      </div>
    </div>
  );
}
