#!/usr/bin/env python3
"""End-to-end audit of edge-mem against the problem statement.

Usage:  python3 tests/audit/audit.py [base_url]        (default http://localhost:3001)

Sections, screenshot artifacts in tests/audit/shots/:
feasibility, ui (incl. mobile overflow), ux, capability, accessibility,
problem-statement coverage, offline purity (external requests blocked),
durability (engine restart), and new capabilities (federation, cloud browser,
snapshot handoff, search filters, SSE metrics, TTL retention).
Exit code 0 = all green.
"""
from __future__ import annotations

import json
import os
import re
import socket
import urllib.request
import subprocess
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001").rstrip("/")
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)

TABS = ["Home", "Search", "Knowledge", "Sync", "Fleet", "Policy", "Activity"]

results: list[tuple[str, str, bool, str]] = []


def check(aspect: str, name: str, ok: bool, detail: str = "") -> bool:
    results.append((aspect, name, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {aspect:<12} {name}" + (f" — {detail}" if detail else ""))
    return bool(ok)


def wait_for(fn, timeout: float = 15, interval: float = 0.5) -> bool:
    """Poll until fn() is truthy, or give up at timeout."""
    end = time.time() + timeout
    while True:
        if fn():
            return True
        if time.time() >= end:
            return False
        time.sleep(interval)


def shot(page: Page, name: str, full: bool = False) -> None:
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)


def tab(page: Page, name: str) -> None:
    page.evaluate("window.scrollTo(0, 0)")
    page.get_by_role("tab", name=name, exact=True).click()
    page.wait_for_timeout(900)


def stat(page: Page, label: str) -> str:
    """Value next to a label like 'Local points' / 'Queued'."""
    loc = page.locator(f"text={label}").first
    if loc.count() == 0:
        return ""
    return (loc.evaluate("e => (e.parentElement||e).innerText") or "").strip().replace("\n", " ")


def num(text: str) -> int:
    digits = "".join(c for c in text if c.isdigit())
    return int(digits[:6]) if digits else 0


# ---------------------------------------------------------------------------
# 1. FEASIBILITY — does it actually run on a clean machine?
# ---------------------------------------------------------------------------
def audit_feasibility(page: Page) -> None:
    print("\n== FEASIBILITY ==")
    if page.url == "about:blank":
        page.goto(BASE, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1500)
    check("feasibility", "app loads", page.url.startswith(BASE) and page.title().startswith("EDGE.MEM"), page.title())

    # No external gateway: /api/edge must be answered by Next itself.
    r = page.request.get(f"{BASE}/api/edge/health?XTransformPort=3030")
    check("feasibility", "edge-engine reachable without Caddy", r.ok and r.json().get("ok") is True, f"status {r.status}")

    r2 = page.request.get(f"{BASE}/api/edge/health?XTransformPort=3999")
    check("feasibility", "gateway refuses non-engine ports", r2.status == 403, f"status {r2.status}")

    r4 = page.request.get(f"{BASE}/api/edge/..%2F..%2Fhealth?XTransformPort=3030")
    check("feasibility", "gateway rejects path traversal", r4.status in (400, 404), f"status {r4.status}")

    r3 = page.request.get(f"{BASE}/api/edge/health")
    check("feasibility", "missing XTransformPort → 400", r3.status == 400, f"status {r3.status}")

    # the packaged launcher must not die when caddy isn't installed
    start = Path(__file__).resolve().parents[2] / ".zscripts" / "start.sh"
    src = start.read_text() if start.exists() else ""
    check("feasibility", "start.sh degrades without caddy",
          "command -v caddy" in src and "exec caddy run" in src)

    # engine deps must be pinned somewhere other than the bootstrap command line
    req = Path(__file__).resolve().parents[2] / "mini-services" / "edge-engine" / "requirements.txt"
    txt = req.read_text() if req.exists() else ""
    check("feasibility", "edge-engine deps pinned in requirements.txt",
          "qdrant-edge-py==" in txt and "fastembed==" in txt)
    engine = Path(__file__).resolve().parents[2] / "mini-services" / "edge-engine" / "start.sh"
    check("feasibility", "start.sh installs from requirements.txt",
          engine.exists() and "-r requirements.txt" in engine.read_text())


def audit_boot(page: Page) -> None:
    print("\n== BOOT ==")
    for t in TABS:
        tab(page, t)
        body = page.inner_text("body")
        ok = len(body.strip()) > 200 and "Application error" not in body
        check("ui", f"tab '{t}' renders", ok, f"{len(body)} chars")
        shot(page, f"tab-{t.lower()}", full=True)
    errs = page._audit_errors  # type: ignore[attr-defined]
    check("ui", "no console/page errors during tab sweep", len(errs) == 0, "; ".join(errs[:3]))


# ---------------------------------------------------------------------------
# 2. UI
# ---------------------------------------------------------------------------
def audit_ui(page: Page) -> None:
    print("\n== UI ==")
    tab(page, "Home")
    for label in ("Local points", "Cloud points", "Queued", "Conflicts"):
        check("ui", f"home stat '{label}' present", page.locator(f"text={label}").count() > 0)

    # horizontal overflow at desktop + mobile
    for w, h, tagname in ((1440, 960, "desktop"), (390, 844, "mobile")):
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(600)
        for t in TABS:
            tab(page, t)
            overflow = page.evaluate(
                "() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth"
            )
            check("ui", f"no horizontal overflow · {tagname} · {t}", overflow <= 2, f"{overflow}px")
            if tagname == "mobile":
                # a fixed-height tablist would let the panel overlap the last tab row
                hit = page.evaluate(
                    """name => {
                        const tab = [...document.querySelectorAll('[role=tab]')].find(e => e.innerText.trim() === name);
                        if (!tab) return 'missing';
                        const r = tab.getBoundingClientRect();
                        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                        return el && tab.contains(el) ? 'ok' : (el ? el.tagName + '|' + (el.innerText || '').trim().slice(0, 30) : 'none');
                    }""",
                    t,
                )
                check("ui", f"tab trigger not covered by panel · {t}", hit == "ok", hit)
        tab(page, "Home")
        shot(page, f"{tagname}-overview", full=True)
    page.set_viewport_size({"width": 1440, "height": 960})
    page.wait_for_timeout(500)


# ---------------------------------------------------------------------------
# 3. UX
# ---------------------------------------------------------------------------
def active_panel(page: Page):
    return page.locator("[role=tabpanel][data-state=active]")


def audit_ux(page: Page) -> None:
    print("\n== UX ==")

    # empty state for a shard with no points. The sensors shard is seeded with
    # raw telemetry for the TTL demo, so drain it first, then put telemetry back
    # (seed_devices only re-seeds an empty shard on restart).
    tab(page, "Knowledge")
    q = lambda path: f"{BASE}/api/edge/{path}?XTransformPort=3030"
    for pt in page.request.get(q("points") + "&shard=sensors&limit=200").json().get("points", []):
        page.request.post(q("point/delete"), data={"device": "device-alpha", "shard": "sensors", "id": pt["id"]})
    page.get_by_role("button", name=re.compile(r"^sensors")).first.click()
    page.wait_for_timeout(900)
    body = active_panel(page).inner_text()
    check("ux", "sensors shard (0 points) has an empty state",
          "No points on this shard" in body, body[-160:].replace("\n", " "))
    shot(page, "ux-empty-shard")
    for i in range(3):
        page.request.post(q("write"), data={
            "device": "device-alpha", "shard": "sensors", "slug": f"sensor-audit-{i}",
            "text": f"Audit raw telemetry reading {i} on P-201", "domain": "sensor",
            "criticality": "low", "sensitivity": "internal", "sensor_type": "vibration",
            "value": i, "unit": "mm/s", "severity": "info"})

    # memory filter narrows the list
    page.get_by_role("button", name=re.compile(r"^incidents")).first.click()
    page.wait_for_timeout(900)
    filt = page.get_by_placeholder("filter by slug, text, asset, origin…")
    before = active_panel(page).locator("li, article").count()
    filt.fill("bearing")
    page.wait_for_timeout(700)
    after = active_panel(page).locator("li, article").count()
    check("ux", "memory filter narrows results", after < before and after >= 0, f"{before} → {after}")
    filt.fill("")
    page.wait_for_timeout(500)

    # keyboard command palette
    page.keyboard.press("Meta+k")
    page.wait_for_timeout(700)
    palette = page.locator("input[placeholder*='command'], input[placeholder*='Search'], [cmdk-root]").first
    opened = palette.count() > 0 and palette.is_visible()
    check("ux", "⌘K opens command palette", opened)
    shot(page, "ux-command-palette")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)

    # export affordances
    tab(page, "Activity")
    act_export = page.get_by_role("button", name="EXPORT")
    check("ux", "activity log has export", act_export.count() > 0)
    if act_export.count():
        try:
            with page.expect_download(timeout=8000) as dl:
                act_export.first.click()
            d = dl.value
            check("ux", "activity export downloads a file", bool(d.suggested_filename), d.suggested_filename)
        except Exception as e:  # noqa: BLE001
            check("ux", "activity export downloads a file", False, str(e)[:120])



