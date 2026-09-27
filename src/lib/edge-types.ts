// Types mirroring the edge-engine backend (mini-services/edge-engine/src).

export type DeviceId = string;

export interface ShardDef {
  desc: string;
  default_sync: string;
}

export interface DeviceSummary {
  id: DeviceId;
  name: string;
  location: string;
  technician: string;
  online: boolean;
  live: boolean;
  kind?: string;
  total_points: number;
  cloud_contributed?: number;
}

export interface CloudShardStat {
  name: string;
  points: number;
  segments: number;
  disk_bytes: number;
  manifest_hash: string;
}

export interface CloudStats {
  total_points: number;
  shards: Record<string, CloudShardStat>;
}

export interface EdgeState {
  active_device: DeviceId;
  devices: DeviceSummary[];
  cloud: CloudStats;
  policy: Policy;
  shard_defs: Record<string, ShardDef>;
}

export interface MemoryShard {
  name: string;
  desc: string;
  points: number;
  segments: number;
  disk_bytes: number;
  embedding: string;
  manifest_hash: string;
  default_sync: string;
}

export interface MemoryStats {
  device: DeviceId;
  total_points: number;
  shards: Record<string, MemoryShard>;
}

export interface EdgePoint {
  id: string;
  slug?: string;
  title?: string;
  text: string;
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

export interface SearchResult {
  id: string;
  score: number;
  slug?: string;
  text: string;
  title?: string;
  domain?: string;
  criticality?: string;
  sensitivity?: string;
  origin_device?: string;
  asset_id?: string;
  updated_at?: number;
  /** present when explain=true: per-channel contributions to the fused score */
  scores?: { dense: number | null; sparse: number | null; fused: number };
}

export interface SearchResponse {
  results: SearchResult[];
  latency_ms: number;
  offline: boolean;
  mode: string;
  shard: string;
  filters?: Record<string, string>;
  explained?: boolean;
}

/** Keys the backend's FILTERABLE_KEYS accepts in a search filter request. */
export type SearchFilterKey = "domain" | "criticality" | "sensitivity" | "origin_device";
export type SearchFilters = Partial<Record<SearchFilterKey, string>>;

export interface ConflictSide {
  text: string;
  updated_at: number;
  origin_device: string;
  criticality?: string;
}

export interface Conflict {
  id: string;
  point_id: string;
  slug: string;
  shard: string;
  local: ConflictSide;
  remote: ConflictSide;
  status: "open" | "resolved";
  resolution?: string;
  created_at: number;
}

export interface SyncStatus {
  device: DeviceId;
  online: boolean;
  queue_depth: number;
  queue_critical: number;
  last_sync_at: number | null;
  last_sync_summary: {
    pushed: number;
    pulled: number;
    bytes_pushed: number;
    bytes_pulled: number;
    new_conflicts: number;
    manifest_diffs: Record<string, { changed: boolean; cloud_hash: string; last_hash: string }>;
    at: number;
  } | null;
  bytes_pushed: number;
  bytes_pulled: number;
  open_conflicts: Conflict[];
  resolved_conflicts: Conflict[];
}

export interface FleetDevice {
  id: DeviceId;
  name: string;
  location: string;
  technician: string;
  online: boolean;
  active: boolean;
  live: boolean;
  kind?: string;
  total_points: number;
  queue_depth: number;
  open_conflicts: number;
  last_sync_at: number | null;
  bytes_pushed: number;
  bytes_pulled: number;
  cloud_contributed: number;
  shards: MemoryShard[];
  /** federated peer only: false when the peer instance is down */
  reachable?: boolean;
  /** true for members synced through FEDERATED_PEERS rather than static fleet records */
  federated?: boolean;
}

export interface FleetOverview {
  devices: FleetDevice[];
  cloud: CloudStats;
  active_device: DeviceId;
}

export interface ActivityEntry {
  ts: number;
  device: string;
  kind: string;
  message: string;
  meta: Record<string, unknown>;
}

export interface PolicyRule {
  id: string;
  field: string;
  op: "in" | "eq";
  values?: string[];
  value?: string;
  action: "local_only" | "sync_now" | "queued";
  reason: string;
}

export interface Policy {
  rules: PolicyRule[];
  ttl_raw_sensor_seconds: number;
}

export interface WriteResult {
  point_id: string;
  slug: string;
  sync_state: string;
  decision: { sync_state: string; matched_rule: string | null; reason: string };
}

export type SearchMode = "dense" | "sparse" | "hybrid";

// ---------------------------------------------------------------------------
// cloud collections browser (centralized knowledge base)
// ---------------------------------------------------------------------------
export interface CloudCollection {
  collection: string;
  shard: string;
  name: string;
  points: number;
  segments: number;
  disk_bytes: number;
  manifest_hash: string;
}

export interface CloudCollectionsResponse {
  backend: "qdrant-server" | "embedded-edge";
  url: string | null;
  total_points: number;
  collections: CloudCollection[];
}

export interface CloudPoint {
  id: string;
  slug?: string | null;
  text?: string | null;
  domain?: string | null;
  criticality?: string | null;
  sensitivity?: string | null;
  origin_device?: string | null;
  sync_state?: string | null;
  asset_id?: string | null;
  title?: string | null;
  updated_at?: number | null;
  score?: number | null;
}

export interface CloudPointsResponse {
  collection: string;
  shard: string;
  query: string;
  total: number;
  points: CloudPoint[];
}

export interface CloudSearchResponse {
  collection: string;
  shard: string;
  mode: string;
  points: CloudPoint[];
}

export interface CloudDeleteResponse {
  ok: boolean;
  point_id: string;
}

// ---------------------------------------------------------------------------
// snapshot handoff (export from one device, import on another)
// ---------------------------------------------------------------------------
export interface SnapshotShards {
  [shard: string]: Record<string, unknown>[];
}

export interface SnapshotExport {
  format: "edge-mem-snapshot";
  version: number;
  device: DeviceId;
  exported_at: number;
  shards: SnapshotShards;
  point_count: number;
  excluded_local_only: number;
}

export interface SnapshotImportResult {
  ok: boolean;
  reason?: string;
  imported?: number;
  skipped?: number;
  source_device?: DeviceId;
  shards?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// TTL retention of raw telemetry
// ---------------------------------------------------------------------------
export interface RetentionStatus {
  device?: DeviceId;
  shard?: string;
  expired?: number;
  checked?: number;
  expired_total?: number;
  last_run: number | null;
  ttl_seconds: number;
  ok?: boolean;
}
