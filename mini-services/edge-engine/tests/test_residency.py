"""Regression checks for the Phase 1 residency / sync-integrity fixes.

Runs without qdrant_edge or fastembed: those modules are stubbed and the
EdgeShard wrapper is swapped for an in-memory dict.

    python3 mini-services/edge-engine/tests/test_residency.py
"""
import http.server
import os
import sys
import tempfile
import threading
import time
import types
import uuid

SRC = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, SRC)
os.environ["EDGE_DATA_DIR"] = tempfile.mkdtemp(prefix="edge-mem-test-")
os.environ.pop("QDRANT_URL", None)
os.environ.pop("FEDERATED_PEERS", None)

qe = types.ModuleType("qdrant_edge")
qe.__getattr__ = lambda name: type(name, (), {})
sys.modules["qdrant_edge"] = qe
emb = types.ModuleType("embed")
emb.DENSE_DIM, emb.SPARSE_NAME = 4, "bm25"
emb.embed_dense = lambda t: [0.0] * 4
emb.embed_sparse_doc = emb.embed_sparse_query = lambda t: None
sys.modules["embed"] = emb
cq = types.ModuleType("cloud_qdrant")
cq.build_cloud_store = lambda cls, names: cls()
sys.modules["cloud_qdrant"] = cq

import engine  # noqa: E402


class FakeShard:
    def __init__(self, name, path):
        self.name, self.path, self.pts = name, path, {}

    def upsert(self, pid, dense, sparse, payload):
        self.pts[pid] = dict(payload)

    def retrieve_payload(self, pid):
        return dict(self.pts[pid], _id=pid) if pid in self.pts else None

    def scroll(self, limit=20, offset=None, flt=None):
        return [types.SimpleNamespace(id=k, payload=dict(v)) for k, v in self.pts.items()], None

    def delete_point(self, pid):
        return self.pts.pop(pid, None) is not None

    def optimize(self): pass
    def flush(self): pass
    def manifest_hash(self, fresh=False): return str(sorted((k, v.get("updated_at")) for k, v in self.pts.items()))


engine.ShardStore = FakeShard
pid_of = lambda slug: str(uuid.uuid5(uuid.NAMESPACE_URL, slug))


def fresh():
    f = engine.Fleet()
    return f, f.active_device


def test_resolve_conflict_keeps_restricted_local():
    f, d = fresh()
    f.write_point(d, "manuals", {"slug": "sop", "sensitivity": " Restricted "}, text="RESTRICTED-CANARY")
    pid = pid_of("sop")
    assert f.devices[d].shards["manuals"].pts[pid]["sensitivity"] == "restricted"
    f.cloud.shards["manuals"].upsert(pid, None, None, {"slug": "sop", "text": "beta edit",
                                     "origin_device": "device-beta", "updated_at": int(time.time() * 1000) + 1000})
    f.sync(d)
    cs = [c for c in f.devices[d].conflicts if c["status"] == "open"]
    assert len(cs) == 1 and "CANARY" in cs[0]["local"]["text"]
    r = f.resolve_conflict(d, cs[0]["id"], "local")
    assert r == {"ok": True, "synced": False}, r
    assert "CANARY" not in f.cloud.shards["manuals"].pts[pid]["text"]
    assert f.devices[d].shards["manuals"].pts[pid]["sensitivity"] == "restricted"
    assert f.resolve_conflict(d, cs[0]["id"], "local")["ok"] is False  # no replay
    f.sync(d)  # the remote version we chose to ignore must not re-raise
    assert not [c for c in f.devices[d].conflicts if c["status"] == "open"]


def test_resolve_conflict_offline_does_not_touch_cloud():
    f, d = fresh()
    f.write_point(d, "manuals", {"slug": "shared"}, text="alpha text")
    pid = pid_of("shared")
    f.cloud.shards["manuals"].upsert(pid, None, None, {"slug": "shared", "text": "beta",
                                     "origin_device": "device-beta", "updated_at": 1})
    f.sync(d)
    cid = f.devices[d].conflicts[-1]["id"]
    f.set_connectivity(d, False)
    assert f.resolve_conflict(d, cid, "local")["ok"] is False
    assert f.cloud.shards["manuals"].pts[pid]["text"] == "beta"


