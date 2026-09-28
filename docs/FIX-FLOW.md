# Security fix flow (from audit run-1)

Audit output: `~/security-audit-skill/edge-mem/run-1/` — read `NEEDS-VALIDATION.md` for the full trace, blocker and regression plan of every fingerprint named below.

**Run order:** Phase 0 first (it completes the audit and may drop a lead). Phases 1–5 are independent: each one owns a disjoint set of files, so they can run in parallel chats/subagents and merge cleanly. Rules for every phase:

- Edit **only** the files your phase owns. If a fix needs another phase's file, write it under "Handoff" in your summary instead.
- Read `CLAUDE.md` + `AGENTS.md` first. Hard constraints: engine stays single-threaded `http.server` (no threads/async), restricted notes never reach the cloud, UI rules (no indigo/blue, use `edge-ui.tsx`).
- Next.js here is v16 — read `node_modules/next/dist/docs/` before touching routing/middleware/proxy.
- The engine cannot run on this machine (no `qdrant_edge`/fastembed). Verify with: `python3 -m py_compile mini-services/edge-engine/src/*.py`, `npx tsc --noEmit`, `npx eslint <changed files>` (9 pre-existing react-hooks errors are known). If you add a regression test, make it runnable without qdrant_edge (stub imports) or document it as needing the full stack.
- Work on a branch `fix/phase-N-<slug>`; don't commit `AGENTS.md` changes made by `next dev`.
- Finish with a short summary: fingerprints fixed, files changed, checks run, anything handed off.

---

## Phase 0 — Complete the audit (read-only, no code changes)

Run 1 skipped Phase 5 and the final-clean critic. Do this in a fresh session:

```
/security-audit
Resume ~/security-audit-skill/edge-mem/run-1 (do not start a new run). Only do:
1. Phase 5: one fresh verifier per needs_validation record in findings.json (14), per VALIDATION-AND-REPORTING.md Phase 5, source-only (target execution is blocked on this host: no memory limit). Apply replacements per the materiality rule.
2. One final-clean coverage critic over coverage-ledger.json.
3. Rerun both validators, regenerate REPORT.md / NEEDS-VALIDATION.md, set run_status "complete" in run-metadata.json.
```

If Phase 0 rejects a fingerprint, the phase that owns it drops that item.

---

## Phase 1 — Engine residency & sync integrity

**Owns:** `mini-services/edge-engine/src/engine.py`

Fingerprints:
- `edge-engine:resolve_conflict:policy-bypass-cloud-upsert`
- `edge-engine:sync-push:stale-queue-snapshot-no-policy-recheck`
- `edge-engine/engine.py:Fleet.import_snapshot:caller-id-and-updated_at-trusted`
- `edge-engine/engine.py:Fleet._peer_overview:unbounded-peer-read-on-main-thread`
- `mini-services/edge-engine/src/engine.py:Fleet._peer_overview:edge-token-sent-to-unauthenticated-plaintext-endpoint`

