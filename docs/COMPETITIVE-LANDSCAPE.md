# Competitive landscape — EDGE.MEM

**As of 2026-09-29.** Data: [`competitive-landscape/landscape.csv`](competitive-landscape/landscape.csv) (one row per competitor, with source URLs, evidence type, confidence and `last_verified`). Validate and regenerate the matrix with `python3 docs/competitive-landscape/check.py [--matrix]`.

No competitor analysis existed in this repo before this file. Everything below was researched on 2026-09-29 from the sources listed in the CSV. It is a first pass: several cells are `?` on purpose (section 8).

## 1. Executive summary

1. **EDGE.MEM is an application on top of Qdrant Edge, not a vector database.** Its "competitors" are therefore (a) stacks a customer could assemble from an embedded DB plus a sync layer, (b) vertical field-service AI products that solve the same technician problem, and (c) Qdrant itself.
2. **The closest assembled rivals are Couchbase Lite + Sync Gateway and ObjectBox + Sync.** Both have on-device vector search and a commercial sync product, and both are more mature than anything here. Couchbase Lite also documents hybrid (vector + full-text) search.
3. **The one differentiator that holds up in code is residency:** a rule engine with a non-editable floor that stops `restricted` notes ever syncing, plus explicit conflict cards. **It is not yet proven unique.** Selective sync (Couchbase) and conflict handling (ObjectBox, Turso) were not examined deeply enough to rule out equivalents.
4. **Two new facts change the picture:** Actian launched VectorAI DB on 2026-04-28 aimed squarely at regulated, air-gapped edge (vendor claims: SOC 2 Type II, HIPAA, GDPR, ISO 27001), and MongoDB retired Atlas Device Sync on 2025-09-30 (per secondary sources; see section 9), orphaning Realm users.
5. **Commercial blockers are in this repo, not the market:** no LICENSE file, no auth/RBAC, and a dependency on Qdrant Edge, which the vendor still labels beta with no licensing terms on the pages reviewed.

## 2. Method and evidence rules

| Evidence tag | Meaning | Use externally? |
|---|---|---|
| `primary-page` | Vendor page or docs fetched and read on the date above | Yes, quote with date |
| `vendor-claim` | Vendor's own marketing or benchmark (e.g. "22x faster") | Only as "vendor claims" |
| `secondary` / `search-summary` | Third-party site or search-result summary; the vendor page was not read | No, verify first |
| `vendor-comparison` | A rival's blog about competitors (Actian on LanceDB/Chroma) | No, biased |
| `repo-verified` | Checked in this repository, with tests | Yes |

- **Capability cells:** `Y` means a source states it. `N` means a source states it is absent, or the product has no sync at all. `?` means **not stated in the sources reviewed, which is not the same as no.** `n.a.` means not applicable to that category.
- **No composite score.** The landscape gives capability facts and evidence quality only. Weighted scores would need weights the business hasn't set.
- **Staleness:** `check.py` fails a row whose `last_verified` is older than 90 days.
- **To update:** edit the CSV, run `check.py`, regenerate the matrix, and bump `last_verified` only for rows you re-read.

## 3. Who the competitors are

| Group | Members | Why they matter |
|---|---|---|
| **A. Assembled edge-sync stacks** (direct) | Couchbase Lite + Sync Gateway, ObjectBox + Sync, Turso, Actian VectorAI DB | A buyer can get on-device vector search plus sync without EDGE.MEM |
| **B. Embedded vector DBs, DIY sync** (substitutes) | LanceDB, Chroma, Milvus Lite, sqlite-vec | Free and popular; the customer builds sync, conflicts and policy |
| **C. Vertical field-service / connected-worker AI** (indirect) | Aquant, PTC ServiceMax AI, Siemens Industrial Copilot, Dozuki, Augmentir | Same user pain (technician needs answers), sold as SaaS. Aquant's page makes no offline claim; the others were not read at source |
| **D. Platform** | Qdrant Edge / Qdrant Cloud | Supplies the engine; can add sync policy or a console itself |
| **E. Displaced** | MongoDB Realm / Device Sync | Ended 2025-09-30; a segment looking for a replacement |

