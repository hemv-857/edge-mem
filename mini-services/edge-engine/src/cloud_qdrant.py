"""Centralized cloud backend backed by a real Qdrant Server.

The edge devices keep their memory in embedded EdgeShards (offline-first); the
shared "cloud" is a separate Qdrant Server reached over HTTP by qdrant-client.
When the server cannot be reached the caller falls back to the embedded
EdgeShard CloudStore, so the demo still runs with no external process.

Each cloud shard maps to one collection named ``edge-<shard>`` holding a named
dense vector (bge-small-en-v1.5, 384d) plus the BM25 sparse vector under
``text`` — the same two fields EdgeShard stores, so payloads and point ids move
between the two backends unchanged.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

import embed

DENSE_DIM = embed.DENSE_DIM
SPARSE_NAME = embed.SPARSE_NAME
COLLECTION_PREFIX = "edge-"
DEFAULT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
DEFAULT_TIMEOUT = float(os.environ.get("QDRANT_TIMEOUT", "3"))


def _dir_size(path: str) -> int:
    """Real disk usage (st_blocks), not logical size — Qdrant preallocates
    sparse segment files that report tens of MB each on disk-like stat calls."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.stat(os.path.join(root, f)).st_blocks * 512
            except OSError:
                pass
    return total


def _to_sparse(s: Any) -> qm.SparseVector:
    if isinstance(s, qm.SparseVector):
        return s
    return qm.SparseVector(indices=[int(i) for i in s.indices],
                            values=[float(v) for v in s.values])


class ShardInfo:
    def __init__(self, points: int, segments: int, disk: int):
        self.points_count = points
        self.segments_count = segments
        self.disk_bytes = disk


