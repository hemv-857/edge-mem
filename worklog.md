# Edge Intelligence Platform — Worklog

## Project: AI-Powered Edge Memory & Intelligence Platform (Qdrant Edge)

---
Task ID: 1
Agent: main (orchestrator)
Task: Build the Python Qdrant Edge engine mini-service (port 3030) — embedded vector memory, hybrid retrieval, policy engine, sync engine, conflict detection, activity log, seed data.

Work Log:
- Installed `qdrant-edge-py` 0.8.0 (real Qdrant Edge beta), `fastembed`, `fastapi`, `uvicorn` into `/home/z/.venv`.
- Read the full `qdrant_edge` type stubs (`__init__.pyi`) to learn the API: `EdgeShard.create/load`, `EdgeConfig` (dense `EdgeVectorParams` + sparse `EdgeSparseVectorParams`), `Bm25` sparse embedder, `UpdateOperation.upsert_points`, `Point(id, vector={"":dense,"text":sparse}, payload)`, unified `query()` with `QueryRequest` + `Prefetch` + `Query.Nearest` + `Fusion.Rrf` for hybrid search, `snapshot_manifest()` for manifest-diff sync, `scroll/count/retrieve`.
- Validated end-to-end: dense (FastEmbed bge-small-en, 384d) + sparse (BM25) vectors, all 3 search modes (dense/sparse/hybrid) via `query()` return correct semantic results. UUID string IDs (uuid5 of slug) work for stable cross-device identity.
- Built `mini-services/edge-engine/` (package.json + src/embed.py + src/engine.py + src/seed.py + src/main.py).
- Engine: 3 EdgeShards per device (manuals/incidents/sensors) + 3 cloud shards = 6 total. `device-alpha` is the live interactive device; `device-beta`/`device-gamma` are remote fleet members whose knowledge lives in the cloud (origin_device tag) — keeps memory within the 4GB cgroup limit.
- Policy engine: tags every point on write with sensitivity/criticality/domain; routes to `local_only` / `queued` / `sync_now` via rule set.
- Sync engine: dual-write push queue (critical jumps queue); manifest-diff pull (compares `snapshot_manifest()` hashes, transfers only newer points); conflict detection (divergent `updated_at`+`origin_device` → conflict card, never silent overwrite); bootstrap = full snapshot pull.
- Seed: cloud pre-seeded with 7 manuals + 5 incidents (originating from beta/gamma). device-alpha starts empty → first demo step is bootstrapping.
- Full golden path verified via HTTP: bootstrap(12) → offline write(critical→sync_now) → offline hybrid search(33-38ms) → sync(push 1) → manufactured conflict → resolve(merge) → fleet overview. Server stays alive.

CRITICAL findings (binding quirks — documented for future agents):
1. **uvloop crashes the binding.** Must run with the standard `asyncio` loop (or no event loop).
2. **The binding is incompatible with FastAPI/uvicorn entirely** — even with `--loop asyncio` and async endpoints on the main event-loop thread, the process dies silently (SIGKILL, no traceback) after the first binding access corrupts the thread. A dedicated worker thread ALSO crashes (binding needs the main thread, but the main thread running an asyncio loop also fails).
3. **`EdgeShard.optimize()` spawns background optimizer threads that crash a long-running server.** The standalone script survives because it exits before the background thread interferes; a long-running server idles in `select()` and the background optimizer touching shared binding state during that idle kills the process. FIX: `ShardStore.optimize()` is a no-op (just `flush()`). For edge-scale collections (hundreds of points) brute-force search is sub-40ms without HNSW — fine for the demo.
4. **`scroll()` with `order_by` on a payload field needs a range index** that EdgeShard can't create at runtime → removed `order_by`, sort by `updated_at` in Python instead.
5. **`retrieve()` requires `with_vector` positional arg** → pass `with_vector=False`.
6. **Solution:** `main.py` uses a single-threaded `http.server.HTTPServer` (main thread, no asyncio, no threads). This matches the execution model under which the binding is stable. Sequential request handling is acceptable and safer for a single-user edge demo.

Stage Summary:
- Backend COMPLETE and STABLE. Service running on port 3030, single-threaded http.server.
- API contract frozen (see endpoints in main.py ROUTES table): health, state, fleet, memory, points, search, write, connectivity, sync, bootstrap, sync-status, conflict/resolve, demo/conflict, activity, policy (GET/PUT), active.
- Cloud seeded with 12 points. device-alpha empty (bootstrap on first use).
- Ready for frontend development. Frontend must call `/api/edge/*?XTransformPort=3030` (relative path, port in query per gateway rules).
- The dev script is `bun run dev` → `cd src && python3 main.py` (no uvicorn).

