import type { MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { previousPeriodOf } from "@/lib/audit/meta-audit-data";
import type { BusinessType } from "@/lib/analysis/shared-rules";
import type { MeasurementBreak } from "@/lib/analysis/measurement";
import { COMPARISON_THRESHOLDS } from "./thresholds";

const DAY_MS = 86_400_000;

export type Windows = {
  current: { since: string; until: string; days: number };
  previous: { since: string; until: string; days: number };
  equalLength: boolean;
  maturity: { immature: boolean; immatureFrom: string | null; reason: string | null };
};

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

function addDays(date: string, n: number): string {
  return new Date((dayNumber(date) + n) * DAY_MS).toISOString().slice(0, 10);
}

function inclusiveDays(since: string, until: string): number {
  return daysBetween(since, until) + 1;
}

/** Longest click-attribution window (days) any ad set uses; 7 when none say. */
function longestClickWindow(snap: MetaAuditSnapshot): number {
  let longest = 0;
  for (const adSet of snap.adSets ?? []) {
    for (const w of adSet.attributionWindows ?? []) {
      const m = /^(\d+)d_click$/.exec(w);
      if (m) longest = Math.max(longest, Number(m[1]));
    }
  }
  return longest || 7;
}

/**
 * The two windows, and whether the current one is still maturing. Meta keeps adding conversions
 * for as long as the click window runs, so a day is immature when it is fewer than `lag` days
 * before today (daysBetween(day, today) < lag). `immatureFrom` is the first such day inside the
 * window: max(since, today - lag + 1). The window is immature when its last day is immature.
 */
export function windowsOf(snap: MetaAuditSnapshot, today: string): Windows {
  const current = {
    since: snap.period.since,
    until: snap.period.until,
    days: inclusiveDays(snap.period.since, snap.period.until),
  };
  const prev = snap.previousPeriod ?? previousPeriodOf(snap.period.since, snap.period.until);
  const previous = { since: prev.since, until: prev.until, days: inclusiveDays(prev.since, prev.until) };

  const lag = longestClickWindow(snap);
  const immature = daysBetween(current.until, today) < lag;
  let immatureFrom: string | null = null;
  if (immature) {
    const lagStart = addDays(today, -lag + 1);
    immatureFrom = lagStart > current.since ? lagStart : current.since;
  }
  return {
    current,
    previous,
    equalLength: current.days === previous.days,
    maturity: {
      immature,
      immatureFrom,
      reason: immature
        ? `Meta can still add conversions to the last ${lag} days (${lag}-day click attribution)`
        : null,
    },
  };
}

export type KpiStatus = "Improved" | "Declined" | "Stable" | "Low volume";

export type KpiRow = {
  metric: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  perDayCurrent: number | null;
  perDayPrevious: number | null;
  status: KpiStatus;
  lowVolume: boolean;
  higherIsBetter: boolean | null;
  measurementBreak: boolean;
};

/** Which count must be large enough before a row's change can be trusted. */
type Basis = "results" | "purchases" | "leads" | "self" | "impressions" | "none";

type Def = {
  metric: string;
  value: (p: PeriodPerformance) => number | null | undefined;
  higherIsBetter: boolean | null;
  basis: Basis;
  /** Additive over days, so a per-day figure means something. */
  perDay: boolean;
  /** Moves when what counts as a result changes (attribution, event, dataset). */
  breakable: boolean;
};

const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null || b == null || b === 0 ? null : a / b;

const num = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v);

const DEFS: Record<string, Def> = {
  spend: { metric: "Spend", value: (p) => p.spendCents, higherIsBetter: null, basis: "none", perDay: true, breakable: false },
  impressions: { metric: "Impressions", value: (p) => p.impressions, higherIsBetter: true, basis: "none", perDay: true, breakable: false },
  reach: { metric: "Reach", value: (p) => p.reach, higherIsBetter: true, basis: "none", perDay: false, breakable: false },
  frequency: { metric: "Frequency", value: (p) => p.frequency, higherIsBetter: false, basis: "impressions", perDay: false, breakable: false },
  cpm: { metric: "CPM", value: (p) => p.cpmCents, higherIsBetter: false, basis: "impressions", perDay: false, breakable: false },
  linkClicks: { metric: "Link clicks", value: (p) => p.linkClicks, higherIsBetter: true, basis: "none", perDay: true, breakable: false },
  linkCtr: { metric: "Link CTR", value: (p) => p.linkCtr, higherIsBetter: true, basis: "impressions", perDay: false, breakable: false },
  costPerLinkClick: { metric: "Cost per link click", value: (p) => ratio(p.spendCents, p.linkClicks), higherIsBetter: false, basis: "impressions", perDay: false, breakable: false },
  lpv: { metric: "Landing page views", value: (p) => p.landingPageViews, higherIsBetter: true, basis: "none", perDay: true, breakable: false },
  results: { metric: "Results", value: (p) => p.results, higherIsBetter: true, basis: "results", perDay: true, breakable: true },
  costPerResult: { metric: "Cost per result", value: (p) => p.costPerResultCents, higherIsBetter: false, basis: "results", perDay: false, breakable: true },
  purchases: { metric: "Purchases", value: (p) => p.purchases, higherIsBetter: true, basis: "purchases", perDay: true, breakable: true },
  purchaseValue: { metric: "Purchase value", value: (p) => p.purchaseValueCents, higherIsBetter: true, basis: "purchases", perDay: true, breakable: true },
  roas: { metric: "ROAS", value: (p) => p.roas, higherIsBetter: true, basis: "purchases", perDay: false, breakable: true },
  costPerPurchase: { metric: "Cost per purchase", value: (p) => ratio(p.spendCents, p.purchases), higherIsBetter: false, basis: "purchases", perDay: false, breakable: true },
  aov: { metric: "AOV", value: (p) => ratio(p.purchaseValueCents, p.purchases), higherIsBetter: true, basis: "purchases", perDay: false, breakable: true },
  addToCart: { metric: "Add to cart", value: (p) => p.addToCart, higherIsBetter: true, basis: "self", perDay: true, breakable: false },
  initiateCheckout: { metric: "Initiate checkout", value: (p) => p.initiateCheckout, higherIsBetter: true, basis: "self", perDay: true, breakable: false },
  leads: { metric: "Leads", value: (p) => p.leads, higherIsBetter: true, basis: "leads", perDay: true, breakable: true },
  cpl: { metric: "Cost per lead", value: (p) => ratio(p.spendCents, p.leads), higherIsBetter: false, basis: "leads", perDay: false, breakable: true },
};

