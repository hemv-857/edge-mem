# EDGE.MEM

Offline-first knowledge engine for industrial edge devices: a local hybrid-search
memory (dense + BM25 sparse) that syncs to a shared Qdrant Server cloud, with
federation across real device processes.

The edge keeps working with no network; the cloud only adds synthesis
(LLM-assisted tagging and SOP distillation) and shared retrieval.

## What it does

- **Hybrid search offline** — dense (`BAAI/bge-small-en-v1.5`, 384d) + BM25 sparse
  fused with RRF, on the device — single-digit milliseconds p95 in the audit.
- **Payload filters + score breakdown** — filter on
  `domain / criticality / sensitivity / origin_device / sync_state / asset_id`,
  and see the dense/sparse/fused contribution per result.
- **Residency policy** — a rule engine decides per note whether it may leave the
  device (`synced`, `queued`, or `local_only`). Restricted notes never reach the
  cloud, and the audit asserts it.
- **Federation** — `device-alpha` (:3030) and `device-beta` (:3031) are separate
  engine processes with separate data dirs, probing each other live over
  `FEDERATED_PEERS`. A third member (`device-gamma`) is deliberately unreachable
  so the "peer down" state is exercised.
- **Cross-device snapshot handoff** — export/import a portable snapshot
  (`edge-mem-snapshot` v1) that preserves point ids, `origin_device` and
  timestamps, so re-importing your own snapshot raises zero conflicts.
- **Cloud browser** — browse, search and delete Qdrant Server collections from
  the Cloud tab.
- **Live metrics** — SSE stream of fleet metrics into the Metrics tab.
- **TTL retention** — raw sensor telemetry is swept against
  `policy.ttl_raw_sensor_seconds` by a background ticker on the engine's main
  thread.

## Architecture

```
  browser ──► Next.js (:3001) ── /api/edge/[...path]?XTransformPort=NNNN ──► edge-engine (:3030)
                                                                     │         device-alpha
                                                                     │              │
                                                                     │        FEDERATED_PEERS
                                                                     ▼              ▼
                                                          edge-engine (:3031) ◄──────┘
                                                          device-beta (own data dir)
                                                                     │
                       LLM_* (optional, online only)                │
  Next.js /api/intelligence ──► any OpenAI-compatible endpoint      │
                                                                     ▼
                                                       Qdrant Server (:6333)
                                                       edge-manuals / edge-incidents / edge-sensors
```

`mini-services/edge-engine` is a plain single-threaded `http.server`. That is
deliberate: the `qdrant_edge` Rust binding segfaults when driven from anything
other than the main thread doing sequential work — so there are no worker
threads, and the retention ticker runs from `HTTPServer.service_actions()`
between request batches.

## Quick start

Prerequisites: [bun](https://bun.sh), Python 3.13+, curl.

```bash
# 1. edge engine + Qdrant Server + the device-beta peer
./mini-services/edge-engine/start.sh
#    bootstraps ./.venv and ./.qdrant on first run, then serves :3030
#    (peer :3031, Qdrant :6333)

# 2. in another terminal: the UI
bun install
PORT=3001 bun run dev
```

Open http://localhost:3001. Caddy is optional — Next.js proxies `/api/edge`
itself, and the audit verifies the app works without the gateway.

Optional, for the online AI features only (distill → SOP, auto-tag):

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini \
  PORT=3001 bun run dev
```

Everything except distill/auto-tag works with no LLM and no network.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGE_PORT` | `3030` | Engine port |
| `EDGE_DEVICE` | `device-alpha` | Identity of this device |
| `EDGE_DATA_DIR` | `./data` | Local memory directory |
| `EDGE_PEER_PORT` | `3031` | Federated peer port |
| `EDGE_PEER_HOST` | `localhost` | Federated peer address — set to another host to federate across machines |
| `EDGE_FEDERATION_AUTO` | `1` | Spawn the peer locally (only when `EDGE_PEER_HOST` is `localhost`) |
| `EDGE_RETENTION_INTERVAL` | `15` | Background TTL sweep interval in seconds (`0` disables) |
| `FEDERATED_PEERS` | `device-beta=http://localhost:3031` | `name=url` pairs the fleet probes live |
| `QDRANT_URL` | `http://localhost:6333` | Cloud backend; falls back to an embedded store when unreachable |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI | Cloud synthesis only |
| `EDGE_TOKEN` | unset | Shared secret required as `X-Edge-Token` on every engine route but `/health`. Set the same value for both engines and the Next.js server |
| `EDGE_BIND` | `0.0.0.0` | Engine bind address — use `127.0.0.1` when you don't federate across hosts |
| `EDGE_PORTS` | `3030,3031` | Ports the Next.js proxy may forward `XTransformPort` to |

The engine binds `0.0.0.0` (reported as `bind` in `/api/edge/health`) so a peer
is reachable from another host. On anything but a trusted network set
`EDGE_TOKEN` (and/or `EDGE_BIND=127.0.0.1`). The engine sends no CORS headers and
only accepts `application/json` bodies, so other websites can't drive it from a
browser. See `docs/PRD.md` for the full security model.

## Testing

The whole statement is covered by one Playwright audit:

```bash
python3 tests/audit/audit.py            # 124 checks, exit 0 = all green
```

Screenshots land in `tests/audit/shots/`. It needs the engine and UI running,
plus `pip install playwright && playwright install chromium`.

**CI** (`.github/workflows/ci.yml`) runs three jobs on every push/PR:

| job | what |
| --- | --- |
| `lint` | `eslint .` |
| `typecheck` | `prisma generate` + `tsc --noEmit` (clean gate, 0 allowed errors) |
| `e2e audit` | boots Qdrant, both engines, `next dev`, and a stub LLM, then runs all 124 checks |

`tests/audit/fake_llm.py` is a deterministic OpenAI-compatible stub so CI does
not have to pull a local model; locally the audit uses whatever `LLM_*` points at.

## Repository layout

```
src/                          Next.js UI (tabs: Overview, Memory, Search, Sync, Metrics, Activity, Cloud, Policy)
  app/api/edge/               proxy + SSE relay to the engine
  components/edge/            one component per tab
mini-services/edge-engine/    the device runtime
  src/engine.py               fleet, shards, search, sync, policy, retention, snapshots
  src/main.py                 routes, health, background retention ticker
  src/cloud_qdrant.py         Qdrant Server store (embedded fallback)
  start.sh                    bootstraps venv + Qdrant + the device-beta peer
tests/audit/                  the 124-check Playwright audit + CI stub LLM
worklog.md                    per-task development log
```

## Notes

- Runtime state under `mini-services/edge-engine/data/` is committed so a fresh
  clone boots into the state the audit expects. `.qdrant/`, `.venv/` and audit
  screenshots are not.
- See `worklog.md` for the reasoning behind each stage.
