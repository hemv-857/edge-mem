"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Cpu, Cloud, RefreshCw, Zap, DownloadCloud, Wifi, WifiOff, Command } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import { StatusDot, formatRelative } from "./edge-ui";

export default function TopBar({ edge, onOpenPalette }: { edge: EdgeHook; onOpenPalette?: () => void }) {
  const { state, syncStatus, busy } = edge;
  const online = syncStatus?.online ?? true;
  const active = state?.devices.find((d) => d.id === state.active_device);
  const queueDepth = syncStatus?.queue_depth ?? 0;
  const queueCritical = syncStatus?.queue_critical ?? 0;
  const lastSync = syncStatus?.last_sync_at ?? null;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 edge-glow-emerald">
            <Cpu className="h-4.5 w-4.5 text-emerald-400" />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-sm font-bold tracking-tight text-foreground">EDGE.MEM</h1>
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                Qdrant Edge
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground">Fleet Intelligence Console</span>
          </div>
        </div>

        {/* Active device */}
        {active && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-1.5">
            <StatusDot online={active.online} />
            <div className="leading-tight">
              <div className="font-mono text-xs font-semibold text-foreground">{active.id}</div>
              <div className="text-[10px] text-muted-foreground">{active.location}</div>
            </div>
          </div>
        )}

        {/* Connectivity toggle — the hero control */}
        <div className={cn(
          "flex items-center gap-2.5 rounded-lg border px-3 py-1.5 transition-colors",
          online ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"
        )}>
          {online ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-amber-400" />}
          <div className="leading-tight">
            <div className={cn("font-mono text-[10px] font-bold uppercase tracking-wider", online ? "text-emerald-300" : "text-amber-300")}>
              {online ? "Online" : "Offline"}
            </div>
            <div className="text-[9px] text-muted-foreground">{online ? "cloud reachable" : "local-only mode"}</div>
          </div>
          <Switch
            checked={online}
            onCheckedChange={(v) => edge.setOnline(v)}
            disabled={!!busy}
            aria-label={online ? "Connectivity: online — switch to offline" : "Connectivity: offline — switch to online"}
            className={cn("data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-amber-500/70")}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* ⌘K command palette trigger */}
          {onOpenPalette && (
            <button
              onClick={onOpenPalette}
              title="Command palette (⌘K)"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card/50 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-emerald-500/30 hover:text-foreground"
            >
              <Command className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border border-border bg-muted px-1 py-0.5 text-[8px] sm:inline">⌘K</kbd>
            </button>
          )}
          {/* queue mini */}
          <div className="hidden items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-1.5 sm:flex">
            <Zap className={cn("h-3.5 w-3.5", queueCritical > 0 ? "text-rose-400" : queueDepth > 0 ? "text-amber-400" : "text-muted-foreground")} />
            <div className="leading-tight">
              <div className="font-mono text-xs font-semibold tabular-nums text-foreground">
                {queueDepth} <span className="text-muted-foreground">queued</span>
                {queueCritical > 0 && <span className="ml-1 text-rose-400">·{queueCritical} crit</span>}
              </div>
              <div className="text-[9px] text-muted-foreground">sync · {formatRelative(lastSync)}</div>
            </div>
          </div>

          {/* Cloud */}
          <div className="hidden items-center gap-1.5 rounded-lg border border-border bg-card/50 px-3 py-1.5 md:flex">
            <Cloud className="h-3.5 w-3.5 text-sky-300" />
            <span className="font-mono text-xs tabular-nums text-foreground">{state?.cloud.total_points ?? 0}</span>
            <span className="text-[9px] text-muted-foreground">cloud pts</span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => edge.bootstrap()}
            disabled={!!busy || !online}
            className="gap-1.5 border-border bg-card/50 font-mono text-xs"
          >
            <DownloadCloud className="h-3.5 w-3.5" />
            Bootstrap
          </Button>
          <Button
            size="sm"
            onClick={() => edge.sync()}
            disabled={!!busy || !online}
            className="gap-1.5 bg-emerald-500/90 font-mono text-xs text-emerald-950 hover:bg-emerald-400"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy === "sync" && "animate-spin")} />
            Sync
          </Button>
        </div>
      </div>
    </header>
  );
}
