"""Regression checks for the engine HTTP surface (main.py), runnable without
qdrant_edge/fastembed: engine, embed and seed are stubbed.

    python3 mini-services/edge-engine/tests/test_http_surface.py
"""
import os
import socket
import sys
import threading
import time
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for name in ("engine", "embed", "seed"):
    sys.modules[name] = mock.MagicMock()
import main as M  # noqa: E402

assert M.Handler.timeout and M.Handler.timeout <= 30, "Handler needs a socket timeout"
M.Handler.timeout = 1  # keep the stall test short


def request(port, raw, timeout=5):
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(raw)
        return s.recv(4096).split(b"\r\n", 1)[0]


def main():
    M.ROUTES[("GET", "/api/edge/ping")] = lambda body, qs: (200, {"ok": True})
    M.ROUTES[("GET", "/api/edge/boom")] = lambda body, qs: 1 / 0
    srv = M.EdgeHTTPServer(("127.0.0.1", 0), M.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()  # test only; the engine stays single-threaded

    # an idle socket and a half-sent POST body must not stall the next client
    idle = socket.create_connection(("127.0.0.1", port))
    t0 = time.monotonic()
    assert request(port, b"GET /api/edge/ping HTTP/1.0\r\nHost: localhost\r\n\r\n").endswith(b"200 OK")
    assert time.monotonic() - t0 < 4
    half = socket.create_connection(("127.0.0.1", port))
    half.sendall(b"POST /api/edge/ping HTTP/1.0\r\nHost: localhost\r\n"
                 b"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
    time.sleep(0.1)
    assert request(port, b"GET /api/edge/ping HTTP/1.0\r\nHost: 127.0.0.1:3030\r\n\r\n").endswith(b"200 OK")
    idle.close(); half.close()

    # Host allowlist (DNS rebinding); /health stays exempt
    assert request(port, b"GET /api/edge/ping HTTP/1.0\r\nHost: evil.example:3030\r\n\r\n").endswith(b"403 Forbidden")
    assert request(port, b"GET /api/edge/ping HTTP/1.0\r\n\r\n").endswith(b"403 Forbidden")
    assert request(port, b"GET /api/edge/ping HTTP/1.0\r\nHost: [::1]:3030\r\n\r\n").endswith(b"200 OK")

    # 500 does not echo exception text
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(b"GET /api/edge/boom HTTP/1.0\r\nHost: localhost\r\n\r\n")
        resp = b"".join(iter(lambda: s.recv(4096), b""))
    assert b"500" in resp.split(b"\r\n", 1)[0] and b"division" not in resp and b"internal error" in resp

    # non-ASCII token header is a clean 401, not an exception
    M.TOKEN = "secret"
    assert request(port, "GET /api/edge/ping HTTP/1.0\r\nHost: localhost\r\nX-Edge-Token: é\r\n\r\n"
                   .encode("latin-1")).endswith(b"401 Unauthorized")
    M.TOKEN = ""
    srv.shutdown()

    # log lines escape control characters
    h = M.Handler.__new__(M.Handler)
    h.client_address = ("127.0.0.1", 1)
    with mock.patch("builtins.print") as p:
        h.log_message("%s", "GET /\x1b[2J\nfake")
    assert "\x1b" not in p.call_args[0][0] and "\n" not in p.call_args[0][0]

    # policy residency floor
    r1 = {"id": "r1", "field": "sensitivity", "op": "in", "values": ["restricted"], "action": "local_only", "reason": ""}
    pub = {"id": "p", "field": "sensitivity", "op": "eq", "value": "public", "action": "sync_now", "reason": ""}
    crit = {"id": "c", "field": "criticality", "op": "eq", "value": "critical", "action": "sync_now", "reason": ""}
    pol = lambda *rules: {"rules": list(rules), "ttl_raw_sensor_seconds": 0}
    assert M.validate_policy(pol(r1, crit)) is None
    assert M.validate_policy(pol(pub, r1, crit)) is None
    assert M.validate_policy(pol()) is not None
    assert M.validate_policy(pol(crit, r1)) is not None
    assert M.validate_policy(pol({**r1, "action": "queued"})) is not None

    # opt-in background sync: only online devices with a queue, exponential backoff on failure
    dev = mock.Mock(online=True, queue=[1], id="d")
    M.fleet = mock.Mock(devices={"d": dev})
    M.AUTOSYNC_INTERVAL, M._next_autosync_at = 10, 0
    M.fleet.sync.return_value = {"ok": False}
    M.autosync_tick()
    assert M.fleet.sync.call_count == 1 and M._autosync_fails == 1
    assert 19 < M._next_autosync_at - time.time() <= 20   # 10s * 2**1
    M.autosync_tick()                                       # not due yet
    assert M.fleet.sync.call_count == 1
    M._next_autosync_at = 0
    dev.online = False
    M.autosync_tick()                                       # offline: nothing to try, counts as healthy
    assert M.fleet.sync.call_count == 1 and M._autosync_fails == 0
    M.AUTOSYNC_INTERVAL = 0
    print("ok")


if __name__ == "__main__":
    main()
