"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Cpu, LayoutDashboard, Database, Search, RefreshCw, Activity, Shield, Cloud, HardDrive, Zap, LineChart } from "lucide-react";
import { useEdge } from "@/hooks/use-edge";
import { cn } from "@/lib/utils";
import TopBar from "@/components/edge/TopBar";
import FleetOverview from "@/components/edge/FleetOverview";
import MemoryExplorer from "@/components/edge/MemoryExplorer";
import SearchPlayground from "@/components/edge/SearchPlayground";
import SyncConsole from "@/components/edge/SyncConsole";
import ActivityLog from "@/components/edge/ActivityLog";
import PolicyEngine from "@/components/edge/PolicyEngine";
import PointDetailDrawer from "@/components/edge/PointDetailDrawer";
import MetricsPanel from "@/components/edge/MetricsPanel";
import CommandPalette from "@/components/edge/CommandPalette";
import { formatBytes, formatRelative } from "@/components/edge/edge-ui";

export default function Home() {
  const edge = useEdge();
  const [tab, setTab] = useState("overview");
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl+K to open the command palette
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const totalPoints = edge.memory?.total_points ?? 0;
  const queueDepth = edge.syncStatus?.queue_depth ?? 0;
  const openConflicts = edge.syncStatus?.open_conflicts.length ?? 0;
  const cloudPoints = edge.state?.cloud.total_points ?? 0;
  const diskTotal = edge.memory
    ? Object.values(edge.memory.shards).reduce((a, s) => a + s.disk_bytes, 0)
    : 0;
  const online = edge.syncStatus?.online ?? true;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <TopBar edge={edge} onOpenPalette={() => setPaletteOpen(true)} />

      {/* Sub-strip: live KPIs */}
      <div className="border-b border-border/60 bg-card/20">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1.5 px-4 py-2 sm:px-6">
          <KPI icon={<HardDrive className="h-3 w-3" />} label="local pts" value={totalPoints} />
          <KPI icon={<Cloud className="h-3 w-3" />} label="cloud pts" value={cloudPoints} />
          <KPI icon={<HardDrive className="h-3 w-3" />} label="disk" value={formatBytes(diskTotal)} />
          <KPI icon={<Zap className="h-3 w-3" />} label="queue" value={queueDepth} accent={queueDepth > 0 ? "amber" : undefined} />
          <KPI icon={<RefreshCw className="h-3 w-3" />} label="conflicts" value={openConflicts} accent={openConflicts > 0 ? "rose" : undefined} />
          <KPI icon={<Cpu className="h-3 w-3" />} label="engine" value="EdgeShard · FastEmbed · BM25" />
          <div className="ml-auto flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", edge.loading ? "bg-amber-400" : "bg-emerald-400")} />
            {edge.error ? <span className="text-rose-400">link error</span> : <span>telemetry live · synced {formatRelative(edge.syncStatus?.last_sync_at)}</span>}
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6">
        {edge.error && !edge.state && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
            <p className="font-mono">edge-engine unreachable on port 3030.</p>
            <p className="mt-1 text-xs text-muted-foreground">{edge.error}</p>
            <p className="mt-2 text-xs">Ensure the service is running: <code className="rounded bg-muted px-1.5 py-0.5">cd mini-services/edge-engine && bun run dev</code></p>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 gap-1 bg-card/40 sm:grid-cols-7">
            <TabsTrigger value="overview" className="gap-1.5 font-mono text-xs"><LayoutDashboard className="h-3.5 w-3.5" />Overview</TabsTrigger>
            <TabsTrigger value="memory" className="gap-1.5 font-mono text-xs"><Database className="h-3.5 w-3.5" />Memory</TabsTrigger>
            <TabsTrigger value="search" className="gap-1.5 font-mono text-xs"><Search className="h-3.5 w-3.5" />Search</TabsTrigger>
            <TabsTrigger value="sync" className="gap-1.5 font-mono text-xs"><RefreshCw className="h-3.5 w-3.5" />Sync</TabsTrigger>
            <TabsTrigger value="metrics" className="gap-1.5 font-mono text-xs"><LineChart className="h-3.5 w-3.5" />Metrics</TabsTrigger>
            <TabsTrigger value="activity" className="gap-1.5 font-mono text-xs"><Activity className="h-3.5 w-3.5" />Activity</TabsTrigger>
            <TabsTrigger value="policy" className="gap-1.5 font-mono text-xs"><Shield className="h-3.5 w-3.5" />Policy</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-5 focus-visible:outline-none"><FleetOverview edge={edge} /></TabsContent>
          <TabsContent value="memory" className="mt-5 focus-visible:outline-none"><MemoryExplorer edge={edge} /></TabsContent>
          <TabsContent value="search" className="mt-5 focus-visible:outline-none"><SearchPlayground edge={edge} /></TabsContent>
          <TabsContent value="sync" className="mt-5 focus-visible:outline-none"><SyncConsole edge={edge} /></TabsContent>
          <TabsContent value="metrics" className="mt-5 focus-visible:outline-none"><MetricsPanel edge={edge} /></TabsContent>
          <TabsContent value="activity" className="mt-5 focus-visible:outline-none"><ActivityLog edge={edge} /></TabsContent>
          <TabsContent value="policy" className="mt-5 focus-visible:outline-none"><PolicyEngine edge={edge} /></TabsContent>
        </Tabs>
      </main>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-border/60 bg-card/30 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 sm:px-6">
          <span className="font-mono text-[10px] font-bold tracking-wider text-muted-foreground">EDGE.MEM</span>
          <span className="text-[10px] text-muted-foreground">Offline-first semantic memory · Qdrant Edge + FastEmbed + BM25</span>
          <span className="ml-auto flex items-center gap-4 font-mono text-[10px] text-muted-foreground">
            <span>link: <span className={online ? "text-emerald-400" : "text-amber-400"}>{online ? "ONLINE" : "OFFLINE"}</span></span>
            <span>shards: <span className="text-foreground">{edge.memory ? Object.keys(edge.memory.shards).length : 0}</span></span>
            <span>last sync: <span className="text-foreground">{formatRelative(edge.syncStatus?.last_sync_at)}</span></span>
          </span>
        </div>
      </footer>

      {/* Point detail drawer — shared across all panels via edge.openPoint() */}
      <PointDetailDrawer point={edge.activePoint} onClose={edge.closePoint} edge={edge} />

      {/* Command palette — ⌘K / Ctrl+K */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} edge={edge} onNavigate={(t) => setTab(t)} />
    </div>
  );
}

function KPI({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: "amber" | "rose" }) {
  const color = accent === "amber" ? "text-amber-400" : accent === "rose" ? "text-rose-400" : "text-foreground";
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs font-semibold tabular-nums", color)}>{value}</span>
    </div>
  );
}
