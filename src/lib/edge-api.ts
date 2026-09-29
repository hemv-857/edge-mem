// Typed client for the edge-engine mini-service (port 3030).
// All requests go through the gateway via ?XTransformPort=3030 (relative path).
import type {
  EdgeState, MemoryStats, SearchResponse, SearchMode, SearchFilters, WriteResult,
  SyncStatus, FleetOverview, ActivityEntry, Policy, Conflict,
  CloudCollectionsResponse, CloudPointsResponse, CloudSearchResponse, CloudDeleteResponse,
  SnapshotExport, SnapshotImportResult, RetentionStatus,
} from "./edge-types";

const EDGE_PORT = 3030;

function qs(params: Record<string, string | number | boolean | undefined> = {}): string {
  const sp = new URLSearchParams();
  sp.set("XTransformPort", String(EDGE_PORT));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  return sp.toString();
}

async function edgeGet<T>(subpath: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const res = await fetch(`/api/edge/${subpath}?${qs(query || {})}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`edge GET ${subpath} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function edgePost<T>(subpath: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const res = await fetch(`/api/edge/${subpath}?${qs(query || {})}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`edge POST ${subpath} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function edgePut<T>(subpath: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/edge/${subpath}?${qs()}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`edge PUT ${subpath} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const edge = {
  health: () => edgeGet<{ ok: boolean; uptime_s: number; dense_model: string; dense_dim: number }>("health"),
  state: () => edgeGet<EdgeState>("state"),
  fleet: () => edgeGet<FleetOverview>("fleet"),
  memory: (device?: string) => edgeGet<MemoryStats>("memory", { device }),
  points: (shard: string, device?: string, limit = 12) =>
    edgeGet<{ shard: string; device: string; points: import("./edge-types").EdgePoint[] }>("points", { shard, device, limit }),
  getPoint: (shard: string, id: string, device?: string) =>
    edgeGet<Record<string, unknown>>("point", { shard, id, device }),
  deletePoint: (shard: string, id: string, device?: string) =>
    edgePost<{ ok: boolean; reason?: string }>("point/delete", { shard, id, device }),
  search: (p: {
    device?: string; shard: string; query: string; mode?: SearchMode; limit?: number;
    filters?: SearchFilters; explain?: boolean;
  }) => edgePost<SearchResponse>("search", p),
  write: (p: {
    device?: string; shard: string; text: string; slug?: string; domain?: string;
    criticality?: string; sensitivity?: string; asset_id?: string; title?: string;
    sensor_type?: string; value?: number; unit?: string; severity?: string;
  }) => edgePost<WriteResult>("write", p),
  connectivity: (device: string, online: boolean) => edgePost<{ online: boolean }>("connectivity", { device, online }),
  sync: (device: string) => edgePost<ReturnType<typeof Object> & { ok?: boolean; pushed?: number; pulled?: number; new_conflicts?: number; reason?: string }>("sync", { device }),
  bootstrap: (device: string) => edgePost<{ ok: boolean; pulled: number; bytes_pulled: number; conflicts?: number; reason?: string }>("bootstrap", { device }),
  syncStatus: (device?: string) => edgeGet<SyncStatus>("sync-status", { device }),
  resolveConflict: (device: string, conflict_id: string, resolution: "local" | "remote" | "merge", merged_text?: string) =>
    edgePost<{ ok: boolean }>("conflict/resolve", { device, conflict_id, resolution, merged_text }),
  demoConflict: (device: string) => edgePost<{ ok: boolean; slug: string }>("demo/conflict", { device }),
  activity: (device: string | null, limit = 60, since = 0) =>
    edgeGet<{ entries: ActivityEntry[] }>("activity", { device: device ?? "", limit, since }),
  getPolicy: () => edgeGet<Policy>("policy"),
  putPolicy: (policy: Policy) => edgePut<Policy>("policy", policy),
  simulatePolicy: (p: { text: string; criticality: string; sensitivity: string; domain: string }) =>
    edgePost<{ decision: { sync_state: string; matched_rule: string | null; reason: string }; trace: Array<{ id: string; field: string; op: string; value?: string; values?: string[]; point_value: string; matched: boolean; action: string; reason: string; is_match: boolean }>; point_meta: Record<string, string> }>("policy/simulate", p),
  setActive: (device: string) => edgePost<{ active_device: string }>("active", { device }),

  // -- cloud collections browser (reads straight from Qdrant Server) --
  cloudCollections: () => edgeGet<CloudCollectionsResponse>("cloud/collections"),
  cloudPoints: (p: { collection: string; q?: string; mode?: SearchMode; limit?: number }) =>
    edgeGet<CloudPointsResponse>("cloud/points", p),
  cloudSearch: (p: { collection: string; query: string; mode?: SearchMode; limit?: number }) =>
    edgePost<CloudSearchResponse>("cloud/search", p),
  cloudDelete: (p: { collection: string; id: string }) =>
    edgePost<CloudDeleteResponse>("cloud/delete", p),

  // -- snapshot handoff --
  exportSnapshot: (device?: string) => edgePost<SnapshotExport>("snapshot/export", { device }),
  importSnapshot: (p: { device?: string; snapshot: SnapshotExport | string }) =>
    edgePost<SnapshotImportResult>("snapshot/import", p),

  // -- TTL retention of raw telemetry --
  retentionStatus: () => edgeGet<RetentionStatus>("retention/status"),
  runRetention: (device?: string) => edgePost<RetentionStatus>("retention/run", { device }),
};

export type EdgeApi = typeof edge;
