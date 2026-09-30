# EDGE.MEM

EDGE.MEM is an offline-first knowledge engine for industrial edge devices. Each
device keeps a local hybrid-search memory (dense vectors plus BM25 sparse) and
syncs it to a shared Qdrant Server in the cloud. Devices run as separate
processes and federate with each other.

A device keeps working with no network. The cloud adds shared retrieval and
LLM-assisted synthesis (tagging and SOP distillation), but nothing on the device
depends on it.

## Demo, pitch deck and business model

- [Demo video](https://drive.google.com/file/d/1jMHn4Do94CLMi2uxqPao-_Qm_owcWabR/view?usp=sharing) (MP4, Google Drive)
- [Pitch deck](https://drive.google.com/file/d/19Dq-LhxoTzhdAWAs9wkoQ8rvZzI6v5tJ/view?usp=sharing) (PDF, Google Drive)
- [All submission files](https://drive.google.com/drive/folders/1I1GbZSiF2JqdgyWjbx2ADoYsJBNrOhVD?usp=sharing): video, deck and both workbooks in one Drive folder

The pricing and go-to-market analysis lives in two workbooks. Copies are in
`docs/`, and shared versions are on Google Sheets:

| Workbook | Contents |
| --- | --- |
| [EDGE-MEM GTM & Pricing Model](https://docs.google.com/spreadsheets/d/1lht8Na3XLH8lEV1ANUAuHjHokqn2clf3/edit?usp=sharing&ouid=114034518876045891640&rtpof=true&sd=true) | Executive summary, ICP and segmentation, GTM strategy, pricing, revenue model, competitive positioning, assumptions and sources, open items |
| [EDGE-MEM Pricing Model](https://docs.google.com/spreadsheets/d/1LUUssD1v0ntksp3xJv4yC4-XU3ww6u1A/edit?usp=sharing&ouid=114034518876045891640&rtpof=true&sd=true) | EdgeMem pricing sheet |

`docs/COMPETITIVE-LANDSCAPE.md` compares EDGE.MEM with the alternatives.

## Features

- Offline hybrid search. Dense embeddings (`BAAI/bge-small-en-v1.5`, 384
  dimensions) and BM25 sparse vectors are fused with RRF on the device. The
  audit measures p95 latency in single-digit milliseconds.
- Payload filters on `domain`, `criticality`, `sensitivity`, `origin_device`,
  `sync_state` and `asset_id`. Each result shows its dense, sparse and fused
  scores.
- A residency policy. A rule engine decides whether each note may leave the
  device (`synced`, `queued` or `local_only`). Restricted notes never reach the
  cloud, and the audit checks this.
- Federation. `device-alpha` (:3030) and `device-beta` (:3031) are separate
  engine processes with their own data directories, and they probe each other
  over `FEDERATED_PEERS`. A third member, `device-gamma`, is unreachable on
  purpose so the "peer down" state gets exercised.
- Snapshot handoff between devices. A portable snapshot (`edge-mem-snapshot` v1)
  keeps point IDs, `origin_device` and timestamps, so re-importing your own
  snapshot produces no conflicts.
- A cloud browser in the Fleet tab for browsing, searching and deleting Qdrant
  Server collections.
- Live fleet metrics, streamed over SSE to the Activity tab.
- TTL retention. A background ticker on the engine's main thread deletes raw
  sensor telemetry older than `policy.ttl_raw_sensor_seconds`.

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

`mini-services/edge-engine` is a single-threaded `http.server`. The `qdrant_edge`
Rust binding segfaults unless the main thread drives it with sequential work, so
the engine has no worker threads. The retention ticker runs from
`HTTPServer.service_actions()` between request batches.

## Quick start

You need [bun](https://bun.sh), Python 3.13 or later, and curl.

```bash
# 1. edge engine + Qdrant Server + the device-beta peer
./mini-services/edge-engine/start.sh
#    bootstraps ./.venv and ./.qdrant on first run, then serves :3030
#    (peer :3031, Qdrant :6333)

# 2. in another terminal: the UI
bun install
PORT=3001 bun run dev
```

Open http://localhost:3001. Caddy is optional because Next.js proxies
`/api/edge` itself, and the audit checks that the app works without the gateway.

The online AI features (distill to SOP, auto-tag) need an OpenAI-compatible
endpoint:

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini \
  PORT=3001 bun run dev
```

Everything else works with no LLM and no network.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGE_PORT` | `3030` | Engine port |
| `EDGE_DEVICE` | `device-alpha` | Identity of this device |
| `EDGE_DATA_DIR` | `./data` | Local memory directory |
| `EDGE_PEER_PORT` | `3031` | Federated peer port |
| `EDGE_PEER_HOST` | `localhost` | Federated peer address. Set it to another host to federate across machines |
| `EDGE_FEDERATION_AUTO` | `1` | Spawn the peer locally (only when `EDGE_PEER_HOST` is `localhost`) |
| `EDGE_RETENTION_INTERVAL` | `15` | Seconds between background TTL sweeps (`0` disables them) |
| `EDGE_AUTOSYNC_INTERVAL` | `0` (off) | Seconds between headless sync attempts for any online device with a queue. Failures back off (×2, up to 10 min). When off, sync runs only from the console or `POST /sync` |
| `QDRANT_MANIFEST_TTL` | `30` | Seconds a polled cloud manifest hash is reused. Sync always re-reads it, so it sees other devices' writes |
| `FEDERATED_PEERS` | `device-beta=http://localhost:3031` | `name=url` pairs the fleet probes |
| `QDRANT_URL` | `http://localhost:6333` | Cloud backend. Falls back to an embedded store when unreachable |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI | Cloud synthesis only |
| `EDGE_TOKEN` | unset | Shared secret, sent as `X-Edge-Token`, required on every engine route except `/health`. Use the same value for both engines and the Next.js server |
| `EDGE_BIND` | `0.0.0.0` | Engine bind address. Use `127.0.0.1` if you don't federate across hosts |
| `EDGE_PORTS` | `3030,3031` | Ports the Next.js proxy may forward `XTransformPort` to |
| `EDGE_ALLOWED_HOSTS` | unset | Extra `Host` names or IPs (comma-separated, no port) the engine accepts besides `localhost`, `127.0.0.1`, `[::1]` and `EDGE_BIND` |

## Security

The engine binds `0.0.0.0` by default, reported as `bind` in
`/api/edge/health`, so a peer on another host can reach it. On an untrusted
network, set `EDGE_TOKEN`, `EDGE_BIND=127.0.0.1`, or both.

The engine sends no CORS headers and only accepts `application/json` bodies. It
returns 403 on every route except `/health` unless the `Host` header is
loopback, `EDGE_BIND`, or listed in `EDGE_ALLOWED_HOSTS`. Other websites
therefore can't drive it from a browser, even through DNS rebinding. If you
reach an engine by a LAN name or IP (for example a cross-host peer probed at
`http://192.168.1.50:3031`, or Caddy forwarding the browser's `Host`), add that
name to `EDGE_ALLOWED_HOSTS` on that engine.

The engine drops connections that sit idle for 10 seconds. It rejects a policy
update unless the first rule a `restricted` note can match keeps that note
`local_only`. `docs/PRD.md` describes the full security model.

## Testing

The engine unit tests run fast and need no models, Qdrant or Playwright;
`qdrant_edge`, `fastembed` and `qdrant_client` are stubbed:

```bash
for t in mini-services/edge-engine/tests/test_*.py; do python3 "$t"; done
```

They cover the residency floor, sync and conflict integrity (no false or
duplicate conflicts, and bootstrap never overwrites an unsynced edit), behaviour
during a cloud outage, atomic state files, policy persistence, cross-device
manifest freshness and the HTTP surface.

A Playwright audit covers the full problem statement:

```bash
python3 tests/audit/audit.py            # 124 checks, exit 0 = all green
```

The audit needs the engine and UI running, plus
`pip install playwright && playwright install chromium`. It saves screenshots
to `tests/audit/shots/`.

CI (`.github/workflows/ci.yml`) runs four jobs on every push and pull request:

| Job | What it runs |
| --- | --- |
| `engine-unit` | The Python unit tests above |
| `lint` | `eslint .` |
| `typecheck` | `prisma generate` and `tsc --noEmit` (no errors allowed) |
| `e2e audit` | Starts Qdrant, both engines, `next dev` and a stub LLM, then runs all 124 checks |

`tests/audit/fake_llm.py` is a deterministic OpenAI-compatible stub, so CI
doesn't need to pull a local model. Run locally, the audit uses whatever the
`LLM_*` variables point at.

## Repository layout

```
src/                          Next.js UI (tabs: Home, Search, Knowledge, Sync, Fleet, Policy, Activity)
  app/api/edge/               proxy + SSE relay to the engine
  components/edge/            tab components and shared UI primitives
mini-services/edge-engine/    the device runtime
  src/engine.py               fleet, shards, search, sync, policy, retention, snapshots
  src/main.py                 routes, health, background retention ticker
  src/cloud_qdrant.py         Qdrant Server store (embedded fallback)
  start.sh                    bootstraps venv + Qdrant + the device-beta peer
tests/audit/                  the 124-check Playwright audit + CI stub LLM
docs/                         PRD, competitive landscape, pricing and GTM workbooks
worklog.md                    per-task development log
```

## Notes

- Runtime state under `mini-services/edge-engine/data/` is committed, so a fresh
  clone starts in the state the audit expects. `.qdrant/`, `.venv/`, audit
  screenshots and the admin's `policy.json` are not committed.
- Offline provisioning: on first boot the engine downloads the pinned embedding
  model into `EDGE_MODEL_DIR` (default `data/models`). A device that has never
  been online needs that directory copied onto it, or a prebuilt image. After
  that it starts and searches with no network.
- The console keeps working when the cloud is down. Cloud counts show the last
  known values and the Fleet tab reports the cloud as unreachable. Sync,
  bootstrap and resolve fail cleanly, leave the queue intact, and the console
  says so.
- `worklog.md` explains the reasoning behind each stage.
