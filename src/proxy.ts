// Host / cross-site guard for every /api route.
//
// The /api/edge proxy attaches EDGE_TOKEN for the caller and /api/intelligence
// spends a paid LLM key, so neither can trust "the browser's same-origin policy"
// alone: a DNS-rebinding domain pointed at this box *is* same-origin. Pin the
// Host, and refuse cross-site state-changing requests.
//
//   EDGE_ALLOWED_HOSTS  extra hostnames (or host:port) the app is served on,
//                       comma-separated, e.g. "edge-01.plant.lan,10.0.4.21"
import { NextResponse, type NextRequest } from "next/server";

// Deployed hosts come from the platform: Vercel publishes the deployment's own
// hostnames as env vars, so a request pinned to them is still same-origin.
const csv = (s?: string) => (s ?? "").split(",");
const ALLOWED_HOSTS = new Set(
  [
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...csv(process.env.EDGE_ALLOWED_HOSTS),
    ...csv(process.env.VERCEL_URL),
    ...csv(process.env.VERCEL_BRANCH_URL),
    ...csv(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOk(host: string | null): boolean {
  if (!host) return false;
  host = host.toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return ALLOWED_HOSTS.has(name) || ALLOWED_HOSTS.has(host);
}

export function proxy(req: NextRequest) {
  if (!hostOk(req.headers.get("host"))) {
    return NextResponse.json({ error: "host not allowed" }, { status: 403 });
  }
  // browsers always send Sec-Fetch-Site; non-browser clients (curl, peers) omit it
  const site = req.headers.get("sec-fetch-site");
  if (!SAFE_METHODS.has(req.method) && site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
