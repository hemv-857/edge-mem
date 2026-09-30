# EDGE.MEM — Product Requirements

## Problem
Field technicians at industrial sites (plants, rigs, substations) need past incidents,
manuals and sensor context **while offline**. Cloud-only knowledge bases fail exactly when
connectivity is worst, and some notes (personnel, contractor, restricted data) must never
leave the device.

## Users
- **Field technician** — searches and writes notes on a device, often offline.
- **Reliability engineer** — reviews synced incidents, distills them into SOPs.
- **Site admin** — sets data-residency policy and manages the fleet.

## Goals
1. Hybrid (dense + BM25) search on-device, fully offline, single-digit ms p95.
2. Policy-driven residency: every note is `local_only`, `queued` or `sync_now`.
3. Edge ↔ cloud sync with explicit conflict cards — never silent overwrite.
4. Federation across real device processes; peer-down state handled.
5. Portable snapshot handoff between devices that preserves provenance.
6. Optional cloud LLM for synthesis (SOP distill, auto-tag) — never required.

## Non-goals
- Multi-tenant SaaS, user accounts, per-user RBAC.
- Running the engine on untrusted networks without `EDGE_TOKEN` + a firewall.

## Features (shipped)
| Tab | Question it answers | What |
| --- | --- | --- |
| Home | What needs me on this device now? | Attention line (conflicts, offline, queue), "seen this before?" search, recent incidents, device facts |
| Search | Have we seen this before? | dense / sparse / hybrid, filters, score breakdown, mode compare, distill → SOP |
| Knowledge | What's stored here? | Shards, notes list with filter, write form with live policy decision |
| Sync | Is my knowledge in step with the fleet? | Queue, sync / bootstrap, auto-sync, conflicts (local / remote / merge), snapshot handoff, history |
| Fleet | Who else is out there? | Devices (incl. federated peer), cloud collections: browse / search / delete |
| Policy | What leaves the device? | Rule table, simulate with decision trace, raw-sensor TTL retention |
| Activity | What happened? | Live SSE metrics, search latency, append-only event log with export |

The demo walkthrough lives in a side sheet (top bar "Guide" or ⌘K), not on Home.

## Security requirements
| # | Requirement | Status |
| --- | --- | --- |
| S1 | Proxy must not reach arbitrary local ports (SSRF) | Done — `EDGE_PORTS` allowlist, `..` rejected |
| S2 | Other websites must not drive the engine from a user's browser (CSRF) | Done — no CORS, JSON-only POST/PUT |
| S3 | Engine reachable on LAN must require auth | Done (opt-in) — `EDGE_TOKEN` |
| S4 | Malformed policy must not break writes | Done — schema validation on PUT |
| S5 | Bounded request size / LLM spend | Done — 8 MB body, 8000-char LLM input |
| S6 | Standard browser hardening headers | Done — XFO, nosniff, referrer, permissions |
| S7 | Restricted data never syncs | Enforced by policy r1 + audit |
| S8 | Secrets never committed | Done — `.env` untracked, `.env.example` holds placeholders |
| S9 | Auth for UI / role separation (admin vs technician) for policy + cloud delete | Open |
| S10 | Snapshot import can set arbitrary `origin_device` (provenance spoofing) | Open — accepted for handoff; sign snapshots if it matters |

## Resilience requirements
| # | Requirement | Status |
| --- | --- | --- |
| R1 | A cloud outage never breaks local search/write or the console (last-known cloud counts, `reachable:false`, cloud shown unreachable on Fleet tab) | Done — circuit breaker, `test_sync_integrity.py` |
| R2 | Queue, conflicts and policy survive a crash or power cut (atomic writes) | Done |
| R3 | A shard that fails to load is quarantined (`<shard>.corrupt-<ts>`), never deleted | Done |
| R4 | Admin policy survives an engine restart (`data/policy.json`, re-validated on load) | Done |
| R5 | Sync never silently overwrites: editing a pulled note is a normal update, a true divergence raises exactly one card, bootstrap keeps unsynced local edits | Done |
| R6 | Sync notices other devices' cloud writes (fresh manifest per sync) | Done |
| R7 | Devices sync on their own when the link returns | Opt-in — `EDGE_AUTOSYNC_INTERVAL` (default off; product decision) |

## UX requirements
- Every async action shows pending, success and failure states.
- Offline is a first-class state, not an error.
- Keyboard: ⌘K palette, Esc closes overlays; all controls reachable by Tab with visible focus.
- Works at 375 px width without horizontal scroll.
- Colour is never the only signal (badges carry text).

## Success metrics
- Audit green (all checks) in CI.
- Offline hybrid search p95 < 10 ms on seed data.
- Zero restricted points in cloud collections.
