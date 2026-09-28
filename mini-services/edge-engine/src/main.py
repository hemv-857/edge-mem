"""Single-threaded HTTP service exposing the Qdrant Edge intelligence engine.

WHY NOT uvicorn/asyncio: the qdrant_edge Rust binding is incompatible with the
asyncio event loop (uvloop OR the default asyncio loop) and with background
worker threads — it segfaults the process whenever the binding is driven from
any thread other than a plain main thread doing sequential work. A plain
`http.server.HTTPServer` (single-threaded, main thread) matches the execution
model under which the binding is stable (verified by a standalone script that
runs the full golden path on the main thread). For a single-user edge demo,
sequential request handling is not just acceptable — it is the safe choice.

All endpoints live under /api/edge and are reached via ?XTransformPort=3030.
"""
from __future__ import annotations

import hmac
import json
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from typing import Any, Callable, Dict, Optional

import embed
import engine as E
import seed as S

PORT = int(os.environ.get("EDGE_PORT", "3030"))
BIND = os.environ.get("EDGE_BIND", "0.0.0.0")   # 0.0.0.0: a peer on another host must reach us
# Shared secret for everything except /health. Unset = open (local dev only);
# set it on every engine + the Next.js server whenever the bind is reachable.
TOKEN = os.environ.get("EDGE_TOKEN", "")
MAX_BODY = 8 * 1024 * 1024   # snapshots are the largest legit body
# Host header allowlist (DNS-rebinding guard): a rebound attacker page would
# otherwise be same-origin with the engine. Add LAN names/IPs that clients use
# (Caddy forwards the browser's Host; a cross-host peer is probed by its IP).
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", BIND.lower()} | {
    h.strip().lower() for h in os.environ.get("EDGE_ALLOWED_HOSTS", "").split(",") if h.strip()}
_started_at = time.time()

print("[edge-engine] booting — creating Fleet on main thread...", flush=True)
fleet = E.Fleet()
try:
    embed.get_dense(); embed.get_bm25()
except Exception:
    pass
S.seed_fleet(fleet)
S.seed_devices(fleet, fleet.active_device)
print(f"[edge-engine] ready. devices={list(fleet.devices)} "
      f"cloud_points={fleet.cloud.memory_stats()['total_points']}", flush=True)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _device_id(body: dict, qs: dict) -> str:
    return body.get("device") or (qs.get("device", [None])[0]) or fleet.active_device


# ---------------------------------------------------------------------------
# endpoint handlers (each returns (status, dict))
# ---------------------------------------------------------------------------

def h_health(body, qs):
    return 200, {
        "ok": True, "service": "edge-engine", "port": PORT,
        "uptime_s": round(time.time() - _started_at, 1),
        "engine": "qdrant_edge (EdgeShard) + FastEmbed + BM25",
        "dense_model": embed.DENSE_MODEL, "dense_dim": embed.DENSE_DIM,
        "runtime": "single-threaded http.server (main thread)",
        "retention_interval_s": RETENTION_INTERVAL,
        "bind": BIND,
    }

def h_state(body, qs):
    live = [{"id": d.id, "name": d.name, "location": d.location,
             "technician": d.technician, "online": d.online, "live": True,
             "total_points": d.memory_stats()["total_points"]}
            for d in fleet.devices.values()]
    remote = [fleet.remote_member_entry(m) for m in fleet.remote_members]
    return 200, {"active_device": fleet.active_device, "devices": live + remote,
                 "cloud": fleet.cloud.memory_stats(), "policy": fleet.policy,
                 "shard_defs": E.SHARD_DEFS}

def h_fleet(body, qs):
    return 200, fleet.fleet_overview()

def h_memory(body, qs):
    dev_id = _device_id(body, qs)
    return 200, fleet.devices[dev_id].memory_stats()

def h_points(body, qs):
    dev_id = _device_id(body, qs)
    shard = qs.get("shard", [None])[0]
    limit = int(qs.get("limit", ["12"])[0])
    dev = fleet.devices[dev_id]
    if shard not in dev.shards:
        return 404, {"error": "unknown shard"}
    return 200, {"shard": shard, "device": dev.id, "points": dev.recent_points(shard, limit)}

