import type { AuditScorecard } from "@/lib/audit/checkpoints";
import { moneyFor } from "@/lib/audit/render";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { measurementBreaks, measurementCaveats, type MeasurementBreak } from "@/lib/analysis/measurement";
import { businessTypeOf, type BusinessType } from "@/lib/analysis/shared-rules";
import { bridgesOf, type Bridge, type BridgeEffect } from "./bridge";
import { creativeChanges, entitySplit, type EntityChange } from "./entities";
import { funnelsOf } from "./funnel";
import { kpiRows, windowsOf, type KpiRow, type Windows } from "./kpis";
import { breakdownShifts } from "./shifts";
import { COMPARISON_THRESHOLDS } from "./thresholds";

/**
 * Findings kind/bucket mapping (the buckets say who fixes it / where to look first):
 *  - measurement break           -> kind "measurement", bucket "Fix tracking"
 *  - tracking checkpoint fail    -> kind "tracking",    bucket "Fix tracking"
 *  - declined Link CTR / cost per link click / link clicks / landing page views -> "Creative"
 *  - declined CPM / frequency / reach                  -> "Audience"
 *  - declined spend / impressions                      -> "Budget"
 *  - declined outcome metrics (results, cost per result, purchases, ROAS, AOV, funnel steps) -> "Investigate"
 *    (the cause is not known from the KPI alone; the bridge and the funnel narrow it)
 *  - bridge effect by driver: CPM -> "Audience", CTR -> "Creative", Volume -> "Budget", CVR/AOV -> "Investigate";
 *    a bridge that moved in the good direction is a "win" in the "Hold" bucket
 *  - stopped entity (>= 5% of previous spend)          -> kind "structure", bucket "Budget"
 *  - creative fatigue flag                             -> kind "decline",   bucket "Creative"
 *  - improved KPI                                      -> kind "win",       bucket "Hold"
 */
export type ComparisonFinding = {
  id: string;
  title: string;
  evidence: string;
  kind: "decline" | "win" | "measurement" | "structure" | "tracking";
  bucket: "Investigate" | "Fix tracking" | "Creative" | "Audience" | "Budget" | "Hold";
};

export type ComparisonInput = {
  snapshot: MetaAuditSnapshot;
  today: string;
  businessModel?: string;
  scorecard: AuditScorecard;
  userContext: string | null;
};

export type ComparisonParts = {
  windows: Windows;
  type: BusinessType;
  kpis: KpiRow[];
  bridges: Bridge[];
  funnels: ReturnType<typeof funnelsOf>;
  entities: ReturnType<typeof entitySplit>;
  creative: ReturnType<typeof creativeChanges>;
  shifts: ReturnType<typeof breakdownShifts>;
  breaks: MeasurementBreak[];
  caveats: string[];
};

/** Below this relative move a bridge has no meaningful split (the log shares blow up). */
export const BRIDGE_TINY_CHANGE = 0.001;
/** At most this many measurement breaks become findings; the rest stay in the Tracking block. */
const MAX_BREAK_FINDINGS = 5;

type Money = (cents: number) => string;

const MONEY_METRICS = new Set([
  "Spend",
  "CPM",
  "Cost per link click",
  "Cost per result",
  "Purchase value",
  "Cost per purchase",
  "AOV",
  "Cost per lead",
]);
const PERCENT_METRICS = new Set(["Link CTR"]);

const count = (v: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);

const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "-" : "");

/** A KPI value in its own unit; null prints "n/a". */
export function formatKpiValue(metric: string, v: number | null, money: Money): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (MONEY_METRICS.has(metric)) return money(v);
  if (PERCENT_METRICS.has(metric)) return `${v.toFixed(2)}%`;
  if (metric === "ROAS" || metric === "Frequency") return v.toFixed(2);
  return count(v);
}

/** A signed change in the metric's own unit; percent metrics move in percentage points. */
export function formatKpiDelta(metric: string, v: number | null, money: Money): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (v === 0) return formatKpiValue(metric, 0, money);
  if (MONEY_METRICS.has(metric)) return `${sign(v)}${money(Math.abs(v))}`;
  if (PERCENT_METRICS.has(metric)) return `${sign(v)}${Math.abs(v).toFixed(2)} pp`;
  if (metric === "ROAS" || metric === "Frequency") return `${sign(v)}${Math.abs(v).toFixed(2)}`;
  return `${sign(v)}${count(Math.abs(v))}`;
}