Not covered (add if the buyer conversation names them): Weaviate embedded, pgvector plus a sync layer such as ElectricSQL or PowerSync, AWS IoT Greengrass and Azure IoT Edge with local RAG, local-LLM RAG apps (AnythingLLM, Ollama-based), CMMS vendors with AI (Fiix, Limble).

## 4. Capability matrix (generated from the CSV)

| Competitor | on device vector | hybrid search | sync to server | selective sync control | conflict handling | ops console | Confidence |
|---|---|---|---|---|---|---|---|
| Qdrant Edge | Y | Y | Y | ? | ? | ? | High |
| Couchbase Lite + Sync Gateway / Capella App Services | Y | Y | Y | ? | ? | ? | Medium |
| ObjectBox (vector DB + Sync) | Y | ? | Y | ? | Y | ? | High |
| Turso (libSQL embedded replicas + vector) | Y | ? | Y | ? | Y | ? | High |
| MongoDB Atlas Device Sync / Realm | n.a. | n.a. | Ended: | n.a. | n.a. | n.a. | Medium |
| LanceDB | Y | Y | N | N | N | ? | Low-Medium |
| Chroma | Y | N | N | N | N | ? | Low |
| Milvus Lite | Y | Y | Manual | N | N | ? | High |
| sqlite-vec | Y | ? | N | N | N | ? | High |
| Actian VectorAI DB | Y | ? | ? | ? | ? | ? | Medium |
| Aquant | n.a. | n.a. | n.a. | n.a. | n.a. | Y | High |
| PTC ServiceMax AI | n.a. | n.a. | n.a. | n.a. | n.a. | ? | Low |
| Siemens Industrial Copilot | n.a. | n.a. | n.a. | n.a. | n.a. | ? | Low |
| Dozuki | n.a. | n.a. | n.a. | n.a. | n.a. | Y | Low |
| Augmentir | n.a. | n.a. | n.a. | n.a. | n.a. | Y | Low |
| EDGE.MEM (this project) | Y | Y | Y | Y | Y | Y | High |

Reading it: no competitor in this set is confirmed to offer all of on-device vector search, hybrid search, two-way sync, selective sync **and** conflict handling. That is a statement about what the sources reviewed say, not proof that no product does. The row for EDGE.MEM is checked against the repo; its `?`-free look reflects a hackathon-scope feature set, not maturity.

## 5. Pricing (verified figures only)

| Vendor | Model | Verified figures | Source quality |
|---|---|---|---|
| Turso | Tiered usage | Free $0 (5 GB, 500M reads, 10M writes, 3 GB syncs); Developer $4.99/mo; Scaler $24.92/mo; Pro $416.58/mo; Enterprise custom | Primary pricing page |
| Qdrant Cloud | Free tier, usage-based Standard, min-spend Premium, Hybrid/Private Cloud | Free = 0.5 vCPU / 1 GB RAM / 4 GB disk; Standard 99.5% SLA; Premium 99.9% SLA; no prices listed | Primary pricing page |
| ObjectBox | Free Apache-2.0 core, paid Sync | Sync price not published (contact sales) | Primary page |
| Actian VectorAI DB | Free Community Edition, 30-day trial, Enterprise | Commercial price not published | Press coverage |
| Couchbase | Capella per node-hour; Lite EE per licensed device | Per-hour figures seen only on aggregators, not verified | Unverified |
| LanceDB | OSS free, Cloud usage-based, Enterprise custom | Not verified on the vendor site | Search summary |
| Aquant, ServiceMax, Siemens, Dozuki, Augmentir | Enterprise SaaS | Not published | n.a. |

Pattern the evidence supports: free or open core, with money charged for sync, hosting or enterprise features. The metric varies: rows and synced GB (Turso), node-hours (Couchbase Capella), per licensed device (Couchbase Lite EE).

## 6. Where EDGE.MEM is differentiated, and where it is behind

**Differentiated (repo-verified; not contradicted by sources reviewed):**
- Residency as policy: an editable rule table on top of a hard floor for `restricted` data, enforced at push, resolve, export and import, with tests.
- Sync that never silently overwrites: one open conflict card per note; local, remote or 3-way merge; bootstrap keeps unsynced edits.
- Fleet visibility: a console for memory, search score breakdown, queue, conflicts and activity, plus federation across devices.
- Hybrid dense + BM25 on the device with a per-result score breakdown.

