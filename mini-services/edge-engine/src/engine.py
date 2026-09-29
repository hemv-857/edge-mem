"""Core edge intelligence engine.

Grounded in the real Qdrant Edge API (qdrant_edge.EdgeShard):
- Each device holds several EdgeShards (manuals / incidents / sensors) as its
  local semantic memory — fully in-process, like SQLite for vectors.
- Dense vectors from FastEmbed (CPU) + sparse BM25 vectors -> on-device hybrid
  retrieval with zero network calls.
- The centralized cloud is a real Qdrant Server reached over HTTP (see
  cloud_qdrant.py). When no server is reachable it degrades to a co-located set
  of EdgeShards in this process, so the sync mechanics (manifest-diff pull,
  dual-write push queue, conflict detection) stay real either way.
"""
from __future__ import annotations

import os
import json
import time
import uuid
import signal
import hashlib
import threading
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from qdrant_edge import (
    EdgeShard, EdgeConfig, EdgeVectorParams, EdgeSparseVectorParams,
    Bm25, Distance, Point, UpdateOperation, QueryRequest, Prefetch,
    Query, Fusion, Filter, FieldCondition, MatchValue, MatchText,
    CountRequest, ScrollRequest, PayloadSelector, OrderBy, Direction,
)

import embed
from cloud_qdrant import build_cloud_store

DENSE_DIM = embed.DENSE_DIM
SPARSE_NAME = embed.SPARSE_NAME

DATA_DIR = os.environ.get("EDGE_DATA_DIR",
                          os.path.join(os.path.dirname(__file__), "..", "data"))
CLOUD_DIR = os.path.join(DATA_DIR, "cloud")

# Knowledge domains = separate EdgeShards so each can have its own
# retention / sync / embedding policy.
SHARD_DEFS = {
    "manuals":   {"desc": "Equipment manuals & SOPs",            "default_sync": "synced"},
    "incidents": {"desc": "Past incidents & verified fixes",     "default_sync": "synced"},
    "sensors":   {"desc": "Live sensor readings & raw telemetry","default_sync": "local_only"},
}

# The full fleet roster. Each engine instance hosts exactly one member
# (EDGE_DEVICE) and knows the others as remote members; members listed in
# FEDERATED_PEERS ("device-beta=http://localhost:3031,device-gamma=...") are
# probed over HTTP so the fleet panel shows live numbers instead of a stub.
FLEET_DEFS = [
    {"id": "device-alpha", "name": "Alpha — Field Unit 01",   "location": "Plant A — North Wing", "technician": "R. Okafor",    "kind": "unit"},
    {"id": "device-beta",  "name": "Beta — Robotic Inspector", "location": "Plant B — Cell 3",    "technician": "auto (robot)", "kind": "robot"},
    {"id": "device-gamma", "name": "Gamma — Kiosk Terminal",   "location": "Plant C — Lobby",     "technician": "K. Mendoza",   "kind": "kiosk"},
]

PEERS: Dict[str, str] = {}
for _pair in os.environ.get("FEDERATED_PEERS", "").split(","):
    if "=" in _pair:
        _pid, _purl = _pair.split("=", 1)
        PEERS[_pid.strip()] = _purl.strip().rstrip("/")

HOSTED_IDS = [d.strip() for d in os.environ.get("EDGE_DEVICE", "device-alpha").split(",") if d.strip()] or ["device-alpha"]
DEVICE_DEFS = [d for d in FLEET_DEFS if d["id"] in HOSTED_IDS] or [FLEET_DEFS[0]]

# Remote members = everyone we don't host ourselves.
REMOTE_MEMBERS = [
    {**m, "url": PEERS.get(m["id"]), "last_sync_offset_min": 47 if m["id"] == "device-beta" else 12}
    for m in FLEET_DEFS if m["id"] not in HOSTED_IDS
]

# Peer probes run on the engine's only thread, so they are bounded in time and
# size, never follow redirects, and only carry EDGE_TOKEN to peers we can trust
# with it: loopback, https, or everything when EDGE_PEER_SEND_TOKEN=1.
MAX_RESOLVED_CONFLICTS = 50
PEER_DEADLINE_S = 2.0
PEER_MAX_BYTES = 65536
_LOOPBACK = ("localhost", "127.0.0.1", "::1")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a 3xx becomes an HTTPError instead of a second request


_PEER_OPENER = urllib.request.build_opener(_NoRedirect)


class _PeerTimeout(Exception):
    pass


def _peer_alarm(signum, frame):
    raise _PeerTimeout()


def peer_gets_token(url: str) -> bool:
    u = urllib.parse.urlsplit(url)
    return (u.scheme == "https" or (u.hostname or "") in _LOOPBACK
            or os.environ.get("EDGE_PEER_SEND_TOKEN") == "1")


def fetch_peer_json(url: str) -> Any:
    """GET url with a hard wall-clock deadline (SIGALRM; the engine is
    single-threaded on the main thread) and a response size cap."""
    headers = {}
    token = os.environ.get("EDGE_TOKEN", "")
    if token and peer_gets_token(url):
        headers["X-Edge-Token"] = token
    req = urllib.request.Request(url, headers=headers)
    deadline = time.monotonic() + PEER_DEADLINE_S
    use_alarm = hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()
    if use_alarm:
        old = signal.signal(signal.SIGALRM, _peer_alarm)
        signal.setitimer(signal.ITIMER_REAL, PEER_DEADLINE_S)
    try:
        chunks: List[bytes] = []
        size = 0
        with _PEER_OPENER.open(req, timeout=PEER_DEADLINE_S) as resp:
            while True:
                if time.monotonic() > deadline:
                    raise _PeerTimeout()
                b = resp.read1(8192)
                if not b:
                    break
                size += len(b)
                if size > PEER_MAX_BYTES:
                    raise ValueError("peer response too large")
                chunks.append(b)
    finally:
        if use_alarm:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)
    return json.loads(b"".join(chunks).decode() or "{}")


def _count(v: Any) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def atomic_write_json(path: str, obj: Any, durable: bool = True, **kw) -> None:
    """Write JSON so a crash or power cut leaves either the old file or the new
    one, never a torn half. durable=True also fsyncs (queue / conflicts / policy)."""
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(obj, f, **kw)
            if durable:
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def clean_peer_entry(d: Any) -> Optional[Dict[str, Any]]:
    """Keep only the typed fields the fleet panel renders from a peer."""
    if not isinstance(d, dict):
        return None
    shards = d.get("shards") if isinstance(d.get("shards"), list) else []
    return {
        "online": d.get("online") is not False,
        **{k: _count(d.get(k)) for k in ("total_points", "queue_depth", "open_conflicts",
                                          "bytes_pushed", "bytes_pulled")},
        "last_sync_at": _count(d.get("last_sync_at")) or None,
        "shards": [{k: v for k, v in s.items() if isinstance(v, (str, int, float, bool))}
                   for s in shards[:len(SHARD_DEFS)] if isinstance(s, dict)],
    }

# ---------------------------------------------------------------------------
# policy engine
# ---------------------------------------------------------------------------

