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

type Body =
  | { action: "distill_sop"; text: string; asset_id?: string }
  | { action: "auto_tag"; text: string };

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function chat(messages: Msg[]): Promise<string> {
  const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("LLM_API_KEY (or OPENAI_API_KEY) is not set");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

const SOP_SYSTEM = `You are a senior industrial maintenance engineer distilling field incident notes into a concise, reusable Standard Operating Procedure (SOP) update. Output ONLY the SOP text — no preamble, no markdown headings. Structure: one short title line, then numbered steps (max 8), then a "Verification:" line with pass criteria. Reference torque/ clearance/ threshold values from the incident when given. Keep it under 120 words. Field-technician tone, imperative voice.`;

const TAG_SYSTEM = `You are a reliability engineer classifying a maintenance note. Respond with ONLY a single JSON object, no prose, no code fences: {"criticality":"low|medium|high|critical","sensitivity":"internal|restricted|public","reason":"<<=12 words>"}. Critical = safety/production-down/severity above ISO 10816 zone D. Restricted = personal/PII/contractor-sensitive. Default internal.`;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = (body?.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  try {
    if (body.action === "distill_sop") {
      const userPrompt = `Incident note (asset ${body.asset_id ?? "unknown"}):\n"""\n${text}\n"""\n\nDistill this into a reusable SOP update.`;
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
        reason: parsed.reason ?? "auto-classified",
        raw,
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