const COMMON = ["spend", "impressions", "reach", "frequency", "cpm", "linkClicks", "linkCtr", "costPerLinkClick", "lpv", "results", "costPerResult"];
const ECOM = ["purchases", "purchaseValue", "roas", "costPerPurchase", "aov", "addToCart", "initiateCheckout"];
const LEAD = ["leads", "cpl"];

function keysFor(type: BusinessType): string[] {
  if (type === "ecom") return [...COMMON, ...ECOM];
  if (type === "leadgen") return [...COMMON, ...LEAD];
  return [...COMMON, ...ECOM, ...LEAD];
}

function pct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Percent change of a count, treating "none, then some" as an unbounded rise. */
function countChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  if (previous === 0) return current > 0 ? Number.POSITIVE_INFINITY : 0;
  return ((current - previous) / previous) * 100;
}

function basisCount(def: Def, p: PeriodPerformance): number | null {
  switch (def.basis) {
    case "results": return num(p.results);
    case "purchases": return num(p.purchases);
    case "leads": return num(p.leads);
    case "self": return num(def.value(p));
    case "impressions": return num(p.impressions);
    default: return null;
  }
}

function isLowVolume(def: Def, cur: PeriodPerformance | null, prev: PeriodPerformance | null): boolean {
  // No baseline (previous totals failed to load, or nothing was spent): no row can be compared.
  if (!prev || prev.spendCents === 0) return true;
  if (def.basis === "none") return false;
  const min = def.basis === "impressions" ? COMPARISON_THRESHOLDS.minImpressions : COMPARISON_THRESHOLDS.minResults;
  const c = cur ? basisCount(def, cur) : null;
  const p = prev ? basisCount(def, prev) : null;
  return (c ?? 0) < min || (p ?? 0) < min;
}

export function kpiRows(
  snap: MetaAuditSnapshot,
  windows: Windows,
  type: BusinessType,
  breaks: MeasurementBreak[],
): KpiRow[] {
  const cur = snap.totals ?? null;
  const prev = snap.previousTotals ?? null;
  const reachOk = !cur?.reachSummed && !prev?.reachSummed;
  const hasBreak = breaks.length > 0;
  const { materialityPct } = COMPARISON_THRESHOLDS;

  const resultsPct = countChange(num(cur?.results), num(prev?.results));
  const rows: KpiRow[] = [];

  for (const key of keysFor(type)) {
    const def = DEFS[key];
    if ((key === "reach" || key === "frequency") && !reachOk) continue;
    const current = cur ? num(def.value(cur)) : null;
    const previous = prev ? num(def.value(prev)) : null;
    if (current == null && previous == null) continue;

    const delta = current != null && previous != null ? current - previous : null;
    const deltaPct = pct(current, previous);
    // A side missing (not equal values) means there is nothing to compare: never "Stable".
    const lowVolume = isLowVolume(def, cur, prev) || delta == null;

    let status: KpiStatus;
    if (lowVolume) {
      status = "Low volume";
    } else if (delta == null || delta === 0) {
      // delta == null is unreachable here (lowVolume above); kept for the type narrowing.
      status = "Stable";
    } else if (deltaPct != null && Math.abs(deltaPct) <= materialityPct) {
      status = "Stable";
    } else if (def.higherIsBetter == null) {
      // Spend: judged by what it bought. A rise is fine when results rose at least as much;
      // a fall is fine when results fell by less. Unknown results never earn "Improved".
      const spendPct = deltaPct ?? (delta > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
      if (delta > 0) {
        status = resultsPct != null && resultsPct >= spendPct ? "Improved" : "Declined";
      } else {
        status = resultsPct != null && resultsPct > spendPct ? "Improved" : "Declined";
      }
    } else {
      status = delta > 0 === def.higherIsBetter ? "Improved" : "Declined";
    }

    rows.push({
      metric: def.metric,
      current,
      previous,
      delta,
      deltaPct,
      perDayCurrent: def.perDay && current != null ? current / windows.current.days : null,
      perDayPrevious: def.perDay && previous != null ? previous / windows.previous.days : null,
      status,
      lowVolume,
      higherIsBetter: def.higherIsBetter,
      measurementBreak: def.breakable && hasBreak,
    });
  }
  return rows;
}