DEFAULT_POLICY = {
    "rules": [
        {"id": "r1", "field": "sensitivity", "op": "in", "values": ["restricted"], "action": "local_only",   "reason": "Restricted/privacy-sensitive data never leaves the device"},
        {"id": "r2", "field": "domain",      "op": "eq", "value": "sensor",       "action": "local_only",   "reason": "Raw sensor firehose stays on-device; only distilled summaries sync"},
        {"id": "r3", "field": "criticality", "op": "eq", "value": "critical",     "action": "sync_now",     "reason": "Safety-critical anomalies jump the queue and retry aggressively"},
        {"id": "r4", "field": "criticality", "op": "in", "values": ["high"],      "action": "queued",       "reason": "High-severity notes batched and uploaded opportunistically"},
        {"id": "r5", "field": "domain",      "op": "in", "values": ["manual","incident"], "action": "queued", "reason": "Routine knowledge syncs when connectivity returns"},
    ],
    "ttl_raw_sensor_seconds": 600,
}


def norm_sensitivity(v: Any) -> str:
    return str(v if v is not None else "").strip().lower() or "internal"


def is_local_only(payload: Dict[str, Any]) -> bool:
    """Hard residency floor: restricted data never leaves the device, whatever
    the (editable) policy says."""
    return norm_sensitivity(payload.get("sensitivity")) == "restricted"


RESIDENCY_FLOOR = {"sync_state": "local_only", "matched_rule": "floor",
                   "reason": "Restricted data never leaves the device (hard floor, not editable)"}


