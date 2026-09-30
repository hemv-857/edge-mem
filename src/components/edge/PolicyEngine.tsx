"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpToLine, Check, Clock, Loader2, Lock, Minus, Timer, Trash2, X } from "lucide-react";
import type { EdgeHook } from "@/hooks/use-edge";
import type { Policy, PolicyRule, RetentionStatus } from "@/lib/edge-types";
import { edge as edgeApi } from "@/lib/edge-api";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BigStat, BigStats, Hl, PageHero, Panel, Readout, Segmented, SyncStateBadge, formatRelative } from "./edge-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ACTIONS: PolicyRule["action"][] = ["local_only", "queued", "sync_now"];
const ACTION_TONE: Record<PolicyRule["action"], string> = {
  local_only: "text-muted-foreground",
  queued: "text-amber-300",
  sync_now: "text-rose-300",
};

export default function PolicyEngine({ edge }: { edge: EdgeHook }) {
  const serverPolicy = edge.state?.policy ?? null;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const lastSeenSig = useRef<string>("");

  // re-init the local copy only when the server policy actually changes (keeps in-progress edits)
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
    setPolicy((prev) => prev && { ...prev, rules: prev.rules.map((r, i) => (i === idx ? { ...r, action } : r)) });
  }, []);

  const updateTtl = useCallback((raw: string) => {
    const n = parseInt(raw, 10);
    setPolicy((prev) => prev && { ...prev, ttl_raw_sensor_seconds: Number.isFinite(n) && n >= 0 ? n : 0 });
  }, []);

  const handleSave = useCallback(async () => {
    if (!policy || !isDirty || saving) return;
    setSaving(true);
    try {
      await edgeApi.putPolicy(policy);
      toast({ title: "Policy saved", description: "Applies to the next note written." });
      await edge.refresh();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [policy, isDirty, saving, edge]);

  if (!policy) return <div className="h-96 animate-pulse rounded-lg bg-card" />;

  const count = (a: PolicyRule["action"]) => policy.rules.filter((r) => r.action === a).length;

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <PageHero
        className="xl:col-span-12"
        title={<><Hl>{policy.rules.length} {policy.rules.length === 1 ? "rule decides" : "rules decide"}</Hl> what leaves the device.</>}
        sub="Every new note is checked top to bottom; the first match wins. Restricted notes never sync."
        stats={
          <BigStats>
            <BigStat icon={<Lock />} label="Local only" value={count("local_only")} hint="never leave" />
            <BigStat icon={<Clock />} label="Queued" value={count("queued")} tone={count("queued") ? "warn" : undefined} hint="next sync" />
            <BigStat icon={<ArrowUpToLine />} label="Sync now" value={count("sync_now")} tone={count("sync_now") ? "crit" : undefined} hint="front of queue" />
            <BigStat icon={<Timer />} label="Sensor TTL" value={`${policy.ttl_raw_sensor_seconds}s`} hint="raw readings" />
          </BigStats>
        }
      />

      <Panel className="xl:col-span-7" title="Routing rules" right={<span className="font-mono text-xs text-muted-foreground">{policy.rules.length}</span>} flush fill>
        {/* rows share the column height so the panel ends level with the side column */}
        <ol className="grid flex-1 auto-rows-fr divide-y divide-border">
          {policy.rules.map((rule, idx) => (
            <RuleRow key={rule.id} index={idx} rule={rule} onActionChange={(a) => updateRuleAction(idx, a)} />
          ))}
        </ol>
        <p className="mt-auto flex flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-3 sm:px-5 text-xs text-muted-foreground">
          <span><SyncStateBadge value="local_only" /> never leaves the device</span>
          <span><SyncStateBadge value="queued" /> uploads with the next sync</span>
          <span><SyncStateBadge value="sync_now" /> goes to the front of the queue</span>
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2 xl:col-span-5 xl:flex xl:flex-col">
        <SimulatePanel />
        <RetentionPanel edge={edge} ttl={policy.ttl_raw_sensor_seconds} onTtlChange={updateTtl} className="xl:flex-1" />
      </div>

      {isDirty && (
        <div role="status" className="sticky bottom-4 z-30 xl:col-span-12 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-card px-4 py-3 sm:px-5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.7)] animate-in fade-in slide-in-from-bottom-2 duration-200">
          <span className="text-sm text-amber-200">Unsaved policy changes</span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => serverPolicy && setPolicy(serverPolicy)} disabled={saving}>Revert</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5 bg-emerald-500 text-emerald-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-emerald-400">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save policy
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleRow({ index, rule, onActionChange }: { index: number; rule: PolicyRule; onActionChange: (a: PolicyRule["action"]) => void }) {
  const valueText = rule.op === "in" ? (rule.values ?? []).join(", ") : (rule.value ?? "—");
  return (
    <li className="grid grid-cols-[1.5rem_1fr] content-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5 sm:grid-cols-[1.5rem_minmax(0,1fr)_10rem]">
      <span className="pt-1.5 font-mono text-xs text-muted-foreground">{index + 1}</span>
      <div className="min-w-0">
        <div className="font-mono text-sm text-foreground">
          {rule.field} <span className="text-muted-foreground">{rule.op}</span> {valueText}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{rule.reason} <span className="font-mono text-xs">({rule.id})</span></p>
      </div>
      <div className="col-start-2 sm:col-start-3">
        <Select value={rule.action} onValueChange={(v) => onActionChange(v as PolicyRule["action"])}>
          <SelectTrigger size="sm" aria-label={`Action for rule ${rule.id}`} className={cn("h-8 w-full font-mono text-xs", ACTION_TONE[rule.action])}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIONS.map((a) => <SelectItem key={a} value={a} className="font-mono text-xs">{a}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </li>
  );
}

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

const DOMAINS = ["manual", "incident", "sensor"] as const;
const CRITS = ["low", "medium", "high", "critical"] as const;
const SENS = ["internal", "restricted", "public"] as const;

/** Check a note's tags against the saved rules without writing anything. */
function SimulatePanel() {
  const [domain, setDomain] = useState<string>("incident");
  const [criticality, setCriticality] = useState<string>("high");
  const [sensitivity, setSensitivity] = useState<string>("internal");
  const [result, setResult] = useState<{ decision: { sync_state: string; matched_rule: string | null; reason: string }; trace: SimTrace[] } | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      setResult(await edgeApi.simulatePolicy({ text: "(simulated — no write)", criticality, sensitivity, domain }));
    } catch (e) {
      toast({ title: "Simulate failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel title="Test a note" desc="against the saved rules">
      <div className="space-y-3">
        <Picker label="Domain" value={domain} options={DOMAINS} onChange={setDomain} />
        <Picker label="Criticality" value={criticality} options={CRITS} onChange={setCriticality} />
        <Picker label="Sensitivity" value={sensitivity} options={SENS} onChange={setSensitivity} />
        <Button size="sm" variant="outline" onClick={run} disabled={running} className="gap-1.5">
          {running && <Loader2 className="h-4 w-4 animate-spin" />}
          Simulate
        </Button>
      </div>

      {result && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Decision</span>
            <SyncStateBadge value={result.decision.sync_state} />
            {result.decision.matched_rule && <span className="font-mono text-xs text-muted-foreground">by {result.decision.matched_rule}</span>}
          </div>
          <p className="text-sm text-foreground/85">{result.decision.reason}</p>
          <ol className="space-y-1 font-mono text-xs">
            {result.trace.map((t, i) => (
              <li key={t.id} className={cn("flex gap-2", t.is_match ? "text-emerald-300" : t.matched ? "text-foreground/70" : "text-muted-foreground/60")}>
                <span className="w-4 shrink-0 text-right">{i + 1}</span>
                <span aria-label={t.is_match ? "decides" : t.matched ? "matched, not first" : "no match"} className="flex w-3 shrink-0 items-center">{t.is_match ? <Check className="h-3 w-3" /> : t.matched ? <Minus className="h-3 w-3" /> : <X className="h-3 w-3" />}</span>
                <span className="min-w-0 flex-1 truncate">{t.field} {t.op} {t.op === "in" ? (t.values ?? []).join(", ") : t.value}</span>
                <span className="shrink-0">{t.action}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}

function Picker<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-20 shrink-0 text-sm text-muted-foreground">{label}</span>
      <Segmented label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

/** TTL retention: raw telemetry in the sensors shard older than the TTL is dropped. */
function RetentionPanel({ edge, ttl, onTtlChange, className }: { edge: EdgeHook; ttl: number; onTtlChange: (raw: string) => void; className?: string }) {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    edgeApi.retentionStatus().then(setStatus).catch(() => undefined);
  }, [edge.activity.length]);

  async function run() {
    setRunning(true);
    try {
      const r = await edgeApi.runRetention();
      setStatus(r);
      await edge.refresh();
      toast({
        title: r.expired ? "Retention sweep complete" : "Nothing old enough to expire",
        description: `${r.expired} of ${r.checked} raw sensor points older than ${r.ttl_seconds}s removed`,
      });
    } catch (e) {
      toast({ title: "Retention failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel title="Raw sensor retention" className={className}>
      <p className="text-sm text-muted-foreground">
        Raw readings in <span className="font-mono text-foreground/85">sensors</span> expire after the TTL. Manuals and incidents are never swept.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div className="space-y-1.5">
          <label htmlFor="ttl" className="text-xs text-muted-foreground">TTL (seconds)</label>
          <Input id="ttl" type="number" min={0} step={1} value={ttl} onChange={(e) => onTtlChange(e.target.value)} className="h-9 w-28 font-mono tabular-nums" />
        </div>
        <dl className="flex gap-8">
          <Readout label="Expired so far" value={status?.expired_total ?? "—"} />
          <Readout label="Last sweep" value={formatRelative(status?.last_run ?? null)} />
        </dl>
      </div>
      <Button size="sm" variant="outline" onClick={run} disabled={running} className="mt-4 gap-1.5" data-testid="retention-run">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        Run retention sweep
      </Button>
    </Panel>
  );
}
