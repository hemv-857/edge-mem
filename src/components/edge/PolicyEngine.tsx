"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Shield, Save, Route, Info, Clock, ListOrdered, Loader2, RotateCcw,
  FlaskConical, Play, Check, X, ArrowRight,
} from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { Policy, PolicyRule } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Panel, SyncStateBadge } from "./edge-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const ACTIONS: PolicyRule["action"][] = ["local_only", "queued", "sync_now"];

const ACTION_TRIGGER: Record<PolicyRule["action"], string> = {
  local_only: "border-amber-500/40 text-amber-300 bg-amber-500/5",
  queued: "border-amber-500/40 text-amber-300 bg-amber-500/5",
  sync_now: "border-rose-500/40 text-rose-300 bg-rose-500/5",
};

const LEGEND: { action: PolicyRule["action"]; desc: string }[] = [
  { action: "local_only", desc: "stays on-device" },
  { action: "queued", desc: "batched upload when online" },
  { action: "sync_now", desc: "jumps queue, retry aggressive" },
];

export default function PolicyEngine({ edge }: { edge: EdgeHook }) {
  const serverPolicy = edge.state?.policy ?? null;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const lastSeenSig = useRef<string>("");

  // re-init local copy when the server-side policy actually changes
  // (won't clobber in-progress edits, since edits don't change server state)
  useEffect(() => {
    if (!serverPolicy) return;
    const sig = JSON.stringify(serverPolicy);
    if (sig !== lastSeenSig.current) {
      lastSeenSig.current = sig;
      setPolicy(serverPolicy);
    }
  }, [serverPolicy]);

  const currentSig = useMemo(() => (policy ? JSON.stringify(policy) : ""), [policy]);
  const isDirty = policy !== null && currentSig !== lastSeenSig.current;

  const updateRuleAction = useCallback((idx: number, action: PolicyRule["action"]) => {
    setPolicy((prev) => {
      if (!prev) return prev;
      const rules = prev.rules.map((r, i) => (i === idx ? { ...r, action } : r));
      return { ...prev, rules };
    });
  }, []);

  const updateTtl = useCallback((raw: string) => {
    const n = parseInt(raw, 10);
    setPolicy((prev) =>
      prev ? { ...prev, ttl_raw_sensor_seconds: Number.isFinite(n) && n >= 0 ? n : 0 } : prev,
    );
  }, []);

  const revert = useCallback(() => {
    if (serverPolicy) {
      setPolicy(serverPolicy);
    }
  }, [serverPolicy]);

  const handleSave = useCallback(async () => {
    if (!policy || !isDirty || saving) return;
    setSaving(true);
    try {
      await edgeApi.putPolicy(policy);
      toast({
        title: "Policy saved",
        description: `${policy.rules.length} rules · ttl ${policy.ttl_raw_sensor_seconds}s`,
      });
      await edge.refresh();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }, [policy, isDirty, saving, edge]);

  return (
    <Panel
      title="Policy Engine"
      desc="Routes every written point: local-only / queued / sync-now — the edge↔cloud decision layer"
      right={
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1">
          <Shield className="h-3.5 w-3.5 text-emerald-400" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {policy ? `${policy.rules.length} rules` : "—"}
          </span>
        </div>
      }
    >
      {!policy ? (
        <PolicyLoadingSkeleton />
      ) : (
        <div className="space-y-5">
          {/* explainer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Every point is tagged on write with{" "}
              <span className="font-mono text-foreground/80">sensitivity</span>,{" "}
              <span className="font-mono text-foreground/80">criticality</span>, and{" "}
              <span className="font-mono text-foreground/80">domain</span>. The rule set
              below is evaluated top-down; the first match decides{" "}
              <span className="font-mono text-foreground/80">sync_state</span>. Restricted
              data and raw sensors never leave the device; critical anomalies jump the queue.
            </p>
          </div>

          {/* rule table */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListOrdered className="h-3.5 w-3.5 text-emerald-400" />
                <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
                  routing rules
                </h3>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                evaluated top-down · first match wins
              </span>
            </div>

            <div className="space-y-2">
              {policy.rules.map((rule, idx) => (
                <RuleRow
                  key={rule.id}
                  index={idx}
                  rule={rule}
                  onActionChange={(a) => updateRuleAction(idx, a)}
                />
              ))}
            </div>
          </div>

          {/* ttl + save */}
          <div className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card/30 p-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1.5">
              <label
                htmlFor="ttl"
                className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                <Clock className="h-3 w-3" />
                ttl_raw_sensor_seconds
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="ttl"
                  type="number"
                  min={0}
                  step={1}
                  value={policy.ttl_raw_sensor_seconds}
                  onChange={(e) => updateTtl(e.target.value)}
                  className="h-9 w-32 font-mono text-sm tabular-nums"
                />
                <span className="font-mono text-[10px] text-muted-foreground">
                  raw sensor points expire after this window
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={revert}
                  disabled={saving}
                  className="gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  revert
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={!isDirty || saving}
                className={cn(
                  "gap-1.5 font-mono text-xs",
                  isDirty
                    ? "bg-emerald-500/90 text-emerald-950 hover:bg-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {saving ? "saving…" : "save policy"}
              </Button>
            </div>
          </div>

          {/* routing legend */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Route className="h-3.5 w-3.5 text-emerald-400" />
              <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
                routing legend
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {LEGEND.map(({ action, desc }) => (
                <div
                  key={action}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border bg-card/40 p-3",
                    action === "sync_now"
                      ? "border-rose-500/25"
                      : "border-amber-500/25",
                  )}
                >
                  <SyncStateBadge value={action} />
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* version note */}
          <div className="flex items-center gap-2 border-t border-border/60 pt-3 font-mono text-[10px] text-muted-foreground">
            <Info className="h-3 w-3" />
            <span>
              rules are evaluated top-down; first match wins · ttl governs raw-sensor
              expiry · edits apply to the next write
            </span>
          </div>

          {/* simulate panel */}
          <SimulatePanel policy={policy} />
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* simulate panel — test a point against the rules without writing              */
/* -------------------------------------------------------------------------- */

interface SimTrace {
  id: string;
  field: string;
  op: string;
  value?: string;
  values?: string[];
  point_value: string;
  matched: boolean;
  action: string;
  reason: string;
  is_match: boolean;
}

function SimulatePanel({ policy }: { policy: Policy | null }) {
  const [domain, setDomain] = useState("incident");
  const [criticality, setCriticality] = useState("high");
  const [sensitivity, setSensitivity] = useState("internal");
  const [result, setResult] = useState<{ decision: { sync_state: string; matched_rule: string | null; reason: string }; trace: SimTrace[] } | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (!policy) return;
    setRunning(true);
    try {
      const r = await edgeApi.simulatePolicy({ text: "(simulated — no write)", criticality, sensitivity, domain });
      setResult(r);
    } catch (e) {
      toast({ title: "Simulate failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  // quick presets
  const presets = [
    { label: "critical incident", domain: "incident", criticality: "critical", sensitivity: "internal" },
    { label: "restricted sensor", domain: "sensor", criticality: "medium", sensitivity: "restricted" },
    { label: "routine manual", domain: "manual", criticality: "low", sensitivity: "internal" },
  ];

  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-3.5 w-3.5 text-sky-300" />
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
            simulate
          </h3>
          <span className="font-mono text-[10px] text-muted-foreground">— test tags against rules (no write)</span>
        </div>
      </div>

      {/* tag selectors */}
      <div className="grid grid-cols-3 gap-2">
        <TagSelect label="domain" value={domain} onChange={setDomain} options={["manual", "incident", "sensor"]} />
        <TagSelect label="criticality" value={criticality} onChange={setCriticality} options={["low", "medium", "high", "critical"]} />
        <TagSelect label="sensitivity" value={sensitivity} onChange={setSensitivity} options={["internal", "restricted", "public"]} />
      </div>

      {/* presets */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => { setDomain(p.domain); setCriticality(p.criticality); setSensitivity(p.sensitivity); }}
            className="rounded-full border border-border bg-card/40 px-2 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:border-sky-500/30 hover:text-sky-300"
          >
            {p.label}
          </button>
        ))}
      </div>

      <Button
        size="sm"
        onClick={run}
        disabled={running || !policy}
        className="mt-3 gap-1.5 bg-sky-500/80 font-mono text-xs text-sky-950 hover:bg-sky-400"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        simulate
      </Button>

      {/* result */}
      {result && (
        <div className="mt-3 space-y-2">
          {/* decision-flow diagram: tags → rules → decision */}
          <div className="flex items-center gap-2 rounded-md border border-border bg-background/30 p-2.5">
            {/* tags */}
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">tags</span>
              <div className="flex flex-col gap-0.5">
                <TagChip label={`domain=${domain}`} />
                <TagChip label={`crit=${criticality}`} />
                <TagChip label={`sens=${sensitivity}`} />
              </div>
            </div>
            {/* arrow */}
            <div className="flex flex-1 items-center justify-center">
              <div className="flex items-center gap-1">
                <div className="h-px w-8 bg-border" />
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">{result.trace.length} rules</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <div className="h-px w-8 bg-border" />
              </div>
            </div>
            {/* decision */}
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">decision</span>
              <SyncStateBadge value={result.decision.sync_state} />
              {result.decision.matched_rule && (
                <span className="font-mono text-[9px] text-muted-foreground">← {result.decision.matched_rule}</span>
              )}
            </div>
          </div>

          {/* decision detail */}
          <div className={cn(
            "flex items-center gap-2 rounded-md border p-2.5",
            result.decision.sync_state === "sync_now" ? "border-rose-500/30 bg-rose-500/5"
              : result.decision.sync_state === "local_only" ? "border-amber-500/30 bg-amber-500/5"
              : "border-emerald-500/30 bg-emerald-500/5"
          )}>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">decision</span>
            <SyncStateBadge value={result.decision.sync_state} />
            <span className="ml-auto text-[11px] text-muted-foreground">{result.decision.reason}</span>
          </div>

          {/* trace */}
          <div className="space-y-1">
            {result.trace.map((t, i) => (
              <div
                key={t.id}
                className={cn(
                  "flex items-center gap-2 rounded border px-2 py-1.5 font-mono text-[10px]",
                  t.is_match ? "border-emerald-500/30 bg-emerald-500/5"
                    : t.matched ? "border-amber-500/20 bg-amber-500/5"
                    : "border-border bg-muted/20"
                )}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] tabular-nums text-muted-foreground">{i + 1}</span>
                {t.is_match ? <Check className="h-3 w-3 text-emerald-400" /> : t.matched ? <Check className="h-3 w-3 text-amber-400" /> : <X className="h-3 w-3 text-muted-foreground/40" />}
                <span className="text-foreground/80">{t.field} {t.op} {t.op === "in" ? (t.values ?? []).join(", ") : t.value}</span>
                <span className="text-muted-foreground/60">· point: {t.point_value}</span>
                <span className="ml-auto text-muted-foreground">{t.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TagChip({ label }: { label: string }) {
  return (
    <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{label}</span>
  );
}

function TagSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex gap-0.5">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={cn(
              "flex-1 rounded border px-1 py-1 font-mono text-[10px] transition-colors",
              value === o ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
            )}
          >{o.slice(0, 4)}</button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* rule row                                                                    */
/* -------------------------------------------------------------------------- */

function RuleRow({
  index, rule, onActionChange,
}: {
  index: number;
  rule: PolicyRule;
  onActionChange: (a: PolicyRule["action"]) => void;
}) {
  const valueText = rule.op === "in"
    ? (rule.values ?? []).join(", ")
    : (rule.value ?? "—");

  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3 transition-colors hover:border-border">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        {/* left: id + matchers */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-5 min-w-5 items-center justify-center rounded bg-muted px-1.5 font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            {rule.id}
          </span>
          <span className="font-mono text-xs text-foreground">{rule.field}</span>
          <span className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            {rule.op}
          </span>
          <span className="max-w-[280px] truncate rounded bg-muted/20 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200/80">
            {valueText}
          </span>
        </div>

        {/* right: action select */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            →
          </span>
          <Select value={rule.action} onValueChange={(v) => onActionChange(v as PolicyRule["action"])}>
            <SelectTrigger
              size="sm"
              className={cn("h-8 w-36 font-mono text-xs", ACTION_TRIGGER[rule.action])}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a} className="font-mono text-xs">
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* reason */}
      <p className="mt-2 pl-7 text-[11px] leading-relaxed text-muted-foreground">
        {rule.reason}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* loading skeleton                                                            */
/* -------------------------------------------------------------------------- */

function PolicyLoadingSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