def test_sync_push_rechecks_current_point_and_policy():
    f, d = fresh()
    f.set_connectivity(d, False)
    # (a) reclassified to restricted while queued
    f.write_point(d, "incidents", {"slug": "reclass", "sensitivity": "internal"}, text="CANARY-A")
    f.write_point(d, "incidents", {"slug": "reclass", "sensitivity": "restricted"}, text="CANARY-A")
    # (b) policy tightened while queued
    f.write_point(d, "incidents", {"slug": "pol", "sensitivity": "confidential"}, text="CANARY-B")
    f.policy["rules"].insert(0, {"id": "r0", "field": "sensitivity", "op": "in", "values": ["confidential"],
                                 "action": "local_only", "reason": "x"})
    # (c) deleted while queued
    f.write_point(d, "incidents", {"slug": "gone"}, text="CANARY-C")
    f.delete_point(d, "incidents", pid_of("gone"))
    # a normal note still syncs, once, at its latest version
    f.write_point(d, "incidents", {"slug": "ok"}, text="v1")
    f.write_point(d, "incidents", {"slug": "ok"}, text="v2")
    assert len(f.devices[d].queue) == 2  # deduped; reclass + gone dropped
    f.set_connectivity(d, True)
    f.sync(d)
    cloud = f.cloud.shards["incidents"].pts
    for slug in ("reclass", "pol", "gone"):
        assert pid_of(slug) not in cloud, slug
    assert cloud[pid_of("ok")]["text"] == "v2"


def test_policy_cannot_unfloor_restricted():
    f, _ = fresh()
    f.policy["rules"] = [r for r in f.policy["rules"] if r["id"] != "r1"]
    assert engine.evaluate_policy({"sensitivity": "RESTRICTED"}, f.policy)["sync_state"] == "local_only"
    assert engine.evaluate_policy({"sensitivity": "restricted"}, engine.DEFAULT_POLICY)["matched_rule"] == "r1"


def test_export_holds_back_restricted_even_if_tagged_synced():
    f, d = fresh()
    f.devices[d].shards["manuals"].upsert("x", None, None, {"text": "t", "sensitivity": "restricted",
                                                            "sync_state": "queued"})
    snap = f.export_snapshot(d)
    assert snap["point_count"] == 0 and snap["excluded_local_only"] == 1


def test_import_never_overwrites_and_stamps_time():
    f, d = fresh()
    f.write_point(d, "manuals", {"slug": "mine"}, text="original")
    pid = pid_of("mine")
    snap = {"format": "edge-mem-snapshot", "device": "device-beta", "shards": {"manuals": [
        {"_id": pid, "text": "original"},
        {"_id": pid, "text": "FORGED", "updated_at": 1, "origin_device": "device-beta"},
        {"_id": "beta-id", "text": "PROBE", "updated_at": 42, "origin_device": "device-beta"},
        "junk",
    ]}}
    r = f.import_snapshot(d, snap)
    assert (r["unchanged"], r["conflicts"], r["skipped"]) == (1, 1, 1), r
    assert f.devices[d].shards["manuals"].pts[pid]["text"] == "original"
    assert f.devices[d].shards["manuals"].pts["beta-id"]["updated_at"] != 42
    # the forged-timestamp point can't silently overwrite beta's cloud copy
    f.cloud.shards["manuals"].upsert("beta-id", None, None, {"text": "beta original", "origin_device": "device-beta",
                                                             "updated_at": 42})
    before = len(f.devices[d].conflicts)
    f.sync(d)
    assert f.cloud.shards["manuals"].pts["beta-id"]["text"] == "beta original"
    assert len(f.devices[d].conflicts) == before + 1


def _serve(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_peer_probe_is_bounded():
    seen = []

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def do_GET(self):
            seen.append(self.headers.get("X-Edge-Token"))
            if self.path.startswith("/trickle"):
                self.send_response(200); self.send_header("Content-Length", "10"); self.end_headers()
                try:
                    for _ in range(10):
                        self.wfile.write(b" "); self.wfile.flush(); time.sleep(1)
                except BrokenPipeError:
                    pass  # the probe gave up, as it should
            elif self.path.startswith("/big"):
                self.send_response(200); self.end_headers(); self.wfile.write(b" " * 200000)
            else:
                self.send_response(302); self.send_header("Location", "/big"); self.end_headers()

    srv, base = _serve(H)
    for path in ("/trickle", "/big", "/redirect"):
        t0 = time.monotonic()
        try:
            engine.fetch_peer_json(base + path)
            raise AssertionError(path + " should fail")
        except AssertionError:
            raise
        except Exception:
            pass
        assert time.monotonic() - t0 < 3, path
    assert len(seen) == 3  # the redirect was not followed
    srv.shutdown()
    assert engine.peer_gets_token("http://127.0.0.1:3031")
    assert engine.peer_gets_token("https://peer.example")
    assert not engine.peer_gets_token("http://10.0.0.5:3031")


def test_peer_entry_is_typed():
    e = engine.clean_peer_entry({"total_points": "9" * 9, "queue_depth": -1, "shards": "x", "online": False})
    assert e["total_points"] == 0 and e["queue_depth"] == 0 and e["shards"] == [] and e["online"] is False
    assert engine.clean_peer_entry(["nope"]) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
