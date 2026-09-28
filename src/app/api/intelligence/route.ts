// Cloud intelligence layer (online-only).
// Talks to any OpenAI-compatible /chat/completions endpoint (server-side only, native
// fetch — no SDK). This is the "cloud LLM" half of the edge/cloud division of labor:
// the edge does offline hybrid retrieval; the cloud LLM does synthesis (distill
// incidents → SOP) and classification (auto-tag criticality/sensitivity) — only
// reachable when the device is online.
//
// Configure via env (defaults shown):
//   LLM_BASE_URL  https://api.openai.com/v1
//   LLM_API_KEY    (falls back to OPENAI_API_KEY)
//   LLM_MODEL      gpt-4o-mini
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_URL = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const MAX_TEXT = 8000;
const MAX_BODY = 64 * 1024; // 8000 chars of \uXXXX-escaped JSON fits with room to spare
const MAX_PROMPT = MAX_TEXT + 1000; // text + fixed template + a 64-char asset id
const ASSET_ID = /^[\w.-]{1,64}$/;

type Body =
  | { action: "distill_sop"; text: string; asset_id?: string }
  | { action: "auto_tag"; text: string };

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function chat(messages: Msg[]): Promise<string> {
  // every field that reaches the paid prompt is bounded; this catches the next one added
  if (messages.some((m) => m.role === "user" && m.content.length > MAX_PROMPT)) throw new Error("prompt too long");
  const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("LLM_API_KEY (or OPENAI_API_KEY) is not set");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
    cache: "no-store",
  });
  // provider bodies can echo request details; log them server-side, don't return them
  if (!res.ok) {
    console.error("[intelligence] LLM error", res.status, (await res.text()).slice(0, 500));
    throw new Error(`LLM request failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

const SOP_SYSTEM = `You are a senior industrial maintenance engineer distilling field incident notes into a concise, reusable Standard Operating Procedure (SOP) update. Output ONLY the SOP text — no preamble, no markdown headings. Structure: one short title line, then numbered steps (max 8), then a "Verification:" line with pass criteria. Reference torque/ clearance/ threshold values from the incident when given. Keep it under 120 words. Field-technician tone, imperative voice.`;

const TAG_SYSTEM = `You are a reliability engineer classifying a maintenance note. Respond with ONLY a single JSON object, no prose, no code fences: {"criticality":"low|medium|high|critical","sensitivity":"internal|restricted|public","reason":"<<=12 words>"}. Critical = safety/production-down/severity above ISO 10816 zone D. Restricted = personal/PII/contractor-sensitive. Default internal.`;

export async function POST(req: Request) {
  // req.json() parses any Content-Type, so a cross-site text/plain "simple request"
  // (no preflight) would otherwise reach the paid LLM. Require JSON like the engine does.
  const ctype = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ctype !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: Body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return NextResponse.json({ error: "body too large" }, { status: 413 });
    body = JSON.parse(raw) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  // unauthenticated route in front of a paid API key — bound the spend per call
  if (text.length > MAX_TEXT) return NextResponse.json({ error: `text over ${MAX_TEXT} chars` }, { status: 413 });
  // UI sends null/"" for notes without an asset — treat as absent
  const assetId = (body.action === "distill_sop" && body.asset_id) || undefined;
  if (assetId !== undefined && (typeof assetId !== "string" || !ASSET_ID.test(assetId))) {
    return NextResponse.json({ error: "invalid asset_id" }, { status: 400 });
  }

  try {
    if (body.action === "distill_sop") {
      const userPrompt = `Incident note (asset ${assetId ?? "unknown"}):\n"""\n${text}\n"""\n\nDistill this into a reusable SOP update.`;
      const sop = await chat([
        { role: "system", content: SOP_SYSTEM },
        { role: "user", content: userPrompt },
      ]);
      return NextResponse.json({ ok: true, sop, action: "distill_sop" });
    }
    if (body.action === "auto_tag") {
      const raw = await chat([
        { role: "system", content: TAG_SYSTEM },
        { role: "user", content: `Classify this note:\n"""\n${text}\n"""` },
      ]);
      let parsed: { criticality?: string; sensitivity?: string; reason?: string } = {};
      try {
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : {};
      } catch {
        /* leave empty */
      }
      return NextResponse.json({
        ok: true,
        action: "auto_tag",
        criticality: ["low", "medium", "high", "critical"].includes(parsed.criticality ?? "")
          ? parsed.criticality
          : "medium",
        sensitivity: ["internal", "restricted", "public"].includes(parsed.sensitivity ?? "")
          ? parsed.sensitivity
          : "internal",
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 160) : "auto-classified",
      });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, note: "Cloud LLM unavailable — the edge still operates offline; this only affects online synthesis." },
      { status: 502 },
    );
  }
}