def h_get_point(body, qs):
    dev_id = _device_id(body, qs)
    shard = qs.get("shard", [None])[0]
    point_id = qs.get("id", [None])[0]
    if not shard or not point_id:
        return 400, {"error": "shard and id required"}
    p = fleet.get_point(dev_id, shard, point_id)
    if p is None:
        return 404, {"error": "point not found"}
    return 200, p

def h_delete_point(body, qs):
    dev_id = body.get("device") or fleet.active_device
    shard = body.get("shard")
    point_id = body.get("id")
    if not shard or not point_id:
        return 400, {"error": "shard and id required"}
    return 200, fleet.delete_point(dev_id, shard, point_id)

def h_search(body, qs):
    try:
        return 200, fleet.search(body.get("device") or fleet.active_device,
                                 body.get("shard", "incidents"), body.get("query", ""),
                                 body.get("mode", "hybrid"), int(body.get("limit", 5)),
                                 filters=body.get("filters") or {},
                                 explain=bool(body.get("explain")))
    except ValueError as e:
        return 400, {"error": str(e)}

def h_write(body, qs):
    payload = {k: v for k, v in body.items() if k not in ("device", "shard", "text") and v is not None}
    return 200, fleet.write_point(body.get("device") or fleet.active_device,
                                  body.get("shard"), payload, text=body.get("text", ""))

def h_connectivity(body, qs):
    return 200, fleet.set_connectivity(body.get("device") or fleet.active_device, bool(body.get("online")))

def h_sync(body, qs):
    return 200, fleet.sync(body.get("device") or fleet.active_device)

def h_bootstrap(body, qs):
    return 200, fleet.bootstrap(body.get("device") or fleet.active_device)

def h_sync_status(body, qs):
    dev_id = _device_id(body, qs)
    return 200, fleet.sync_status(dev_id)

def h_conflict_resolve(body, qs):
    res = fleet.resolve_conflict(body.get("device") or fleet.active_device,
                                 body.get("conflict_id"), body.get("resolution"),
                                 body.get("merged_text"))
    if not res["ok"]:
        return 404, res
    return 200, res

def h_demo_conflict(body, qs):
    return 200, fleet.trigger_demo_conflict(body.get("device") or fleet.active_device)

def h_activity(body, qs):
    device = qs.get("device", [None])[0]
    limit = int(qs.get("limit", ["60"])[0])
    since = int(qs.get("since", ["0"])[0])
    return 200, {"entries": fleet.activity_since(device, limit, since)}

def h_get_policy(body, qs):
    return 200, fleet.policy

POLICY_FIELDS = {"sensitivity", "criticality", "domain"}
POLICY_ACTIONS = {"local_only", "queued", "sync_now"}


def _matches_restricted(r) -> bool:
    return r["field"] == "sensitivity" and (
        r.get("value") == "restricted" if r["op"] == "eq" else "restricted" in r["values"])


def validate_policy(p) -> Optional[str]:
    """A malformed policy would crash evaluate_policy on every write, so reject it here."""
    if not isinstance(p, dict) or not isinstance(p.get("rules"), list):
        return "policy.rules must be a list"
    ttl = p.get("ttl_raw_sensor_seconds")
    if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl < 0:
        return "ttl_raw_sensor_seconds must be a non-negative integer"
    for r in p["rules"]:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str):
            return "every rule needs a string id"
        if r.get("field") not in POLICY_FIELDS:
            return f"rule {r['id']}: field must be one of {sorted(POLICY_FIELDS)}"
        if r.get("action") not in POLICY_ACTIONS:
            return f"rule {r['id']}: action must be one of {sorted(POLICY_ACTIONS)}"
        if r.get("op") == "eq":
            if not isinstance(r.get("value"), str):
                return f"rule {r['id']}: eq needs a string value"
        elif r.get("op") == "in":
            if not isinstance(r.get("values"), list) or not all(isinstance(v, str) for v in r["values"]):
                return f"rule {r['id']}: in needs a list of strings"
        else:
            return f"rule {r['id']}: op must be eq or in"
        if not isinstance(r.get("reason", ""), str):
            return f"rule {r['id']}: reason must be a string"
    # Residency floor: the first rule a restricted note can hit must keep it local.
    # Only sensitivity rules that can't match "restricted" may come before it.
    first = next((r for r in p["rules"]
                  if r["field"] != "sensitivity" or _matches_restricted(r)), None)
    if not first or not _matches_restricted(first) or first["action"] != "local_only":
        return "the first rule a restricted note can match must be sensitivity=restricted → local_only"
    return None


