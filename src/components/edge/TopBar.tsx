"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { RefreshCw, Command, BookOpen } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";

/** One persistent command row: identity, the tabs (`nav`), then global state and actions. Below lg the tabs wrap to their own row. */
export default function TopBar({ edge, nav, onOpenPalette, onOpenGuide }: { edge: EdgeHook; nav: React.ReactNode; onOpenPalette: () => void; onOpenGuide: () => void }) {
  const { state, syncStatus, busy } = edge;
  const online = syncStatus?.online ?? true;
  const active = state?.devices.find((d) => d.id === state.active_device);
  const queued = syncStatus?.queue_depth ?? 0;

  return (
    <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-x-4 px-4 sm:px-6 lg:h-16 lg:flex-nowrap lg:gap-x-8 xl:px-10">
      <div className="flex h-14 min-w-0 flex-1 basis-0 items-baseline gap-3 lg:h-auto lg:flex-none lg:basis-auto">
        <img src="/logo.svg" alt="" aria-hidden width={24} height={24} className="h-6 w-6 shrink-0 self-center" />
        <h1 className="text-[17px] font-bold tracking-tight text-foreground">EDGE.MEM</h1>
        {active && (
          <span className="truncate font-mono text-sm text-muted-foreground" title={active.location}>{active.id}</span>
        )}
      </div>

      <nav aria-label="Sections" className="order-last -mx-4 w-[calc(100%+2rem)] border-t border-border/60 px-4 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:order-none lg:mx-0 lg:w-auto lg:self-stretch lg:border-0 lg:px-0">
        {nav}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        <Button variant="ghost" size="sm" onClick={onOpenGuide} className="hidden gap-1.5 text-muted-foreground sm:inline-flex">
          <BookOpen className="h-4 w-4" /> Guide
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenPalette} aria-label="Command palette" title="Command palette (⌘K)" className="gap-1.5 text-muted-foreground">
          <Command className="h-4 w-4" />
          <kbd className="hidden font-mono text-xs sm:inline">⌘K</kbd>
        </Button>

        <label className={cn(
          "flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors",
          online ? "border-border bg-card" : "border-amber-500/40 bg-amber-500/10",
        )}>
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-emerald-400" : "bg-amber-400")} />
          <span className={cn("max-sm:sr-only", online ? "text-foreground" : "text-amber-300")}>{online ? "Online" : "Offline"}</span>
          <Switch
            checked={online}
            onCheckedChange={(v) => edge.setOnline(v)}
            disabled={!!busy}
            aria-label={online ? "Connectivity: online — switch to offline" : "Connectivity: offline — switch to online"}
            className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-amber-500/70"
          />
        </label>

        <Button
          size="sm"
          onClick={() => edge.sync()}
          disabled={!!busy || !online}
          title={online ? "Push the queue and pull fleet updates" : "Sync needs the link"}
          className="gap-1.5 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400"
        >
          <RefreshCw className={cn("h-4 w-4", busy === "sync" && "animate-spin")} />
          <span className="max-sm:sr-only">Sync</span>
          {queued > 0 && <span className="font-mono tabular-nums">{queued}</span>}
        </Button>
      </div>
    </div>
  );
}
