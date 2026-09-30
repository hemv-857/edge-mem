"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { EdgeHook } from "@/hooks/use-edge";
import type { TabId } from "./edge-ui";

const STEPS = [
  { id: "bootstrap", title: "Bootstrap from cloud", desc: "Pull the fleet's shared knowledge into local memory." },
  { id: "offline", title: "Go offline", desc: "Cut the link. The device keeps working." },
  { id: "search", title: "Search offline", desc: "Hybrid retrieval, no network calls." },
  { id: "write", title: "Log a critical incident", desc: "Policy routes it to the front of the queue." },
  { id: "online", title: "Reconnect and sync", desc: "The incident goes up, fleet fixes come down." },
  { id: "conflict", title: "Raise and resolve a conflict", desc: "Two devices edit the same SOP." },
] as const;

/** The golden edge ↔ cloud path, kept out of the daily view. Steps tick themselves off from live state. */
export default function DemoGuide({
  open, onOpenChange, edge, onNavigate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  edge: EdgeHook;
  onNavigate: (t: TabId) => void;
}) {
  const [running, setRunning] = useState<number | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());

  const ss = edge.syncStatus;
  const online = ss?.online ?? true;
  const points = edge.memory?.total_points ?? 0;
  const auto = new Set<number>();
  if (points > 0) auto.add(0);
  if (!online) auto.add(1);
  if ((ss?.queue_depth ?? 0) > 0) auto.add(3);
  if (online && (ss?.queue_depth ?? 0) === 0 && points > 0) auto.add(4);
  if ((ss?.open_conflicts.length ?? 0) > 0 || (ss?.resolved_conflicts.length ?? 0) > 0) auto.add(5);
  const complete = new Set([...done, ...auto]);

  async function run(i: number) {
    setRunning(i);
    try {
      switch (STEPS[i].id) {
        case "bootstrap":
          await edge.bootstrap();
          break;
        case "offline":
          await edge.setOnline(false);
          break;
        case "search":
          onNavigate("search");
          onOpenChange(false);
          break;
        case "write":
          await edge.write({ shard: "incidents", text: "P-201 drive-end vibration 9.2mm/s, BPFO 142Hz — suspected outer race defect. Isolating pump.", criticality: "critical", asset_id: "P-201", title: "P-201 Vibration Spike" });
          toast({ title: "Incident logged", description: "Critical, so it syncs first." });
          break;
        case "online":
          await edge.setOnline(true);
          await new Promise((r) => setTimeout(r, 500));
          await edge.sync();
          break;
        case "conflict":
          await edge.demoConflict();
          await new Promise((r) => setTimeout(r, 500));
          await edge.sync();
          onNavigate("sync");
          onOpenChange(false);
          break;
      }
      setDone((prev) => new Set([...prev, i]));
    } catch (e) {
      toast({ title: "Step failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 bg-card sm:max-w-md">
        <SheetHeader className="gap-2 border-b border-border p-5">
          <SheetTitle className="text-xl font-semibold tracking-tight">Demo guide</SheetTitle>
          <SheetDescription>The offline → sync → conflict path, one click per step.</SheetDescription>
          <div className="mt-2 flex items-center gap-3">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-emerald-400 transition-[width] duration-500 ease-[var(--ease-out)]" style={{ width: `${(complete.size / STEPS.length) * 100}%` }} />
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{complete.size}/{STEPS.length} done</span>
          </div>
        </SheetHeader>
        <ol className="divide-y divide-border overflow-y-auto">
          {STEPS.map((s, i) => {
            const isDone = complete.has(i);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => run(i)}
                  disabled={running !== null}
                  className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted/40 disabled:opacity-60"
                >
                  <span className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                    isDone ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300" : "border-border text-muted-foreground",
                  )}>
                    {running === i ? <Loader2 className="h-3 w-3 animate-spin" /> : isDone ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">{s.title}</span>
                    <span className="block text-sm text-muted-foreground">{s.desc}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