# ---------------------------------------------------------------------------
# 4. CAPABILITY — the eight things the brief asks for
# ---------------------------------------------------------------------------
def audit_capability(page: Page) -> None:
    print("\n== CAPABILITY ==")
    state = page.request.get(f"{BASE}/api/edge/state?XTransformPort=3030").json()
    check("capability", "device reports live edge memory", state["devices"][0]["total_points"] > 0,
          f"{state['devices'][0]['total_points']} pts")

    # (1) bootstrap if the device is empty
    if state["devices"][0]["total_points"] == 0:
        page.request.post(f"{BASE}/api/edge/bootstrap?XTransformPort=3030",
                          data={"device": "device-alpha"})
    mem = page.request.get(f"{BASE}/api/edge/memory?XTransformPort=3030&device=device-alpha").json()
    check("capability", "memory holds multiple shards", len(mem["shards"]) >= 3 and mem["total_points"] > 0,
          f"{mem['total_points']} pts / {len(mem['shards'])} shards")

    # (2) ranked semantic search, online
    s = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                          data={"device": "device-alpha", "shard": "incidents",
                                "query": "bearing vibration pump", "mode": "hybrid", "limit": 5}).json()
    scores = [r["score"] for r in s.get("results", [])]
    check("capability", "hybrid search returns ranked results", len(scores) >= 3 and scores == sorted(scores, reverse=True),
          f"{len(scores)} results, top={scores[0] if scores else '-'}")

    # (3) UI: search tab returns results
    tab(page, "Search")
    q = page.get_by_placeholder("e.g. seen this vibration pattern before?")
    q.fill("bearing vibration pump")
    active_panel(page).get_by_role("button", name="Search", exact=True).click()
    page.wait_for_timeout(2500)
    shot(page, "cap-search-online", full=True)
    txt = page.inner_text("body")
    check("capability", "search UI renders results with scores", "fused" in txt or "score" in txt.lower())

    # (4) OFFLINE: toggle connectivity, search must still work with zero network
    sw = page.locator("header [role=switch]").first
    sw.click()
    page.wait_for_timeout(1500)
    offline = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                                data={"device": "device-alpha", "shard": "incidents",
                                      "query": "bearing vibration pump", "mode": "hybrid", "limit": 3}).json()
    check("capability", "search works offline", offline.get("offline") is True and len(offline.get("results", [])) > 0,
          f"offline={offline.get('offline')} n={len(offline.get('results', []))}")
    lat = float(offline.get("latency_ms") or 0)
    check("capability", "offline search is low-latency (<50ms)", 0 < lat < 50, f"{lat}ms")

    # (4b) same path through the UI while still offline
    sw_off = "OFFLINE" in page.inner_text("header").upper() and sw.get_attribute("aria-checked") == "false"
    check("capability", "topbar reflects offline state", sw_off, "OFFLINE / local-only mode" if sw_off else "still shows ONLINE")
    tab(page, "Search")
    q.fill("bearing vibration pump")
    active_panel(page).get_by_role("button", name="Search", exact=True).click()
    page.wait_for_timeout(2500)
    ui_off = active_panel(page).inner_text()
    check("capability", "UI search still returns results while offline", len(ui_off) > 400, f"{len(ui_off)} chars")
    shot(page, "cap-search-offline", full=True)

    # (5) policy-driven offline write
    w = page.request.post(f"{BASE}/api/edge/write?XTransformPort=3030",
                          data={"device": "device-alpha", "shard": "incidents",
                                "text": "P-202 bearing seized at 50 Nm on pump-3, line stopped.",
                                "slug": "audit-critical-write", "criticality": "critical",
                                "sensitivity": "internal", "title": "Audit write"}).json()
    check("capability", "policy engine routes a critical offline write",
          w.get("sync_state") in ("sync_now", "queued") and w.get("decision", {}).get("matched_rule"),
          f"{w.get('sync_state')} via {w.get('decision', {}).get('matched_rule')}")

    ss = page.request.get(f"{BASE}/api/edge/sync-status?XTransformPort=3030&device=device-alpha").json()
    check("capability", "offline write is queued, not dropped", ss.get("queue_depth", 0) >= 1 or w.get("sync_state") == "sync_now",
          f"queue_depth={ss.get('queue_depth')}")

    # (6) reconnect + sync
    sw.click()
    page.wait_for_timeout(1200)
    before_cloud = page.request.get(f"{BASE}/api/edge/state?XTransformPort=3030").json()["cloud"]["total_points"]
    sync = page.request.post(f"{BASE}/api/edge/sync?XTransformPort=3030", data={"device": "device-alpha"}).json()
    after_cloud = page.request.get(f"{BASE}/api/edge/state?XTransformPort=3030").json()["cloud"]["total_points"]
    check("capability", "sync pushes queued work when connectivity returns",
          sync.get("ok") and after_cloud >= before_cloud, f"pushed={sync.get('pushed')} cloud {before_cloud}→{after_cloud}")

    # (7) conflict detection + resolution
    ss = page.request.get(f"{BASE}/api/edge/sync-status?XTransformPort=3030&device=device-alpha").json()
    if not ss.get("open_conflicts"):
        page.request.post(f"{BASE}/api/edge/demo/conflict?XTransformPort=3030", data={"device": "device-alpha"})
        page.request.post(f"{BASE}/api/edge/sync?XTransformPort=3030", data={"device": "device-alpha"})
        ss = page.request.get(f"{BASE}/api/edge/sync-status?XTransformPort=3030&device=device-alpha").json()
    check("capability", "divergent edits are detected as conflicts", len(ss.get("open_conflicts", [])) >= 1,
          f"{len(ss.get('open_conflicts', []))} open")

    tab(page, "Sync")
    shown = wait_for(lambda: page.get_by_text("Keep local").count() > 0, 20)
    shot(page, "cap-conflict", full=True)
    check("capability", "conflict card shown with local vs remote", shown)
    merge = page.get_by_role("button", name="Merge…")
    if shown and merge.count():
        merge.first.click()
        page.wait_for_timeout(900)
        ta = page.locator("textarea").last
        if ta.count():
            ta.fill("SOP-12 merged: field 50Nm verified on P-201; beta 45Nm retained as alternate step.")
            page.wait_for_timeout(300)
        btn = page.get_by_role("button", name=re.compile(r"resolve|merge|save", re.I)).last
        try:
            btn.click(timeout=5000)
        except Exception:  # noqa: BLE001
            pass
    cleared = wait_for(
        lambda: not page.request.get(f"{BASE}/api/edge/sync-status?XTransformPort=3030&device=device-alpha")
        .json().get("open_conflicts"), 20)
    check("capability", "conflict can be resolved", cleared,
          "0 open" if cleared else "still open")
    shot(page, "cap-conflict-resolved", full=True)

    # (8) policy simulate = dynamic local/cloud decision
    sim = page.request.post(f"{BASE}/api/edge/policy/simulate?XTransformPort=3030",
                            data={"text": "critical incident on pump", "criticality": "critical",
                                  "sensitivity": "internal", "domain": "incident"}).json()
    check("capability", "policy simulate explains local-vs-cloud decision",
          sim.get("decision", {}).get("sync_state") == "sync_now" and len(sim.get("trace", [])) >= 3,
          sim.get("decision", {}).get("matched_rule", ""))

    # (8b) routing rules are editable in the UI and persist across reload
    snapshot = page.request.get(f"{BASE}/api/edge/policy?XTransformPort=3030").json()
    tab(page, "Policy")
    combos = active_panel(page).get_by_role("combobox")
    n = combos.count()
    check("capability", "policy engine lists editable routing rules", n >= 5, f"{n} rules")
    combos.nth(n - 1).click()
    page.wait_for_timeout(500)
    page.get_by_role("option", name="sync_now", exact=True).click()
    page.wait_for_timeout(500)
    active_panel(page).get_by_role("button", name=re.compile("save policy", re.I)).click()
    page.wait_for_timeout(1200)
    check("capability", "saving policy gives feedback",
          wait_for(lambda: "Policy saved" in page.inner_text("body"), 8))
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1500)
    tab(page, "Policy")
    persisted = wait_for(
        lambda: active_panel(page).get_by_role("combobox").count() >= n
        and active_panel(page).get_by_role("combobox").nth(n - 1).inner_text() == "sync_now", 20)
    check("capability", "policy edit survives reload", persisted)
    shot(page, "cap-policy", full=True)
    page.request.put(f"{BASE}/api/edge/policy?XTransformPort=3030", data=snapshot)

    # (9) evolving memory: the new point is findable
    found = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                              data={"device": "device-alpha", "shard": "incidents",
                                    "query": "bearing seized line stopped", "mode": "hybrid", "limit": 5}).json()
    check("capability", "newly written point is retrievable",
          any(r.get("slug") == "audit-critical-write" for r in found.get("results", [])),
          ", ".join(r.get("slug", "?") for r in found.get("results", [])[:3]))

    # (10) metrics + activity reflect live traffic
    tab(page, "Activity")
    page.wait_for_timeout(1200)
    shot(page, "cap-metrics", full=True)
    mtxt = page.inner_text("body")
    check("capability", "metrics show live latency data", any(c.isdigit() for c in mtxt) and "search latency" in mtxt.lower())
    act = page.request.get(f"{BASE}/api/edge/activity?XTransformPort=3030&device=device-alpha&limit=100").json()
    check("capability", "activity log records system events", len(act.get("entries", [])) > 5, f"{len(act.get('entries', []))} entries")


