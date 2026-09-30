// Gateway fallback for the edge-engine mini-service.
//
// The app is normally fronted by Caddy (Caddyfile), which reads the
// ?XTransformPort=NNNN query param and reverse-proxies to that port. Without a
// gateway installed, every data call 404s — so this route does the same job in
// Next.js itself, letting `bun run dev` stand alone on a clean machine.
// When a gateway *is* present it still intercepts these requests first, so the
// two never conflict.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Only the edge engines may be reached — without this list the proxy is an open
// SSRF relay to every localhost service (e.g. Qdrant's unauthenticated :6333).
const ALLOWED_PORTS = new Set((process.env.EDGE_PORTS ?? "3030,3031").split(",").map((p) => p.trim()));
const TOKEN = process.env.EDGE_TOKEN;
// Remote engine (Render/another host): when set, calls go there instead of a
// loopback port. Operator-set, so not part of the SSRF surface.
const REMOTE = (process.env.EDGE_URL ?? "").replace(/\/+$/, "");
const MAX_BODY = 8 * 1024 * 1024; // same cap the engine enforces
// Remote engines sleep on free plans (Render cold start measured ~12s) — a
// loopback engine answers in ms, a remote one sometimes needs a whole boot.
const TIMEOUT_MS = REMOTE ? 30_000 : 10_000;

async function proxy(req: Request, method: string, path: string[]) {
  const url = new URL(req.url);
  const port = url.searchParams.get("XTransformPort");
  if (!port) {
    return NextResponse.json(
      { error: "XTransformPort query param required (e.g. ?XTransformPort=3030)" },
      { status: 400 },
    );
  }
  if (!ALLOWED_PORTS.has(port)) {
    return NextResponse.json({ error: `port ${port} is not an edge engine` }, { status: 403 });
  }
  // `..` (or its %2e spelling, which the URL parser also resolves) would let
  // fetch() normalise the target out of /api/edge/
  if (path.some((seg) => /^(\.|%2e){1,2}$/i.test(seg) || seg.includes("/") || seg.includes("\\"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  url.searchParams.delete("XTransformPort");
  const target = `${REMOTE || `http://127.0.0.1:${port}`}/api/edge/${path.join("/")}${url.search}`;
  if (!new URL(target).pathname.startsWith("/api/edge/")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (TOKEN) headers["x-edge-token"] = TOKEN;
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    // forwarded as-is: the engine rejects non-JSON bodies, which is what stops
    // a cross-site <form>/text/plain POST from driving it
    headers["content-type"] = req.headers.get("content-type") ?? "";
    // ponytail: chunked bodies are still buffered before the length check; stream-count if that matters
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return NextResponse.json({ error: "body too large" }, { status: 413 });
    }
    init.body = await req.text();
    if (init.body.length > MAX_BODY) return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  try {
    const res = await fetch(target, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    console.error("[edge-proxy]", port, e);
    return NextResponse.json({ error: `edge-engine unreachable at ${new URL(target).host}` }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  return proxy(req, "GET", (await params).path);
}
export async function POST(req: Request, { params }: Ctx) {
  return proxy(req, "POST", (await params).path);
}
export async function PUT(req: Request, { params }: Ctx) {
  return proxy(req, "PUT", (await params).path);
}