def h_put_policy(body, qs):
    err = validate_policy(body)
    if err:
        return 400, {"error": err}
    fleet.policy = body
    fleet.log("system", "policy", "Policy rules updated", {})
    return 200, fleet.policy

def h_simulate_policy(body, qs):
    """Simulate a point's tags against the policy rules — returns the matched
    rule + resulting sync_state, WITHOUT writing anything. Used by the Policy
    Engine's 'Simulate' panel."""
    from engine import evaluate_policy
    text = body.get("text", "")
    criticality = body.get("criticality", "medium")
    sensitivity = body.get("sensitivity", "internal")
    domain = body.get("domain", "incident")
    meta = {"criticality": criticality, "sensitivity": sensitivity, "domain": domain}
    decision = evaluate_policy(meta, fleet.policy)
    # also return which rules were evaluated (and which matched/skipped) for the UI
    trace = []
    for rule in fleet.policy["rules"]:
        field = rule["field"]
        val = meta.get(field)
        if rule["op"] == "eq":
            matched = val == rule.get("value")
        else:  # in
            matched = val in (rule.get("values", []) or [])
        trace.append({
            "id": rule["id"], "field": field, "op": rule["op"],
            "value": rule.get("value"), "values": rule.get("values"),
            "point_value": val, "matched": matched,
            "action": rule["action"], "reason": rule["reason"],
            "is_match": rule["id"] == decision["matched_rule"],
        })
    return 200, {"decision": decision, "trace": trace, "point_meta": meta}

def h_active(body, qs):
    dev = body.get("device")
    if dev not in fleet.devices:
        return 400, {"error": f"{dev} is a remote fleet member — only {fleet.active_device} is a live local device"}
    fleet.active_device = dev
    fleet.log(dev, "system", f"Active device switched to {dev}", {})
    return 200, {"active_device": dev}


# ---------------------------------------------------------------------------
# cloud collections browser (the centralized knowledge base, made operable)
# ---------------------------------------------------------------------------
COLLECTION_PREFIX = "edge-"
CLOUD_FIELDS = ("slug", "text", "domain", "criticality", "sensitivity",
                "origin_device", "sync_state", "asset_id", "title", "updated_at")


def _shard_for(name: str) -> Optional[str]:
    shard = (name or "").strip()
    if shard.startswith(COLLECTION_PREFIX):
        shard = shard[len(COLLECTION_PREFIX):]
    return shard if shard in E.SHARD_DEFS else None


def _cloud_view(p: Dict[str, Any], score: Optional[float] = None) -> Dict[str, Any]:
    row = {"id": p.get("_id") or p.get("id"), "score": score}
    row.update({k: p.get(k) for k in CLOUD_FIELDS})
    return row


def h_cloud_collections(body, qs):
    ms = fleet.cloud.memory_stats()
    url = getattr(fleet.cloud, "url", None)
    cols = [{"collection": f"{COLLECTION_PREFIX}{k}", "shard": k, **v}
            for k, v in ms["shards"].items()]
    return 200, {"backend": "qdrant-server" if url else "embedded-edge",
                 "url": url, "total_points": ms["total_points"],
                 "collections": cols}


def h_cloud_points(body, qs):
    shard = _shard_for(qs.get("collection", ["edge-incidents"])[0])
    if not shard:
        return 400, {"error": "unknown collection"}
    limit = min(int(qs.get("limit", ["50"])[0]), 500)
    q = (qs.get("q", [""])[0] or "").strip()
    if q:
        hits = fleet.cloud.search(shard, qs.get("mode", ["hybrid"])[0], q, limit=limit)
        return 200, {"collection": f"{COLLECTION_PREFIX}{shard}", "shard": shard, "query": q,
                     "total": len(hits), "points": [_cloud_view(h, h.get("score")) for h in hits]}
    pts = fleet.cloud.all_points(shard)
    return 200, {"collection": f"{COLLECTION_PREFIX}{shard}", "shard": shard, "query": "",
                 "total": len(pts), "points": [_cloud_view(p) for p in pts[:limit]]}


