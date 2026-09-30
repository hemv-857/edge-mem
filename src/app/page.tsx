"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useEdge } from "@/hooks/use-edge";
import { cn } from "@/lib/utils";
import type { SearchResponse } from "@/lib/edge-types";
import TopBar from "@/components/edge/TopBar";
import Home from "@/components/edge/Home";
import FleetOverview from "@/components/edge/FleetOverview";
import MemoryExplorer from "@/components/edge/MemoryExplorer";
import SearchPlayground from "@/components/edge/SearchPlayground";
import SyncConsole from "@/components/edge/SyncConsole";
import ActivityLog from "@/components/edge/ActivityLog";
import PolicyEngine from "@/components/edge/PolicyEngine";
import PointDetailDrawer from "@/components/edge/PointDetailDrawer";
import MetricsPanel from "@/components/edge/MetricsPanel";
import CommandPalette from "@/components/edge/CommandPalette";
import DemoGuide from "@/components/edge/DemoGuide";
import type { TabId } from "@/components/edge/edge-ui";

// ordered by how often a device operator needs them
const TABS: { id: TabId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "search", label: "Search" },
  { id: "knowledge", label: "Knowledge" },
  { id: "sync", label: "Sync" },
  { id: "fleet", label: "Fleet" },
  { id: "policy", label: "Policy" },
  { id: "activity", label: "Activity" },
];

export default function Page() {
  const edge = useEdge();
  const [tab, setTab] = useState<TabId>("home");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // a search started on Home lands on the Search tab with its results in place
  const [seed, setSeed] = useState<{ n: number; query: string; res: SearchResponse } | null>(null);

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

  const conflicts = edge.syncStatus?.open_conflicts.length ?? 0;
  const queued = edge.syncStatus?.queue_depth ?? 0;
  const syncDot = conflicts > 0 ? "bg-rose-400" : queued > 0 ? "bg-amber-400" : null;

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="min-h-screen gap-0">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <TopBar
          edge={edge}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenGuide={() => setGuideOpen(true)}
          nav={
            // h-auto! overrides TabsList's fixed h-9 so the two mobile rows never slide under the panel
            <TabsList className="grid h-auto! w-full grid-cols-4 gap-0 rounded-none bg-transparent p-0 sm:flex sm:w-auto sm:justify-start lg:h-full!">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    "relative h-10 flex-none rounded-none border-0 px-3 text-sm font-normal text-muted-foreground shadow-none! transition-colors lg:h-full",
                    "hover:text-foreground data-[state=active]:bg-transparent! data-[state=active]:font-medium data-[state=active]:text-foreground",
                    "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:after:bg-emerald-400",
                  )}
                >
                  {t.label}
                  {t.id === "sync" && syncDot && <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", syncDot)} />}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        />
      </header>

      <main className="mx-auto w-full max-w-[1760px] flex-1 px-4 py-6 sm:px-6 xl:px-10">
        {edge.error && !edge.state && (
          <div role="alert" className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
            <p className="font-medium text-rose-300">Can&apos;t reach the edge engine</p>
            <p className="mt-1 text-muted-foreground">
              {process.env.NODE_ENV === "development" ? (
                <>Start it with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">cd mini-services/edge-engine && bun run dev</code></>
              ) : (
                "The engine may be cold-starting — it retries automatically, give it a few seconds."
              )}
            </p>
          </div>
        )}

        <TabsContent value="home">
          <Home
            edge={edge}
            onNavigate={setTab}
            onSearched={(query, res) => { setSeed((s) => ({ n: (s?.n ?? 0) + 1, query, res })); setTab("search"); }}
          />
        </TabsContent>
        <TabsContent value="search">
          <SearchPlayground key={seed?.n ?? 0} edge={edge} initialQuery={seed?.query} initialResult={seed?.res} />
        </TabsContent>
        <TabsContent value="knowledge"><MemoryExplorer edge={edge} /></TabsContent>
        <TabsContent value="sync"><SyncConsole edge={edge} /></TabsContent>
        <TabsContent value="fleet"><FleetOverview edge={edge} /></TabsContent>
        <TabsContent value="policy"><PolicyEngine edge={edge} /></TabsContent>
        <TabsContent value="activity" className="space-y-6">
          <MetricsPanel edge={edge} />
          <ActivityLog edge={edge} />
        </TabsContent>
      </main>

      <PointDetailDrawer point={edge.activePoint} onClose={edge.closePoint} edge={edge} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        edge={edge}
        onNavigate={(t) => setTab(t as TabId)}
        onOpenGuide={() => setGuideOpen(true)}
      />
      <DemoGuide open={guideOpen} onOpenChange={setGuideOpen} edge={edge} onNavigate={setTab} />
    </Tabs>
  );
}