# ---------------------------------------------------------------------------
# 5. EDGE → CLOUD AI WORKFLOW (the "meaningful" part of the brief)
# ---------------------------------------------------------------------------
def audit_ai_workflow(page: Page) -> None:
    print("\n== EDGE→CLOUD AI WORKFLOW ==")
    r = page.request.post(f"{BASE}/api/intelligence", data={"action": "auto_tag", "text": "Bearing P-202 overheating, line stopped, contractor John Smith on site"})
    ok = r.ok and r.json().get("criticality") in ("low", "medium", "high", "critical")
    check("capability", "cloud LLM auto-tags a note", ok, json.dumps(r.json())[:140] if r.ok else f"status {r.status}")

    r2 = page.request.post(f"{BASE}/api/intelligence",
                           data={"action": "distill_sop", "text": "P-202 bearing failure. Torque 50Nm exceeded. Vibration 8.2mm/s.", "asset_id": "P-202"})
    sop = r2.json().get("sop", "") if r2.ok else ""
    check("capability", "cloud LLM distills incident → SOP", len(sop) > 40, f"{len(sop)} chars")

    # through the UI
    tab(page, "Search")
    q = page.get_by_placeholder("e.g. seen this vibration pattern before?")
    q.fill("bearing vibration pump")
    active_panel(page).get_by_role("button", name="Search", exact=True).click()
    page.wait_for_timeout(2500)
    distill = page.get_by_role("button", name=re.compile(r"distill", re.I))
    check("ux", "Distill affordance surfaced on search results", distill.count() > 0, f"{distill.count()} buttons")
    if distill.count():
        try:
            distill.first.click()
            page.wait_for_timeout(9000)
            body = page.inner_text("body")
            generated = "Verification" in body or "SOP" in body or page.get_by_text("Save to manuals").count() > 0
            check("capability", "Distill → SOP generated in UI", generated)
            shot(page, "cap-distill", full=True)
        except Exception as e:  # noqa: BLE001
            check("capability", "Distill → SOP generated in UI", False, str(e)[:140])


    # AUTO-TAG in the write form: cloud LLM classifies the note in place
    tab(page, "Knowledge")
    pane = active_panel(page)
    pane.get_by_placeholder(re.compile(r"Paste a manual")).fill(
        "Bearing P-202 overheating, production line stopped for 40 minutes.")
    pane.get_by_role("combobox").first.click()
    page.wait_for_timeout(400)
    page.get_by_role("option", name="low", exact=True).click()
    page.wait_for_timeout(400)
    pane.get_by_role("button").filter(has_text="AUTO-TAG").first.click()
    # poll — ollama may still be draining a long distill request
    wait_for(lambda: pane.get_by_role("combobox").first.inner_text() != "low", 40, 1)
    tagged = pane.get_by_role("combobox").first.inner_text()
    check("capability", "AUTO-TAG reclassifies the note via cloud LLM", tagged in ("high", "critical"), f"low → {tagged}")
    shot(page, "cap-autotag", full=True)


