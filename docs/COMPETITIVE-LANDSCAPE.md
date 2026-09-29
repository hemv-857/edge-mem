# Edge.Mem — Competitive Landscape & Upgrade Plan

Research date: Sep 2026 (GitHub + web, ~20 queries, star counts verified live).

**Edge.Mem reference features:** offline-first hybrid search on-device (384d `BAAI/bge-small-en-v1.5` dense + BM25 sparse, RRF fusion, ms p95 on CPU, no network) · Qdrant Edge Rust local storage syncing to Qdrant Server · payload filters + per-result score breakdown · per-note residency policy (`synced` / `queued` / `local_only`, restricted never leaves device) · device federation (peer probing) + cross-device snapshot handoff · TTL retention of raw telemetry · cloud OpenAI-compatible LLM for online-only synthesis (incident → SOP, auto-tag) · memory explorer UI + SSE live metrics.

---

## Landscape

### Group A — closest overlap

| Product | What it does | Gap vs Edge.Mem |
|---|---|---|
| [Qdrant Edge](https://qdrant.tech/edge) (OSS β, Apache lineage) | Our substrate: ~11MB in-process Rust shard, dense + BM25, snapshot sync to Qdrant Server | **No query-time fusion, no embedding, no residency policy, no federation, no TTL** — we fill real holes |
| [ObjectBox](https://objectbox.io) (OSS ~4.6k★ + paid Sync) | On-device DB + vector search + bidirectional offline-first sync, field-service focus | No BM25/RRF hybrid, no memory layer, no P2P federation/snapshot handoff |
| [EdgeVDB](https://github.com/XformAI/EDGEVDB) (5★, Apache) | Embedded C++: HNSW + hybrid vector∪BM25 with RRF fusion + KG + LWW multi-device sync | No residency policy, no TTL, no LLM — very early stage |
| [Endee Edge](https://endee.io/products/endee-edge) | Air-gapped on-device vector DB, <5ms, Int8e 4× compression, ARM/Pi/Jetson targets | No memory/knowledge model, no sync/federation on Edge tier |
| [agentmemory](https://github.com/rohitg00/agentmemory) (29k★, Apache) | BM25 + vector + KG fused via RRF, 4-tier consolidation, auto-capture, local mode | Desktop/server-shaped; no edge residency, no federation |
| [Awareness-Local](https://github.com/edwin-hao-ai/Awareness-Local) (199★, MIT) | Local-first memory daemon: FTS5 + embedding hybrid RRF, dashboard, optional sync | Single machine; no per-note residency, no TTL semantics |

### Group B — partial overlap

- **Memory engines (server-shaped):** mem0 (~58k★), Supermemory (~26k★), Hindsight (~16k★), Graphiti/Zep (~27k★), [Khoj](https://github.com/khoj-ai/khoj) (~37k★, AGPL, offline-capable), [RAGFlow](https://ragflow.io) (~90k★, industrial-maintenance template)
- **[PowerSync](https://docs.powersync.com/usage/sync-rules)** — declarative per-row sync rules + offline outbox queue: the closest *shipping* residency engine, but no vector/memory layer
- **[vstash (arXiv 2604.15484)](https://arxiv.org/abs/2604.15484)** — research: single SQLite, sqlite-vec + FTS5, IDF-weighted adaptive RRF, refined BGE-small; verified 20.9ms @50k — our exact retrieval stack, no sync/residency
- **Sovereign on-prem RAG** (Sphere Knowledge AI, Cohesity Gaia, SovraRAG) — air-gapped compliance posture, datacenter-scoped

### Group C — adjacent

- AnythingLLM (~60k★, MIT), Open WebUI (~146k★) — offline local AI workspaces, server-shaped
- Offline field-service FSM (FieldAware, Dynamics 365 Field Service) — the problem domain itself; offline caches but no vector memory or policy
- Local-first sync primitives (crdt-kit, ElectricSQL, Automerge/Yjs, Syncthing) — transport only; confirmed no search/memory/AI layer
- Obsidian local vector plugins — consumer-scale hybrid search, hobby-grade

---

## Verdict

The **components** are brutally crowded (embedded vector stores, offline AI apps, agent-memory engines at 16k–90k★). The **intersection** is effectively empty: enforced per-note residency (synced/queued/local_only) + device federation with peer probing + portable snapshot handoff + TTL telemetry + online-only LLM distill on top of hybrid edge search. Sync players ship no vector layer; memory players ship no edge policy layer. Qdrant's own docs push fusion to application code — our RRF/score-breakdown and residency layers are not redundant with the substrate.

**Honest risk:** thin moat — Qdrant could ship first-party sync+policy on Edge, ObjectBox could add BM25. Defensible ground = the residency/federation **policy model** + industrial UX, not the search math (commodity by 2026).

---

## Best things to take

| From | Take | Becomes | Effort |
|---|---|---|---|
| PowerSync | Declarative sync rules + durable outbox queue with retry/backoff | Formalize residency as a YAML policy DSL + durable queued-state outbox (today: in-process) | M |
| EdgeVDB | Tombstone/deletion propagation in sync | Deletes via snapshot/federation actually propagate | S |
| vstash (arXiv) | IDF-weighted adaptive RRF instead of plain RRF(k=2) | Better ranking for free; score breakdown shows the weights | S |
| RAGFlow | PDF/manual ingestion pipeline + weighted fusion/rerank option | Upload equipment manuals → chunk → hybrid index (today: seeded only) | M |
| agentmemory | 4-tier memory consolidation | Replace "TTL sweep = delete" with consolidate → distill → archive (old telemetry becomes summaries) | M |
| mem0 / Hindsight | Extract/distill pipeline, entity + temporal retrieval | Temporal facets + asset-entity links between notes | M |
| Endee | Int8 quantization (4× memory) + Pi/Jetson benchmarks | Run on 1GB SBCs; publish our own p95 numbers | M |
| agentmemory | Auto-capture hooks | MQTT/syslog → notes, no human in the loop | M |
| Sovereign RAG (Sphere) | Query audit log + permission inheritance | Phase 2 compliance set alongside SSO | S |
| CRDT kit / Syncthing | Encrypted P2P snapshot transfer | Federation link carries signed/encrypted snapshots | M |
| vstash | Self-supervised embedder fine-tune on domain text | Domain-adapt bge-small with our maintenance corpus | L |

## How we stack up

**Ours:** only product combining hybrid edge search + enforced residency + federation + snapshot handoff + TTL + online-only LLM; on-device latency is the product.
**Ours lacking:** declarative/durable sync semantics (PowerSync-class), fusion quality (plain RRF), ingestion (PDF manuals), memory lifecycle (consolidation vs raw sweep), published hardware benchmarks (Endee-class).

## Upgrade priority

- **P0** — declarative residency DSL + durable outbox + tombstone propagation (*this is the moat*)
- **P0** — IDF-weighted adaptive RRF (one-function change, measurable lift)
- **P1** — manual/PDF ingestion pipeline, memory consolidation lifecycle, auto-capture hooks
- **P1** — quantized vectors + published SBC benchmarks (differentiator vs Endee)
- **P2** — encrypted snapshot transfer, query audit log, entity/temporal search, domain fine-tune of embedder
- **Phase 2 (shared with ImpactLens)** — SSO/RBAC + audit log + public API; build once, share patterns