/** A percent change with one decimal; null (no usable baseline) prints "n/a", never a number. */
export function formatPctChange(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${sign(v)}${Math.abs(v).toFixed(1)}%`;
}

function statusCell(row: KpiRow): string {
  if (row.lowVolume) return "Low volume - not a trend";
  return row.measurementBreak ? `${row.status} (measurement break - not a performance change)` : row.status;
}

/** One markdown table row: Metric | Current | Previous | Δ | Δ% | Status. */
export function formatKpiRow(row: KpiRow, money: Money): string {
  return `| ${row.metric} | ${formatKpiValue(row.metric, row.current, money)} | ${formatKpiValue(row.metric, row.previous, money)} | ${formatKpiDelta(row.metric, row.delta, money)} | ${formatPctChange(row.deltaPct)} | ${statusCell(row)} |`;
}

export function formatCount(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "n/a" : count(v);
}

/** True when a bridge metric barely moved, so its shares mean nothing. */
export function bridgeIsFlat(previous: number, current: number): boolean {
  return previous === 0 ? current === 0 : Math.abs(current - previous) / Math.abs(previous) < BRIDGE_TINY_CHANGE;
}

export function formatBridgeValue(metric: string, v: number, money: Money): string {
  return metric === "results" ? count(v) : money(v);
}

export function formatBridgeEffect(metric: string, e: BridgeEffect, money: Money): string {
  const v = metric === "results" ? `${sign(e.value)}${count(Math.abs(e.value))}` : `${sign(e.value)}${money(Math.abs(e.value))}`;
  return `${e.driver} ${v} (${Math.round(e.shareOfChangePct)}% of the change)`;
}

/** Everything the report computes, without the findings (they are derived from these parts). */
export function comparisonParts(input: ComparisonInput): ComparisonParts {
  const { snapshot, today, businessModel } = input;
  const windows = windowsOf(snapshot, today);
  const type = businessTypeOf(snapshot, businessModel);
  const breaks = measurementBreaks(snapshot);
  const bridges = snapshot.totals && snapshot.previousTotals ? bridgesOf(snapshot.totals, snapshot.previousTotals, type) : [];
  return {
    windows,
    type,
    kpis: kpiRows(snapshot, windows, type, breaks),
    bridges,
    funnels: funnelsOf(snapshot, type),
    entities: entitySplit(snapshot),
    creative: creativeChanges(snapshot),
    shifts: breakdownShifts(snapshot),
    breaks,
    caveats: measurementCaveats(snapshot),
  };
}

const KPI_BUCKET: Record<string, ComparisonFinding["bucket"]> = {
  "Link CTR": "Creative",
  "Cost per link click": "Creative",
  "Link clicks": "Creative",
  "Landing page views": "Creative",
  CPM: "Audience",
  Frequency: "Audience",
  Reach: "Audience",
  Spend: "Budget",
  Impressions: "Budget",
};

const DRIVER_BUCKET: Record<BridgeEffect["driver"], ComparisonFinding["bucket"]> = {
  CPM: "Audience",
  CTR: "Creative",
  Volume: "Budget",
  CVR: "Investigate",
  AOV: "Investigate",
};

function byAbsChangeDesc(a: KpiRow, b: KpiRow): number {
  // A row with no usable % (zero baseline) sorts after every row that has one.
  const av = a.deltaPct == null ? -1 : Math.abs(a.deltaPct);
  const bv = b.deltaPct == null ? -1 : Math.abs(b.deltaPct);
  return bv - av;
}

type Draft = Omit<ComparisonFinding, "id">;

function kpiEvidence(row: KpiRow, money: Money, extra: string): string {
  return `${row.metric}: ${formatKpiValue(row.metric, row.previous, money)} -> ${formatKpiValue(row.metric, row.current, money)} (${formatPctChange(row.deltaPct)})${extra}`;
}

function largestBridgeEffect(bridges: Bridge[], money: Money): Draft | null {
  let best: { metric: "cost per result" | "results" | "purchase value"; previous: number; current: number; effect: BridgeEffect } | null = null;
  for (const b of bridges) {
    if (!("effects" in b) || bridgeIsFlat(b.previous, b.current)) continue;
    for (const e of b.effects) {
      if (!best || Math.abs(e.shareOfChangePct) > Math.abs(best.effect.shareOfChangePct)) {
        best = { metric: b.metric, previous: b.previous, current: b.current, effect: e };
      }
    }
  }
  if (!best) return null;
  const { metric, previous, current, effect } = best;
  const worse = metric === "cost per result" ? current > previous : current < previous;
  const share = Math.round(effect.shareOfChangePct);
  return {
    title: `${effect.driver} drove ${share}% of the change in ${metric}`,
    evidence: `${metric} moved ${formatBridgeValue(metric, previous, money)} -> ${formatBridgeValue(metric, current, money)}; ${formatBridgeEffect(metric, effect, money)}`,
    kind: worse ? "decline" : "win",
    bucket: worse ? DRIVER_BUCKET[effect.driver] : "Hold",
  };
}

function stoppedAtLeast5Pct(parts: ComparisonParts, snapshot: MetaAuditSnapshot, money: Money): Draft[] {
  const previousSpend = snapshot.previousTotals?.spendCents ?? 0;
  if (previousSpend <= 0) return [];
  const ads = parts.creative.ads.filter((e) => e.previous && !e.current);
  const all: EntityChange[] = [...parts.entities.stopped, ...ads];
  return all
    .filter((e) => (e.previous?.spendCents ?? 0) / previousSpend >= COMPARISON_THRESHOLDS.minSpendShare)
    .sort((a, b) => (b.previous?.spendCents ?? 0) - (a.previous?.spendCents ?? 0) || a.id.localeCompare(b.id))
    .map((e) => {
      const spend = e.previous?.spendCents ?? 0;
      return {
        title: `Stopped ${e.level}: ${e.name}`,
        evidence: `${e.level} ${e.name} (${e.id}) spent ${money(spend)} in the previous window (${((spend / previousSpend) * 100).toFixed(1)}% of account spend) and nothing in the current window`,
        kind: "structure" as const,
        bucket: "Budget" as const,
      };
    });
}

function draftsFrom(input: ComparisonInput, parts: ComparisonParts): Draft[] {
  const { snapshot, scorecard } = input;
  const money = moneyFor(snapshot.account.currency);
  const drafts: Draft[] = [];

  // 1. Measurement breaks, earliest first.
  parts.breaks.slice(0, MAX_BREAK_FINDINGS).forEach((b, i, shown) => {
    const more = i === shown.length - 1 && parts.breaks.length > shown.length ? ` (+${parts.breaks.length - shown.length} more breaks, see Tracking)` : "";
    drafts.push({
      title: `Measurement change: ${b.what}`,
      evidence: `${b.date} (${b.window} window): ${b.what}${b.objectName ? ` on ${b.objectName}` : ""} [${b.eventType}]; results and cost per result around this date are not a performance change${more}`,
      kind: "measurement",
      bucket: "Fix tracking",
    });
  });

  // 2. Tracking checkpoints that fail.
  for (const c of scorecard.checkpoints) {
    if (c.category !== "Tracking & measurement" || c.status !== "fail") continue;
    drafts.push({
      title: `${c.id} ${c.title}`,
      evidence: c.evidence,
      kind: "tracking",
      bucket: "Fix tracking",
    });
  }

  // 3. Declined KPIs, biggest move first (rows with no usable % last).
  const declined = parts.kpis.filter((r) => r.status === "Declined").sort(byAbsChangeDesc);
  for (const r of declined) {
    drafts.push({
      title: `${r.metric} declined (${formatPctChange(r.deltaPct)})`,
      evidence: kpiEvidence(r, money, r.measurementBreak ? "; moved around a measurement break, so part of this may be counting, not performance" : ""),
      kind: "decline",
      bucket: r.measurementBreak ? "Investigate" : (KPI_BUCKET[r.metric] ?? "Investigate"),
    });
  }

  // 4. Largest bridge effect.
  const bridge = largestBridgeEffect(parts.bridges, money);
  if (bridge) drafts.push(bridge);

  // 5. Stopped entities holding at least 5% of previous spend.
  drafts.push(...stoppedAtLeast5Pct(parts, snapshot, money));

  // 6. Creative fatigue.
  for (const f of parts.creative.fatigue) {
    drafts.push({
      title: `Creative fatigue: ${f.name}`,
      evidence: `Ad ${f.name} (${f.adId}): Link CTR ${f.ctrPrevious.toFixed(2)}% -> ${f.ctrCurrent.toFixed(2)}% while 7-day frequency is ${f.frequency7d.toFixed(2)}`,
      kind: "decline",
      bucket: "Creative",
    });
  }

  // 7. Improved KPIs.
  const improved = parts.kpis.filter((r) => r.status === "Improved").sort(byAbsChangeDesc);
  for (const r of improved) {
    drafts.push({
      title: `${r.metric} improved (${formatPctChange(r.deltaPct)})`,
      evidence: kpiEvidence(r, money, r.measurementBreak ? "; moved around a measurement break" : ""),
      kind: "win",
      bucket: "Hold",
    });
  }
  return drafts;
}

export function findingsFromParts(input: ComparisonInput, parts: ComparisonParts): ComparisonFinding[] {
  return draftsFrom(input, parts).map((d, i) => ({ id: `CMP-${String(i + 1).padStart(3, "0")}`, ...d }));
}

export function comparisonFindings(input: ComparisonInput): ComparisonFinding[] {
  return findingsFromParts(input, comparisonParts(input));
}

export function buildComparison(input: ComparisonInput): ComparisonParts & { findings: ComparisonFinding[] } {
  const parts = comparisonParts(input);
  return { ...parts, findings: findingsFromParts(input, parts) };
}