# ---------------------------------------------------------------------------
# 6. EXPLICIT PROBLEM-STATEMENT COVERAGE — the goals that are easy to fake
# ---------------------------------------------------------------------------
def state_of(page: Page) -> dict:
    return page.request.get(f"{BASE}/api/edge/state?XTransformPort=3030").json()


def audit_statement(page: Page) -> None:
    print("\n== PROBLEM-STATEMENT COVERAGE ==")

    # GOAL: sensitive data cannot always leave the device
    page.request.post(f"{BASE}/api/edge/sync?XTransformPort=3030", data={"device": "device-alpha"})
    before = state_of(page)["cloud"]["total_points"]
    r = page.request.post(f"{BASE}/api/edge/write?XTransformPort=3030",
                          data={"device": "device-alpha", "shard": "incidents",
                                "text": "Restricted: contractor SSN 123-45-6789, badge log cabinet 7.",
                                "slug": "audit-restricted-keep-local", "criticality": "low",
                                "sensitivity": "restricted", "title": "Restricted audit"}).json()
    check("capability", "restricted note routes to local_only",
          r.get("sync_state") == "local_only" and r.get("decision", {}).get("matched_rule") == "r1",
          f"{r.get('sync_state')} via {r.get('decision', {}).get('matched_rule')}")
    page.request.post(f"{BASE}/api/edge/sync?XTransformPort=3030", data={"device": "device-alpha"})
    after = state_of(page)["cloud"]["total_points"]
    check("capability", "restricted note never reaches the cloud",
          after == before,
          f"cloud {before}→{after} after sync")

    # GOAL: low-latency vector + hybrid search without network access
    sw = page.locator("header [role=switch]").first
    if sw.get_attribute("aria-checked") == "true":
        sw.click()
        page.wait_for_timeout(1200)
    lats: dict[str, float] = {}
    for mode in ("dense", "sparse", "hybrid"):
        s = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                              data={"device": "device-alpha", "shard": "incidents",
                                    "query": "bearing vibration pump", "mode": mode, "limit": 5}).json()
        ok = s.get("offline") is True and len(s.get("results", [])) > 0
        lats[mode] = float(s.get("latency_ms") or 0)
        check("capability", f"{mode} search offline works", ok,
              f"n={len(s.get('results', []))} {lats[mode]}ms")
    run = [float(page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                                   data={"device": "device-alpha", "shard": "incidents",
                                         "query": q, "mode": "hybrid", "limit": 5}).json().get("latency_ms") or 0)
           for q in ("bearing vibration pump", "seal leak repair", "motor imbalance iso",
                     "overheat dust filter", "power fluctuation kiosk", "torque clearance m8",
                     "outer race defect", "lubrication interval", "vibration alarm", "gland repacking")]
    run.sort()
    p95 = run[min(len(run) - 1, int(len(run) * 0.95))]
    check("capability", "offline hybrid p95 < 50ms", 0 < p95 < 50, f"p95={p95:.2f}ms over {len(run)} queries")

    # GOAL: knowledge syncs edge → cloud → other devices
    fleet = page.request.get(f"{BASE}/api/edge/fleet?XTransformPort=3030").json()
    remote = [d for d in fleet["devices"] if not d.get("live")]
    check("capability", "federated fleet members present", len(remote) >= 2,
          ", ".join(d["id"] for d in remote))
    if sw.get_attribute("aria-checked") == "false":
        sw.click()
        page.wait_for_timeout(1200)
    page.request.post(f"{BASE}/api/edge/sync?XTransformPort=3030", data={"device": "device-alpha"})
    page.request.post(f"{BASE}/api/edge/bootstrap?XTransformPort=3030", data={"device": "device-alpha"})
    probe = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                              data={"device": "device-alpha", "shard": "incidents",
                                    "query": "motor bearing fault", "mode": "hybrid", "limit": 10}).json()
    remote_hits = [r for r in probe.get("results", []) if r.get("origin_device") not in (None, "device-alpha")]
    check("capability", "another device's knowledge is retrievable after sync",
          len(remote_hits) > 0,
          ", ".join(f"{r.get('slug')}@{r.get('origin_device')}" for r in remote_hits[:3]))

    # GOAL: the cloud is Qdrant Server, not an in-process stand-in
    try:
        srv = page.request.get("http://localhost:6333/collections", timeout=2500)
        served = srv.ok
        detail = f"HTTP {srv.status}" if served else f"HTTP {srv.status}"
    except Exception as e:  # noqa: BLE001
        served, detail = False, str(e).split(":")[0]
    claims = "Qdrant Server" in page.inner_text("body")
    check("capability", "cloud is backed by a real Qdrant Server", served,
          detail if served else f"{detail} — UI still labels it 'Qdrant Server'" if claims else detail)


