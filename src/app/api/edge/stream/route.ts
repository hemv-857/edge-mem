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

async function snap(): Promise<Snapshot> {
  const [st, ss] = await Promise.all([
    fetch(`${ENGINE}/api/edge/state`, { cache: "no-store", headers: HEADERS }).then((r) => r.json() as Promise<EngineState>),
    fetch(`${ENGINE}/api/edge/sync-status`, { cache: "no-store", headers: HEADERS }).then((r) => r.json() as Promise<{ queue_depth?: number; open_conflicts?: unknown[] }>),
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

export async function GET() {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const beat = async () => {
        try {
          send("metrics", await snap());
        } catch {
          send("error", { ts: Date.now(), reason: "edge-engine unreachable" });
        }
      };

      await beat();
      const timer = setInterval(beat, TICK_MS);
      const keepalive = setInterval(() => send("ping", { ts: Date.now() }), 15000);

      // hold the response open until the client disconnects (cancel() fires)
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (closed) {
            clearInterval(poll);
            resolve();
          }
        }, 400);
      });

      clearInterval(timer);
      clearInterval(keepalive);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      closed = true;
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
