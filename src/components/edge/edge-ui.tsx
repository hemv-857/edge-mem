"use client";

import { cn } from "@/lib/utils";

export type TabId = "home" | "search" | "knowledge" | "sync" | "fleet" | "policy" | "activity";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* -------------------------------------------------------------------------- */
/* status tags — text always carries the meaning, colour only reinforces it     */
/* -------------------------------------------------------------------------- */

type Tone = "ok" | "warn" | "crit" | "neutral" | "dim";

const TONE: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  crit: "border-rose-500/35 bg-rose-500/10 text-rose-300",
  neutral: "border-border bg-muted text-foreground/80",
  dim: "border-border text-muted-foreground",
};

export function Tag({ tone = "neutral", children, className, title }: { tone?: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex h-5 shrink-0 items-center rounded border px-1.5 font-mono text-[10px] leading-none", TONE[tone], className)}
    >
      {children}
    </span>
  );
}

const CRIT_TONE: Record<string, Tone> = { critical: "crit", high: "warn", medium: "neutral", low: "dim" };

export function CriticalityBadge({ value }: { value?: string }) {
  if (!value) return null;
  return <Tag tone={CRIT_TONE[value] ?? "dim"}>{value}</Tag>;
}

const SYNC_TONE: Record<string, Tone> = { synced: "ok", queued: "warn", sync_now: "crit", local_only: "dim", conflict: "crit" };
const SYNC_LABEL: Record<string, string> = { sync_now: "sync now", local_only: "local only" };

export function SyncStateBadge({ value }: { value?: string }) {
  if (!value) return null;
  return <Tag tone={SYNC_TONE[value] ?? "dim"}>{SYNC_LABEL[value] ?? value}</Tag>;
}

export function StatusDot({ online }: { online: boolean }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", online ? "bg-emerald-400" : "bg-amber-400")} />;
}

/* -------------------------------------------------------------------------- */
/* layout primitives                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A titled region. `flush` drops body padding for divided lists and tables.
 * `fill` makes it a flex column whose body takes the remaining height — pair it with `h-full` / `flex-1`
 * so panels in one row end on the same line (see `FillScroll`).
 */
export function Panel({
  title, desc, right, children, className, flush, fill,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
  fill?: boolean;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-card shadow-[inset_0_1px_0_oklch(1_0_0/0.04),0_1px_2px_oklch(0_0_0/0.3)]", fill && "flex flex-col", className)}>
      <header className="flex min-h-13 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/70 px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {desc && <span className="truncate text-xs text-muted-foreground">{desc}</span>}
        </div>
        {right}
      </header>
      <div className={cn(!flush && "p-4 sm:p-5", fill && "flex min-h-0 flex-1 flex-col")}>{children}</div>
    </section>
  );
}

const FILL_AT = {
  lg: { box: "lg:min-h-56", inner: "max-lg:max-h-[480px] max-lg:overflow-y-auto lg:absolute lg:inset-0 lg:overflow-y-auto" },
  xl: { box: "xl:min-h-56", inner: "max-xl:max-h-[480px] max-xl:overflow-y-auto xl:absolute xl:inset-0 xl:overflow-y-auto" },
} as const;

/**
 * Row-alignment rule: in a side-by-side row the shorter, fixed content sets the height and a long
 * list fills what is left and scrolls, instead of stretching the row. Stacked (below `at`) it caps at 480px.
 */
export function FillScroll({ children, at = "lg", className }: { children: React.ReactNode; at?: keyof typeof FILL_AT; className?: string }) {
  return (
    <div className={cn("relative min-h-0 flex-1", FILL_AT[at].box)}>
      <div className={cn("edge-scroll", FILL_AT[at].inner, className)}>{children}</div>
    </div>
  );
}

type HeadTone = "ok" | "warn" | "crit";
const STAT_TONE: Record<HeadTone, string> = { ok: "text-emerald-400", warn: "text-amber-300", crit: "text-rose-400" };
/* the hero's accent word, status dot and ambient light all take the state colour */
const HERO_TONE: Record<HeadTone, { accent: string; dot: string; light: string }> = {
  ok: { accent: "[--hero-accent:var(--color-emerald-400)]", dot: "bg-emerald-400", light: "oklch(0.765 0.177 163.2 / 0.1)" },
  warn: { accent: "[--hero-accent:var(--color-amber-300)]", dot: "bg-amber-400", light: "oklch(0.828 0.189 84.429 / 0.09)" },
  crit: { accent: "[--hero-accent:var(--color-rose-400)]", dot: "bg-rose-500", light: "oklch(0.645 0.246 16.439 / 0.1)" },
};

/** The word in a hero title that carries the state ("All <Hl>clear.</Hl>"); takes the hero's tone colour. */
export function Hl({ children }: { children: React.ReactNode }) {
  return <span className="text-(--hero-accent)">{children}</span>;
}

