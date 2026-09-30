"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Search, LayoutDashboard, Database, Search as SearchIcon, RefreshCw,
  Activity, Shield, Cloud, DownloadCloud, WifiOff, Wifi,
  Zap, AlertTriangle, BookOpen, CornerDownLeft,
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
  open, onClose, edge, onNavigate, onOpenGuide,
}: {
  open: boolean;
  onClose: () => void;
  edge: EdgeHook;
  onNavigate: (tab: string) => void;
  onOpenGuide: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const online = edge.syncStatus?.online ?? true;
  const queueDepth = edge.syncStatus?.queue_depth ?? 0;

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-home", label: "Go to Home", hint: "what needs attention", icon: <LayoutDashboard className="h-4 w-4" />, group: "navigate", keywords: "home overview dashboard attention", run: () => onNavigate("home") },
      { id: "nav-search", label: "Go to Search", hint: "find a past fix", icon: <SearchIcon className="h-4 w-4" />, group: "navigate", keywords: "search query retrieval seen before", run: () => onNavigate("search") },
      { id: "nav-knowledge", label: "Go to Knowledge", hint: "browse shards, write a note", icon: <Database className="h-4 w-4" />, group: "navigate", keywords: "knowledge memory shards points write note log", run: () => onNavigate("knowledge") },
      { id: "nav-sync", label: "Go to Sync", hint: "queue, conflicts, handoff", icon: <RefreshCw className="h-4 w-4" />, group: "navigate", keywords: "sync queue conflicts snapshot handoff history", run: () => onNavigate("sync") },
      { id: "nav-fleet", label: "Go to Fleet", hint: "devices and cloud collections", icon: <Cloud className="h-4 w-4" />, group: "navigate", keywords: "fleet devices cloud collections qdrant", run: () => onNavigate("fleet") },
      { id: "nav-policy", label: "Go to Policy", hint: "routing rules, retention", icon: <Shield className="h-4 w-4" />, group: "navigate", keywords: "policy rules simulate routing retention ttl", run: () => onNavigate("policy") },
      { id: "nav-activity", label: "Go to Activity", hint: "event log, latency", icon: <Activity className="h-4 w-4" />, group: "navigate", keywords: "activity log events metrics latency export", run: () => onNavigate("activity") },
    ];
    const actions: Command[] = [
      { id: "act-bootstrap", label: "Bootstrap from cloud", hint: "pull full snapshot", icon: <DownloadCloud className="h-4 w-4" />, group: "actions", keywords: "bootstrap pull sync snapshot", run: () => { edge.bootstrap(); }, disabled: !online || !!edge.busy },
      { id: "act-sync", label: "Sync now", hint: "push queue + pull updates", icon: <RefreshCw className="h-4 w-4" />, group: "actions", keywords: "sync push pull flush", run: () => { edge.sync(); }, disabled: !online || !!edge.busy },
      { id: "act-offline", label: online ? "Go offline" : "Go online", hint: online ? "toggle connectivity off" : "toggle connectivity on", icon: online ? <WifiOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />, group: "actions", keywords: "offline online connectivity toggle link", run: () => { edge.setOnline(!online); } },
      ...(queueDepth > 0 ? [{ id: "act-queue", label: `Flush queue (${queueDepth} pending)`, hint: "sync to clear queue", icon: <Zap className="h-4 w-4" />, group: "actions" as const, keywords: "queue flush sync clear", run: () => { edge.sync(); }, disabled: !online || !!edge.busy }] : []),
      { id: "act-guide", label: "Open demo guide", hint: "offline → sync → conflict walkthrough", icon: <BookOpen className="h-4 w-4" />, group: "actions", keywords: "demo guide walkthrough tour help", run: () => onOpenGuide() },
      { id: "act-conflict", label: "Stage a demo conflict", hint: "divergent edit on two devices", icon: <AlertTriangle className="h-4 w-4" />, group: "actions", keywords: "conflict demo divergent edit", run: () => { edge.demoConflict(); }, disabled: !!edge.busy },
    ];
    return [...nav, ...actions];
  }, [edge, online, queueDepth, onNavigate, onOpenGuide]);

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
        className="fixed inset-0 z-50 bg-black/60 animate-in fade-in"
        onClick={onClose}
      />
      {/* palette */}
      <div className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 px-4">
        <div className="overflow-hidden rounded-xl border border-foreground/12 bg-card shadow-[0_24px_64px_-16px_rgb(0_0_0/0.75)] animate-in fade-in zoom-in-95 duration-150">
          {/* search input */}
          <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a command or search…"
              aria-label="Command"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
            <kbd className="font-mono text-xs text-muted-foreground">esc</kbd>
          </div>

          {/* results */}
          <div className="max-h-[360px] overflow-y-auto edge-scroll p-2">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
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
      <div className="px-2 py-1 text-xs text-muted-foreground">{label}</div>
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
              isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            )}
          >
            <span className={cn("shrink-0", isActive ? "text-emerald-400" : "text-muted-foreground")}>{c.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">{c.label}</div>
              {c.hint && <div className="truncate text-xs text-muted-foreground">{c.hint}</div>}
            </div>
            {isActive && <CornerDownLeft className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        );
      })}
    </div>
  );
}
