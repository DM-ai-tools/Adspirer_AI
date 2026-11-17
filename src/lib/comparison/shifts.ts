import type { BreakdownDimension, BreakdownRow, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { COMPARISON_THRESHOLDS } from "./thresholds";

export type Shift = {
  dimension: BreakdownDimension;
  key: string;
  /** Share of the dimension's own total spend in each window, in percent. */
  spendShareCurrentPct: number;
  spendSharePreviousPct: number;
  /** Spend ÷ results, in cents; null when there are no results. */
  costPerResultCurrent: number | null;
  costPerResultPrevious: number | null;
  lowVolume: boolean;
};

const TOP_KEYS = 8;

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function spendOf(p: PeriodPerformance | undefined): number {
  return finite(p?.spendCents) ?? 0;
}

function cost(p: PeriodPerformance | undefined): number | null {
  const results = finite(p?.results);
  if (!p || results == null || results <= 0) return null;
  const c = spendOf(p) / results;
  return Number.isFinite(c) ? c : null;
}

function share(p: PeriodPerformance | undefined, total: number): number {
  if (!p || total <= 0) return 0;
  const s = (spendOf(p) / total) * 100;
  return Number.isFinite(s) ? s : 0;
}

function total(rows: BreakdownRow[]): number {
  return rows.reduce((s, r) => s + spendOf(r.performance), 0);
}

/** How each split's spend share and cost per result moved between the windows; dimensions that failed to load are listed. */
export function breakdownShifts(snap: MetaAuditSnapshot): { shifts: Shift[]; failed: BreakdownDimension[] } {
  const shifts: Shift[] = [];
  const failed: BreakdownDimension[] = [];
  const minSharePct = COMPARISON_THRESHOLDS.minSpendShare * 100;

  for (const b of snap.comparisonBreakdowns ?? []) {
    if (b.current == null || b.previous == null) {
      failed.push(b.dimension);
      continue;
    }
    const cur = new Map(b.current.map((r) => [r.key, r.performance]));
    const prev = new Map(b.previous.map((r) => [r.key, r.performance]));
    const curTotal = total(b.current);
    const prevTotal = total(b.previous);
    const keys = [...new Set([...cur.keys(), ...prev.keys()])]
      .sort((a, c) => spendOf(cur.get(c)) - spendOf(cur.get(a)))
      .slice(0, TOP_KEYS);
    for (const key of keys) {
      const c = cur.get(key);
      const p = prev.get(key);
      const sc = share(c, curTotal);
      const sp = share(p, prevTotal);
      const lowResults = [c, p].some((x) => {
        const r = finite(x?.results);
        return r != null && r < COMPARISON_THRESHOLDS.minResults;
      });
      shifts.push({
        dimension: b.dimension,
        key,
        spendShareCurrentPct: sc,
        spendSharePreviousPct: sp,
        costPerResultCurrent: cost(c),
        costPerResultPrevious: cost(p),
        lowVolume: (sc < minSharePct && sp < minSharePct) || lowResults,
      });
    }
  }
  return { shifts, failed };
}
