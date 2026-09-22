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

import json
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from typing import Any, Callable, Dict, Optional

import embed
import engine as E
import seed as S

PORT = 3030
_started_at = time.time()

print("[edge-engine] booting — creating Fleet on main thread...", flush=True)
fleet = E.Fleet()
try:
    embed.get_dense(); embed.get_bm25()
except Exception:
    pass
S.seed_fleet(fleet)
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
    }

def h_state(body, qs):
    live = [{"id": d.id, "name": d.name, "location": d.location,
             "technician": d.technician, "online": d.online, "live": True,
             "total_points": d.memory_stats()["total_points"]}
            for d in fleet.devices.values()]
    remote = [{"id": m["id"], "name": m["name"], "location": m["location"],
               "technician": m["technician"], "online": True, "live": False,
               "kind": m["kind"], "total_points": 0}
              for m in fleet.remote_members]
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

def h_search(body, qs):
    try:
        return 200, fleet.search(body.get("device") or fleet.active_device,
                                 body.get("shard", "incidents"), body.get("query", ""),
                                 body.get("mode", "hybrid"), int(body.get("limit", 5)))
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

def h_put_policy(body, qs):
    fleet.policy = body
    fleet.log("system", "policy", "Policy rules updated", {})
    return 200, fleet.policy

def h_active(body, qs):
    dev = body.get("device")
    if dev not in fleet.devices:
        return 400, {"error": f"{dev} is a remote fleet member — only {fleet.active_device} is a live local device"}
    fleet.active_device = dev
    fleet.log(dev, "system", f"Active device switched to {dev}", {})
    return 200, {"active_device": dev}


# route table: (method, path) -> handler
ROUTES: Dict[tuple, Callable] = {
    ("GET",  "/api/edge/health"):           h_health,
    ("GET",  "/api/edge/state"):            h_state,
    ("GET",  "/api/edge/fleet"):            h_fleet,
    ("GET",  "/api/edge/memory"):           h_memory,
    ("GET",  "/api/edge/points"):           h_points,
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
    ("POST", "/api/edge/active"):           h_active,
}


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 = no keep-alive: the server closes the connection after each
    # response, so no single client (e.g. the caddy gateway) can hog the
    # single-threaded accept loop with a persistent connection. Every client
    # is served round-robin.
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        print(f"[edge] {self.address_string()} - {fmt % args}", flush=True)

    def _send(self, status: int, obj: Any):
        data = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
        body: dict = {}
        if method in ("POST", "PUT"):
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    self._send(400, {"error": "invalid JSON body"})
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
        except Exception as e:
            traceback.print_exc()
            try:
                self._send(500, {"error": str(e), "type": type(e).__name__})
            except Exception:
                pass

    def do_GET(self):  self._handle("GET")
    def do_POST(self): self._handle("POST")
    def do_PUT(self):  self._handle("PUT")
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


class EdgeHTTPServer(HTTPServer):
    # Larger listen backlog so the single-threaded server doesn't refuse
    # connections while busy on a slow request (sync/bootstrap/embed).
    request_queue_size = 128
    allow_reuse_address = True


def main():
    server = EdgeHTTPServer(("0.0.0.0", PORT), Handler)
    server.socket.setsockopt(__import__("socket").IPPROTO_TCP, __import__("socket").TCP_NODELAY, 1)
    print(f"[edge-engine] listening on http://0.0.0.0:{PORT} (single-threaded, main thread, backlog=128)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[edge-engine] shutting down", flush=True)


if __name__ == "__main__":
    main()
