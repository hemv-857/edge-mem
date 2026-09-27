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

const PORT = /^\d{2,5}$/;

async function proxy(req: Request, method: string, path: string[]) {
  const url = new URL(req.url);
  const port = url.searchParams.get("XTransformPort");
  if (!port || !PORT.test(port)) {
    return NextResponse.json(
      { error: "XTransformPort query param required (e.g. ?XTransformPort=3030)" },
      { status: 400 },
    );
  }

  url.searchParams.delete("XTransformPort");
  const target = `http://127.0.0.1:${port}/api/edge/${path.join("/")}${url.search}`;

  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = {
      ...init.headers,
      "content-type": req.headers.get("content-type") ?? "application/json",
    };
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, { ...init, cache: "no-store" });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `edge-engine unreachable on port ${port}: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
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
