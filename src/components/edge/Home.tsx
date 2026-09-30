"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, Clock, Cloud, Cpu, GitMerge, Loader2, MapPin, PenSquare, Search, Server, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { edge as edgeApi } from "@/lib/edge-api";
import { cn } from "@/lib/utils";
import type { EdgeHook } from "@/hooks/use-edge";
import type { ActivityEntry, EdgePoint, SearchResponse } from "@/lib/edge-types";
import { BigStat, BigStats, Empty, FillScroll, Hl, Meta, PageHero, Panel, Segmented, Tag, formatRelative, formatTime, type TabId } from "./edge-ui";
import { EXAMPLES } from "./SearchPlayground";
import { deviceStatus } from "./FleetOverview";

const SHARDS = ["incidents", "manuals", "sensors"] as const;
type Shard = (typeof SHARDS)[number];

const SHARD_FILL: Record<string, string> = { incidents: "bg-emerald-400", manuals: "bg-teal-300", sensors: "bg-lime-300" };
const SHARD_STROKE: Record<string, string> = { incidents: "stroke-emerald-400", manuals: "stroke-teal-300", sensors: "stroke-lime-300" };
const CRIT_ORDER = ["critical", "high", "medium", "low"] as const;
const CRIT_FILL: Record<string, string> = { critical: "bg-rose-500", high: "bg-amber-400", medium: "bg-zinc-400", low: "bg-zinc-600" };
const SEV_TEXT: Record<string, string> = { critical: "text-rose-400", high: "text-amber-300", medium: "text-foreground/70" };

export default function Home({
  edge, onNavigate, onSearched,
}: {
  edge: EdgeHook;
  onNavigate: (t: TabId) => void;
  onSearched: (query: string, res: SearchResponse) => void;
}) {
  // short staggered rise on mount; purely decorative, never blocks input
  const rise = (i: number) => ({ className: "edge-rise", style: { animationDelay: `${i * 50}ms` } });
  // lg: 3 columns; xl: 12 — incidents · memory+fleet · last hour share one row
  return (
    <div className="grid gap-6 lg:grid-cols-3 xl:grid-cols-12">
      <div {...rise(0)} className="edge-rise lg:col-span-3 xl:col-span-12"><Hero edge={edge} onNavigate={onNavigate} /></div>
      <div {...rise(1)} className="edge-rise lg:col-span-3 xl:col-span-12"><AskMemory edge={edge} onSearched={onSearched} /></div>
      <div {...rise(2)} className="edge-rise lg:col-span-2 xl:col-span-5">
        <RecentIncidents edge={edge} onNavigate={onNavigate} className="h-full" />
      </div>
      <div {...rise(2)} className="edge-rise flex flex-col gap-6 xl:col-span-3">
        <MemoryMix edge={edge} />
        <FleetList edge={edge} onNavigate={onNavigate} className="flex-1" />
      </div>
      <div {...rise(3)} className="edge-rise lg:col-span-3 xl:col-span-4"><LastHour edge={edge} onNavigate={onNavigate} /></div>
    </div>
  );
}

