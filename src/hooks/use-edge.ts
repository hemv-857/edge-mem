"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { edge } from "@/lib/edge-api";
import type {
  EdgeState, SyncStatus, MemoryStats, FleetOverview, ActivityEntry,
  SearchResponse, SearchMode, SearchFilters, Policy,
} from "@/lib/edge-types";

const SNAP_INTERVAL = 4500;   // state + syncStatus + memory + fleet
const ACT_INTERVAL = 3500;    // incremental activity

export interface PointRef {
  id: string;
  shard: string;
  slug?: string;
  text?: string;
  title?: string;
  domain?: string;
  criticality?: string;
  sensitivity?: string;
  origin_device?: string;
  sync_state?: string;
  updated_at?: number;
  asset_id?: string;
  sensor_type?: string;
  value?: number;
  unit?: string;
  severity?: string;
}

export interface SearchOpts {
  filters?: SearchFilters;
  /** ask the engine for per-channel (dense/sparse) scores alongside the fused score */
  explain?: boolean;
}

export interface EdgeHook {
  state: EdgeState | null;
  syncStatus: SyncStatus | null;
  memory: MemoryStats | null;
  fleet: FleetOverview | null;
  activity: ActivityEntry[];
  loading: boolean;
  error: string | null;
  // point detail drawer
  activePoint: PointRef | null;
  openPoint: (p: PointRef) => void;
  closePoint: () => void;
  // actions
  bootstrap: () => Promise<void>;
  sync: () => Promise<void>;
  toggleConnectivity: () => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
  write: (p: Parameters<typeof edge.write>[0]) => Promise<void>;
  search: (q: string, shard: string, mode: SearchMode, limit?: number, opts?: SearchOpts) => Promise<SearchResponse>;
  resolveConflict: (conflictId: string, resolution: "local" | "remote" | "merge", mergedText?: string) => Promise<void>;
  demoConflict: () => Promise<void>;
  refresh: () => Promise<void>;
  busy: string | null; // which action is running
}

export function useEdge(): EdgeHook {
  const [state, setState] = useState<EdgeState | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [fleet, setFleet] = useState<FleetOverview | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const sinceRef = useRef(0);
  const activeRef = useRef<string>("device-alpha");

  const refreshSnapshot = useCallback(async () => {
    try {
      const [st, ss, mem, fl] = await Promise.all([
        edge.state(),
        edge.syncStatus(),
        edge.memory(),
        edge.fleet(),
      ]);
      activeRef.current = st.active_device;
      setState(st);
      setSyncStatus(ss);
      setMemory(mem);
      setFleet(fl);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const since = sinceRef.current;
      const dev = activeRef.current;
      const r = await edge.activity(dev, 80, since);
      const entries = r.entries;
      if (entries.length) {
        sinceRef.current = Math.max(...entries.map((e) => e.ts)) + 1;
        setActivity((prev) => {
          const map = new Map(prev.map((e) => [e.ts + e.message, e]));
          for (const e of entries) map.set(e.ts + e.message, e);
          const merged = Array.from(map.values()).sort((a, b) => b.ts - a.ts);
          return merged.slice(0, 120);
        });
      }
    } catch {
      /* activity polling is best-effort */
    }
  }, []);

  // initial + periodic snapshot
  useEffect(() => {
    refreshSnapshot();
    const a = setInterval(refreshSnapshot, SNAP_INTERVAL);
    return () => clearInterval(a);
  }, [refreshSnapshot]);

  // periodic activity (incremental)
  useEffect(() => {
    refreshActivity();
    const a = setInterval(refreshActivity, ACT_INTERVAL);
    return () => clearInterval(a);
  }, [refreshActivity]);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(label);
    try {
      const r = await fn();
      // refresh right away so the UI reflects the change
      await refreshSnapshot();
      await refreshActivity();
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot, refreshActivity]);

  const [activePoint, setActivePoint] = useState<PointRef | null>(null);
  const openPoint = useCallback((p: PointRef) => setActivePoint(p), []);
  const closePoint = useCallback(() => setActivePoint(null), []);

  const bootstrap = useCallback(() => run("bootstrap", () => edge.bootstrap(activeRef.current).then(() => undefined)), [run]);
  const sync = useCallback(() => run("sync", () => edge.sync(activeRef.current).then(() => undefined)), [run]);
  const setOnline = useCallback((online: boolean) => run("connectivity", () => edge.connectivity(activeRef.current, online).then(() => undefined)), [run]);
  const toggleConnectivity = useCallback(() => {
    const next = !(syncStatus?.online ?? true);
    return setOnline(next);
  }, [syncStatus, setOnline]);
  const write = useCallback((p: Parameters<typeof edge.write>[0]) => run("write", () => edge.write({ ...p, device: activeRef.current }).then(() => undefined)), [run]);
  const search = useCallback((q: string, shard: string, mode: SearchMode, limit = 5, opts?: SearchOpts) =>
    run("search", () => edge.search({
      device: activeRef.current, shard, query: q, mode, limit,
      filters: opts?.filters, explain: opts?.explain,
    })), [run]);
  const resolveConflict = useCallback((conflictId: string, resolution: "local" | "remote" | "merge", mergedText?: string) =>
    run("resolve", () => edge.resolveConflict(activeRef.current, conflictId, resolution, mergedText).then(() => undefined)), [run]);
  const demoConflict = useCallback(() => run("demo", () => edge.demoConflict(activeRef.current).then(() => undefined)), [run]);
  const refresh = useCallback(() => run("refresh", async () => { await refreshSnapshot(); }), [run, refreshSnapshot]);

  return {
    state, syncStatus, memory, fleet, activity, loading, error,
    activePoint, openPoint, closePoint,
    bootstrap, sync, toggleConnectivity, setOnline, write, search,
    resolveConflict, demoConflict, refresh, busy,
  };
}

export type { Policy };
