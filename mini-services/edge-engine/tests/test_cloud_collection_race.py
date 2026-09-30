"""A fleet booting against a fresh Qdrant Server must survive the create race.

Every device creates the shared `edge-<shard>` collections at boot; exactly one
wins and the losers get HTTP 409. That used to crash the losing engine, which
is what took device-alpha down in CI:

    qdrant_client.http.exceptions.UnexpectedResponse: 409 (Conflict)
    Collection `edge-manuals` already exists!

Runs without qdrant_client / fastembed (stubbed):

    python3 mini-services/edge-engine/tests/test_cloud_collection_race.py
"""
import os
import sys
import types
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


class FakeUnexpectedResponse(Exception):
    """Stands in for qdrant_client.http.exceptions.UnexpectedResponse."""
    def __init__(self, status_code, content=b""):
        super().__init__(f"Unexpected Response: {status_code}")
        self.status_code = status_code
        self.content = content


for name in ("qdrant_client", "qdrant_client.http", "qdrant_client.http.models",
             "qdrant_client.http.exceptions", "embed"):
    sys.modules[name] = mock.MagicMock()
sys.modules["embed"].DENSE_DIM, sys.modules["embed"].SPARSE_NAME = 4, "text"
sys.modules["qdrant_client.http.exceptions"].UnexpectedResponse = FakeUnexpectedResponse

import cloud_qdrant as C  # noqa: E402


class RaceLoserClient:
    """collection_exists says no, then someone else wins before create lands."""
    def __init__(self, create_error):
        self.create_error = create_error
        self.creates = 0

    def collection_exists(self, name):
        return False

    def create_collection(self, **kw):
        self.creates += 1
        raise self.create_error


def test_losing_the_create_race_is_not_fatal():
    client = RaceLoserClient(FakeUnexpectedResponse(409, b"already exists"))
    shard = C.QdrantCloudShard(client, "manuals")  # must not raise
    assert client.creates == 1 and shard.collection == "edge-manuals"


def test_other_create_errors_still_surface():
    client = RaceLoserClient(FakeUnexpectedResponse(500, b"boom"))
    try:
        C.QdrantCloudShard(client, "manuals")
    except FakeUnexpectedResponse as e:
        assert e.status_code == 500
    else:
        raise AssertionError("a 500 must not be swallowed as 'already exists'")


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