/** The first thing the eye lands on: device state in plain words, the one action it needs, and the numbers behind it. */
function Hero({ edge, onNavigate }: { edge: EdgeHook; onNavigate: (t: TabId) => void }) {
  const ss = edge.syncStatus;
  const online = ss?.online ?? true;
  const queued = ss?.queue_depth ?? 0;
  const critical = ss?.queue_critical ?? 0;
  const conflicts = ss?.open_conflicts.length ?? 0;
  const device = edge.state?.devices.find((d) => d.id === edge.state?.active_device);
  const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

  let tone: "ok" | "warn" | "crit" = "ok";
  let title: React.ReactNode = <>All <Hl>clear.</Hl></>;
  let sub: React.ReactNode = <>In step with the fleet · last sync <span className="font-mono">{formatRelative(ss?.last_sync_at)}</span></>;
  let action: React.ReactNode = null;
  if (!ss) {
    title = "Connecting…";
    sub = "Reading this device's memory.";
  } else if (conflicts > 0) {
    tone = "crit";
    title = <><Hl>{conflicts} {conflicts === 1 ? "conflict" : "conflicts"}</Hl> {conflicts === 1 ? "needs" : "need"} you.</>;
    sub = "Another device edited the same note. Pick what stays.";
    action = <Button onClick={() => onNavigate("sync")} className="bg-rose-500 text-white hover:bg-rose-400">Resolve conflicts</Button>;
  } else if (!online) {
    tone = "warn";
    title = <><Hl>Offline.</Hl> Still working.</>;
    sub = queued > 0
      ? `Search and notes run on this device. ${notes(queued)} sync when the link returns${critical > 0 ? `, ${critical} critical first` : ""}.`
      : "Search and notes run on this device.";
    action = <Button variant="outline" onClick={() => edge.setOnline(true)} disabled={!!edge.busy} className="border-amber-500/40 text-amber-200 hover:bg-amber-500/10">Reconnect</Button>;
  } else if (queued > 0) {
    tone = "warn";
    title = <><Hl>{notes(queued)}</Hl> waiting to sync.</>;
    sub = critical > 0 ? `${critical} critical — they go first.` : "They go up on the next sync.";
    action = <Button onClick={() => edge.sync()} disabled={!!edge.busy} className="bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">Sync now</Button>;
  }

  return (
    <PageHero
      tone={tone}
      live={tone === "ok" && !!ss}
      title={title}
      sub={sub}
      action={action}
      meta={
        <>
          {device && <Meta icon={<MapPin />}>{device.location}</Meta>}
          <Meta icon={online ? <Wifi /> : <WifiOff />} tone={online ? undefined : "warn"}>{online ? "Link up" : "No link"}</Meta>
          {edge.fleet && <Meta icon={<Server />}>{edge.fleet.devices.length} devices in fleet</Meta>}
        </>
      }
      stats={
        <BigStats className="xl:min-w-[600px]">
          <BigStat icon={<Cpu />} label="Local points" value={edge.memory?.total_points ?? "—"} hint="on this device" />
          <BigStat icon={<Cloud />} label="Cloud points" value={edge.state?.cloud.total_points ?? "—"} hint="shared by the fleet" />
          <BigStat icon={<Clock />} label="Queued" value={ss ? queued : "—"} tone={queued > 0 ? "warn" : undefined} hint={critical > 0 ? `${critical} critical first` : "waiting to go up"} />
          <BigStat icon={<GitMerge />} label="Conflicts" value={ss ? conflicts : "—"} tone={conflicts > 0 ? "crit" : undefined} hint={conflicts > 0 ? "need a decision" : "none open"} />
        </BigStats>
      }
    />
  );
}

const noop = () => () => {};
const readRecent = () => { try { return localStorage.getItem("edge-recent-searches"); } catch { return null; } };

