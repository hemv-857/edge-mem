"""The cloud manifest hash must notice writes made by *other* devices.

Runs without qdrant_client / fastembed (stubbed):

    python3 mini-services/edge-engine/tests/test_cloud_manifest.py
"""
import os
import sys
import time
import types
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for name in ("qdrant_client", "qdrant_client.http", "qdrant_client.http.models", "embed"):
    sys.modules[name] = mock.MagicMock()
sys.modules["embed"].DENSE_DIM, sys.modules["embed"].SPARSE_NAME = 4, "text"
import cloud_qdrant as C  # noqa: E402


class FakeClient:
    """One shared 'server' whose rows another process can change under us."""
    def __init__(self):
        self.rows = [("a", 1)]

    def collection_exists(self, name):
        return True

    def scroll(self, collection_name, limit, offset, with_payload, with_vectors):
        recs = [types.SimpleNamespace(id=i, payload={"updated_at": u}) for i, u in self.rows]
        return recs, None


def test_other_devices_writes_are_visible_to_a_forced_check():
    client = FakeClient()
    shard = C.QdrantCloudShard(client, "manuals")
    before = shard.manifest_hash()
    client.rows.append(("b", 2))  # device-beta, a different process, writes to the server
    assert shard.manifest_hash(fresh=True) != before, "sync must see another device's write"
    assert shard.manifest_hash() == shard.manifest_hash(), "polled stats stay cheap"


def test_polled_hash_expires():
    client = FakeClient()
    shard = C.QdrantCloudShard(client, "manuals")
    before = shard.manifest_hash()
    client.rows.append(("b", 2))
    shard._hash_at -= C.MANIFEST_TTL_S + 1
    assert shard.manifest_hash() != before


if __name__ == "__main__":
    for n, fn in list(globals().items()):
        if n.startswith("test_"):
            fn()
            print("ok", n)