**Competitors are stronger:**
- **Maturity and support:** Couchbase, ObjectBox and Actian are companies with documented products. Actian claims compliance certifications; EDGE.MEM has none.
- **Platform reach:** native mobile and embedded SDKs (ObjectBox, Couchbase Lite). EDGE.MEM is a Python engine plus web console.
- **Price of entry:** Turso Free, sqlite-vec and Milvus Lite cost nothing and need no server.
- **Finished workflows:** Aquant ships conversational troubleshooting, voice, analytics and customer references.
- **Engine risk:** the vector engine is in beta at its vendor, and that vendor could add these layers.

## 7. Gaps and segments (hypotheses to validate, not findings)

| Hypothesis | Evidence so far | What would confirm it |
|---|---|---|
| Regulated or industrial sites want a *provable* "this data never leaves the device" control | The repo implements it; Actian's positioning stresses regulated/air-gapped and says it has no sync dependency (whether it offers sync at all is unverified) | 5 to 10 interviews with plant IT/OT or security leads; check Couchbase channels and Sync Gateway sync functions for an equivalent |
| Realm/Device Sync refugees need an edge-sync replacement | Retirement 2025-09-30 (secondary sources) | Size the affected apps; confirm EDGE.MEM can serve them (it has no mobile SDK today) |
| Field-service AI vendors lack offline, so offline-first retrieval is a wedge | Aquant page makes no offline claim; ServiceMax and Siemens pages not read | Read those product docs and sales material |
| Teams choosing DIY (Chroma, LanceDB, sqlite-vec) hit a wall on sync and conflicts | Those products have no built-in sync per the sources reviewed | Interview teams that adopted them |

## 8. Strategic implications

**Product (recommendations, ordered by what unblocks the rest):**
1. **Decide the license** (currently none) and read the Qdrant Edge terms for redistribution. Until then nothing here is commercially usable.
2. **Verify the residency differentiator against Couchbase channels and ObjectBox/Turso sync filtering** before making it the headline.
3. **Close the trust gap Actian is selling into:** authentication and roles (PRD S9), and an audit trail of what left the device. Certifications are a business decision; the audit trail is engineering.
4. **Reduce engine dependence:** keep the storage layer behind a narrow interface so a beta change or a Qdrant move doesn't strand the product.

**Positioning (assumption, needs your call):** "Offline knowledge memory for industrial sites where some notes must never leave the device." This claim is credible only after items 1 and 2 are done. Avoid "vector database" language; that is the ground of Qdrant, ObjectBox, Couchbase and Actian.

**Pricing (options, not a recommendation):** the market charges for sync, hosting or enterprise features over a free core. Candidate metrics: per device, per synced GB, per fleet. Choosing one needs your unit economics and buyer input, which this repo does not contain.

## 9. Unresolved, with exactly what to check

| # | Question | Where to look |
|---|---|---|
| 1 | Does Couchbase selective sync (channels / sync functions) match the residency guarantee? | Couchbase Sync Gateway docs |
| 2 | Does ObjectBox Sync carry vectors, and does ObjectBox support hybrid search? | ObjectBox docs / changelog |
| 3 | Qdrant Edge: licence, redistribution rights, and GA date | Qdrant Edge docs, GitHub, sales contact |
| 4 | MongoDB EOL date from MongoDB's own docs (primary pages returned 403/404) | mongodb.com docs / support |
| 5 | LanceDB: built-in sync? (claim came from a rival's blog) Chroma: hybrid and sync? | LanceDB and Chroma docs |
| 6 | Actian VectorAI DB: sync, hybrid search, real pricing; the 22x figure's benchmark method | Actian docs, sales |
| 7 | ServiceMax AI, Siemens Industrial Copilot, Dozuki, Augmentir: offline support and pricing | Vendor pages (fetch was blocked or only summaries were read) |
| 8 | Couchbase Capella and Lite EE real prices | couchbase.com/pricing |
| 9 | Customer segments and willingness to pay | Buyer interviews (no data in the repo) |
| 10 | The e2e audit was not re-run in this session, so the EDGE.MEM row rests on unit tests | Run `python3 tests/audit/audit.py` |

Rows tagged `Low` confidence in the CSV should not appear in any external document until re-read at source.
