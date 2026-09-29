"""Regression checks for sync correctness and offline-first resilience.

Reuses the stub harness from test_residency.py (no qdrant_edge / fastembed):

    python3 mini-services/edge-engine/tests/test_sync_integrity.py
"""
import json
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(__file__))
import shutil  # noqa: E402
from test_residency import engine, pid_of  # noqa: E402


engine.ShardStore.info = lambda self: types.SimpleNamespace(points_count=len(self.pts), segments_count=1)


def fresh():
    """A Fleet on an empty data dir (meta.json/activity.json persist between Fleets)."""
    shutil.rmtree(engine.DATA_DIR, ignore_errors=True)
    f = engine.Fleet()
    return f, f.active_device


def _cloud_put(f, shard, slug, text, origin="device-beta", updated_at=None):
    f.cloud.shards[shard].upsert(pid_of(slug), None, None, {
        "slug": slug, "text": text, "origin_device": origin,
        "updated_at": updated_at or int(time.time() * 1000)})


def _open(f, d):
    return [c for c in f.devices[d].conflicts if c["status"] == "open"]


def test_editing_a_pulled_note_is_not_a_conflict():
    """Pull beta's SOP, improve it, sync: that is the normal update path."""
    f, d = fresh()
    _cloud_put(f, "manuals", "shared-sop", "beta v1", updated_at=1000)
    f.sync(d)
    assert f.devices[d].shards["manuals"].pts[pid_of("shared-sop")]["text"] == "beta v1"
    f.write_point(d, "manuals", {"slug": "shared-sop"}, text="alpha improved")
    r = f.sync(d)
    assert r["new_conflicts"] == 0 and not _open(f, d), r
    assert f.cloud.shards["manuals"].pts[pid_of("shared-sop")]["text"] == "alpha improved"


def test_true_divergence_raises_exactly_one_conflict():
    """Cloud moved on after we last saw it AND we edited: one card, no dupes."""
    f, d = fresh()
    _cloud_put(f, "manuals", "sop", "beta v1", updated_at=1000)
    f.sync(d)
    f.write_point(d, "manuals", {"slug": "sop"}, text="alpha edit")
    _cloud_put(f, "manuals", "sop", "beta v2", updated_at=int(time.time() * 1000) + 5000)
    f.sync(d)
    assert len(_open(f, d)) == 1, _open(f, d)
    _cloud_put(f, "manuals", "sop", "beta v3", updated_at=int(time.time() * 1000) + 9000)
    f.sync(d)  # still unresolved: refresh the card, don't stack another
    cs = _open(f, d)
    assert len(cs) == 1 and cs[0]["remote"]["text"] == "beta v3", cs
    assert "alpha edit" in f.devices[d].shards["manuals"].pts[pid_of("sop")]["text"]


def test_bootstrap_never_overwrites_unsynced_local_edit():
    f, d = fresh()
    f.write_point(d, "manuals", {"slug": "sop"}, text="LOCAL-UNSYNCED")
    _cloud_put(f, "manuals", "sop", "cloud text", updated_at=1000)
    f.bootstrap(d)
    assert f.devices[d].shards["manuals"].pts[pid_of("sop")]["text"] == "LOCAL-UNSYNCED"
    assert len(_open(f, d)) == 1
    _cloud_put(f, "manuals", "fresh", "new from cloud", updated_at=1000)
    f.bootstrap(d)  # ids we do not hold still arrive
    assert pid_of("fresh") in f.devices[d].shards["manuals"].pts


def _break_cloud(f):
    def boom(*a, **k):
        raise ConnectionError("qdrant down")
    for st in f.cloud.shards.values():
        for m in ("upsert", "retrieve_payload", "manifest_hash", "scroll"):
            setattr(st, m, boom)
    f.cloud.memory_stats = boom
    f.cloud.all_points = boom


def test_cloud_outage_degrades_instead_of_erroring():
    f, d = fresh()
    f.write_point(d, "incidents", {"slug": "n1"}, text="offline note")
    ok = f.fleet_overview()
    _break_cloud(f)
    assert len(f.devices[d].queue) == 1
    r = f.sync(d)
    assert r["ok"] is False and "cloud" in r["reason"], r
    assert len(f.devices[d].queue) == 1, "queue must survive a failed sync"
    assert f.bootstrap(d)["ok"] is False
    # the console polls these; they must keep answering with the last known numbers
    ov = f.fleet_overview()
    assert ov["cloud"]["reachable"] is False and ov["devices"][0]["total_points"] == ok["devices"][0]["total_points"]
    assert f.cloud_stats()["reachable"] is False
    # local work is untouched
    f.write_point(d, "incidents", {"slug": "n2"}, text="still writing")
    assert len(f.devices[d].queue) == 2


def test_state_files_are_written_atomically():
    f, d = fresh()
    dev = f.devices[d]
    path = dev._meta_path()
    dev.save_meta()
    good = open(path).read()
    real_dump = json.dump

    def dying_dump(obj, fp, **kw):  # crash mid-write
        fp.write('{"queue": [')
        raise OSError("power cut")
    json.dump = dying_dump
    try:
        dev.save_meta()
    finally:
        json.dump = real_dump
    assert open(path).read() == good, "a torn write must not clobber meta.json"
    assert not [n for n in os.listdir(os.path.dirname(path)) if n.endswith(".tmp")]


def test_corrupt_shard_is_quarantined_not_deleted():
    import tempfile
    calls = []
    root = tempfile.mkdtemp()
    shard_dir = os.path.join(root, "manuals")
    os.makedirs(shard_dir)
    open(os.path.join(shard_dir, "wal"), "w").write("precious")

    class FakeEdge:
        @staticmethod
        def load(p):
            raise RuntimeError("bad segment")

        @staticmethod
        def create(p, cfg):
            calls.append(p)
            return object()
    real = (engine.EdgeShard, engine._new_config)
    engine.EdgeShard, engine._new_config = FakeEdge, lambda: None
    try:
        engine._open_or_create(shard_dir)
    finally:
        engine.EdgeShard, engine._new_config = real
    kept = [n for n in os.listdir(root) if n.startswith("manuals.corrupt-")]
    assert kept and open(os.path.join(root, kept[0], "wal")).read() == "precious", os.listdir(root)


def test_policy_survives_restart():
    f, _ = fresh()
    pol = json.loads(json.dumps(f.policy))
    pol["rules"].insert(1, {"id": "r-keep", "field": "criticality", "op": "eq", "value": "high",
                            "action": "local_only", "reason": "site rule"})
    f.set_policy(pol)
    g = engine.Fleet()  # same EDGE_DATA_DIR = a restart
    assert g.policy["rules"][1]["id"] != "r-keep"  # nothing is applied until main.py validates it
    assert g.restore_policy(lambda p: None)
    assert g.policy["rules"][1]["id"] == "r-keep", g.policy["rules"]
    h = engine.Fleet()
    assert not h.restore_policy(lambda p: "nope") and h.policy == engine.DEFAULT_POLICY


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok", name)
            except Exception as e:  # noqa: BLE001
                failed += 1
                print("FAIL", name, type(e).__name__, str(e)[:200])
    sys.exit(1 if failed else 0)