/**
 * Top band of every tab, and its visual anchor: the state in plain words at display size, a status
 * dot and an ambient light in the state colour, facts as chips, and the few numbers that matter.
 * `footer` holds the tab's primary control full-width.
 */
export function PageHero({
  title, sub, tone = "ok", live, action, meta, stats, footer, className,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  tone?: HeadTone;
  /** pulse the status dot — only for a healthy, live state */
  live?: boolean;
  action?: React.ReactNode;
  meta?: React.ReactNode;
  stats?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const t = HERO_TONE[tone];
  return (
    <section
      className={cn("relative isolate overflow-hidden rounded-2xl border border-border bg-card shadow-[inset_0_1px_0_oklch(1_0_0/0.05)]", t.accent, className)}
    >
      {/* ambient light: a soft, wide pool in the state colour behind the headline */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 transition-[background] duration-700"
        style={{ background: `radial-gradient(90% 140% at 0% 0%, ${t.light}, transparent 75%)` }}
      />
      <div className="grid gap-6 p-5 sm:gap-8 sm:p-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0">
          <div role="status" aria-live="polite" className="flex items-start gap-3 sm:gap-4">
            <span aria-hidden className="relative mt-[0.36em] flex h-3 w-3 shrink-0 text-4xl sm:h-3.5 sm:w-3.5 sm:text-5xl xl:text-6xl 2xl:text-7xl">
              {live && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/40 [animation-duration:2.4s] motion-reduce:hidden" />}
              <span className={cn("relative h-full w-full rounded-full", t.dot)} />
            </span>
            <div className="min-w-0">
              <h2 className="text-4xl font-semibold leading-[1.02] tracking-[-0.035em] text-balance text-foreground sm:text-5xl xl:text-6xl 2xl:text-7xl">{title}</h2>
              {sub && <p className="mt-3 max-w-[60ch] text-base text-foreground/70 sm:text-[17px]">{sub}</p>}
            </div>
          </div>
          {(meta || action) && (
            <div className="mt-5 flex flex-wrap items-center gap-2 sm:pl-[1.875rem]">
              {action}
              {meta}
            </div>
          )}
        </div>
        {stats}
      </div>
      {footer && <div className="border-t border-border px-5 py-5 sm:px-8">{footer}</div>}
    </section>
  );
}

/** A fact about the current state, shown as a quiet chip under the hero headline. */
export function Meta({ icon, children, tone }: { icon?: React.ReactNode; children: React.ReactNode; tone?: HeadTone }) {
  return (
    <span className={cn(
      "inline-flex h-8 items-center gap-2 rounded-lg border bg-background/50 px-3 text-sm [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0",
      tone === "warn" ? "border-amber-500/35 text-amber-200" : tone === "crit" ? "border-rose-500/40 text-rose-200" : "border-border text-foreground/80 [&_svg]:text-muted-foreground",
    )}>
      {icon}{children}
    </span>
  );
}

/** Hairline-ruled row of big numbers (1px gaps over the border colour). */
export function BigStats({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none", className)}>
      {children}
    </dl>
  );
}

export function BigStat({ label, value, tone, hint, icon }: { label: string; value: React.ReactNode; tone?: HeadTone; hint?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-background/95 px-4 py-4 max-sm:last:odd:col-span-2 sm:min-w-40 sm:px-5 sm:py-5">
      {icon && (
        <span aria-hidden className="mb-4 hidden h-9 w-9 place-items-center rounded-lg border border-border bg-card text-foreground/75 sm:grid [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      )}
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:text-[11px]">{label}</dt>
      <dd className={cn("mt-1.5 truncate text-3xl font-semibold tabular-nums tracking-[-0.03em] sm:text-4xl", tone ? STAT_TONE[tone] : "text-foreground")}>{value}</dd>
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Label/value readout for status strips. Place inside a <dl>. */
export function Readout({ label, value, tone, large }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "crit"; large?: boolean }) {
  const color = tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "crit" ? "text-rose-300" : "text-foreground";
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate tabular-nums", large ? "mt-1 text-2xl font-semibold tracking-[-0.03em]" : "font-mono text-sm", color)}>{value}</dd>
    </div>
  );
}

/** Single-choice button group (shard, mode, tag pickers). */
export function Segmented<T extends string>({
  label, value, options, onChange, className, render,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  className?: string;
  render?: (v: T) => React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-md border border-border bg-background p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={cn(
            "flex-1 rounded-[5px] px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
            value === o ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {render ? render(o) : o}
        </button>
      ))}
    </div>
  );
}

/** Quiet centred message for empty lists. */
export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
      <p>{children}</p>
      {action}
    </div>
  );
}