def evaluate_policy(point_meta: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return {sync_state, matched_rule, reason} for a point given its tags."""
    decision = {"sync_state": "queued", "matched_rule": None, "reason": "Default: queue for opportunistic sync"}
    for rule in policy["rules"]:
        field = rule["field"]
        val = point_meta.get(field)
        if (rule["op"] == "eq" and val == rule.get("value")) or \
           (rule["op"] == "in" and val in rule.get("values", [])):
            decision = {"sync_state": rule["action"], "matched_rule": rule["id"], "reason": rule["reason"]}
            break
    if decision["sync_state"] != "local_only" and is_local_only(point_meta):
        return dict(RESIDENCY_FLOOR)
    return decision


def stays_local(payload: Dict[str, Any], policy: Dict[str, Any]) -> bool:
    return is_local_only(payload) or evaluate_policy(payload, policy)["sync_state"] == "local_only"


FILTERABLE_KEYS = ("domain", "criticality", "sensitivity", "origin_device", "sync_state", "asset_id")


def build_filter(filters: Optional[Dict[str, Any]]) -> Optional[Filter]:
    """Turn {key: value} query constraints into a Qdrant filter. Values must be
    non-empty strings — empty/None entries are ignored so the UI can send its
    whole form state."""
    if not filters:
        return None
    conds = [FieldCondition(key=k, match=MatchValue(value=str(filters[k])))
             for k in FILTERABLE_KEYS
             if filters.get(k) not in (None, "", [])]
    return Filter(must=conds) if conds else None


# ---------------------------------------------------------------------------
# shard wrapper
# ---------------------------------------------------------------------------

def _shard_path(base: str, name: str) -> str:
    p = os.path.join(base, name)
    os.makedirs(p, exist_ok=True)
    return p


def _new_config() -> EdgeConfig:
    return EdgeConfig(
        vectors=EdgeVectorParams(size=DENSE_DIM, distance=Distance.Cosine),
        sparse_vectors={SPARSE_NAME: EdgeSparseVectorParams()},
    )


def _open_or_create(path: str) -> EdgeShard:
    # If the dir contains a created shard (has 'wal' or segment files), load it.
    has_data = any(
        os.path.exists(os.path.join(path, f)) for f in ("wal", "segments", "meta.json")
    )
    if has_data:
        try:
            return EdgeShard.load(path)
        except Exception as e:  # noqa: BLE001
            # never delete a device's memory because a load failed: park it
            # beside the shard for recovery and start a fresh one
            parked = f"{path}.corrupt-{int(time.time())}"
            print(f"[edge-engine] shard {path} failed to load ({type(e).__name__}); "
                  f"moved to {parked}", flush=True)
            os.replace(path, parked)
            os.makedirs(path, exist_ok=True)
    return EdgeShard.create(path, _new_config())


class ShardStore:
    """A single EdgeShard with convenience helpers."""

    def __init__(self, name: str, path: str):
        self.name = name
        self.path = path
        self.shard = _open_or_create(path)
        self._manifest_cache: Optional[str] = None
        self._dirty = True

    def upsert(self, point_id: str, dense: List[float], sparse, payload: Dict[str, Any]):
        self.shard.update(UpdateOperation.upsert_points([
            Point(id=point_id, vector={"": dense, SPARSE_NAME: sparse}, payload=payload)
        ]))
        self._dirty = True

    def count(self, flt: Optional[Filter] = None) -> int:
        return self.shard.count(CountRequest(exact=True, filter=flt))

    def info(self):
        return self.shard.info()

    def scroll(self, limit: int = 20, offset=None, flt: Optional[Filter] = None) -> Tuple[List, Optional[Any]]:
        # NOTE: order_by on a payload field requires a range index which EdgeShard
        # cannot create at runtime, so we scroll in internal order and sort by
        # updated_at in Python (cheap for edge-scale collections).
        # with_payload=True: full payloads (the cloud browser + snapshot export
        # need every key; payloads are edge-scale so bandwidth is not a concern).
        recs, nxt = self.shard.scroll(ScrollRequest(
            offset=offset, limit=limit, filter=flt, with_payload=True,
        ))
        return recs, nxt

    def manifest_hash(self, fresh: bool = False) -> str:
        # `fresh` exists for interface parity with the Qdrant Server shard: the
        # embedded store is only ever written by this process, so the dirty flag is exact.
        # Cache the manifest hash; recompute only after a write (upsert) marks
        # the shard dirty. snapshot_manifest() touches the binding and is called
        # on every polled memory_stats/fleet_overview, so caching it removes the
        # bulk of binding calls during idle polling.
        if self._manifest_cache is not None and not self._dirty:
            return self._manifest_cache
        m = self.shard.snapshot_manifest()
        try:
            h = hashlib.md5(json.dumps(m, default=str, sort_keys=True).encode()).hexdigest()
        except Exception:
            h = hashlib.md5(str(m).encode()).hexdigest()
        self._manifest_cache = h
        self._dirty = False
        return h

    def manifest(self) -> Dict[str, Any]:
        m = self.shard.snapshot_manifest()
        try:
            return json.loads(json.dumps(m, default=str))
        except Exception:
            return {"raw": str(m)[:2000]}

    def search(self, mode: str, query: str, limit: int = 5, flt: Optional[Filter] = None) -> List[Dict[str, Any]]:
        dense = embed.embed_dense(query)
        sparse = embed.embed_sparse_query(query)
        if mode == "dense":
            req = QueryRequest(limit=limit, query=Query.Nearest(dense, using=""),
                               with_payload=PayloadSelector.Include(["slug","text","domain","criticality","sensitivity","sync_state","origin_device","asset_id","title","updated_at"]),
                               filter=flt)
        elif mode == "sparse":
            req = QueryRequest(limit=limit, query=Query.Nearest(sparse, using=SPARSE_NAME),
                               with_payload=PayloadSelector.Include(["slug","text","domain","criticality","sensitivity","sync_state","origin_device","asset_id","title","updated_at"]),
                               filter=flt)
        else:  # hybrid
            req = QueryRequest(
                limit=limit,
                prefetches=[
                    Prefetch(limit=max(limit * 4, 20), query=Query.Nearest(dense, using="")),
                    Prefetch(limit=max(limit * 4, 20), query=Query.Nearest(sparse, using=SPARSE_NAME)),
                ],
                query=Fusion.Rrf(k=2),
                with_payload=PayloadSelector.Include(["slug","text","domain","criticality","sensitivity","sync_state","origin_device","asset_id","title","updated_at"]),
                filter=flt,
            )
        results = self.shard.query(req)
        out = []
        for r in results:
            p = r.payload or {}
            out.append({
                "id": str(r.id), "score": round(float(r.score), 4),
                "slug": p.get("slug"), "text": p.get("text", ""),
                "title": p.get("title"), "domain": p.get("domain"),
                "criticality": p.get("criticality"), "sensitivity": p.get("sensitivity"),
                "origin_device": p.get("origin_device"),
                "asset_id": p.get("asset_id"), "updated_at": p.get("updated_at"),
            })
        return out

    def retrieve_payload(self, point_id: str) -> Optional[Dict[str, Any]]:
        recs = self.shard.retrieve([point_id], with_payload=True, with_vector=False)
        if not recs:
            return None
        p = recs[0].payload or {}
        p["_id"] = str(recs[0].id)
        return p

    def delete_point(self, point_id: str) -> bool:
        """Delete a point by id."""
        try:
            self.shard.update(UpdateOperation.delete_points([point_id]))
            self._dirty = True
            self.shard.flush()
            return True
        except Exception:
            return False

    def optimize(self):
        # DISABLED: qdrant_edge's optimize() spawns background optimizer threads
        # that destabilise a long-running server process (the main thread idles
        # in select() between requests; the background optimizer touching shared
        # binding state during that idle crashes the process). For edge-scale
        # collections (hundreds of points) brute-force search without HNSW is
        # sub-millisecond anyway, so optimisation is not needed for the demo.
        # flush() alone persists writes safely.
        try:
            self.shard.flush()
        except Exception:
            pass

    def flush(self):
        try:
            self.shard.flush()
        except Exception:
            pass

    def close(self):
        try:
            self.shard.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# device
# ---------------------------------------------------------------------------

class Device:
    def __init__(self, defn: Dict[str, Any]):
        self.id = defn["id"]
        self.name = defn["name"]
        self.location = defn["location"]
        self.technician = defn["technician"]
        self.base = os.path.join(DATA_DIR, self.id)
        os.makedirs(self.base, exist_ok=True)
        self.shards: Dict[str, ShardStore] = {
            name: ShardStore(name, _shard_path(self.base, name)) for name in SHARD_DEFS
        }
        self.online = True
        self.queue: List[Dict[str, Any]] = []          # pending push ops
        self.last_sync_at: Optional[float] = None
        self.last_sync_summary: Optional[Dict[str, Any]] = None
        self.bytes_pushed = 0
        self.bytes_pulled = 0
        self.last_manifests: Dict[str, str] = {}       # cloud manifest hash last pulled
        self.synced_updated_at: Dict[str, int] = {}    # point_id -> updated_at last synced to/from cloud
        self.conflicts: List[Dict[str, Any]] = []
        self._load_meta()

    # -- meta persistence --
    def _meta_path(self):
        return os.path.join(self.base, "meta.json")

    def _load_meta(self):
        try:
            with open(self._meta_path()) as f:
                m = json.load(f)
            self.online = m.get("online", True)
            self.queue = m.get("queue", [])
            self.last_sync_at = m.get("last_sync_at")
            self.last_sync_summary = m.get("last_sync_summary")
            self.bytes_pushed = m.get("bytes_pushed", 0)
            self.bytes_pulled = m.get("bytes_pulled", 0)
            self.last_manifests = m.get("last_manifests", {})
            self.synced_updated_at = m.get("synced_updated_at", {})
            self.conflicts = m.get("conflicts", [])
        except Exception:
            pass

    def save_meta(self):
        try:
            atomic_write_json(self._meta_path(), {
                "online": self.online, "queue": self.queue,
                "last_sync_at": self.last_sync_at, "last_sync_summary": self.last_sync_summary,
                "bytes_pushed": self.bytes_pushed, "bytes_pulled": self.bytes_pulled,
                "last_manifests": self.last_manifests, "synced_updated_at": self.synced_updated_at,
                "conflicts": self.conflicts,
            }, default=str)
        except Exception as e:  # noqa: BLE001 — keep serving, but never fail silently
            print(f"[edge-engine] WARNING: could not persist {self._meta_path()}: {e}", flush=True)

    def memory_stats(self) -> Dict[str, Any]:
        shards = {}
        total = 0
        for name, st in self.shards.items():
            info = st.info()
            cnt = info.points_count
            total += cnt
            disk = _dir_size(st.path)
            shards[name] = {
                "name": name, "desc": SHARD_DEFS[name]["desc"],
                "points": cnt, "segments": info.segments_count,
                "disk_bytes": disk,
                "embedding": f"FastEmbed bge-small-en ({DENSE_DIM}d) + BM25 sparse",
                "manifest_hash": st.manifest_hash()[:12],
                "default_sync": SHARD_DEFS[name]["default_sync"],
            }
        return {"device": self.id, "total_points": total, "shards": shards}

    def recent_points(self, shard: str, limit: int = 12) -> List[Dict[str, Any]]:
        st = self.shards[shard]
        # scroll all (edge-scale is small) then sort by updated_at desc in Python
        all_recs = []
        offset = None
        while True:
            recs, offset = st.scroll(limit=200, offset=offset)
            all_recs.extend(recs)
            if not offset:
                break
        all_recs.sort(key=lambda r: (r.payload or {}).get("updated_at", 0) or 0, reverse=True)
        out = []
        for r in all_recs[:limit]:
            p = r.payload or {}
            out.append({
                "id": str(r.id), "slug": p.get("slug"), "title": p.get("title"),
                "text": p.get("text", ""), "domain": p.get("domain"),
                "criticality": p.get("criticality"), "sensitivity": p.get("sensitivity"),
                "origin_device": p.get("origin_device"), "sync_state": p.get("sync_state"),
                "updated_at": p.get("updated_at"),
                "asset_id": p.get("asset_id"), "sensor_type": p.get("sensor_type"),
                "value": p.get("value"), "unit": p.get("unit"), "severity": p.get("severity"),
            })
        return out


def _dir_size(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


# ---------------------------------------------------------------------------
# cloud (represents Qdrant Server knowledge)
# ---------------------------------------------------------------------------

class CloudStore:
    def __init__(self):
        os.makedirs(CLOUD_DIR, exist_ok=True)
        self.shards: Dict[str, ShardStore] = {
            name: ShardStore(name, _shard_path(CLOUD_DIR, name)) for name in SHARD_DEFS
        }

    def memory_stats(self) -> Dict[str, Any]:
        shards = {}
        total = 0
        for name, st in self.shards.items():
            info = st.info()
            cnt = info.points_count
            total += cnt
            shards[name] = {
                "name": name, "points": cnt, "segments": info.segments_count,
                "disk_bytes": _dir_size(st.path), "manifest_hash": st.manifest_hash()[:12],
            }
        return {"total_points": total, "shards": shards}

    def all_points(self, shard: str) -> List[Dict[str, Any]]:
        st = self.shards[shard]
        out = []
        offset = None
        while True:
            recs, offset = st.scroll(limit=200, offset=offset)
            for r in recs:
                p = r.payload or {}
                p["_id"] = str(r.id)
                out.append(p)
            if not offset:
                break
        return out

    # -- admin surface used by the Cloud Collections browser --
    def search(self, shard: str, mode: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        return self.shards[shard].search(mode, query, limit=limit)

    def delete_point(self, shard: str, point_id: str) -> bool:
        return self.shards[shard].delete_point(point_id)


# ---------------------------------------------------------------------------
# fleet manager
# ---------------------------------------------------------------------------

class Fleet:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.policy = json.loads(json.dumps(DEFAULT_POLICY))
        self.cloud = build_cloud_store(CloudStore, list(SHARD_DEFS))
        self.devices: Dict[str, Device] = {}
        for d in DEVICE_DEFS:
            self.devices[d["id"]] = Device(d)
        self.remote_members = REMOTE_MEMBERS
        self.active_device = DEVICE_DEFS[0]["id"]
        self.activity: List[Dict[str, Any]] = []
        self._lock = threading.RLock()
        self._contrib_cache: Optional[Dict[str, int]] = None
        self._contrib_ts: float = 0.0
        # live peer snapshots, cached so a polled fleet panel doesn't hammer a
        # peer that is down (a refused connection is cheap, a timeout is not)
        self._peer_cache: Dict[str, Tuple[float, Optional[Dict[str, Any]]]] = {}
        self._peer_ttl = 4.0
        self._retention = {"expired_total": 0, "last_run": None, "ttl_seconds": None}
        # cloud circuit breaker: a black-holed network makes every cloud call
        # wait out QDRANT_TIMEOUT, and the engine is single-threaded — so after a
        # failure, polled status calls answer from cache instead of re-probing
        self._cloud_last: Optional[Dict[str, Any]] = None
        self._cloud_down_until = 0.0
        self._load_activity()

    def _invalidate_contrib(self):
        self._contrib_cache = None

    # -- policy persistence: an admin's residency rules must survive a restart --
    def _policy_path(self):
        return os.path.join(DATA_DIR, "policy.json")

    def restore_policy(self, validate) -> bool:
        """Load the saved policy if it exists and passes `validate` (returns an
        error string or None). A bad file is ignored, never applied."""
        try:
            with open(self._policy_path()) as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return False
        err = validate(saved)
        if err:
            print(f"[edge-engine] ignoring saved policy.json: {err}", flush=True)
            return False
        self.policy = saved
        return True

    def set_policy(self, policy: Dict[str, Any]) -> None:
        atomic_write_json(self._policy_path(), policy)  # disk first: fail loudly, keep the old policy
        self.policy = policy

    # -- cloud reachability --
    def _cloud_failed(self, cooldown: float = 15.0):
        self._cloud_down_until = time.time() + cooldown

    def cloud_stats(self) -> Dict[str, Any]:
        """Cloud point counts for the console. Never raises: when the cloud is
        down the last known numbers come back flagged reachable=False."""
        if time.time() >= self._cloud_down_until:
            try:
                st = self.cloud.memory_stats()
                self._cloud_last = st
                return {**st, "reachable": True}
            except Exception as e:  # noqa: BLE001
                print(f"[edge-engine] cloud stats failed: {type(e).__name__}", flush=True)
                self._cloud_failed()
        return {**(self._cloud_last or {"total_points": 0, "shards": {}}), "reachable": False}

    def _cloud_error(self, device_id: str, what: str, e: Exception) -> Dict[str, Any]:
        """A cloud call failed mid-operation: nothing is lost (the queue is only
        cleared after a full push), the device just stays a device."""
        import traceback
        traceback.print_exc()
        self._cloud_failed()
        dev = self.devices[device_id]
        dev.save_meta()
        self.log(device_id, "sync", f"{what} failed — cloud unreachable or erroring ({type(e).__name__}); "
                 f"{len(dev.queue)} queued point(s) kept for retry", {"queue_depth": len(dev.queue)})
        return {"ok": False, "reason": "cloud unreachable — local memory and queue are intact",
                "queue_depth": len(dev.queue)}

    # -- federation: live peers ------------------------------------------
    def _peer_overview(self, url: str) -> Optional[Dict[str, Any]]:
        """GET <peer>/api/edge/fleet, cached for _peer_ttl seconds.
        Returns the peer's own live device entry, or None when unreachable."""
        now = time.time()
        hit = self._peer_cache.get(url)
        if hit and (now - hit[0]) < self._peer_ttl:
            return hit[1]
        data: Optional[Dict[str, Any]] = None
        try:
            payload = fetch_peer_json(f"{url}/api/edge/fleet")
            devices = payload.get("devices") if isinstance(payload, dict) else None
            live = next((d for d in devices if isinstance(d, dict) and d.get("live") is True), None) \
                if isinstance(devices, list) else None
            data = clean_peer_entry(live)
        except Exception:
            data = None
        # stamp after the call so a slow failure is cached for a full TTL
        self._peer_cache[url] = (time.time(), data)
        return data

    def remote_member_entry(self, m: Dict[str, Any]) -> Dict[str, Any]:
        """Fleet row for a member we do not host. With a URL we show its real
        numbers; without one we fall back to the static record."""
        url = m.get("url")
        entry = {
            "id": m["id"], "name": m["name"], "location": m["location"],
            "technician": m["technician"], "online": True, "active": False,
            "live": False, "kind": m["kind"], "federated": bool(url),
            "reachable": False, "total_points": 0, "queue_depth": 0,
            "open_conflicts": 0, "bytes_pushed": 0, "bytes_pulled": 0,
            "last_sync_at": int(time.time() * 1000) - m.get("last_sync_offset_min", 30) * 60000,
            "cloud_contributed": self._cloud_contrib_by_origin().get(m["id"], 0),
            "shards": [],
        }
        if url:
            live = self._peer_overview(url)
            if live:
                entry.update({**live, "reachable": True,
                              "last_sync_at": live["last_sync_at"] or entry["last_sync_at"]})
        return entry

    def _cloud_contrib_by_origin(self) -> Dict[str, int]:
        """Count cloud points per origin_device (for remote fleet members).
        Cached for 20s to avoid scrolling all cloud points on every polled
        fleet_overview call — sync/bootstrap invalidates the cache."""
        now = time.time()
        if self._contrib_cache is not None and (now - self._contrib_ts) < 20:
            return self._contrib_cache
        if now < self._cloud_down_until:
            return self._contrib_cache or {}
        counts: Dict[str, int] = {}
        try:
            for shard_name in SHARD_DEFS:
                for p in self.cloud.all_points(shard_name):
                    o = p.get("origin_device", "unknown")
                    counts[o] = counts.get(o, 0) + 1
        except Exception:  # noqa: BLE001 — cloud down: show the last known split
            self._cloud_failed()
            return self._contrib_cache or {}
        self._contrib_cache = counts
        self._contrib_ts = now
        return counts

    # -- activity log --
    def _act_path(self):
        return os.path.join(DATA_DIR, "activity.json")

    def _load_activity(self):
        try:
            with open(self._act_path()) as f:
                self.activity = json.load(f)
        except Exception:
            self.activity = []

    def log(self, device: str, kind: str, message: str, meta: Optional[Dict[str, Any]] = None):
        with self._lock:
            entry = {
                "ts": int(time.time() * 1000), "device": device, "kind": kind,
                "message": message, "meta": meta or {},
            }
            self.activity.append(entry)
            # keep last 500
            if len(self.activity) > 500:
                self.activity = self.activity[-500:]
            try:
                atomic_write_json(self._act_path(), self.activity[-500:], durable=False)
            except Exception:
                pass
            return entry

    def activity_since(self, device: Optional[str], limit: int = 60, since_ts: int = 0) -> List[Dict[str, Any]]:
        with self._lock:
            items = [a for a in self.activity if a["ts"] > since_ts]
            if device:
                items = [a for a in items if a["device"] == device or a["device"] == "system"]
            return list(reversed(items[-limit:]))

    # -- queue / conflict helpers --
    @staticmethod
    def _dequeue(dev: Device, point_id: str):
        dev.queue = [q for q in dev.queue if q.get("point_id") != point_id]

    @staticmethod
    def _conflict(pid: str, slug: Any, shard: str, local: Dict[str, Any], remote: Dict[str, Any],
                  local_device: str, **extra) -> Dict[str, Any]:
        side = lambda p, dev: {"text": p.get("text", ""), "updated_at": p.get("updated_at"),
                               "origin_device": dev, "criticality": p.get("criticality"),
                               "sensitivity": p.get("sensitivity")}
        now = int(time.time() * 1000)
        return {"id": f"c-{pid[:8]}-{now}", "point_id": pid, "slug": slug, "shard": shard,
                "local": side(local, local_device),
                "remote": side(remote, remote.get("origin_device")),
                "status": "open", "created_at": now, **extra}

    @staticmethod
    def _raise_conflict(dev: Device, c: Dict[str, Any]) -> bool:
        """Record an open conflict. A note that already has one just gets its
        card refreshed — stacking a second card for the same note is noise, and
        resolving one would strand the other. True when a new card was raised."""
        old = next((x for x in dev.conflicts if x["status"] == "open" and x["point_id"] == c["point_id"]), None)
        if old:
            old.update(local=c["local"], remote=c["remote"])
            return False
        dev.conflicts.append(c)
        return True

    # -- write --
    def write_point(self, device_id: str, shard: str, payload: Dict[str, Any],
                    text: Optional[str] = None, point_id: Optional[str] = None,
                    origin_device: Optional[str] = None) -> Dict[str, Any]:
        dev = self.devices[device_id]
        if shard not in dev.shards:
            raise ValueError(f"unknown shard {shard}")
        text = text if text is not None else payload.get("text", "")
        slug = payload.get("slug") or f"{device_id}-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}"
        point_id = point_id or str(uuid.uuid5(uuid.NAMESPACE_URL, slug))
        now = int(time.time() * 1000)
        # tag on write
        meta = {
            "domain": payload.get("domain", shard.rstrip("s") if shard.endswith("s") else shard),
            "criticality": payload.get("criticality", "medium"),
            "sensitivity": norm_sensitivity(payload.get("sensitivity")),
        }
        decision = evaluate_policy(meta, self.policy)
        full_payload = dict(payload)
        full_payload.update({
            "slug": slug, "text": text, "domain": meta["domain"],
            "criticality": meta["criticality"], "sensitivity": meta["sensitivity"],
            # provenance is caller-supplied on snapshot import so a handoff
            # keeps the original authorship; the timestamp is always ours
            "origin_device": origin_device or device_id,
            "updated_at": now,
            "sync_state": decision["sync_state"],
        })
        dense = embed.embed_dense(text)
        sparse = embed.embed_sparse_doc(text)
        dev.shards[shard].upsert(point_id, dense, sparse, full_payload)
        dev.shards[shard].optimize()
        self.log(device_id, "write", f"Wrote point '{slug}' to {shard} ({meta['criticality']}/{meta['sensitivity']}) → {decision['sync_state']}",
                 {"shard": shard, "slug": slug, "decision": decision, "point_id": point_id})
        # dual-write queue: one entry per point (latest wins); a rewrite to
        # local_only drops any stale entry so the old version can't sync
        self._dequeue(dev, point_id)
        if decision["sync_state"] != "local_only":
            dev.queue.append({
                "point_id": point_id, "shard": shard, "slug": slug,
                "enqueued_at": now, "priority": 1 if decision["sync_state"] == "sync_now" else 0,
            })
            self.log(device_id, "queue", f"Point '{slug}' enqueued for sync (priority={'high' if decision['sync_state']=='sync_now' else 'normal'})",
                     {"queue_depth": len(dev.queue)})
        else:
            self.log(device_id, "policy", f"Point '{slug}' tagged local-only — never syncs ({decision['reason']})",
                     {"rule": decision["matched_rule"]})
        dev.save_meta()
        return {"point_id": point_id, "slug": slug, "sync_state": decision["sync_state"], "decision": decision}

    # -- connectivity --
    def set_connectivity(self, device_id: str, online: bool):
        dev = self.devices[device_id]
        was = dev.online
        dev.online = online
        dev.save_meta()
        self.log(device_id, "connectivity",
                 f"Link {'ESTABLISHED' if online else 'LOST'} — device {'online' if online else 'offline'}",
                 {"was": was, "now": online})
        if online and not was and dev.queue:
            self.log(device_id, "sync", f"Link restored — {len(dev.queue)} queued point(s) ready to sync",
                     {"queue_depth": len(dev.queue)})
        return {"online": online}

    # -- sync --
    def sync(self, device_id: str) -> Dict[str, Any]:
        dev = self.devices[device_id]
        if not dev.online:
            self.log(device_id, "sync", "Sync blocked — device offline (queue retained)", {})
            return {"ok": False, "reason": "offline", "queue_depth": len(dev.queue)}
        try:
            res = self._sync(dev, device_id)
        except Exception as e:  # noqa: BLE001 — the cloud is allowed to be down
            return self._cloud_error(device_id, "Sync", e)
        self._cloud_down_until = 0.0
        return res

    def _sync(self, dev: Device, device_id: str) -> Dict[str, Any]:
        pushed = 0; pulled = 0; bytes_p = 0; bytes_r = 0; new_conflicts = 0
        manifest_diffs: Dict[str, Any] = {}
        # ---- PUSH (edge -> cloud) ----
        if dev.queue:
            # critical first
            queue = sorted(dev.queue, key=lambda q: -q.get("priority", 0))
            held = 0
            touched = set()
            for item in queue:
                shard = item.get("shard"); point_id = item.get("point_id")
                if shard not in dev.shards or not point_id:
                    held += 1
                    continue
                # the queue entry is only a pointer: push the point as it is
                # *now*, under the policy as it is *now*
                payload = dev.shards[shard].retrieve_payload(point_id)
                if payload is None or stays_local(payload, self.policy):
                    held += 1
                    continue
                payload.pop("_id", None)
                text = payload.get("text", "")
                # conflict check at cloud: does cloud already have this id from another device?
                existing = self.cloud.shards[shard].retrieve_payload(point_id)
                if existing and existing.get("origin_device") not in (None, device_id):
                    # another device's version is in the cloud. It only diverges
                    # from ours if it moved on since this device last saw it —
                    # improving a note we pulled is a normal update, not a conflict.
                    e_upd = existing.get("updated_at", 0)
                    if e_upd > dev.synced_updated_at.get(point_id, 0) and e_upd != payload.get("updated_at"):
                        # genuine divergence -> record conflict, do NOT silently overwrite
                        conflict = self._conflict(point_id, payload.get("slug"), shard,
                                                  payload, existing, device_id)
                        if self._raise_conflict(dev, conflict):
                            new_conflicts += 1
                            self.log(device_id, "conflict",
                                     f"Conflict detected on '{payload.get('slug')}' — edited on {device_id} and {existing.get('origin_device')}",
                                     {"shard": shard, "conflict_id": conflict["id"]})
                        pushed += 1  # count as processed
                        continue
                # no conflict -> upsert to cloud
                dense = embed.embed_dense(text)
                sparse = embed.embed_sparse_doc(text)
                self.cloud.shards[shard].upsert(point_id, dense, sparse, payload)
                self.cloud.shards[shard].optimize()
                touched.add(shard)
                dev.synced_updated_at[point_id] = payload.get("updated_at", 0)
                pushed += 1
                bytes_p += len(text.encode()) + 400  # approx payload size
            for shard in touched:
                self.cloud.shards[shard].flush()
            dev.queue = []
            self.log(device_id, "sync", f"Pushed {pushed} point(s) to cloud"
                     + (f", held back {held} (deleted or now local-only)" if held else ""),
                     {"pushed": pushed, "held": held, "bytes": bytes_p, "conflicts": new_conflicts})
        # ---- PULL (cloud -> edge) ----
        for shard_name in SHARD_DEFS:
            cloud_st = self.cloud.shards[shard_name]
            dev_st = dev.shards[shard_name]
            cur_hash = cloud_st.manifest_hash(fresh=True)  # other devices write too
            last_hash = dev.last_manifests.get(shard_name)
            changed = cur_hash != last_hash
            manifest_diffs[shard_name] = {"changed": changed, "cloud_hash": cur_hash[:12],
                                          "last_hash": (last_hash or "")[:12]}
            if not changed and last_hash is not None:
                continue
            # manifest-diff pull: transfer only points newer than what device last synced
            cloud_points = self.cloud.all_points(shard_name)
            for cp in cloud_points:
                pid = cp.get("_id")
                c_updated = cp.get("updated_at", 0)
                last_synced = dev.synced_updated_at.get(pid, 0)
                if c_updated <= last_synced:
                    continue
                # conflict check: did device modify this point locally?
                local = dev_st.retrieve_payload(pid)
                if local and local.get("origin_device") == device_id and \
                   local.get("updated_at", 0) > last_synced and \
                   local.get("updated_at", 0) != c_updated:
                    conflict = self._conflict(pid, cp.get("slug"), shard_name, local, cp, device_id)
                    if self._raise_conflict(dev, conflict):
                        new_conflicts += 1
                        self.log(device_id, "conflict",
                                 f"Pulled '{cp.get('slug')}' but local copy diverged — conflict raised",
                                 {"shard": shard_name, "conflict_id": conflict["id"]})
                    continue
                # no conflict -> upsert into device (re-embed from text)
                text = cp.get("text", "")
                dense = embed.embed_dense(text)
                sparse = embed.embed_sparse_doc(text)
                dev_st.upsert(pid, dense, sparse, cp)
                dev.synced_updated_at[pid] = c_updated
                pulled += 1
                bytes_r += len(text.encode()) + 400
            dev_st.optimize(); dev_st.flush()
            dev.last_manifests[shard_name] = cur_hash
        dev.bytes_pushed += bytes_p
        dev.bytes_pulled += bytes_r
        dev.last_sync_at = int(time.time() * 1000)
        summary = {
            "pushed": pushed, "pulled": pulled, "bytes_pushed": bytes_p,
            "bytes_pulled": bytes_r, "new_conflicts": new_conflicts,
            "manifest_diffs": manifest_diffs, "at": dev.last_sync_at,
        }
        dev.last_sync_summary = summary
        dev.save_meta()
        self.log(device_id, "sync",
                 f"Sync complete — pushed {pushed}, pulled {pulled}, conflicts {new_conflicts}",
                 {"summary": summary})
        self._invalidate_contrib()
        return {"ok": True, **summary}

    def bootstrap(self, device_id: str) -> Dict[str, Any]:
        """Full snapshot pull: seed an empty device from the entire cloud."""
        dev = self.devices[device_id]
        if not dev.online:
            return {"ok": False, "reason": "offline"}
        try:
            res = self._bootstrap(dev, device_id)
        except Exception as e:  # noqa: BLE001
            return self._cloud_error(device_id, "Bootstrap", e)
        self._cloud_down_until = 0.0
        return res

    def _bootstrap(self, dev: Device, device_id: str) -> Dict[str, Any]:
        pulled = 0; bytes_r = 0; conflicts = 0
        for shard_name in SHARD_DEFS:
            cloud_st = self.cloud.shards[shard_name]
            dev_st = dev.shards[shard_name]
            for cp in self.cloud.all_points(shard_name):
                pid = cp.get("_id")
                text = cp.get("text", "")
                # never silently overwrite a local edit that hasn't reached the cloud
                local = dev_st.retrieve_payload(pid)
                if local and local.get("text") != text and \
                   local.get("updated_at", 0) > dev.synced_updated_at.get(pid, 0):
                    c = self._conflict(pid, cp.get("slug"), shard_name, local, cp, device_id)
                    if self._raise_conflict(dev, c):
                        conflicts += 1
                        self.log(device_id, "conflict",
                                 f"Bootstrap found '{cp.get('slug')}' diverged from the local copy — conflict raised",
                                 {"shard": shard_name, "conflict_id": c["id"]})
                    continue
                dense = embed.embed_dense(text)
                sparse = embed.embed_sparse_doc(text)
                dev_st.upsert(pid, dense, sparse, cp)
                dev.synced_updated_at[pid] = cp.get("updated_at", 0)
                pulled += 1
                bytes_r += len(text.encode()) + 400
            dev_st.optimize(); dev_st.flush()
            dev.last_manifests[shard_name] = cloud_st.manifest_hash()
        dev.bytes_pulled += bytes_r
        dev.last_sync_at = int(time.time() * 1000)
        dev.save_meta()
        self.log(device_id, "bootstrap", f"Bootstrapped device from cloud snapshot — {pulled} points pulled"
                 + (f", {conflicts} conflict(s) raised" if conflicts else ""),
                 {"pulled": pulled, "bytes": bytes_r, "conflicts": conflicts})
        return {"ok": True, "pulled": pulled, "bytes_pulled": bytes_r, "conflicts": conflicts}

    def resolve_conflict(self, device_id: str, conflict_id: str, resolution: str, merged_text: Optional[str] = None) -> Dict[str, Any]:
        dev = self.devices[device_id]
        c = next((x for x in dev.conflicts if x["id"] == conflict_id), None)
        if not c:
            return {"ok": False, "reason": "not found"}
        if c.get("status") != "open":
            return {"ok": False, "reason": "already resolved"}
        if resolution not in ("local", "remote", "merge"):
            return {"ok": False, "reason": "resolution must be local, remote or merge"}
        pid = c["point_id"]; shard = c["shard"]
        if shard not in dev.shards:
            return {"ok": False, "reason": "unknown shard"}
        if resolution == "local":
            chosen = c["local"]; text = chosen["text"]
        elif resolution == "remote":
            chosen = c["remote"]; text = chosen["text"]
        else:  # merge
            text = merged_text if isinstance(merged_text, str) and merged_text else c["local"]["text"]
            chosen = {**c["local"], "text": text}
        # keep the local point's real tags (sensitivity above all): the
        # residency decision is made on what the device actually holds
        current = dev.shards[shard].retrieve_payload(pid) or {}
        current.pop("_id", None)
        now = int(time.time() * 1000)
        payload = {**current,
                   "slug": c["slug"], "text": text,
                   "domain": current.get("domain") or (shard.rstrip("s") if shard.endswith("s") else shard),
                   "criticality": chosen.get("criticality") or current.get("criticality") or "medium",
                   "sensitivity": norm_sensitivity(current.get("sensitivity") or c["local"].get("sensitivity")),
                   "origin_device": device_id, "updated_at": now}
        decision = evaluate_policy(payload, self.policy)
        local_only = decision["sync_state"] == "local_only"
        if not local_only and not dev.online:
            return {"ok": False, "reason": "offline — reconnect to resolve and sync"}
        payload["sync_state"] = decision["sync_state"]
        dense = embed.embed_dense(text); sparse = embed.embed_sparse_doc(text)
        if not local_only:
            # cloud first: if it is down nothing has changed and the card stays open
            try:
                self.cloud.shards[shard].upsert(pid, dense, sparse, payload)
                self.cloud.shards[shard].optimize()
            except Exception as e:  # noqa: BLE001
                return self._cloud_error(device_id, "Conflict resolution", e)
        dev.shards[shard].upsert(pid, dense, sparse, payload)
        dev.shards[shard].optimize()
        self._dequeue(dev, pid)
        if local_only:
            # never touches the cloud; remember the remote version we saw so
            # the next pull doesn't raise the same conflict again
            dev.synced_updated_at[pid] = max(dev.synced_updated_at.get(pid, 0),
                                             _count(c["remote"].get("updated_at")))
        else:
            dev.synced_updated_at[pid] = now
        c["status"] = "resolved"; c["resolution"] = resolution
        # resolved cards are history, and sync-status returns them on every poll
        done = [x for x in dev.conflicts if x["status"] != "open"]
        if len(done) > MAX_RESOLVED_CONFLICTS:
            drop = {id(x) for x in done[:-MAX_RESOLVED_CONFLICTS]}
            dev.conflicts = [x for x in dev.conflicts if id(x) not in drop]
        c["scope"] = "local" if local_only else "synced"
        dev.save_meta()
        self._invalidate_contrib()
        self.log(device_id, "conflict",
                 f"Conflict '{c['slug']}' resolved ({resolution}) "
                 + (f"on-device only — {decision['reason']}" if local_only else "and synced"),
                 {"conflict_id": conflict_id, "resolution": resolution, "decision": decision})
        return {"ok": True, "synced": not local_only}

    def sync_status(self, device_id: str) -> Dict[str, Any]:
        dev = self.devices[device_id]
        return {
            "device": device_id, "online": dev.online,
            "queue_depth": len(dev.queue),
            "queue_critical": sum(1 for q in dev.queue if q.get("priority", 0) > 0),
            "last_sync_at": dev.last_sync_at,
            "last_sync_summary": dev.last_sync_summary,
            "bytes_pushed": dev.bytes_pushed, "bytes_pulled": dev.bytes_pulled,
            "open_conflicts": [c for c in dev.conflicts if c["status"] == "open"],
            "resolved_conflicts": [c for c in dev.conflicts if c["status"] == "resolved"],
        }

    # -- snapshot handoff (device -> file -> another device) --
    def export_snapshot(self, device_id: str) -> Dict[str, Any]:
        """Portable snapshot of a device's memory. Vectors are omitted — the
        importer re-embeds from text — and local_only points are excluded so an
        export can never carry restricted data off the device."""
        dev = self.devices[device_id]
        out: Dict[str, Any] = {
            "format": "edge-mem-snapshot", "version": 1, "device": device_id,
            "exported_at": int(time.time() * 1000), "shards": {}, "excluded_local_only": 0,
        }
        for name, st in dev.shards.items():
            rows: List[Dict[str, Any]] = []
            offset = None
            while True:
                recs, offset = st.scroll(limit=200, offset=offset)
                for r in recs:
                    p = dict(r.payload or {})
                    if p.get("sync_state") == "local_only" or stays_local(p, self.policy):
                        out["excluded_local_only"] += 1
                        continue
                    p["_id"] = str(r.id)
                    rows.append(p)
                if not offset:
                    break
            out["shards"][name] = rows
        out["point_count"] = sum(len(v) for v in out["shards"].values())
        self.log(device_id, "snapshot",
                 f"Exported snapshot — {out['point_count']} points ({out['excluded_local_only']} restricted held back)",
                 {"points": out["point_count"]})
        return out

    def import_snapshot(self, device_id: str, snap: Dict[str, Any]) -> Dict[str, Any]:
        """Load a snapshot onto a device. New ids go through write_point so
        policy tagging, queueing and logging behave exactly as for a locally
        authored note, stamped with *this* device's clock (a file-supplied
        updated_at could mask a real divergence at the cloud). An id the
        device already holds is never overwritten: identical text is a no-op,
        different text becomes a conflict for a human to resolve."""
        if not isinstance(snap, dict) or snap.get("format") != "edge-mem-snapshot":
            return {"ok": False, "reason": "not an edge-mem snapshot"}
        dev = self.devices[device_id]
        imported = skipped = unchanged = conflicts = 0
        seen: Dict[str, int] = {}
        shards = snap.get("shards")
        for shard, rows in (shards.items() if isinstance(shards, dict) else []):
            if shard not in SHARD_DEFS or not isinstance(rows, list):
                skipped += len(rows) if isinstance(rows, list) else 1
                continue
            for p in rows:
                if not isinstance(p, dict):
                    skipped += 1
                    continue
                pid = p.get("_id") or p.get("point_id") or p.get("id")
                text = p.get("text", "")
                if not pid or not isinstance(text, str) or not text:
                    skipped += 1
                    continue
                pid = str(pid)
                local = dev.shards[shard].retrieve_payload(pid)
                if local is not None:
                    if local.get("text") == text:
                        unchanged += 1
                    else:
                        c = self._conflict(pid, local.get("slug"), shard, local,
                                           {**p, "origin_device": p.get("origin_device") or snap.get("device")},
                                           device_id, source="snapshot")
                        if self._raise_conflict(dev, c):
                            conflicts += 1
                            self.log(device_id, "conflict",
                                     f"Snapshot import diverges from local '{local.get('slug')}' — conflict raised",
                                     {"shard": shard, "conflict_id": c["id"]})
                        continue
                else:
                    body = {k: v for k, v in p.items() if k not in ("_id", "point_id", "id", "text")}
                    self.write_point(device_id, shard, body, text=text, point_id=pid,
                                     origin_device=p.get("origin_device"))
                imported += 1
                seen[shard] = seen.get(shard, 0) + 1
        if conflicts:
            dev.save_meta()
        self._invalidate_contrib()
        return {"ok": True, "imported": imported, "unchanged": unchanged, "conflicts": conflicts,
                "skipped": skipped, "source_device": snap.get("device"), "shards": seen}

    # -- TTL retention --
    def run_retention(self, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Expire raw telemetry older than policy.ttl_raw_sensor_seconds.
        The sensors EdgeShard *is* the raw firehose, so everything in it is
        subject to the TTL; distilled knowledge lives in the other shards."""
        dev = self.devices[device_id or self.active_device]
        # ponytail: full-shard scroll sweep, no scheduler — runs on demand from
        # POST /api/edge/retention/run (or the Metrics button). Add a background
        # ticker only if expiring stale telemetry between manual runs matters.
        ttl_s = int(self.policy.get("ttl_raw_sensor_seconds", 600))
        ttl_ms = ttl_s * 1000
        now = int(time.time() * 1000)
        st = dev.shards["sensors"]
        expired = checked = 0
        offset = None
        while True:
            recs, offset = st.scroll(limit=200, offset=offset)
            for r in recs:
                checked += 1
                if now - int((r.payload or {}).get("updated_at", 0)) > ttl_ms:
                    if st.delete_point(str(r.id)):
                        self._dequeue(dev, str(r.id))
                        expired += 1
            if not offset:
                break
        if expired:
            st.optimize(); st.flush()
            dev.save_meta()
        self._retention = {"expired_total": self._retention.get("expired_total", 0) + expired,
                           "last_run": now, "ttl_seconds": ttl_s}
        if expired:
            self.log(dev.id, "retention",
                     f"TTL sweep expired {expired} raw sensor point(s) older than {ttl_s}s",
                     {"expired": expired, "checked": checked, "ttl_seconds": ttl_s})
        return {"ok": True, "device": dev.id, "shard": "sensors", "expired": expired,
                "checked": checked, "ttl_seconds": ttl_s, **self._retention}

    def retention_status(self) -> Dict[str, Any]:
        return dict(self._retention, ttl_seconds=int(self.policy.get("ttl_raw_sensor_seconds", 600)))

    def fleet_overview(self) -> Dict[str, Any]:
        contrib = self._cloud_contrib_by_origin()
        devices = []
        for did, dev in self.devices.items():
            ms = dev.memory_stats()
            ss = self.sync_status(did)
            devices.append({
                "id": did, "name": dev.name, "location": dev.location,
                "technician": dev.technician, "online": dev.online,
                "active": did == self.active_device, "live": True,
                "total_points": ms["total_points"], "queue_depth": ss["queue_depth"],
                "open_conflicts": len(ss["open_conflicts"]),
                "last_sync_at": dev.last_sync_at,
                "bytes_pushed": dev.bytes_pushed, "bytes_pulled": dev.bytes_pulled,
                "cloud_contributed": contrib.get(did, 0),
                "shards": list(ms["shards"].values()),
            })
        # remote members: live probe when federated, static record otherwise
        for m in self.remote_members:
            devices.append(self.remote_member_entry(m))
        return {"devices": devices, "cloud": self.cloud_stats(), "active_device": self.active_device}

    def search(self, device_id: str, shard: str, query: str, mode: str = "hybrid",
               limit: int = 5, filters: Optional[Dict[str, Any]] = None,
               explain: bool = False) -> Dict[str, Any]:
        dev = self.devices[device_id]
        st = dev.shards.get(shard)
        if not st:
            raise ValueError("unknown shard")
        flt = build_filter(filters)
        active = [k for k in FILTERABLE_KEYS if filters.get(k) not in (None, "")]
        t0 = time.perf_counter()
        results = st.search(mode, query, limit=limit, flt=flt)
        if explain:
            # two extra single-mode passes so the UI can show dense vs sparse
            # contribution next to the fused RRF score
            n = max(limit * 3, 15)
            dense = {r["id"]: r["score"] for r in st.search("dense", query, limit=n, flt=flt)}
            sparse = {r["id"]: r["score"] for r in st.search("sparse", query, limit=n, flt=flt)}
            for r in results:
                r["scores"] = {"dense": dense.get(r["id"]), "sparse": sparse.get(r["id"]),
                               "fused": r["score"]}
        ms = (time.perf_counter() - t0) * 1000
        self.log(device_id, "search",
                 f"{'OFFLINE' if not dev.online else 'online'} {mode} search on {shard}: '{query[:40]}' → {len(results)} hits in {ms:.1f}ms",
                 {"shard": shard, "mode": mode, "latency_ms": round(ms, 2), "hits": len(results),
                  "offline": not dev.online, "filters": active})
        return {
            "results": results, "latency_ms": round(ms, 2),
            "offline": not dev.online, "mode": mode, "shard": shard,
            "filters": {k: filters[k] for k in active},
            "explained": bool(explain),
        }

    def get_point(self, device_id: str, shard: str, point_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a single point's full payload."""
        dev = self.devices[device_id]
        st = dev.shards.get(shard)
        if not st:
            return None
        return st.retrieve_payload(point_id)

    def delete_point(self, device_id: str, shard: str, point_id: str) -> Dict[str, Any]:
        """Delete a point from a device shard (local only — does not touch cloud)."""
        dev = self.devices[device_id]
        st = dev.shards.get(shard)
        if not st:
            return {"ok": False, "reason": "unknown shard"}
        ok = st.delete_point(point_id)
        if ok:
            self._dequeue(dev, point_id)
            self.log(device_id, "write", f"Deleted point {point_id[:12]}… from {shard}",
                     {"shard": shard, "point_id": point_id, "action": "delete"})
            dev.save_meta()
        return {"ok": ok}

    def trigger_demo_conflict(self, device_id: str) -> Dict[str, Any]:
        """Manufacture a conflict: a known shared slug gets divergent edits on the
        active device and on another device (via cloud), then a sync surfaces it."""
        slug = "manual-sop12-bearing"
        shard = "manuals"
        pid = str(uuid.uuid5(uuid.NAMESPACE_URL, slug))
        now = int(time.time() * 1000)
        # remote version on cloud from device-beta
        remote_payload = {
            "slug": slug, "text": "SOP-12 (v2, beta edit): Bearing replacement for P-200 pumps. Added torque step 45Nm on M8 cap screws. Clearance check 0.05mm.",
            "domain": "manual", "criticality": "high", "sensitivity": "internal",
            "origin_device": "device-beta", "updated_at": now - 1000, "sync_state": "synced",
        }
        dense = embed.embed_dense(remote_payload["text"]); sparse = embed.embed_sparse_doc(remote_payload["text"])
        self.cloud.shards[shard].upsert(pid, dense, sparse, remote_payload)
        self.cloud.shards[shard].optimize()
        # local version on active device (newer, divergent)
        dev = self.devices[device_id]
        local_payload = {
            "slug": slug, "text": "SOP-12 (alpha field edit): Bearing replacement P-200. Field note — use 50Nm on M8, clearance 0.04mm. Verified on P-201.",
            "domain": "manual", "criticality": "high", "sensitivity": "internal",
            "origin_device": device_id, "updated_at": now, "sync_state": "synced",
        }
        dev.shards[shard].upsert(pid, embed.embed_dense(local_payload["text"]),
                                 embed.embed_sparse_doc(local_payload["text"]), local_payload)
        dev.shards[shard].optimize()
        dev.synced_updated_at[pid] = now - 2000  # pretend last sync was before both edits
        dev.save_meta()
        self.log(device_id, "demo", f"Manufactured divergent edits on '{slug}' (alpha vs beta) — run sync to surface conflict", {})
        self._invalidate_contrib()
        return {"ok": True, "slug": slug, "shard": shard}