Do:
1. **Hard residency floor.** Add one helper (e.g. `_is_local_only(payload)`) that normalises `sensitivity` (`str().strip().lower()`) and returns True for `restricted` regardless of the editable policy list. Use it in `write_point` (normalise the stored value too), at the **sync push sink** (skip + drop the queue item), in `resolve_conflict`, and in `export_snapshot` (filter on sensitivity as well as `sync_state`).
2. **resolve_conflict:** read the current local point; if it is local-only (helper or `evaluate_policy`), refuse the cloud upsert (keep the local copy, mark conflict resolved-local) instead of hard-coding `sensitivity: "internal"`. Keep the local point's real sensitivity. Reject already-resolved conflicts (`c["status"]`) and do nothing to the cloud while `dev.online` is False.
3. **Sync push re-check:** for each queued item, re-read the current local point; skip if deleted, and re-run `evaluate_policy` with the current policy on the current payload; skip if local-only. Dedupe the queue by `point_id` on enqueue (latest wins). Remove queue items in `delete_point` and `run_retention`.
4. **import_snapshot:** do not upsert over an id that already exists locally. Either re-key to a fresh id or route it into the conflict path. Stamp `updated_at` itself (or keep the file's value only when the id is new everywhere), so equal timestamps can't hide a real divergence.
5. **_peer_overview:** enforce a total deadline (monotonic clock, ~2 s) and a size cap (`resp.read(65537)`, reject anything larger). Use an opener without redirect-following. Only send `X-Edge-Token` to loopback peers or to peers explicitly opted in (e.g. `https://` or an env flag). Cache failures with a fresh timestamp. Validate the peer JSON shape (ints/lists) before merging.

Regression checks: see the local plans for these fingerprints in NEEDS-VALIDATION.md (canary restricted note → resolve "local" → not in cloud; offline internal → rewrite restricted → sync → not in cloud; import with an existing id + equal updated_at → conflict raised).

---

## Phase 2 — Engine HTTP surface

**Owns:** `mini-services/edge-engine/src/main.py`

Fingerprints:
- `edge-engine/main.py:Handler:no-socket-timeout-single-threaded-stall`
- `mini-services/edge-engine/src/main.py:Handler._handle:no-host-validation-dns-rebinding`
- hardening: log escape injection (`log_message` override), `validate_policy` can drop rule r1, 500s echo `str(e)`

Do:
1. Set `timeout = 10` on `Handler` (socket read deadline). Make sure `socket.timeout` in a handler does not kill `serve_forever`.
2. Validate `Host` in `_handle` before routing: allow `localhost`, `127.0.0.1`, `[::1]`, the bind address, and hosts in a new env `EDGE_ALLOWED_HOSTS` (comma list); else 403. `/api/edge/health` may stay exempt.
3. `log_message`: `(fmt % args).translate(self._control_char_table)` (stdlib escaping).
4. `validate_policy`: reject policies whose first matching rule for `sensitivity=restricted` isn't `local_only` (or simply require a `sensitivity in [restricted] → local_only` rule to be first).
5. The 500 path returns a generic message; keep the traceback server-side.
6. Encode the `X-Edge-Token` header to bytes before `hmac.compare_digest` (non-ASCII currently raises outside the try).
7. Document `EDGE_ALLOWED_HOSTS` in README.md's security section. You own that one README section; no other phase edits README.

Regression: stub-import harness from the NEEDS-VALIDATION local plan (idle socket + second request answered within timeout; foreign `Host` → 403).

---

## Phase 3 — Next.js API routes

**Owns:** `src/app/api/intelligence/route.ts`, `src/app/api/edge/[...path]/route.ts`, `src/app/api/edge/stream/route.ts`, new `src/proxy.ts` (or the v16-correct middleware file; check the docs)

Fingerprints:
- `next-api:edge-proxy:no-host-allowlist-dns-rebinding`
- `next-api:intelligence:POST:json-parse-without-content-type-csrf`
- `edge-mem:intelligence/asset_id-uncapped-prompt-bypasses-spend-cap`

Do:
1. **Host/Origin guard** for `/api/*`: allow Hosts from `EDGE_ALLOWED_HOSTS` + localhost forms. Reject cross-site `Sec-Fetch-Site` (allow `same-origin`/`none`) on state-changing methods. Return 403 otherwise.
2. **/api/intelligence:** return 415 unless the Content-Type essence is `application/json`. Check `typeof text === "string"` (inside try). `asset_id` must be absent or match `/^[\w.-]{1,64}$/`. Cap the total prompt length. Coerce `reason` to a string and cap it; drop `raw` from the response.
3. **Edge proxy hardening:** reject segments matching `/^(\.|%2e){1,2}$/i` or assert `new URL(target).pathname.startsWith('/api/edge/')`. Cap the body size before `req.text()`. Add `AbortSignal.timeout(10_000)` to the fetch. Return a generic 502 message.
4. **SSE relay** (rejected as a finding, cheap hardening): a single module-level poller with a cached snapshot shared by all streams, skip a tick while a fetch is in flight, `AbortSignal.timeout`.

Checks: `npx tsc --noEmit`, eslint on the changed files, and manual curl against `next dev` if you can run it (UI-only, no engine needed for the 415/403 paths).

---

## Phase 4 — UI data handling

**Owns:** `src/components/edge/SearchPlayground.tsx`, `PointDetailDrawer.tsx`, `MemoryExplorer.tsx`, `ActivityLog.tsx`, `FleetOverview.tsx`

Fingerprints:
- `edge-mem:ui/llm-distill-restricted-egress-and-internal-relabel`
- `src/components/edge/ActivityLog.tsx:exportLog:tsv-field-injection`

Do:
1. Hide/disable Distill (search row + drawer) when the note's sensitivity is `restricted`, with a tooltip explaining why. Search results currently drop `sensitivity`. Use the field if present; otherwise fetch the point (`/api/edge/point`) before distilling. Do **not** edit engine files; if the engine must return sensitivity in search hits, write that under "Handoff" for Phase 1.
2. Saved SOPs inherit the source note's sensitivity (never hard-code `internal`). A restricted source must not produce a syncable SOP.
3. Auto-tag must never lower a user-selected `restricted` value. Also skip the LLM call entirely when the user already chose `restricted`.
4. TSV export: replace `\t\r\n` in every field with spaces, and prefix cells starting with `= + - @` with `'`. Apply the same fix in `MetricsPanel.tsx`'s TSV export if it takes free text; you own that file for this change only.
5. FleetOverview: guard `d.shards` with `Array.isArray`.

Checks: tsc + eslint on the changed files. Follow the UI design rules in CLAUDE.md.

---

## Phase 5 — Deployment config

**Owns:** `Caddyfile`, `mini-services/edge-engine/start.sh`, `mini-services/edge-engine/src/cloud_qdrant.py`, `.github/workflows/ci.yml`, `.env` / `.gitignore`

Fingerprints:
- `caddyfile:reverse_proxy:xtransformport-no-port-allowlist`
- `edge-engine/start.sh:qdrant-server-no-api-key:cloud-payloads-trusted-on-pull`

Do:
1. **Caddyfile:** match only `XTransformPort=3030` / `3031` (mirror `EDGE_PORTS`) plus `path /api/edge/*`; everything else goes to the default Next handler or 404.
2. **start.sh:** start Qdrant with `QDRANT__SERVICE__HOST=127.0.0.1`. Support an optional `QDRANT_API_KEY` (pass it as `QDRANT__SERVICE__API_KEY`). Verify the downloaded tarball against a pinned SHA-256 (add it as a variable; leave a clear TODO if you can't fetch the hash offline).
3. **cloud_qdrant.py:** pass `api_key=os.environ.get("QDRANT_API_KEY") or None` to `QdrantClient`. Redact userinfo from any URL it reports.
4. **CI:** add top-level `permissions: contents: read`.
5. **.env:** `git rm --cached .env`, add `.env.example` with placeholders (PRD S8). Ask the user before running the git command.

Checks: `bash -n start.sh`, `python3 -m py_compile .../cloud_qdrant.py`, `caddy validate` if available (otherwise note it).

---

## After all phases

Merge the branches (they don't overlap), then in one session: run `npx tsc --noEmit`, eslint, `py_compile`, and, on a machine where the engine runs, the e2e audit (`tests/audit/audit.py`). Then rerun `/security-audit` with the Phase 0 ledger as the prior run to confirm the fixes.
