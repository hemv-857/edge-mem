// SSE relay for live edge metrics.
//
// ponytail: the Python engine is single-threaded and cannot hold a long-lived
// connection (it would block every other request), so this route polls the
// engine and pushes snapshots over SSE. Ceiling: ~1s freshness; move the
// engine to an async server if genuinely event-driven metrics are ever needed.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENGINE = process.env.EDGE_URL ?? "http://localhost:3030";
const TICK_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;
const HEADERS: HeadersInit = process.env.EDGE_TOKEN ? { "x-edge-token": process.env.EDGE_TOKEN } : {};

interface Snapshot {
  ts: number;
  local_points: number;
  cloud_points: number;
  devices: number;
  federated_reachable: number;
  queue_depth: number;
  open_conflicts: number;
}

interface EngineState {
  cloud?: { total_points?: number };
  devices?: { total_points?: number; reachable?: boolean }[];
}

type Event = { event: "metrics" | "error"; data: unknown };

async function snap(): Promise<Snapshot> {
  const init = { cache: "no-store", headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } as const;
  const [st, ss] = await Promise.all([
    fetch(`${ENGINE}/api/edge/state`, init).then((r) => r.json() as Promise<EngineState>),
    fetch(`${ENGINE}/api/edge/sync-status`, init).then((r) => r.json() as Promise<{ queue_depth?: number; open_conflicts?: unknown[] }>),
  ]);
  const devices = st.devices ?? [];
  return {
    ts: Date.now(),
    local_points: devices.reduce((a, d) => a + (d.total_points ?? 0), 0),
    cloud_points: st.cloud?.total_points ?? 0,
    devices: devices.length,
    federated_reachable: devices.filter((d) => d.reachable).length,
    queue_depth: ss.queue_depth ?? 0,
    open_conflicts: (ss.open_conflicts ?? []).length,
  };
}

// One poller shared by every open stream: N browser tabs cost the single-threaded
// engine one request pair per tick, not N. A tick is skipped while one is in flight.
let latest: Event | null = null;
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(e: Event) => void>();

async function tick() {
  if (inflight) return;
  inflight = true;
  try {
    latest = { event: "metrics", data: await snap() };
  } catch {
    latest = { event: "error", data: { ts: Date.now(), reason: "edge-engine unreachable" } };
  } finally {
    inflight = false;
  }
  for (const l of listeners) l(latest);
}

function subscribe(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  if (latest) fn(latest);
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    void tick();
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
      latest = null; // don't greet the next subscriber with a stale snapshot
    }
  };
}

export async function GET() {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup(); // client gone
        }
      };
      const unsubscribe = subscribe((e) => send(e.event, e.data));
      const keepalive = setInterval(() => send("ping", { ts: Date.now() }), 15000);
      cleanup = () => {
        unsubscribe();
        clearInterval(keepalive);
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
