# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Purpose

EDGE.MEM is an offline-first knowledge engine that runs on an industrial edge device
(plant, rig, substation). It keeps past incidents, manuals and sensor context searchable
on the device with no network, and syncs with a shared cloud knowledge base when the
link is up, under a residency policy that keeps restricted notes on the device.

## Users

- **Device operator (primary).** A field technician on one device, often offline, often
  mid-fault. Job: "have we seen this before, and what fixed it?", then log what they found.
  The console is built for this person first.
- **Reliability engineer.** Reviews synced incidents, distills them into SOPs.
- **Site admin.** Sets residency policy, watches the fleet and the cloud collections.

## Primary workflows

1. Search local memory for a symptom (hybrid dense + BM25), open a hit, act on it.
2. Log a note (incident, manual excerpt, sensor observation); the policy decides whether
   it stays local, queues, or syncs now.
3. When the link returns: sync, then resolve any conflict (keep local, keep remote, merge).
4. Occasionally: tune policy, check the fleet and cloud, hand a snapshot to another device,
   inspect activity and latency.

## Constraints

- Offline is a normal state, not an error. Nothing may depend on the public internet.
- Restricted notes never leave the device, including to the optional cloud LLM.
- Sync never silently overwrites; divergence is shown as an explicit conflict.
- Works at 375 px wide; keyboard reachable; colour is never the only signal.
- The e2e audit (`tests/audit/audit.py`) drives the UI by tab name and visible text; UI
  changes update it in the same change.

## Brand commitments (binding)

- Forced dark "industrial ops" theme.
- Status colours: emerald = ok/online/synced, amber = offline/queued/warning,
  rose = critical/conflict. Indigo/violet only as faint ambient light, never for status, controls or text.
- Monospace only for technical values (IDs, slugs, counts, timestamps, scores).

## Terminology

Device, shard (manuals / incidents / sensors), point (a stored note), queue, sync,
bootstrap, conflict, policy rule, sync state (`local_only`, `queued`, `sync_now`, `synced`),
fleet, federated peer, cloud collection, snapshot handoff.

## Open decisions

Licence, UI auth and role separation (PRD S9), auto-sync default (R7), pricing.
