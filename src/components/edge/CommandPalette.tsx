"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Search, LayoutDashboard, Database, Search as SearchIcon, RefreshCw,
  LineChart, Activity, Shield, Cloud, DownloadCloud, WifiOff, Wifi,
  Zap, AlertTriangle, ArrowRight, CornerDownLeft,
} from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  group: "navigate" | "actions";
  keywords?: string;
  run: () => void;
  disabled?: boolean;
}

export default function CommandPalette({
  open, onClose, edge, onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  edge: EdgeHook;
  onNavigate: (tab: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const online = edge.syncStatus?.online ?? true;
  const queueDepth = edge.syncStatus?.queue_depth ?? 0;

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-overview", label: "Go to Overview", hint: "fleet dashboard", icon: <LayoutDashboard className="h-4 w-4" />, group: "navigate", keywords: "overview fleet dashboard home", run: () => onNavigate("overview") },
      { id: "nav-memory", label: "Go to Memory", hint: "inspect shards + points", icon: <Database className="h-4 w-4" />, group: "navigate", keywords: "memory shards points inspect", run: () => onNavigate("memory") },
      { id: "nav-search", label: "Go to Search", hint: "hybrid retrieval playground", icon: <SearchIcon className="h-4 w-4" />, group: "navigate", keywords: "search query retrieval", run: () => onNavigate("search") },
      { id: "nav-sync", label: "Go to Sync", hint: "queue + conflicts + timeline", icon: <RefreshCw className="h-4 w-4" />, group: "navigate", keywords: "sync queue conflicts timeline", run: () => onNavigate("sync") },
      { id: "nav-metrics", label: "Go to Metrics", hint: "latency + health + breakdown", icon: <LineChart className="h-4 w-4" />, group: "navigate", keywords: "metrics latency health stats", run: () => onNavigate("metrics") },
      { id: "nav-activity", label: "Go to Activity", hint: "event log + export", icon: <Activity className="h-4 w-4" />, group: "navigate", keywords: "activity log events", run: () => onNavigate("activity") },
      { id: "nav-policy", label: "Go to Policy", hint: "routing rules + simulate", icon: <Shield className="h-4 w-4" />, group: "navigate", keywords: "policy rules simulate routing", run: () => onNavigate("policy") },
    ];
    const actions: Command[] = [
      { id: "act-bootstrap", label: "Bootstrap from cloud", hint: "pull full snapshot", icon: <DownloadCloud className="h-4 w-4" />, group: "actions", keywords: "bootstrap pull sync snapshot", run: () => { edge.bootstrap(); }, disabled: !online || !!edge.busy },
      { id: "act-sync", label: "Sync now", hint: "push queue + pull updates", icon: <RefreshCw className="h-4 w-4" />, group: "actions", keywords: "sync push pull flush", run: () => { edge.sync(); }, disabled: !online || !!edge.busy },
      { id: "act-offline", label: online ? "Go offline" : "Go online", hint: online ? "toggle connectivity off" : "toggle connectivity on", icon: online ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />, group: "actions", keywords: "offline online connectivity toggle link", run: () => { edge.setOnline(!online); } },
      ...(queueDepth > 0 ? [{ id: "act-queue", label: `Flush queue (${queueDepth} pending)`, hint: "sync to clear queue", icon: <Zap className="h-4 w-4" />, group: "actions" as const, keywords: "queue flush sync clear", run: () => { edge.sync(); }, disabled: !online || !!edge.busy }] : []),
      { id: "act-conflict", label: "Manufacture a conflict", hint: "demo divergent edit", icon: <AlertTriangle className="h-4 w-4" />, group: "actions", keywords: "conflict demo divergent edit", run: () => { edge.demoConflict(); }, disabled: !!edge.busy },
    ];
    return [...nav, ...actions];
  }, [edge, online, queueDepth, onNavigate]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.trim().toLowerCase();
    return commands.filter((c) =>
      `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // clamp activeIdx into filtered range (derived, no effect needed)
  const safeActiveIdx = Math.min(activeIdx, Math.max(0, filtered.length - 1));

  // focus input when opened — reset query/idx via rAF to avoid cascading renders
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => {
        setQuery("");
        setActiveIdx(0);
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // keyboard navigation
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const c = filtered[safeActiveIdx];
        if (c && !c.disabled) { c.run(); onClose(); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, filtered, safeActiveIdx, onClose]);

  if (!open) return null;

  const groups = {
    navigate: filtered.filter((c) => c.group === "navigate"),
    actions: filtered.filter((c) => c.group === "actions"),
  };

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm animate-in fade-in"
        onClick={onClose}
      />
      {/* palette */}
      <div className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 px-4">
        <div className="overflow-hidden rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 slide-in-from-top-2">
          {/* search input */}
          <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a command or search…"
              className="flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">esc</kbd>
          </div>

          {/* results */}
          <div className="max-h-[360px] overflow-y-auto edge-scroll p-2">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Search className="mx-auto mb-2 h-5 w-5 text-muted-foreground/40" />
                No commands match &ldquo;{query}&rdquo;
              </div>
            ) : (
              <>
                {groups.navigate.length > 0 && (
                  <CommandGroup label="Navigate" commands={groups.navigate} activeIdx={safeActiveIdx} allFiltered={filtered} onSelect={(c) => { c.run(); onClose(); }} onHover={setActiveIdx} />
                )}
                {groups.actions.length > 0 && (
                  <CommandGroup label="Actions" commands={groups.actions} activeIdx={safeActiveIdx} allFiltered={filtered} onSelect={(c) => { c.run(); onClose(); }} onHover={setActiveIdx} />
                )}
              </>
            )}
          </div>

          {/* footer */}
          <div className="flex items-center justify-between border-t border-border/60 px-3.5 py-2 font-mono text-[10px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1"><kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[8px]">↑↓</kbd> navigate</span>
              <span className="flex items-center gap-1"><kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[8px]">↵</kbd> select</span>
              <span className="flex items-center gap-1"><kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[8px]">esc</kbd> close</span>
            </div>
            <span className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-emerald-400" : "bg-amber-400")} />
              {online ? "online" : "offline"} · {queueDepth} queued
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function CommandGroup({
  label, commands, activeIdx, allFiltered, onSelect, onHover,
}: {
  label: string;
  commands: Command[];
  activeIdx: number;
  allFiltered: Command[];
  onSelect: (c: Command) => void;
  onHover: (idx: number) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      {commands.map((c) => {
        const realIdx = allFiltered.indexOf(c);
        const isActive = realIdx === activeIdx;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c)}
            onMouseEnter={() => onHover(realIdx)}
            disabled={c.disabled}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors disabled:opacity-40",
              isActive ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            )}
          >
            <span className={cn("shrink-0", isActive ? "text-emerald-400" : "text-muted-foreground")}>{c.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs font-medium text-foreground">{c.label}</div>
              {c.hint && <div className="truncate text-[10px] text-muted-foreground">{c.hint}</div>}
            </div>
            {isActive && <CornerDownLeft className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        );
      })}
    </div>
  );
}