function AskMemory({ edge, onSearched }: { edge: EdgeHook; onSearched: (q: string, r: SearchResponse) => void }) {
  const [query, setQuery] = useState("");
  const [shard, setShard] = useState<Shard>("incidents");
  const [running, setRunning] = useState(false);
  // same store the Search tab writes; examples on a fresh device (and during SSR)
  const recentRaw = useSyncExternalStore(noop, readRecent, () => null);
  const suggestions = useMemo<{ q: string; shard: string }[]>(() => {
    try {
      const recent = JSON.parse(recentRaw ?? "[]");
      if (Array.isArray(recent) && recent.length) return recent.slice(0, 4);
    } catch { /* ignore */ }
    return [...EXAMPLES];
  }, [recentRaw]);

  async function run(q: string, s: Shard) {
    q = q.trim();
    if (!q) return;
    setRunning(true);
    try {
      onSearched(q, await edge.search(q, s, "hybrid", 5, { explain: true }));
    } catch (err) {
      toast({ title: "Search failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); run(query, shard); }} className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-[inset_0_1px_0_oklch(1_0_0/0.04)] sm:p-4">
      <label htmlFor="ask" className="sr-only">Seen this before? Describe the symptom</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" />
          <Input
            id="ask"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Seen this before? Describe the symptom — e.g. drive-end vibration on P-201"
            className="h-12 bg-background pl-11 text-base md:text-base"
          />
        </div>
        <Button type="submit" disabled={running || !query.trim()} className="h-12 gap-2 bg-emerald-500 px-7 text-base font-semibold text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 sm:hidden" />}
          Search
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Shard to search" value={shard} options={SHARDS} onChange={setShard} />
        {suggestions.map((s, i) => (
          <button
            key={s.q}
            type="button"
            disabled={running}
            onClick={() => {
              const sh = (SHARDS as readonly string[]).includes(s.shard) ? (s.shard as Shard) : "incidents";
              setQuery(s.q);
              setShard(sh);
              run(s.q, sh);
            }}
            className={cn(i >= 2 && "hidden sm:block", "h-7 max-w-full truncate rounded-md border border-border bg-background/40 px-2.5 text-xs text-foreground/70 transition-colors hover:border-emerald-500/40 hover:text-foreground")}
          >
            {s.q}
          </button>
        ))}
      </div>
    </form>
  );
}

function RecentIncidents({ edge, onNavigate, className }: { edge: EdgeHook; onNavigate: (t: TabId) => void; className?: string }) {
  const [points, setPoints] = useState<EdgePoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    edgeApi.points("incidents", undefined, 200)
      .then((r) => { if (!cancelled) setPoints([...r.points].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))); })
      .catch(() => { if (!cancelled) setPoints([]); });
    return () => { cancelled = true; };
  }, [edge.memory]);

  const severity = CRIT_ORDER.map((c) => ({ key: c, n: points?.filter((p) => p.criticality === c).length ?? 0, fill: CRIT_FILL[c] }));

  return (
    <Panel
      title="Recent incidents"
      className={className}
      flush
      fill
      right={
        <Button size="sm" variant="ghost" onClick={() => onNavigate("knowledge")} className="gap-1.5 text-muted-foreground">
          <PenSquare className="h-4 w-4" /> Log a note
        </Button>
      }
    >
      {points === null ? (
        <div className="space-y-px p-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded bg-muted/40" />)}</div>
      ) : points.length === 0 ? (
        <Empty action={<Button size="sm" variant="outline" onClick={() => onNavigate("sync")}>Bootstrap from cloud</Button>}>
          No incidents on this device yet.
        </Empty>
      ) : (
        <>
          <dl className="grid grid-cols-4 divide-x divide-border border-b border-border">
            {severity.map((sv) => (
              <div key={sv.key} className="px-4 py-3 sm:px-5">
                <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <span aria-hidden className={cn("h-2 w-2 rounded-sm", sv.fill)} />{sv.key}
                </dt>
                <dd className={cn("mt-1 text-2xl font-semibold tabular-nums tracking-[-0.03em] sm:text-3xl",
                  sv.n === 0 ? "text-muted-foreground/50" : sv.key === "critical" ? "text-rose-400" : sv.key === "high" ? "text-amber-300" : "text-foreground")}>
                  {sv.n}
                </dd>
              </div>
            ))}
          </dl>
          <FillScroll>
          <ul className="divide-y divide-border">
            {points.slice(0, 12).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => edge.openPoint({ ...p, shard: "incidents" })}
                  className="grid w-full grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:px-5"
                >
                  <span className={cn("flex items-center gap-2 pt-0.5 font-mono text-[11px] uppercase tracking-[0.08em]", SEV_TEXT[p.criticality ?? ""] ?? "text-muted-foreground")}>
                    <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", CRIT_FILL[p.criticality ?? ""] ?? "bg-zinc-600")} />
                    {p.criticality ?? "—"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{p.title || p.slug || p.id.slice(0, 8)}</span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{p.slug ?? p.id.slice(0, 8)}{p.asset_id ? ` · ${p.asset_id}` : ""}</span>
                  </span>
                  <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{formatRelative(p.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
          </FillScroll>
        </>
      )}
    </Panel>
  );
}

