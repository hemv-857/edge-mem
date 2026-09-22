"""Core edge intelligence engine.

Grounded in the real Qdrant Edge API (qdrant_edge.EdgeShard):
- Each device holds several EdgeShards (manuals / incidents / sensors) as its
  local semantic memory — fully in-process, like SQLite for vectors.
- Dense vectors from FastEmbed (CPU) + sparse BM25 vectors -> on-device hybrid
  retrieval with zero network calls.
- A co-located set of EdgeShards represents the centralized Qdrant Server
  knowledge ("the cloud"). We are transparent about this: the sandbox cannot
  run a separate Qdrant server, so the cloud is an EdgeShard in the same process.
  The sync mechanics (manifest-diff pull, dual-write push queue, conflict
  detection) are real and operate on real vector points.
"""
from __future__ import annotations

import os
import json
import time
import uuid
import shutil
import hashlib
import threading
from typing import Any, Dict, List, Optional, Tuple

from qdrant_edge import (
    EdgeShard, EdgeConfig, EdgeVectorParams, EdgeSparseVectorParams,
    Bm25, Distance, Point, UpdateOperation, QueryRequest, Prefetch,
    Query, Fusion, Filter, FieldCondition, MatchValue, MatchText,
    CountRequest, ScrollRequest, PayloadSelector, OrderBy, Direction,
)

import embed

DENSE_DIM = embed.DENSE_DIM
SPARSE_NAME = embed.SPARSE_NAME

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
CLOUD_DIR = os.path.join(DATA_DIR, "cloud")

# Knowledge domains = separate EdgeShards so each can have its own
# retention / sync / embedding policy.
SHARD_DEFS = {
    "manuals":   {"desc": "Equipment manuals & SOPs",            "default_sync": "synced"},
    "incidents": {"desc": "Past incidents & verified fixes",     "default_sync": "synced"},
    "sensors":   {"desc": "Live sensor readings & raw telemetry","default_sync": "local_only"},
}

DEVICE_DEFS = [
    {"id": "device-alpha", "name": "Alpha — Field Unit 01", "location": "Plant A — North Wing", "technician": "R. Okafor"},
]

# Remote fleet members: their knowledge lives in the cloud (origin_device tag).
# They appear in the fleet dashboard with their contributed points + simulated
# sync health, but hold no live local shards in this process (memory budget).
REMOTE_MEMBERS = [
    {"id": "device-beta",  "name": "Beta — Robotic Inspector", "location": "Plant B — Cell 3",   "technician": "auto (robot)", "kind": "robot",     "last_sync_offset_min": 47},
    {"id": "device-gamma", "name": "Gamma — Kiosk Terminal",  "location": "Plant C — Lobby",    "technician": "K. Mendoza",   "kind": "kiosk",     "last_sync_offset_min": 12},
]

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