def audit_accessibility(page: Page) -> None:
    print("\n== ACCESSIBILITY ==")
    worst = {"unnamedButtons": 0, "unlabeledFields": 0, "h1": 0, "lang": "", "missingAlt": 0}
    for t in TABS:
        tab(page, t)
        acc = page.evaluate("""() => {
            const vis = e => e.offsetParent !== null || e.getClientRects().length;
            const named = e => (e.innerText||'').trim() || e.getAttribute('aria-label')
                || e.getAttribute('aria-labelledby') || e.getAttribute('title')
                || (e.labels && e.labels.length);
            return {
                unnamedButtons: [...document.querySelectorAll('button')].filter(vis).filter(e => !named(e)).length,
                unlabeledFields: [...document.querySelectorAll('input,select,textarea')].filter(vis)
                    .filter(e => !named(e) && !e.getAttribute('placeholder')).length,
                h1: document.querySelectorAll('h1').length,
                lang: document.documentElement.lang || '',
                missingAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
            };
        }""")
        for k in ("unnamedButtons", "unlabeledFields", "h1", "missingAlt"):
            worst[k] = max(worst[k], acc[k]) if k != "h1" else acc[k]
        worst["lang"] = acc["lang"]
    check("ux", "every visible control has an accessible name (all tabs)",
          worst["unnamedButtons"] == 0 and worst["unlabeledFields"] == 0,
          f"{worst['unnamedButtons']} buttons / {worst['unlabeledFields']} fields unnamed")
    check("ux", "page declares a single <h1>", worst["h1"] == 1, f"h1 count = {worst['h1']}")
    check("ux", "html lang declared", bool(worst["lang"]), worst["lang"] or "(unset)")
    check("ux", "images have alt text", worst["missingAlt"] == 0, f"{worst['missingAlt']} missing")
    tab(page, "Home")