---
Task ID: 4-a
Agent: full-stack-developer
Task: Build MemoryExplorer, ActivityLog, PolicyEngine panels

Work Log:
- Read worklog.md (task 1 backend summary) + all contract files: use-edge.ts (EdgeHook), edge-ui.tsx (Panel/StatCard/badges/formatters), edge-types.ts (EdgePoint/MemoryShard/Policy/PolicyRule/ActivityEntry/WriteResult), edge-api.ts (edge client), TopBar.tsx (aesthetic reference), globals.css (edge-glow-*/edge-scroll/edge-pulse tokens, emerald/amber/rose palette).
- Built MemoryExplorer.tsx: Panel header + 3 clickable shard cards (manuals/incidents/sensors) with mono name, SyncStateBadge, big point count, segments, formatBytes disk, embedding line, truncated manifest hash, emerald glow when selected. Selection stored in state; effective shard DERIVED in render (selectedShard = shardKeys.includes(selected) ? selected : shardKeys[0]) to avoid setState-in-effect. Two-column layout: left PointsList (fetches via edgeApi.points(shard, undefined, 20) in a useEffect keyed by [shard, edge.memory]; component remounts via key={shard} so loading=true is the initial state, no synchronous setState needed; each row shows slug/title/text snippet/origin_device/CriticalityBadge/SyncStateBadge/formatRelative). Right WriteForm: Textarea + criticality Select (low/medium/high/critical) + sensitivity Select (internal/restricted/public) + optional title/asset_id Inputs + offline note ("embeds locally via FastEmbed + BM25, zero network"). Write button calls edgeApi.write() directly (hook's write() returns void, so the API client is called to capture WriteResult.decision), then edge.refresh(). On success: toast + inline decision card (SyncStateBadge + reason + matched_rule + slug). Loading skeleton when edge.memory null.
- Built ActivityLog.tsx: Panel header with live event count. Filter row of chip-buttons (all/write/search/sync/connectivity/conflict/policy/demo/seed/system) with per-kind counts; active chip emerald-accented. Timeline <ol> max-h-[560px] overflow-y-auto edge-scroll. Each row: left-rail colored dot (emerald=write/sync/seed, sky=search, amber=connectivity/queue/demo, rose=conflict, zinc=system/policy) + formatTime mono + colored kind badge + device mono + message + up to 2 meta chips (shard/slug/latency_ms/queue_depth/sync_state/mode/criticality/action, typed-safe via metaValue helper). animate-in fade-in slide-in-from-top-1 on each item keyed by ts+message. Empty state: "Awaiting activity…".
- Built PolicyEngine.tsx: Panel header + explainer paragraph. Local policy state initialized from edge.state.policy via a ref-guarded effect (lastSeenSig tracks JSON signature; re-inits only when server policy actually changes, never clobbers in-progress edits). Rule table: one Card per rule with index/id/field/op/values|value mono chips + editable action Select (local_only/queued/sync_now, color-coded amber/rose) + reason. ttl_raw_sensor_seconds number Input. isDirty computed from JSON-sig diff. Save button → edgeApi.putPolicy(policy) → toast → edge.refresh(). Revert button when dirty. Routing legend: 3 colored cards (local_only/queued amber, sync_now rose) with descriptions, using SyncStateBadge. Version note "evaluated top-down, first match wins". Skeleton when policy null.
- Fixed a blocking bug in src/lib/edge-api.ts: the qs() helper required a `params` argument but edgePut() (used by putPolicy) called it with zero args, which throws at runtime via Object.entries(undefined) and is a strict-TS arity error (TS2554). Applied a minimal, backward-compatible fix by giving qs() a default param `= {}`. This unblocks PolicyEngine's save and resolves the pre-existing tsc error; no contract change (existing callers qs(query || {}) behave identically). Documented here for orchestrator awareness.
- Ran `bun run lint` (clean, 0 errors) and `bunx tsc --noEmit` — my 3 files have zero type errors; only remaining tsc errors are in src/app/page.tsx referencing sibling panels (FleetOverview/SearchPlayground/SyncConsole) that belong to other agents' tasks (4-b/4-c/4-d) and don't exist yet.

Stage Summary:
- 3 production-ready client components delivered: MemoryExplorer.tsx, ActivityLog.tsx, PolicyEngine.tsx — all in src/components/edge/, each default-exported with signature `({ edge }: { edge: EdgeHook })`.
- Aesthetic matches TopBar.tsx: dark industrial theme, emerald/amber/rose/zinc accents (no indigo/blue; sky used sparingly for search/sensors), font-mono for IDs/timestamps/metrics, uppercase tracking-wider micro-labels, rounded-xl border bg-card/40 backdrop-blur panels, edge-glow/edge-scroll/edge-pulse tokens, responsive (stack on mobile, grid on sm/lg).
- All shared helpers reused (Panel, CriticalityBadge, SyncStateBadge, formatBytes, formatRelative, formatTime). shadcn components used throughout (Button, Input, Textarea, Label, Select, Skeleton). Toast via @/hooks/use-toast. Edge API client imported as edgeApi for points()/write()/putPolicy().
- Strict TypeScript clean (no `any`); react-hooks/set-state-in-effect rule satisfied (selection derived in render; fetch loading handled via key-remount + initial useState(true); policy re-init uses ref-guarded effect pattern).
- One infra bugfix (edge-api.ts qs() default param) applied + documented. Ready for the other panel agents (4-b/4-c/4-d) to fill in FleetOverview/SearchPlayground/SyncConsole so page.tsx resolves.

---
Task ID: 2-7
Agent: main (orchestrator)
Task: Define API contract, build Next.js frontend (shell + 6 panels), wire cloud-LLM intelligence route, integrate, browser-verify golden path, create cron job.

Work Log:
- Froze the REST API contract (see mini-services/edge-engine/src/main.py ROUTES table): /api/edge/{health,state,fleet,memory,points,search,write,connectivity,sync,bootstrap,sync-status,conflict/resolve,demo/conflict,activity,policy,active}. Frontend calls via ?XTransformPort=3030 (relative path through Caddy gateway).
- Built frontend foundation: src/lib/edge-types.ts (TS types mirroring backend), src/lib/edge-api.ts (typed client, XTransformPort=3030), src/hooks/use-edge.ts (polling hook: snapshot every 4.5s + incremental activity every 3.5s, action wrappers with busy state).
- Custom industrial dark theme (globals.css): near-black slate base, emerald=online/synced, amber=offline/queued, rose=critical/conflict, NO indigo/blue. Custom utilities: edge-grid-bg, edge-glow-*, edge-pulse, edge-scroll, edge-scan.
- Shared edge-ui.tsx: Panel, StatCard, CriticalityBadge, SyncStateBadge, LatencyBadge, StatusDot, formatBytes/Time/Relative.
- TopBar.tsx: brand, active device, hero connectivity toggle (Switch, emerald/amber), queue mini, cloud pts, Bootstrap + Sync buttons.
- page.tsx: sticky TopBar + live-KPI sub-strip + Tabs (Overview/Memory/Search/Sync/Activity/Policy) + sticky footer (min-h-screen flex flex-col, mt-auto).
- Delegated 3 panels (MemoryExplorer, ActivityLog, PolicyEngine) to a full-stack-developer subagent (Task 4-a) — built + lint-clean; also fixed a qs() default-param bug in edge-api.ts.
- Built 3 demo-critical panels myself: FleetOverview (device cards + cloud panel + contribution bars), SearchPlayground (query/shard/mode controls, example chips, scored results with score bars, OFFLINE badge), SyncConsole (queue, last-sync summary, manifest-diff, conflict cards with local/remote/merge resolution).
- Cloud-LLM intelligence layer (Task 5): src/app/api/intelligence/route.ts (Next.js route, z-ai-web-dev-sdk, online-only). Actions: distill_sop (incident → reusable SOP) + auto_tag. Wired "Distill → SOP" button into SearchPlayground results (online only) → cloud LLM generates SOP → "Save to manuals shard" writes it locally → queues for fleet sync. This is the edge/cloud division of labor made visible.
- Fixed lucide icon Robot→Bot (build error).
- Fixed the critical keep-alive hogging bug: the single-threaded http.server with HTTP/1.1 keep-alive let Caddy's persistent connection monopolise the accept loop, making direct curls time out (looked like hangs). Switched to HTTP/1.0 + Connection: close → all clients served round-robin. Also raised listen backlog to 128, added manifest-hash + cloud-contrib caching in the engine to cut binding calls during polling, and reduced frontend polling to 4.5s/3.5s.
- Browser-verified the full golden path via agent-browser through the gateway (http://localhost:81/): Overview renders live data (3 devices, 12 cloud pts) → Bootstrap pulls 12 (LOCAL PTS 0→12) → Memory Explorer shows shards+points → Search returns beta's verified fixes with RRF scores (1.0000, 0.6667) → toggle OFFLINE + search works (OFFLINE badge, "zero network calls") → Manufacture conflict + Sync surfaces conflict card (alpha 50Nm vs beta 45Nm) → Merge resolution clears it → Cloud-LLM "Distill → SOP" generates a clean 8-step SOP from the P-202 incident → Save to manuals (7→8 pts, queued for fleet sync). No console/runtime errors throughout.
- Final: lint clean, both services up (edge-engine :3030, next :3000), app served via gateway :81.

Stage Summary:
- COMPLETE, browser-verified edge-to-cloud AI workflow. Every brief requirement met: local semantic memory (EdgeShard), offline hybrid retrieval (FastEmbed+BM25+RRF), policy-driven local-vs-sync routing, intermittent-connectivity survival (dual-write queue + manifest-diff pull), conflict detection + resolution, fleet dashboard, and a meaningful edge↔cloud LLM workflow (offline retrieval → online LLM SOP synthesis → fleet sync).
- Cron webDevReview job created (job_id 406908, every 15 min) to continue QA + feature work autonomously.
- Known limitation (documented): the qdrant_edge Rust binding is incompatible with asyncio/uvicorn/uvloop and with background threads — requires a single-threaded plain http.server on the main thread; and EdgeShard.optimize() must be disabled (spawns background threads that crash a long-running process). All worked around stably.


---
Task ID: cron-review-1
Agent: main (cron webDevReview round 1)
Task: QA pass via agent-browser + VLM, fix bugs, add new features, improve styling.

Work Log:
- Reviewed worklog.md — project was complete and browser-verified from the prior session.
- Performed QA via agent-browser: opened the app through the gateway (http://localhost:81/), screenshotted all 6 tabs, ran the VLM skill (z-ai vision CLI) on the Overview, Search, and Sync screenshots to get concrete UI/UX feedback.
- VLM-identified issues (verified against the code): (1) FleetOverview — 0-contribution bar got a tiny bar instead of an empty state; device-gamma (remote) showed an empty data block where live-only fields would be; cloud shards lacked icons; large empty space below the cloud panel. (2) SearchPlayground — search button taller than the query textarea; controls row underutilized width; excessive vertical padding. (3) SyncConsole — "critical: 0" shown in red even when zero; manifest diffs lacked relative-time context.

BUG FIXES (all browser-verified):
- FleetOverview.tsx rewrite: 0-contribution bars now show a dashed "no contributions yet" empty state; remote device cards show a dedicated remote layout (location/technician/kind/cloud-contrib/last-sync/status + a "knowledge hosted in cloud" info bar) instead of empty live-only fields; cloud shards now have colored icons (BookOpen/AlertTriangle/Gauge) with per-shard accent rings; live device cards now also show a "pushed" bytes meta; filled the empty space below the cloud panel with a new MiniActivityFeed (top 8 recent fleet events with colored dots).
- SearchPlayground.tsx: aligned the search button height to the textarea (both 42px, button uses mt-[18px] to clear the label); tightened vertical padding (mt-4→mt-3); restructured the Shard/Mode/Limit controls into a 12-col grid (5/4/3) for better width utilization.
- SyncConsole.tsx: muted "critical: 0" to muted-foreground when zero (was always rose-400); added "checked Xm ago" relative time to the manifest-diff header; colored changed manifest rows with emerald accent; clarified unchanged rows with "v{hash}" instead of "—→hash".

NEW FEATURES (all browser-verified):
1. Point Detail Drawer (PointDetailDrawer.tsx): a reusable slide-over drawer opened by clicking any point in MemoryExplorer or SearchPlayground. Fetches the full payload via a new GET /api/edge/point endpoint (added to engine.py + main.py). Shows badges (criticality/sync_state/severity), a metadata grid (id/origin/asset/sensor/value/sensitivity/time), the full text content, a "Distill → SOP" cloud-LLM action for incident-domain points (online only), any extra payload keys, and a Delete button (new POST /api/edge/point/delete endpoint). Closes on backdrop click or Escape. Wired into page.tsx via a shared `edge.openPoint()`/`edge.closePoint()`/`edge.activePoint` state added to the useEdge hook so any panel can trigger it. Search result cards and memory list items are now clickable with hover-emerald borders; inner buttons use stopPropagation to avoid triggering the card click.
2. Sync History Timeline (in SyncConsole.tsx): a new full-width panel below the sync/conflicts grid. Filters the activity log to sync/bootstrap/connectivity/conflict/queue events, renders them as a vertical timeline with colored nodes (emerald=sync, sky=bootstrap, amber=connectivity, rose=conflict), kind badges, timestamps + relative times, and metric chips (pushed↑/pulled↓/conflicts/queued) when available. Empty state prompts the user to run a sync.
3. Auto-tag on Write form (in MemoryExplorer.tsx): a new "auto-tag" button in the WriteForm header that calls the existing /api/intelligence route with action "auto_tag" to classify the note's criticality + sensitivity via the cloud LLM (online only). On success, auto-fills the criticality/sensitivity selects and shows a "cloud LLM: <reason>" inline note. Disabled when offline or when text is empty.
4. Overview mini activity feed (in FleetOverview.tsx): fills the previously-empty space below the cloud panel with a compact recent-activity stream (top 8 events with colored dots), making the right column feel complete.

BACKEND additions:
- engine.py: ShardStore.delete_point() method; Fleet.get_point() + Fleet.delete_point() methods; contrib-cache invalidation on sync/resolve/demo.
- main.py: new routes GET /api/edge/point (fetch full payload) + POST /api/edge/point/delete (delete a point); EdgeHTTPServer subclass with request_queue_size=128 + allow_reuse_address (already present from prior round).
- edge-api.ts: added getPoint() + deletePoint() client methods.
- use-edge.ts: added PointRef type + activePoint/openPoint/closePoint to the hook.

VERIFICATION (agent-browser through gateway http://localhost:81/):
- App loads cleanly, no console/runtime errors.
- Bootstrap → Memory tab → click a point → Point Detail Drawer opens with full metadata + content + Delete button (VLM-verified: "drawer visible with point metadata, Content section displays text, Delete button present, no visual issues").
- Sync tab → Sync History Timeline shows 11 events with bootstrap/sync/queue/conflict entries, timestamps, relative times, and metric chips (12 pulled, 1 queued, 1 conflict).
- Overview tab → Mini Recent Activity feed shows top events; remote device cards (gamma) now show a proper "knowledge hosted in cloud" info bar instead of empty fields; 0-contribution bars show dashed empty state.
- Memory tab → typed incident text → "auto-tag" button enabled → click → cloud LLM classified as "critical / Safety hazard, production stop required" → criticality select auto-updated to "critical" + reason shown inline.
- Lint clean (eslint . → 0 errors). Both services up (edge-engine :3030 uptime stable, next :3000 HTTP 200).

Stage Summary:
- All VLM-identified visual bugs fixed + 4 new features added (Point Detail Drawer, Sync History Timeline, Auto-tag on Write, Overview mini activity feed).
- Project is feature-complete and polished for a hackathon demo. The edge↔cloud AI workflow is now richer: users can inspect any point's full payload, see a visual sync history timeline, auto-classify notes via the cloud LLM before writing, and the fleet overview is information-dense with no empty space.
- Known limitation: Next.js dev server occasionally needs restart if the edge-engine restarts during a polling cycle (the cron reviewer should check `ps aux | grep next-server` and restart if the page renders blank). The edge-engine is stable with HTTP/1.0 + backlog=128 + manifest/contrib caching.

---
Task ID: cron-review-2
Agent: main (cron webDevReview round 2)
Task: QA pass via agent-browser + VLM, add new features (Memory filter, Similar Points, Metrics tab), styling polish.

Work Log:
- Reviewed worklog.md — project was feature-complete and browser-verified after cron-review-1 (Point Detail Drawer, Sync History Timeline, Auto-tag, Overview mini activity feed all present).
- Performed fresh QA: opened app via gateway, screenshotted all 6 tabs, ran VLM (z-ai vision) on Memory and Activity tabs. VLM flagged: inconsistent shard card heights (sensors shorter when 0 points), missing search/filter/stats within Memory Explorer points list, no latency/metrics visualization. (The recurring "floating N badge" the VLM reports was verified via DOM inspection — `document.querySelectorAll('*')` for fixed/absolute positioned single-letter elements returns empty; it is a VLM hallucination from the dark theme, not a real bug.)

NEW FEATURES (all browser-verified):
1. Memory Explorer — search/filter/stats (MemoryExplorer.tsx): added a stats summary bar (4 mini cards: total / critical / local-only / origins count, derived directly from the points list with no effect), a text filter input (filters by slug/title/text/asset/origin, with clear-X button), and criticality filter chips (critical/high/medium/low, each showing its count, colored when active, hidden when count is 0 unless active). The list shows "filtered/total shown" (e.g. "3/7 shown"). Empty-filter state and no-match state both handled. Bumped the fetch limit from 20→50 so the filter has more to work with. Fixed the shard-card desc min-height so cards align even when a shard has 0 points.
2. Similar Points (PointDetailDrawer.tsx): a new "Similar points" section in the drawer with a "find similar" button that runs a hybrid search across ALL three shards (manuals/incidents/sensors) using the current point's own text as the query, then shows the top-3 related points per shard (excluding the point itself) with score, slug, text snippet, and origin. Each similar result is clickable → opens that point in the drawer (chained exploration). Includes a loading state, empty state, and "re-run search" button. Uses stopPropagation so clicking a similar result doesn't trigger the drawer's inner actions.
3. Metrics tab (MetricsPanel.tsx — new 7th tab): a full edge-metrics dashboard with 5 panels:
   - 4 top stat cards: avg search latency (emerald if <50ms, rose if >200ms), min/max range, offline searches count, total events.
   - Search Latency Trend: an inline SVG line chart (no chart lib) plotting the last 20 search-latency samples from the activity log (meta.latency_ms), with grid lines, area fill, online=emerald/offline=amber dots, and a legend. Empty state prompts to run searches.
   - Event Breakdown: per-kind action counts (write/search/sync/connectivity/conflict/queue/etc.) as horizontal bars with the KIND_COLOR palette.
   - Shard Distribution: per-shard point counts with colored bars (sky/amber/emerald by domain) + percentage.
   - Sync Throughput: pushed/pulled bytes cards + last-sync summary (pushed/pulled/conflicts).
   - Engine Configuration: 8 info items (engine, dense, sparse, fusion, shards, sync, cloud LLM, runtime).
4. Styling polish (globals.css): added 3 new animation utilities — `edge-stagger` (staggered fade-in-up for list items, 8+ delays), `edge-shimmer` (skeleton shimmer), `edge-tick` (number tick-in). Applied `edge-stagger` to the Search results list.

VERIFICATION (agent-browser through gateway http://localhost:81/):
- App loads cleanly, no console/runtime errors. Lint clean (eslint . → 0 errors).
- Bootstrap → Memory tab shows stats bar (TOTAL 7, CRITICAL 0, LOCAL-ONLY 0, ORIGINS 1) + filter chips (HIGH 3, MEDIUM 3, LOW 1). Clicking HIGH → "3/7 shown". Typing "bearing" in filter → "2/7 shown". Clearing works.
- Clicking a point → drawer → "FIND SIMILAR" → searches across all shards → found manual-vibration-limits (score 0.583) as related to the lubrication manual. Similar results are clickable.
- Search tab → ran 2 example queries → Metrics tab → Search Latency Trend shows 7 samples (max 60.7ms) with online/offline dots + line + area. VLM-verified: "chart clearly visible with data points, stat cards highly readable".
- Metrics Event Breakdown, Shard Distribution, Sync Throughput, Engine Configuration all render with live data.
- Both services stable (edge-engine :3030, next :3000 HTTP 200, gateway e2e active=device-alpha cloud=12).

Stage Summary:
- 3 new features added (Memory filter/search/stats, Similar Points in drawer, full Metrics dashboard tab) + styling polish (3 new animations).
- The app now has 7 tabs (Overview/Memory/Search/Sync/Metrics/Activity/Policy) and supports a richer inspection workflow: filter points → inspect → find similar → distill → save. The Metrics tab makes the on-device retrieval performance (sub-60ms hybrid search) and fleet activity distribution visible to judges.
- No bugs found this round; project remains stable and lint-clean.
- Known non-issue: the VLM consistently reports a "floating N badge" but DOM inspection confirms no such element exists — it's a vision-model artifact on the dark theme.