def h_cloud_search(body, qs):
    shard = _shard_for(body.get("collection") or "")
    if not shard:
        return 400, {"error": "unknown collection"}
    hits = fleet.cloud.search(shard, body.get("mode", "hybrid"),
                              body.get("query", ""), int(body.get("limit", 10)))
    fleet.log(fleet.active_device, "search",
              f"CLOUD {body.get('mode', 'hybrid')} search on {shard}: '{body.get('query', '')[:40]}' → {len(hits)} hits",
              {"shard": shard, "cloud": True})
    return 200, {"collection": f"{COLLECTION_PREFIX}{shard}", "shard": shard,
                 "mode": body.get("mode", "hybrid"), "points": hits}


def h_cloud_delete(body, qs):
    shard = _shard_for(body.get("collection") or "")
    pid = body.get("id")
    if not shard or not pid:
        return 400, {"error": "collection and id required"}
    ok = fleet.cloud.delete_point(shard, str(pid))
    if ok:
        fleet._invalidate_contrib()
        fleet.log(fleet.active_device, "delete",
                  f"Deleted point {str(pid)[:12]}… from cloud collection edge-{shard}",
                  {"shard": shard, "point_id": pid, "scope": "cloud"})
    return 200, {"ok": ok, "point_id": pid}


# ---------------------------------------------------------------------------
# snapshot handoff + TTL retention
# ---------------------------------------------------------------------------
def h_snapshot_export(body, qs):
    return 200, fleet.export_snapshot(_device_id(body, qs))


def h_snapshot_import(body, qs):
    snap = body.get("snapshot")
    if isinstance(snap, str):
        try:
            snap = json.loads(snap)
        except json.JSONDecodeError:
            return 400, {"ok": False, "reason": "snapshot is not valid JSON"}
    if not isinstance(snap, dict):
        return 400, {"ok": False, "reason": "snapshot object required"}
    res = fleet.import_snapshot(_device_id(body, qs), snap)
    return (200 if res.get("ok") else 400), res


def h_retention_run(body, qs):
    return 200, fleet.run_retention(_device_id(body, qs))


def h_retention_status(body, qs):
    return 200, fleet.retention_status()


# route table: (method, path) -> handler
ROUTES: Dict[tuple, Callable] = {
    ("GET",  "/api/edge/health"):           h_health,
    ("GET",  "/api/edge/state"):            h_state,
    ("GET",  "/api/edge/fleet"):            h_fleet,
    ("GET",  "/api/edge/memory"):           h_memory,
    ("GET",  "/api/edge/points"):           h_points,
    ("GET",  "/api/edge/point"):            h_get_point,
    ("POST", "/api/edge/point/delete"):     h_delete_point,
    ("POST", "/api/edge/search"):           h_search,
    ("POST", "/api/edge/write"):            h_write,
    ("POST", "/api/edge/connectivity"):     h_connectivity,
    ("POST", "/api/edge/sync"):             h_sync,
    ("POST", "/api/edge/bootstrap"):        h_bootstrap,
    ("GET",  "/api/edge/sync-status"):      h_sync_status,
    ("POST", "/api/edge/conflict/resolve"): h_conflict_resolve,
    ("POST", "/api/edge/demo/conflict"):    h_demo_conflict,
    ("GET",  "/api/edge/activity"):         h_activity,
    ("GET",  "/api/edge/policy"):           h_get_policy,
    ("PUT",  "/api/edge/policy"):           h_put_policy,
    ("POST", "/api/edge/policy/simulate"):  h_simulate_policy,
    ("POST", "/api/edge/active"):           h_active,
    ("GET",  "/api/edge/cloud/collections"): h_cloud_collections,
    ("GET",  "/api/edge/cloud/points"):      h_cloud_points,
    ("POST", "/api/edge/cloud/search"):      h_cloud_search,
    ("POST", "/api/edge/cloud/delete"):      h_cloud_delete,
    ("POST", "/api/edge/snapshot/export"):   h_snapshot_export,
    ("POST", "/api/edge/snapshot/import"):   h_snapshot_import,
    ("POST", "/api/edge/retention/run"):     h_retention_run,
    ("GET",  "/api/edge/retention/status"):  h_retention_status,
}