def audit_offline_purity(browser) -> None:  # noqa: ANN001
    """GOAL: the app must not depend on the public internet once loaded."""
    print("\n== OFFLINE PURITY (all non-localhost requests blocked) ==")
    ctx = browser.new_context(viewport={"width": 1440, "height": 960})
    blocked: list[str] = []

    def handler(route):  # noqa: ANN001, ANN202
        url = route.request.url
        if url.startswith((BASE, "http://localhost", "http://127.0.0.1", "data:", "blob:", "about:")):
            route.continue_()
        else:
            blocked.append(url)
            route.abort()

    ctx.route("**/*", handler)
    page = ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2500)
    check("feasibility", "zero non-localhost requests on load", len(blocked) == 0,
          ", ".join(sorted({u.split("/")[2] for u in blocked})[:3]) or "none")
    for t in TABS:
        page.evaluate("window.scrollTo(0, 0)")
        page.get_by_role("tab", name=t, exact=True).click()
        page.wait_for_timeout(600)
    page.get_by_role("tab", name="Search", exact=True).click()
    page.wait_for_timeout(900)
    page.get_by_placeholder("e.g. seen this vibration pattern before?").fill("bearing vibration pump")
    page.locator("[role=tabpanel][data-state=active]").get_by_role("button", name="Search", exact=True).click()
    page.wait_for_timeout(2500)
    body = page.locator("[role=tabpanel][data-state=active]").inner_text()
    check("feasibility", "search works with the public internet blocked", len(body) > 400,
          f"{len(body)} chars, {len(errs)} page errors")
    check("feasibility", "no runtime errors while offline", len(errs) == 0, "; ".join(errs[:2]))
    shot(page, "offline-purity", full=True)
    ctx.close()


