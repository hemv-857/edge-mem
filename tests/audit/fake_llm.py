#!/usr/bin/env python3
"""Deterministic OpenAI-compatible stub used by CI.

The EDGE->CLOUD AI workflow in tests/audit/audit.py asserts that the app can
reach *an* OpenAI-compatible /chat/completions endpoint and apply its answer to
the note. Model quality is not under test, and CI is not going to pull a
multi-GB local model, so it serves this instead — same wire format as
Ollama/Groq/OpenAI.  Start it before `next dev` with:

    LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_API_KEY=ci LLM_MODEL=stub
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("FAKE_LLM_PORT", "11434"))

SOP = """P-202 bearing replacement — field SOP

1. Isolate and lock out the P-202 drive before opening the housing.
2. Confirm shaft runout is within 0.05 mm before reassembly.
3. Torque the bearing cap bolts to 50 Nm in a cross pattern.
4. Restart and record vibration on both ends.
Verification: vibration under 4.5 mm/s RMS and bearing housing below 70 C for ten minutes."""

HOT = ("stopped", "halt", "down", "overheat", "trip", "emergency", "line", "fail")
SEVERE = ("seiz", "smoke", "fire", "injur", "spill")
RESTRICTED = ("contractor", "employee", "ssn", "medical", "personal")


def classify(text: str) -> str:
    low = text.lower()
    if any(w in low for w in SEVERE):
        return "critical"
    if any(w in low for w in HOT):
        return "high"
    return "medium"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # keep CI logs readable
        pass

    def _reply(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._reply(200, {"object": "list",
                              "data": [{"id": "stub", "object": "model"}]})
            return
        self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._reply(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._reply(400, {"error": "invalid JSON"})
            return

        messages = body.get("messages") or []
        system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
        user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")

        if "JSON object" in system:  # auto_tag
            low = user.lower()
            content = json.dumps({
                "criticality": classify(user),
                "sensitivity": "restricted" if any(w in low for w in RESTRICTED) else "internal",
                "reason": "classified by CI stub from note keywords",
            })
        else:  # distill_sop
            content = SOP

        self._reply(200, {
            "id": "cmpl-stub",
            "object": "chat.completion",
            "model": body.get("model", "stub"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
        })


def main() -> None:
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[fake-llm] OpenAI-compatible stub on http://127.0.0.1:{PORT}/v1", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
