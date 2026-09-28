@AGENTS.md

# EDGE.MEM — agent context

Offline-first knowledge engine for industrial edge devices. Read `docs/PRD.md` for
the product, `README.md` for setup, `worklog.md` for why things are the way they are.

## Layout
- `src/app/page.tsx` — single-page app, 8 tabs; one component per tab in `src/components/edge/`.
- `src/hooks/use-edge.ts` — shared polling state (`EdgeHook`), passed to every panel as `edge`.
- `src/lib/edge-api.ts` — typed client; every call is `/api/edge/<path>?XTransformPort=3030`.
- `src/app/api/edge/[...path]/route.ts` — same-origin proxy to the engine (Caddy optional).
- `src/app/api/edge/stream/route.ts` — SSE relay (polls engine; engine can't hold connections).
- `src/app/api/intelligence/route.ts` — optional OpenAI-compatible LLM (distill SOP, auto-tag).
- `mini-services/edge-engine/src/` — Python engine: `main.py` routes, `engine.py` fleet/sync/policy.
- `tests/audit/audit.py` — the 124+ check Playwright e2e audit. CI runs lint, tsc, audit.

## Hard constraints
- Engine is a **single-threaded `http.server` on the main thread**. The `qdrant_edge`
  binding segfaults under asyncio/uvicorn/worker threads. No threads, no async, no
  `optimize()`. Background work goes in `EdgeHTTPServer.service_actions()`.
- Restricted notes (`sensitivity=restricted`) must never reach the cloud. The audit asserts it.
- `mini-services/edge-engine/data/` is committed on purpose (audit expects that state).
- UI design rules: forced dark "industrial ops" theme; emerald=ok, amber=offline/queued,
  rose=critical/conflict; **no indigo/blue**; `font-mono` for technical values; use `Panel`
  and badges from `edge-ui.tsx`.

## Security model (see docs/PRD.md §Security)
- Proxy only forwards to ports in `EDGE_PORTS` (default `3030,3031`) and rejects `..` segments.
- Engine: no CORS headers; POST/PUT must be `application/json` (CSRF guard); 8 MB body cap;
  policy PUT is validated; optional `EDGE_TOKEN` shared secret (header `X-Edge-Token`,
  `/health` exempt) — Next proxy, SSE relay and peer probes all send it.
- `/api/intelligence` caps input at 8000 chars and hides provider error bodies.

## Tooling
- Repo expects `bun`; if missing, `npm install --no-package-lock` works (don't commit a lockfile).
- `npx tsc --noEmit` is clean. `eslint .` has 9 pre-existing `react-hooks/*` errors.
- `next dev` regenerates `AGENTS.md` — leave it.
