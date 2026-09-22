// Cloud intelligence layer (online-only).
// Uses z-ai-web-dev-sdk (server-side only). This is the "cloud LLM" half of the
// edge/cloud division of labor: the edge does offline hybrid retrieval; the
// cloud LLM does synthesis (distill incidents → SOP) and classification
// (auto-tag criticality/sensitivity) — only reachable when the device is online.
import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body =
  | { action: "distill_sop"; text: string; asset_id?: string }
  | { action: "auto_tag"; text: string };

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
    const zai = await ZAI.create();
    if (body.action === "distill_sop") {
      const userPrompt = `Incident note (asset ${body.asset_id ?? "unknown"}):\n"""\n${text}\n"""\n\nDistill this into a reusable SOP update.`;
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: SOP_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        thinking: { type: "disabled" },
        stream: false,
      });
      const sop = completion.choices?.[0]?.message?.content?.trim() ?? "";
      return NextResponse.json({ ok: true, sop, action: "distill_sop" });
    }
    if (body.action === "auto_tag") {
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: TAG_SYSTEM },
          { role: "user", content: `Classify this note:\n"""\n${text}\n"""` },
        ],
        thinking: { type: "disabled" },
        stream: false,
      });
      const raw = completion.choices?.[0]?.message?.content?.trim() ?? "";
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