class QdrantCloudShard:
    def __init__(self, client: QdrantClient, name: str, storage_root: str = ""):
        self.client = client
        self.name = name
        self.path = name
        self.collection = f"{COLLECTION_PREFIX}{name}"
        self._storage_root = storage_root
        self._hash: Optional[str] = None
        self._dirty = True
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        if self.client.collection_exists(self.collection):
            return
        self.client.create_collection(
            collection_name=self.collection,
            vectors_config=qm.VectorParams(size=DENSE_DIM, distance=qm.Distance.COSINE),
            sparse_vectors_config={
                SPARSE_NAME: qm.SparseVectorParams(index=qm.SparseIndexParams(on_disk=False)),
            },
        )

    # -- writes -------------------------------------------------------------
    def upsert(self, point_id: str, dense: List[float], sparse, payload: Dict[str, Any]) -> None:
        self.client.upsert(collection_name=self.collection, points=[
            qm.PointStruct(id=point_id, vector={"": dense, SPARSE_NAME: _to_sparse(sparse)},
                           payload=payload),
        ])
        self._dirty = True

    def optimize(self) -> None:
        # The server manages its own segments; nothing to do from the client.
        pass

    def flush(self) -> None:
        pass

    def delete_point(self, point_id: str) -> bool:
        try:
            self.client.delete(collection_name=self.collection,
                               points_selector=qm.PointIdsList(points=[point_id]))
            self._dirty = True
            return True
        except Exception:
            return False

    # -- reads --------------------------------------------------------------
    def count(self) -> int:
        return int(self.client.count(collection_name=self.collection, exact=True).count)

    def info(self) -> ShardInfo:
        i = self.client.get_collection(collection_name=self.collection)
        pts = i.points_count or 0
        segs = i.segments_count or 0
        root = self._disk_root()
        return ShardInfo(pts, segs, _dir_size(root) if root else 0)

    def _disk_root(self) -> str:
        if not self._storage_root:
            return ""
        return os.path.join(self._storage_root, "collections", self.collection)

    def retrieve_payload(self, point_id: str) -> Optional[Dict[str, Any]]:
        recs = self.client.retrieve(collection_name=self.collection,
                                    ids=[point_id], with_payload=True, with_vectors=False)
        if not recs:
            return None
        p = dict(recs[0].payload or {})
        p["_id"] = str(recs[0].id)
        return p

    def scroll(self, limit: int = 200, offset=None) -> Tuple[List[Any], Any]:
        recs, nxt = self.client.scroll(collection_name=self.collection, limit=limit,
                                       offset=offset, with_payload=True, with_vectors=False)
        return list(recs), nxt

    def search(self, mode: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """Cloud-side vector search — same three modes as the edge shards."""
        dense = embed.embed_dense(query)
        sparse = embed.embed_sparse_query(query)
        fields = ["slug", "text", "domain", "criticality", "sensitivity", "origin_device", "updated_at"]
        kw: Dict[str, Any] = {"collection_name": self.collection, "limit": limit,
                              "with_payload": fields}
        if mode == "sparse":
            kw["query"] = qm.NearestQuery(nearest=_to_sparse(sparse))
            kw["using"] = SPARSE_NAME
        elif mode == "dense":
            kw["query"] = dense
        else:
            kw["prefetch"] = [
                qm.Prefetch(query=qm.NearestQuery(nearest=dense), using="", limit=max(limit * 4, 20)),
                qm.Prefetch(query=qm.NearestQuery(nearest=_to_sparse(sparse)), using=SPARSE_NAME,
                            limit=max(limit * 4, 20)),
            ]
            kw["query"] = qm.RrfQuery(rrf=qm.Rrf(k=2))
        res = self.client.query_points(**kw)
        out = []
        for r in res.points:
            p = r.payload or {}
            out.append({"id": str(r.id), "score": round(float(r.score), 4),
                        "slug": p.get("slug"), "text": p.get("text", ""),
                        "domain": p.get("domain"), "criticality": p.get("criticality"),
                        "sensitivity": p.get("sensitivity"), "origin_device": p.get("origin_device"),
                        "updated_at": p.get("updated_at")})
        return out

    def manifest_hash(self) -> str:
        """Data-derived hash so manifest-diff pull notices cloud changes."""
        if self._hash is not None and not self._dirty:
            return self._hash
        rows: List[List[Any]] = []
        offset = None
        while True:
            recs, offset = self.client.scroll(collection_name=self.collection, limit=500,
                                              offset=offset, with_payload=["updated_at"],
                                              with_vectors=False)
            rows.extend([[str(r.id), (r.payload or {}).get("updated_at", 0)] for r in recs])
            if offset is None:
                break
        rows.sort()
        self._hash = hashlib.md5(json.dumps(rows, sort_keys=True).encode()).hexdigest()
        self._dirty = False
        return self._hash


class QdrantCloudStore:
    def __init__(self, client: QdrantClient, url: str, shard_names: List[str],
                 storage_root: str = ""):
        self.client = client
        self.url = url
        self.storage_root = storage_root
        self.shards: Dict[str, QdrantCloudShard] = {
            name: QdrantCloudShard(client, name, storage_root) for name in shard_names
        }

    def memory_stats(self) -> Dict[str, Any]:
        shards: Dict[str, Any] = {}
        total = 0
        for name, st in self.shards.items():
            i = st.info()
            total += i.points_count
            shards[name] = {"name": name, "points": i.points_count,
                            "segments": i.segments_count, "disk_bytes": i.disk_bytes,
                            "manifest_hash": st.manifest_hash()[:12]}
        return {"total_points": total, "shards": shards}

    def all_points(self, shard: str) -> List[Dict[str, Any]]:
        st = self.shards[shard]
        out: List[Dict[str, Any]] = []
        offset = None
        while True:
            recs, offset = st.scroll(limit=200, offset=offset)
            for r in recs:
                p = dict(r.payload or {})
                p["_id"] = str(r.id)
                out.append(p)
            if offset is None:
                break
        return out

    # -- admin surface used by the Cloud Collections browser --
    def search(self, shard: str, mode: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        return self.shards[shard].search(mode, query, limit=limit)

    def delete_point(self, shard: str, point_id: str) -> bool:
        return self.shards[shard].delete_point(point_id)


def _import_legacy(store: QdrantCloudStore, legacy: Any, log: Callable[[str], None]) -> None:
    """Seed an empty Qdrant Server from the embedded cloud shards, once."""
    for name, dst in store.shards.items():
        src = legacy.shards.get(name)
        if src is None:
            continue
        if dst.count() > 0:
            continue
        pts = legacy.all_points(name)
        if not pts:
            continue
        for p in pts:
            pid = p.pop("_id")
            dense = embed.embed_dense(p.get("text", ""))
            sparse = embed.embed_sparse_doc(p.get("text", ""))
            dst.upsert(pid, dense, sparse, p)
        log(f"[cloud] imported {len(pts)} legacy point(s) into qdrant collection {dst.collection}")


def build_cloud_store(legacy_factory: Callable[[], Any], shard_names: List[str],
                      log: Callable[[str], None] = print) -> Any:
    """Return a Qdrant Server-backed store, or the embedded fallback.

    Ponytail: connection health is checked once at boot — the server dropping
    later surfaces as a normal request error rather than a silent mid-run
    backend swap.
    """
    url = os.environ.get("QDRANT_URL", DEFAULT_URL)
    try:
        client = QdrantClient(url=url, timeout=DEFAULT_TIMEOUT)
        client.get_collections()
    except Exception as e:  # noqa: BLE001
        log(f"[cloud] Qdrant Server unreachable at {url} ({type(e).__name__}) — "
            f"using embedded EdgeShard cloud")
        return legacy_factory()
    storage_root = os.environ.get("QDRANT_STORAGE", "")
    store = QdrantCloudStore(client, url, shard_names, storage_root)
    try:
        _import_legacy(store, legacy_factory(), log)
    except Exception as e:  # noqa: BLE001
        log(f"[cloud] legacy import skipped: {e}")
    log(f"[cloud] backed by Qdrant Server at {url}")
    return store
