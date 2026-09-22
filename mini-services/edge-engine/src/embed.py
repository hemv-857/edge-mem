"""Embedding models for the edge engine.

FastEmbed (dense, CPU-only, BAAI/bge-small-en-v1.5 -> 384 dims) + on-device BM25
(sparse). Both run fully offline inside the edge process — no inference service,
no network calls. This is the 'work without network access' requirement.
"""
from __future__ import annotations

import threading
from typing import List

from fastembed import TextEmbedding
from qdrant_edge import Bm25, Bm25Config, SparseVector

DENSE_MODEL = "BAAI/bge-small-en-v1.5"
DENSE_DIM = 384
SPARSE_NAME = "text"  # name of the sparse vector field in every shard

_lock = threading.Lock()
_dense: TextEmbedding | None = None
_bm25: Bm25 | None = None


def get_dense() -> TextEmbedding:
    global _dense
    if _dense is None:
        with _lock:
            if _dense is None:
                # lazy load — first call downloads/loads weights (~0.2s after cache)
                # threads=2 bounds onnxruntime memory/CPU on the edge device
                try:
                    _dense = TextEmbedding(model_name=DENSE_MODEL, threads=2)
                except TypeError:
                    _dense = TextEmbedding(model_name=DENSE_MODEL)
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