def evaluate_policy(point_meta: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return {sync_state, matched_rule, reason} for a point given its tags."""
    for rule in policy["rules"]:
        field = rule["field"]
        val = point_meta.get(field)
        if rule["op"] == "eq" and val == rule.get("value"):
            return {"sync_state": rule["action"], "matched_rule": rule["id"], "reason": rule["reason"]}
        if rule["op"] == "in" and val in rule.get("values", []):
            return {"sync_state": rule["action"], "matched_rule": rule["id"], "reason": rule["reason"]}
    return {"sync_state": "queued", "matched_rule": None, "reason": "Default: queue for opportunistic sync"}


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
        except Exception:
            # corrupt/empty -> recreate
            shutil.rmtree(path, ignore_errors=True)
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
        recs, nxt = self.shard.scroll(ScrollRequest(
            offset=offset, limit=limit, filter=flt,
            with_payload=PayloadSelector.Include([
                "slug","text","domain","criticality","sensitivity","origin_device",
                "updated_at","sync_state","asset_id","severity","sensor_type","value","unit","title",
            ]),
        ))
        return recs, nxt

    def manifest_hash(self) -> str:
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
                               with_payload=PayloadSelector.Include(["slug","text","domain","criticality","origin_device","asset_id","title","updated_at"]),
                               filter=flt)
        elif mode == "sparse":
            req = QueryRequest(limit=limit, query=Query.Nearest(sparse, using=SPARSE_NAME),
                               with_payload=PayloadSelector.Include(["slug","text","domain","criticality","origin_device","asset_id","title","updated_at"]),
                               filter=flt)
        else:  # hybrid
            req = QueryRequest(
                limit=limit,
                prefetches=[
                    Prefetch(limit=max(limit * 4, 20), query=Query.Nearest(dense, using="")),
                    Prefetch(limit=max(limit * 4, 20), query=Query.Nearest(sparse, using=SPARSE_NAME)),
                ],
                query=Fusion.Rrf(k=2),
                with_payload=PayloadSelector.Include(["slug","text","domain","criticality","origin_device","asset_id","title","updated_at"]),
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
                "criticality": p.get("criticality"), "origin_device": p.get("origin_device"),
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
            with open(self._meta_path(), "w") as f:
                json.dump({
                    "online": self.online, "queue": self.queue,
                    "last_sync_at": self.last_sync_at, "last_sync_summary": self.last_sync_summary,
                    "bytes_pushed": self.bytes_pushed, "bytes_pulled": self.bytes_pulled,
                    "last_manifests": self.last_manifests, "synced_updated_at": self.synced_updated_at,
                    "conflicts": self.conflicts,
                }, f, default=str)
        except Exception:
            pass

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


# ---------------------------------------------------------------------------
# fleet manager
# ---------------------------------------------------------------------------

class Fleet:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.policy = json.loads(json.dumps(DEFAULT_POLICY))
        self.cloud = CloudStore()
        self.devices: Dict[str, Device] = {}
        for d in DEVICE_DEFS:
            self.devices[d["id"]] = Device(d)
        self.remote_members = REMOTE_MEMBERS
        self.active_device = DEVICE_DEFS[0]["id"]
        self.activity: List[Dict[str, Any]] = []
        self._lock = threading.RLock()
        self._contrib_cache: Optional[Dict[str, int]] = None
        self._contrib_ts: float = 0.0
        self._load_activity()

    def _invalidate_contrib(self):
        self._contrib_cache = None

    def _cloud_contrib_by_origin(self) -> Dict[str, int]:
        """Count cloud points per origin_device (for remote fleet members).
        Cached for 20s to avoid scrolling all cloud points on every polled
        fleet_overview call — sync/bootstrap invalidates the cache."""
        now = time.time()
        if self._contrib_cache is not None and (now - self._contrib_ts) < 20:
            return self._contrib_cache
        counts: Dict[str, int] = {}
        for shard_name in SHARD_DEFS:
            for p in self.cloud.all_points(shard_name):
                o = p.get("origin_device", "unknown")
                counts[o] = counts.get(o, 0) + 1
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
                with open(self._act_path(), "w") as f:
                    json.dump(self.activity[-500:], f)
            except Exception:
                pass
            return entry

    def activity_since(self, device: Optional[str], limit: int = 60, since_ts: int = 0) -> List[Dict[str, Any]]:
        with self._lock:
            items = [a for a in self.activity if a["ts"] > since_ts]
            if device:
                items = [a for a in items if a["device"] == device or a["device"] == "system"]
            return list(reversed(items[-limit:]))

    # -- write --
    def write_point(self, device_id: str, shard: str, payload: Dict[str, Any], text: Optional[str] = None) -> Dict[str, Any]:
        dev = self.devices[device_id]
        if shard not in dev.shards:
            raise ValueError(f"unknown shard {shard}")
        text = text if text is not None else payload.get("text", "")
        slug = payload.get("slug") or f"{device_id}-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}"
        point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, slug))
        now = int(time.time() * 1000)
        # tag on write
        meta = {
            "domain": payload.get("domain", shard.rstrip("s") if shard.endswith("s") else shard),
            "criticality": payload.get("criticality", "medium"),
            "sensitivity": payload.get("sensitivity", "internal"),
        }
        decision = evaluate_policy(meta, self.policy)
        full_payload = dict(payload)
        full_payload.update({
            "slug": slug, "text": text, "domain": meta["domain"],
            "criticality": meta["criticality"], "sensitivity": meta["sensitivity"],
            "origin_device": device_id, "updated_at": now,
            "sync_state": decision["sync_state"],
        })
        dense = embed.embed_dense(text)
        sparse = embed.embed_sparse_doc(text)
        dev.shards[shard].upsert(point_id, dense, sparse, full_payload)
        dev.shards[shard].optimize()
        self.log(device_id, "write", f"Wrote point '{slug}' to {shard} ({meta['criticality']}/{meta['sensitivity']}) → {decision['sync_state']}",
                 {"shard": shard, "slug": slug, "decision": decision, "point_id": point_id})
        # dual-write queue: enqueue unless local_only
        if decision["sync_state"] != "local_only":
            dev.queue.append({
                "point_id": point_id, "shard": shard, "payload": full_payload,
                "enqueued_at": now, "priority": 1 if decision["sync_state"] == "sync_now" else 0,
                "text": text,
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
        if online and not was:
            self.log(device_id, "sync", "Auto-sync triggered on reconnection", {})
        return {"online": online}

    # -- sync --
    def sync(self, device_id: str) -> Dict[str, Any]:
        dev = self.devices[device_id]
        if not dev.online:
            self.log(device_id, "sync", "Sync blocked — device offline (queue retained)", {})
            return {"ok": False, "reason": "offline", "queue_depth": len(dev.queue)}
        pushed = 0; pulled = 0; bytes_p = 0; bytes_r = 0; new_conflicts = 0
        manifest_diffs: Dict[str, Any] = {}
        # ---- PUSH (edge -> cloud) ----
        if dev.queue:
            # critical first
            queue = sorted(dev.queue, key=lambda q: -q.get("priority", 0))
            for item in queue:
                shard = item["shard"]; payload = dict(item["payload"])
                point_id = item["point_id"]
                # conflict check at cloud: does cloud already have this id from another device?
                existing = self.cloud.shards[shard].retrieve_payload(point_id)
                if existing and existing.get("origin_device") not in (None, device_id):
                    # remote version from another device exists
                    if existing.get("updated_at", 0) != payload.get("updated_at"):
                        # genuine divergence -> record conflict, do NOT silently overwrite
                        conflict = {
                            "id": f"c-{point_id[:8]}-{int(time.time()*1000)}",
                            "point_id": point_id, "slug": payload.get("slug"), "shard": shard,
                            "local": {"text": payload.get("text",""), "updated_at": payload.get("updated_at"),
                                      "origin_device": device_id, "criticality": payload.get("criticality")},
                            "remote": {"text": existing.get("text",""), "updated_at": existing.get("updated_at"),
                                       "origin_device": existing.get("origin_device"),
                                       "criticality": existing.get("criticality")},
                            "status": "open", "created_at": int(time.time()*1000),
                        }
                        dev.conflicts.append(conflict)
                        new_conflicts += 1
                        self.log(device_id, "conflict",
                                 f"Conflict detected on '{payload.get('slug')}' — edited on {device_id} and {existing.get('origin_device')}",
                                 {"shard": shard, "conflict_id": conflict["id"]})
                        pushed += 1  # count as processed
                        continue
                # no conflict -> upsert to cloud
                dense = embed.embed_dense(item["text"])
                sparse = embed.embed_sparse_doc(item["text"])
                self.cloud.shards[shard].upsert(point_id, dense, sparse, payload)
                self.cloud.shards[shard].optimize()
                dev.synced_updated_at[point_id] = payload.get("updated_at", 0)
                pushed += 1
                bytes_p += len(item["text"].encode()) + 400  # approx payload size
            self.cloud.shards[shard].flush()
            dev.queue = []
            self.log(device_id, "sync", f"Pushed {pushed} point(s) to cloud",
                     {"pushed": pushed, "bytes": bytes_p, "conflicts": new_conflicts})
        # ---- PULL (cloud -> edge) ----
        for shard_name in SHARD_DEFS:
            cloud_st = self.cloud.shards[shard_name]
            dev_st = dev.shards[shard_name]
            cur_hash = cloud_st.manifest_hash()
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
                    conflict = {
                        "id": f"c-{pid[:8]}-{int(time.time()*1000)}",
                        "point_id": pid, "slug": cp.get("slug"), "shard": shard_name,
                        "local": {"text": local.get("text",""), "updated_at": local.get("updated_at"),
                                  "origin_device": device_id, "criticality": local.get("criticality")},
                        "remote": {"text": cp.get("text",""), "updated_at": c_updated,
                                   "origin_device": cp.get("origin_device"),
                                   "criticality": cp.get("criticality")},
                        "status": "open", "created_at": int(time.time()*1000),
                    }
                    dev.conflicts.append(conflict)
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
        pulled = 0; bytes_r = 0
        for shard_name in SHARD_DEFS:
            cloud_st = self.cloud.shards[shard_name]
            dev_st = dev.shards[shard_name]
            for cp in self.cloud.all_points(shard_name):
                pid = cp.get("_id")
                text = cp.get("text", "")
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
        self.log(device_id, "bootstrap", f"Bootstrapped device from cloud snapshot — {pulled} points pulled",
                 {"pulled": pulled, "bytes": bytes_r})
        return {"ok": True, "pulled": pulled, "bytes_pulled": bytes_r}

    def resolve_conflict(self, device_id: str, conflict_id: str, resolution: str, merged_text: Optional[str] = None) -> Dict[str, Any]:
        dev = self.devices[device_id]
        c = next((x for x in dev.conflicts if x["id"] == conflict_id), None)
        if not c:
            return {"ok": False, "reason": "not found"}
        pid = c["point_id"]; shard = c["shard"]
        if resolution == "local":
            chosen = c["local"]; text = chosen["text"]
        elif resolution == "remote":
            chosen = c["remote"]; text = chosen["text"]
        else:  # merge
            text = merged_text or c["local"]["text"]
            chosen = {**c["local"], "text": text}
        now = int(time.time() * 1000)
        payload = {
            "slug": c["slug"], "text": text, "shard": shard,
            "domain": c["shard"].rstrip("s") if c["shard"].endswith("s") else c["shard"],
            "criticality": chosen.get("criticality", "medium"),
            "sensitivity": "internal", "origin_device": device_id,
            "updated_at": now, "sync_state": "queued",
        }
        dense = embed.embed_dense(text); sparse = embed.embed_sparse_doc(text)
        dev.shards[shard].upsert(pid, dense, sparse, payload)
        dev.shards[shard].optimize()
        dev.synced_updated_at[pid] = now
        # also push resolved version to cloud
        self.cloud.shards[shard].upsert(pid, dense, sparse, payload)
        self.cloud.shards[shard].optimize()
        c["status"] = "resolved"; c["resolution"] = resolution
        dev.save_meta()
        self.log(device_id, "conflict", f"Conflict '{c['slug']}' resolved ({resolution}) and synced",
                 {"conflict_id": conflict_id, "resolution": resolution})
        return {"ok": True}
        self._invalidate_contrib()

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
        # remote members (no live shards)
        import time as _t
        for m in self.remote_members:
            devices.append({
                "id": m["id"], "name": m["name"], "location": m["location"],
                "technician": m["technician"], "online": True,
                "active": False, "live": False, "kind": m["kind"],
                "total_points": 0, "queue_depth": 0, "open_conflicts": 0,
                "last_sync_at": int(_t.time() * 1000) - m["last_sync_offset_min"] * 60000,
                "bytes_pushed": 0, "bytes_pulled": 0,
                "cloud_contributed": contrib.get(m["id"], 0),
                "shards": [],
            })
        cloud = self.cloud.memory_stats()
        return {"devices": devices, "cloud": cloud, "active_device": self.active_device}

    def search(self, device_id: str, shard: str, query: str, mode: str = "hybrid", limit: int = 5) -> Dict[str, Any]:
        dev = self.devices[device_id]
        st = dev.shards.get(shard)
        if not st:
            raise ValueError("unknown shard")
        t0 = time.perf_counter()
        results = st.search(mode, query, limit=limit)
        ms = (time.perf_counter() - t0) * 1000
        self.log(device_id, "search",
                 f"{'OFFLINE' if not dev.online else 'online'} {mode} search on {shard}: '{query[:40]}' → {len(results)} hits in {ms:.1f}ms",
                 {"shard": shard, "mode": mode, "latency_ms": round(ms, 2), "hits": len(results),
                  "offline": not dev.online})
        return {
            "results": results, "latency_ms": round(ms, 2),
            "offline": not dev.online, "mode": mode, "shard": shard,
        }

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
        return {"ok": True, "slug": slug, "shard": shard}
        self._invalidate_contrib()