def _host_allowed(host: Optional[str]) -> bool:
    h = (host or "").strip().lower()
    # strip the port: "[::1]:3030" -> "[::1]", "localhost:3030" -> "localhost"
    h = h[:h.find("]") + 1] if h.startswith("[") else h.rsplit(":", 1)[0]
    return h in ALLOWED_HOSTS


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 = no keep-alive: the server closes the connection after each
    # response, so no single client (e.g. the caddy gateway) can hog the
    # single-threaded accept loop with a persistent connection. Every client
    # is served round-robin.
    protocol_version = "HTTP/1.0"
    # Socket read deadline: an idle/half-sent request would otherwise hold the
    # only handling slot forever. handle_one_request catches the TimeoutError.
    # ponytail: per-recv deadline, a 1-byte-per-9s slow drip still stalls us;
    # put a proxy with header/body timeouts in front if the port is exposed.
    timeout = 10

    def log_message(self, fmt, *args):
        # escape control chars so a crafted path can't forge log lines / terminal escapes
        msg = (fmt % args).translate(self._control_char_table)
        print(f"[edge] {self.address_string()} - {msg}", flush=True)

    def _send(self, status: int, obj: Any):
        data = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        # no Access-Control-Allow-Origin: the UI reaches us through the same-origin
        # Next.js proxy, so no other website's JS gets to read or drive the engine
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle(self, method: str):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if path != "/api/edge/health" and not _host_allowed(self.headers.get("Host")):
            self._send(403, {"error": "Host not allowed (see EDGE_ALLOWED_HOSTS)"})
            return
        if TOKEN and path != "/api/edge/health" and not hmac.compare_digest(
                self.headers.get("X-Edge-Token", "").encode("utf-8", "surrogateescape"),
                TOKEN.encode("utf-8", "surrogateescape")):
            self._send(401, {"error": "missing or wrong X-Edge-Token"})
            return
        body: dict = {}
        if method in ("POST", "PUT"):
            # JSON only: a cross-site <form> or text/plain fetch can't set this
            # without a CORS preflight, which we never grant (CSRF guard).
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._send(415, {"error": "Content-Type must be application/json"})
                return
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self._send(413, {"error": f"body must be 0..{MAX_BODY} bytes"})
                return
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._send(400, {"error": "invalid JSON body"})
                    return
                if not isinstance(body, dict):
                    self._send(400, {"error": "JSON body must be an object"})
                    return
        handler = ROUTES.get((method, path))
        if not handler:
            # try without trailing-slash normalization differences
            handler = ROUTES.get((method, parsed.path))
        if not handler:
            self._send(404, {"error": f"no route for {method} {path}"})
            return
        try:
            status, obj = handler(body, qs)
            self._send(status, obj)
        except Exception:
            traceback.print_exc()   # details stay in the server log
            try:
                self._send(500, {"error": "internal error"})
            except Exception:
                pass

    def do_GET(self):  self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self):  self._handle("PUT")


# Background TTL retention. Runs from EdgeHTTPServer.service_actions(), i.e. on
# the main thread *between* request batches — no worker thread, so the
# qdrant_edge binding still only ever sees one thread (see module docstring).
# 0 disables the ticker; sweeps are still available on demand via
# POST /api/edge/retention/run.
RETENTION_INTERVAL = max(0, int(os.environ.get("EDGE_RETENTION_INTERVAL", "15")))
_next_retention_at = time.time() + RETENTION_INTERVAL


def retention_tick() -> None:
    global _next_retention_at
    now = time.time()
    if not RETENTION_INTERVAL or now < _next_retention_at:
        return
    _next_retention_at = now + RETENTION_INTERVAL
    try:
        res = fleet.run_retention()
        if res.get("expired"):
            print(f"[edge-engine] TTL sweep: expired {res['expired']}/{res['checked']} "
                  f"raw sensor point(s)", flush=True)
    except Exception:  # noqa: BLE001 — a failed sweep must never kill the server
        traceback.print_exc()


class EdgeHTTPServer(HTTPServer):
    # Larger listen backlog so the single-threaded server doesn't refuse
    # connections while busy on a slow request (sync/bootstrap/embed).
    request_queue_size = 128
    allow_reuse_address = True

    def service_actions(self) -> None:
        retention_tick()


def main():
    server = EdgeHTTPServer((BIND, PORT), Handler)
    server.socket.setsockopt(__import__("socket").IPPROTO_TCP, __import__("socket").TCP_NODELAY, 1)
    print(f"[edge-engine] listening on http://{BIND}:{PORT} (single-threaded, main thread, backlog=128)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[edge-engine] shutting down", flush=True)


if __name__ == "__main__":
    main()
