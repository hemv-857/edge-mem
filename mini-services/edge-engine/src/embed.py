"""Embedding models for the edge engine.

FastEmbed (dense, CPU-only, BAAI/bge-small-en-v1.5 -> 384 dims) + on-device BM25
(sparse). Both run fully offline inside the edge process — no inference service,
no network calls. This is the 'work without network access' requirement.
"""
from __future__ import annotations

import hashlib
import os
import threading
from typing import List

from fastembed import TextEmbedding
from huggingface_hub import snapshot_download
from qdrant_edge import Bm25, Bm25Config, SparseVector

DENSE_MODEL = "BAAI/bge-small-en-v1.5"
DENSE_DIM = 384
SPARSE_NAME = "text"  # name of the sparse vector field in every shard

# Pinned artifact for DENSE_MODEL (fastembed's HF source). fastembed would
# otherwise fetch the hub's latest revision into tempfile.gettempdir(), a
# shared dir any local user can pre-seed. Bump all three together.
DENSE_REPO = "Qdrant/bge-small-en-v1.5-onnx-Q"
DENSE_REVISION = "aa8f8b060edb00e03bfdd08813a2949946c8ba55"
DENSE_ONNX = "model_optimized.onnx"
DENSE_ONNX_SHA256 = "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431"
# same default as engine.DATA_DIR (not imported: engine imports this module)
MODEL_DIR = os.environ.get("EDGE_MODEL_DIR") or os.path.join(
    os.environ.get("EDGE_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")),
    "models")

_lock = threading.Lock()
_dense: TextEmbedding | None = None
_bm25: Bm25 | None = None


def _pinned_model_path() -> str:
    """Local snapshot of DENSE_REPO@DENSE_REVISION, onnx hash-checked."""
    kw = dict(repo_id=DENSE_REPO, revision=DENSE_REVISION, cache_dir=MODEL_DIR,
              allow_patterns=["*.json", "*.txt", DENSE_ONNX])
    try:
        path = snapshot_download(local_files_only=True, **kw)  # offline-first
    except Exception:  # noqa: BLE001 — not cached yet
        os.makedirs(MODEL_DIR, mode=0o700, exist_ok=True)
        path = snapshot_download(**kw)
    h = hashlib.sha256()
    with open(os.path.join(path, DENSE_ONNX), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != DENSE_ONNX_SHA256:
        raise RuntimeError(f"{DENSE_ONNX} in {path} does not match the pinned sha256")
    return path


def get_dense() -> TextEmbedding:
    global _dense
    if _dense is None:
        with _lock:
            if _dense is None:
                # lazy load — first call downloads/loads weights (~0.2s after cache)
                # threads=2 bounds onnxruntime memory/CPU on the edge device
                path = _pinned_model_path()
                _dense = TextEmbedding(model_name=DENSE_MODEL, cache_dir=MODEL_DIR,
                                       threads=2, specific_model_path=path)
    return _dense


def get_bm25() -> Bm25:
    global _bm25
    if _bm25 is None:
        with _lock:
            if _bm25 is None:
                _bm25 = Bm25(Bm25Config())
    return _bm25


def embed_dense(text: str) -> List[float]:
    vecs = list(get_dense().embed(text))
    return vecs[0].tolist()


def embed_dense_batch(texts: List[str]) -> List[List[float]]:
    return [v.tolist() for v in get_dense().embed(texts)]


def embed_sparse_doc(text: str) -> SparseVector:
    return get_bm25().embed_document(text)


def embed_sparse_query(text: str) -> SparseVector:
    return get_bm25().embed_query(text)