function MemoryMix({ edge }: { edge: EdgeHook }) {
  const order = (n: string) => { const i = (SHARDS as readonly string[]).indexOf(n); return i < 0 ? 99 : i; };
  const shards = edge.memory ? Object.values(edge.memory.shards).sort((a, b) => order(a.name) - order(b.name)) : [];
  const total = shards.reduce((a, s) => a + s.points, 0);
  const R = 38, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <Panel title="Memory">
      <div className="flex items-center gap-5">
        <div className="relative h-28 w-28 shrink-0">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img" aria-label={`Local points by shard: ${shards.map((s) => `${s.points} ${s.name}`).join(", ")}`}>
            <circle cx="50" cy="50" r={R} fill="none" strokeWidth="10" className="stroke-muted" />
            {total > 0 && shards.map((s) => {
              const len = (s.points / total) * C;
              const seg = (
                <circle
                  key={s.name} cx="50" cy="50" r={R} fill="none" strokeWidth="10"
                  className={SHARD_STROKE[s.name] ?? "stroke-zinc-500"}
                  strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc}
                  style={{ transition: "stroke-dasharray 500ms var(--ease-out), stroke-dashoffset 500ms var(--ease-out)" }}
                />
              );
              acc += len;
              return seg;
            })}
          </svg>
          <div className="absolute inset-0 grid place-content-center text-center">
            <span className="text-2xl font-semibold tabular-nums tracking-[-0.03em]">{edge.memory ? total : "—"}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">points</span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-2 text-sm">
          {shards.map((s) => (
            <li key={s.name} className="flex items-center gap-2">
              <span aria-hidden className={cn("h-2.5 w-2.5 rounded-sm", SHARD_FILL[s.name] ?? "bg-zinc-500")} />
              <span className="flex-1 text-muted-foreground">{s.name}</span>
              <span className="font-mono tabular-nums text-foreground">{s.points}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function FleetList({ edge, onNavigate, className }: { edge: EdgeHook; onNavigate: (t: TabId) => void; className?: string }) {
  const devices = edge.fleet?.devices ?? [];
  const max = Math.max(1, ...devices.map((d) => d.total_points));
  return (
    <Panel
      title="Fleet"
      className={className}
      flush
      right={
        <Button size="sm" variant="ghost" onClick={() => onNavigate("fleet")} className="gap-1.5 text-muted-foreground">
          Open <ArrowRight className="h-4 w-4" />
        </Button>
      }
    >
      <ul className="divide-y divide-border">
        {devices.map((d) => {
          const st = deviceStatus(d);
          return (
            <li key={d.id} className={cn("flex items-center gap-3 px-4 py-3 sm:px-5", d.id === edge.fleet?.active_device && "bg-emerald-500/[0.04]")}>
              <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", st.ok ? "bg-emerald-400" : "bg-amber-400")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] text-foreground">{d.id}</span>
                  {!st.ok && <Tag tone="warn">{st.text}</Tag>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {d.id === edge.fleet?.active_device && <span className="text-emerald-300">This device · </span>}{d.location}
                </p>
              </div>
              <div className="flex w-20 shrink-0 items-center gap-2" title={`${d.total_points} points`}>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-emerald-400/80" style={{ width: `${(d.total_points / max) * 100}%` }} />
                </span>
                <span className="w-7 text-right font-mono text-xs tabular-nums text-foreground">{d.total_points}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const BUCKETS = 30;
const WINDOW_MS = 60 * 60 * 1000;

function bucketize(activity: ActivityEntry[]) {
  const now = Date.now();
  const size = WINDOW_MS / BUCKETS;
  const out = Array.from({ length: BUCKETS }, (_, i) => ({ n: 0, conflict: false, start: now - WINDOW_MS + i * size }));
  for (const e of activity) {
    const i = Math.floor((e.ts - (now - WINDOW_MS)) / size);
    if (i < 0 || i >= BUCKETS) continue;
    out[i].n++;
    if (e.kind === "conflict") out[i].conflict = true;
  }
  return out;
}

const KIND_TONE: Record<string, "ok" | "warn" | "crit" | "neutral" | "dim"> = {
  write: "ok", sync: "ok", connectivity: "warn", queue: "warn", conflict: "crit",
};

/** Event rate over the last hour plus the latest few events. */
function LastHour({ edge, onNavigate }: { edge: EdgeHook; onNavigate: (t: TabId) => void }) {
  const buckets = bucketize(edge.activity);
  const total = buckets.reduce((a, b) => a + b.n, 0);
  const peak = Math.max(1, ...buckets.map((b) => b.n));
  // collapse runs of identical events (auto-sync repeats) into one row with a count
  const latest: (ActivityEntry & { times: number })[] = [];
  for (const e of edge.activity) {
    const last = latest[latest.length - 1];
    if (last && last.kind === e.kind && last.message === e.message) last.times++;
    else if (latest.length < 5) latest.push({ ...e, times: 1 });
    else break;
  }

  return (
    <Panel
      title="Last hour"
      className="h-full"
      fill
      desc={`${total} ${total === 1 ? "event" : "events"}`}
      flush
      right={
        <Button size="sm" variant="ghost" onClick={() => onNavigate("activity")} className="gap-1.5 text-muted-foreground">
          All activity <ArrowRight className="h-4 w-4" />
        </Button>
      }
    >
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-5 xl:grid-cols-1 xl:grid-rows-[minmax(0,1fr)_auto]">
        <div className="flex flex-col p-4 lg:col-span-3 xl:col-span-1">
          <div role="img" aria-label={`${total} events in the last hour, peak ${peak} per 2 minutes`} className="flex h-24 items-end gap-[3px] xl:h-auto xl:min-h-24 xl:flex-1">
            {buckets.map((b) => (
              <span
                key={b.start}
                title={b.n ? `${b.n} ${b.n === 1 ? "event" : "events"} · ${formatTime(b.start)}` : undefined}
                className={cn("h-full flex-1 origin-bottom rounded-[2px] transition-transform duration-300 ease-[var(--ease-out)]", b.n === 0 ? "bg-muted" : b.conflict ? "bg-rose-500" : "bg-emerald-400")}
                style={{ transform: `scaleY(${b.n === 0 ? 0.03 : Math.max(0.08, b.n / peak)})` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground">
            <span>60m ago</span><span>now</span>
          </div>
        </div>
        <ol className="divide-y divide-border border-t border-border lg:col-span-2 lg:border-t-0 lg:border-l xl:col-span-1 xl:border-t xl:border-l-0">
          {latest.length === 0 ? (
            <li className="px-4 py-6 sm:px-5 text-center text-sm text-muted-foreground">Quiet so far.</li>
          ) : latest.map((e) => (
            <li key={`${e.ts}-${e.message}`} className="flex items-center gap-3 px-4 py-2 sm:px-5 text-sm">
              <Tag tone={KIND_TONE[e.kind] ?? "dim"} className="w-20 justify-center">{e.kind}</Tag>
              <span className="min-w-0 flex-1 truncate text-foreground/85">{e.message}</span>
              {e.times > 1 && <span className="shrink-0 font-mono text-xs text-muted-foreground">×{e.times}</span>}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatRelative(e.ts)}</span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