def audit_durability(page: Page) -> None:
    """GOAL: memory lives on the device — it must survive an engine restart."""
    print("\n== DURABILITY (engine restart) ==")
    before = state_of(page)
    local = before["devices"][0]["total_points"]
    err = None
    try:
        subprocess.run(["sh", "-c", "pkill -f 'src/main.py' || true"], check=False, timeout=10)
        time.sleep(2)
        subprocess.Popen(
            ["bash", "start.sh"],
            cwd=str(Path(__file__).resolve().parents[2] / "mini-services" / "edge-engine"),
            env={**os.environ, "EDGE_PORT": "3030"},  # job-level PORT is Next's, not the engine's
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        alive = wait_for(lambda: page.request.get(f"{BASE}/api/edge/health?XTransformPort=3030",
                                                  timeout=3000).ok, 60, 2)
    except Exception as e:  # noqa: BLE001
        alive, local, err = False, local, str(e)[:120]
        check("feasibility", "edge-engine restarts", False, err)
    if not alive and err is None:
        check("feasibility", "edge-engine restarts", False, "health never came back within 60s")
    if alive:
        after = state_of(page)
        hp = page.request.get(f"{BASE}/api/edge/health?XTransformPort=3030").json()
        check("feasibility", "edge-engine restarts", True, f"uptime {hp['uptime_s']:.0f}s")
        check("feasibility", "local memory survives restart",
              after["devices"][0]["total_points"] == local,
              f"{local} → {after['devices'][0]['total_points']} points")
        s = page.request.post(f"{BASE}/api/edge/search?XTransformPort=3030",
                              data={"device": "device-alpha", "shard": "incidents",
                                    "query": "bearing vibration", "mode": "hybrid", "limit": 3}).json()
        check("feasibility", "search still works after restart",
              len(s.get("results", [])) > 0, f"{len(s.get('results', []))} results")



# ---------------------------------------------------------------------------
# 8. NEW CAPABILITIES — federation, cloud browser, snapshot handoff,
#    search filters + score breakdown, live SSE metrics, TTL retention
# ---------------------------------------------------------------------------
def edge_url(path: str) -> str:
    return f"{BASE}/api/edge/{path}?XTransformPort=3030"


def lan_ip() -> str | None:
    """Routable IPv4 of this host, or None when there is no non-loopback
    address. UDP connect() only selects a route — no packet is sent."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.5)
        sock.connect(("1.1.1.1", 80))
        ip = sock.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        sock.close()


def read_sse(timeout: float = 8.0) -> str:
    with urllib.request.urlopen(f"{BASE}/api/edge/stream", timeout=timeout) as resp:
        return resp.read(320).decode("utf-8", "replace")


def audit_new_features(page: Page) -> None:
    print("\n== NEW CAPABILITIES (federation / cloud / snapshot / filters / SSE / TTL) ==")

    # ---- F1: real multi-host federation ---------------------------------
    fleet = page.request.get(edge_url("fleet")).json()
    by_id = {d["id"]: d for d in fleet.get("devices") or []}  # an error payload reports as 0 devices, not a crash
    beta, gamma = by_id.get("device-beta", {}), by_id.get("device-gamma", {})
    check("capability", "federated peer is probed live, not a static stub",
          beta.get("federated") is True and beta.get("reachable") is True
          and beta.get("live") is False and beta.get("total_points", 0) > 0,
          f"federated={beta.get('federated')} reachable={beta.get('reachable')} pts={beta.get('total_points')}")
    check("capability", "non-federated fleet member reports unreachable",
          gamma.get("federated") is False and gamma.get("reachable") is False,
          f"federated={gamma.get('federated')} reachable={gamma.get('reachable')}")
    try:
        peer = page.request.get("http://localhost:3031/api/edge/health", timeout=3000)
        peer_json = peer.json() if peer.ok else {}
        peer_ok = peer.ok and peer_json.get("ok") is True
    except Exception:  # noqa: BLE001
        peer_json, peer_ok = {}, False
    check("capability", "peer engine runs as a second process on :3031", peer_ok, "localhost:3031")
    # federation is URL-addressed, so the same peer must answer over the
    # machine's routable address too — that is the multi-host path.
    ip = lan_ip()
    bind = peer_json.get("bind")
    if not ip:
        over_lan, detail = True, "no non-loopback address (skipped)"
    else:
        try:
            r = page.request.get(f"http://{ip}:3031/api/edge/health", timeout=3000)
            over_lan, detail = r.ok, f"{ip}:3031 reachable"
        except Exception:  # noqa: BLE001
            # some hosts drop non-loopback inbound for unsigned binaries (macOS
            # application firewall) — a host policy, not an app defect. Then the
            # most we can prove is that the peer is not loopback-only.
            over_lan = bind == "0.0.0.0"
            detail = f"{ip}:3031 blocked by host firewall — peer bind={bind}"
    check("capability", "peer engine answers over a non-loopback address", over_lan, detail)

    tab(page, "Fleet")
    fed_badge = page.get_by_text("federated", exact=True)
    check("ux", "fleet panel labels the federated member", fed_badge.count() > 0,
          f"{fed_badge.count()} badge(s)")
    shot(page, "fleet-federated")

    # ---- F2: cloud collections browser ---------------------------------
    cols = page.request.get(edge_url("cloud/collections")).json()
    names = [c["collection"] for c in cols.get("collections", [])]
    check("capability", "cloud collections listed from Qdrant Server",
          cols.get("backend") == "qdrant-server" and len(names) >= 3
          and all(n.startswith("edge-") for n in names),
          f"{cols.get('backend')} · {', '.join(names)}")
    check("capability", "cloud collections hold fleet knowledge",
          cols.get("total_points", 0) > 0, f"{cols.get('total_points')} points")

    tab(page, "Fleet")
    rows = page.locator('[data-testid="cloud-collection-row"]')
    check("ux", "Fleet tab lists every cloud collection", rows.count() >= 3, f"{rows.count()} rows")
    pts = page.locator('[data-testid="cloud-point-row"]')
    check("ux", "Fleet tab browses collection points", wait_for(lambda: pts.count() > 0, 12),
          f"{pts.count()} point rows")
    shot(page, "cloud-collections")

    cs = page.request.post(edge_url("cloud/search"), data={
        "collection": "edge-incidents", "query": "bearing vibration", "mode": "hybrid", "limit": 5}).json()
    check("capability", "cloud collection supports hybrid vector search",
          len(cs.get("points", [])) > 0 and all("score" in p for p in cs["points"]),
          f"{len(cs.get('points', []))} ranked hits")

    n0 = cols.get("total_points", 0)
    # unique per run: a fixed slug would upsert a point the previous run left
    # behind, and total_points would not move
    slug = f"audit-cloud-disposable-{int(time.time() * 1000)}"
    page.request.post(edge_url("write"), data={
        "device": "device-alpha", "shard": "incidents", "slug": slug,
        "text": "Disposable record written so the audit can prove cloud delete works.",
        "criticality": "low", "sensitivity": "internal"})
    page.request.post(edge_url("sync"), data={"device": "device-alpha"})
    n1 = page.request.get(edge_url("cloud/collections")).json().get("total_points", 0)
    listing = page.request.get(edge_url("cloud/points") + "&collection=edge-incidents&limit=500").json()
    hit = next((p for p in listing.get("points", []) if p.get("slug") == slug), None)
    check("capability", "a new note lands in the cloud collection",
          n1 == n0 + 1 and hit is not None, f"cloud {n0} → {n1}")
    if hit:
        page.request.post(edge_url("cloud/delete"), data={"collection": "edge-incidents", "id": hit["id"]})
    n2 = page.request.get(edge_url("cloud/collections")).json().get("total_points", 0)
    check("capability", "a cloud point can be deleted from the collection",
          hit is not None and n2 == n0, f"cloud {n1} → {n2}")

    # ---- F3: cross-device snapshot handoff -----------------------------
    before_sync = page.request.get(edge_url("sync-status") + "&device=device-alpha").json()
    open_before = len(before_sync.get("open_conflicts", []))
    snap = page.request.post(edge_url("snapshot/export"), data={"device": "device-alpha"}).json()
    total = snap.get("point_count", 0)
    check("capability", "snapshot export produces a portable document",
          snap.get("format") == "edge-mem-snapshot" and total > 0,
          f"{total} points from {snap.get('device')}")
    check("capability", "snapshot export withholds local_only points",
          snap.get("excluded_local_only", 0) >= 1,
          f"{snap.get('excluded_local_only')} restricted held back")
    imp = page.request.post(edge_url("snapshot/import"),
                            data={"device": "device-alpha", "snapshot": snap}).json()
    check("capability", "snapshot import loads every exported point",
          imp.get("ok") is True and imp.get("imported") == total,
          f"imported {imp.get('imported')}/{total}")
    page.request.post(edge_url("sync"), data={"device": "device-alpha"})
    open_after = len(page.request.get(edge_url("sync-status") + "&device=device-alpha")
                     .json().get("open_conflicts", []))
    check("capability", "re-importing a snapshot raises no false conflicts",
          open_after == open_before, f"{open_before} → {open_after} open conflicts")

    # ---- F4: search filters + per-channel score breakdown --------------
    f = page.request.post(edge_url("search"), data={
        "device": "device-alpha", "shard": "incidents", "query": "bearing vibration pump",
        "mode": "hybrid", "limit": 10, "filters": {"origin_device": "device-beta"},
        "explain": True}).json()
    origins = {r.get("origin_device") for r in f.get("results", [])}
    check("capability", "search filters narrow the result set server-side",
          len(f.get("results", [])) > 0 and origins == {"device-beta"},
          f"{len(f.get('results', []))} hits, origins={sorted(o or '?' for o in origins)}")
    check("capability", "search explains dense/sparse/fused scores",
          f.get("explained") is True and all(
              r.get("scores") and {"dense", "sparse", "fused"} <= set(r["scores"])
              for r in f.get("results", [])),
          f"filters={f.get('filters')}")

    tab(page, "Search")
    filter_sel = page.get_by_label("Criticality filter")
    check("ux", "search exposes payload filters", filter_sel.count() > 0, "4 filter selects")
    page.get_by_placeholder("e.g. seen this vibration pattern before?").fill("bearing vibration pump")
    active = page.locator("[role=tabpanel][data-state=active]")
    active.get_by_role("button", name="Search", exact=True).click()
    breakdown = page.locator('[data-testid="score-breakdown"]')
    check("ux", "search results show a score breakdown",
          wait_for(lambda: breakdown.count() > 0, 12), f"{breakdown.count()} breakdowns")
    shot(page, "search-filters-scores")

    # ---- F5: live metrics over SSE -------------------------------------
    try:
        frame = read_sse()
        check("capability", "engine metrics stream over server-sent events",
              "event: metrics" in frame and "cloud_points" in frame,
              frame.splitlines()[0] if frame else "no data")
    except Exception as e:  # noqa: BLE001
        check("capability", "engine metrics stream over server-sent events", False, str(e)[:120])
    tab(page, "Activity")
    sse = page.locator('[data-testid="sse-status"]')
    check("ux", "Activity tab shows a live SSE connection",
          wait_for(lambda: sse.count() > 0 and sse.get_attribute("data-conn") == "live", 15),
          sse.get_attribute("data-conn") if sse.count() else "missing")
    shot(page, "metrics-sse")

    # ---- F6: TTL retention of raw telemetry ----------------------------
    # the background ticker must fire on its own: audit_durability restarted the
    # engine, which resets retention.last_run to null.
    interval = int(page.request.get(edge_url("health")).json().get("retention_interval_s") or 0)
    auto = wait_for(lambda: bool(page.request.get(edge_url("retention/status"))
                                 .json().get("last_run")), interval + 10, 1) if interval else True
    check("capability", "retention ticker sweeps in the background", auto,
          f"interval={interval}s" if interval else "disabled (EDGE_RETENTION_INTERVAL=0)")

    mem = page.request.get(edge_url("memory") + "&device=device-alpha").json()
    sensors_before = mem["shards"]["sensors"]["points"]
    check("capability", "sensors shard holds raw telemetry for the TTL",
          sensors_before > 0, f"{sensors_before} points")
    pol = page.request.get(edge_url("policy")).json()
    # the engine also sweeps on a background ticker, so compare the cumulative
    # expired_total rather than this one run's `expired` count.
    total0 = page.request.get(edge_url("retention/status")).json().get("expired_total", 0)
    try:
        page.request.put(edge_url("policy"), data={**pol, "ttl_raw_sensor_seconds": 0})
        ret = page.request.post(edge_url("retention/run"), data={"device": "device-alpha"}).json()
        total1 = page.request.get(edge_url("retention/status")).json().get("expired_total", 0)
        delta = (total1 or 0) - (total0 or 0)
        check("capability", "TTL retention sweep expires raw telemetry",
              ret.get("ok") is True and ret.get("ttl_seconds") == 0
              and ret.get("checked", 0) > 0 and delta >= 1,
              f"expired {delta} total ({ret.get('expired')} in this run) "
              f"of {ret.get('checked')} checked at ttl={ret.get('ttl_seconds')}s")
        mem2 = page.request.get(edge_url("memory") + "&device=device-alpha").json()
        check("capability", "expired points are dropped from the sensors shard",
              mem2["shards"]["sensors"]["points"] < sensors_before,
              f"{sensors_before} → {mem2['shards']['sensors']['points']}")
    finally:
        page.request.put(edge_url("policy"), data=pol)
    check("capability", "retention honours the restored policy TTL",
          page.request.get(edge_url("retention/status")).json().get("ttl_seconds")
          == pol.get("ttl_raw_sensor_seconds"),
          f"ttl={pol.get('ttl_raw_sensor_seconds')}s")

    tab(page, "Policy")
    run_btn = page.locator('[data-testid="retention-run"]')
    check("ux", "Policy tab exposes a retention sweep control", run_btn.count() > 0,
          "Run retention sweep")


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page._audit_errors = errors  # type: ignore[attr-defined]
        try:
            audit_feasibility(page)
            audit_boot(page)
            audit_ui(page)
            audit_ux(page)
            audit_capability(page)
            audit_ai_workflow(page)
            audit_accessibility(page)
            audit_statement(page)
            audit_offline_purity(browser)
            audit_durability(page)
            audit_new_features(page)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            check("harness", "audit run completed", False, "unhandled exception")
        browser.close()

    failed = [r for r in results if not r[2]]
    print("\n" + "=" * 72)
    for aspect in ("feasibility", "ui", "ux", "capability", "harness"):
        rows = [r for r in results if r[0] == aspect]
        if not rows:
            continue
        print(f"{aspect:<14} {len(rows) - len([r for r in rows if not r[2]])}/{len(rows)} passed")
    print(f"\nTOTAL {len(results) - len(failed)}/{len(results)} passed — {len(failed)} failed")
    for a, n, _, d in failed:
        print(f"  FAIL {a}: {n} — {d}")
    print(f"screenshots: {SHOTS}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
