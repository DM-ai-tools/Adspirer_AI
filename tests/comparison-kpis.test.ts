import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { kpiRows, windowsOf } from "@/lib/comparison/kpis";
import { COMPARISON_THRESHOLDS } from "@/lib/comparison/thresholds";
import type { MeasurementBreak } from "@/lib/analysis/measurement";

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 100_000,
    impressions: 50_000,
    reach: 30_000,
    frequency: 1.6,
    linkCtr: 1.2,
    cpmCents: 2000,
    results: 100,
    resultLabel: "Leads",
    costPerResultCents: 1000,
    roas: null,
    linkClicks: 600,
    landingPageViews: 500,
    ...over,
  };
}

function snap(
  current: Partial<PeriodPerformance>,
  previous: Partial<PeriodPerformance> | null,
  opts: { since?: string; until?: string; prevSince?: string; prevUntil?: string; windows?: string[] } = {},
): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Demo");
  return {
    ...base,
    period: { days: 30, since: opts.since ?? "2026-10-01", until: opts.until ?? "2026-10-30" },
    previousPeriod: { since: opts.prevSince ?? "2026-09-01", until: opts.prevUntil ?? "2026-09-30" },
    totals: perf(current),
    previousTotals: previous ? perf(previous) : null,
    adSets: (base.adSets ?? []).map((a) => ({ ...a, attributionWindows: opts.windows ?? ["7d_click"] })),
  } as MetaAuditSnapshot;
}

const row = (rows: ReturnType<typeof kpiRows>, metric: string) => {
  const r = rows.find((x) => x.metric === metric);
  if (!r) throw new Error(`no row ${metric}`);
  return r;
};

const TODAY = "2026-11-17";

describe("COMPARISON_THRESHOLDS", () => {
  it("has the agreed values", () => {
    expect(COMPARISON_THRESHOLDS).toEqual({ materialityPct: 5, minResults: 30, minImpressions: 1000, minSpendShare: 0.05 });
  });
});

describe("windowsOf", () => {
  it("is mature when the window ended long enough ago", () => {
    const s = snap({}, {});
    const w = windowsOf(s, TODAY);
    expect(w.current).toEqual({ since: "2026-10-01", until: "2026-10-30", days: 30 });
    expect(w.previous).toEqual({ since: "2026-09-01", until: "2026-09-30", days: 30 });
    expect(w.equalLength).toBe(true);
    expect(w.maturity).toEqual({ immature: false, immatureFrom: null, reason: null });
  });

  it("flags unequal lengths", () => {
    const s = snap({}, {}, { prevSince: "2026-09-11", prevUntil: "2026-09-30" });
    const w = windowsOf(s, TODAY);
    expect(w.previous.days).toBe(20);
    expect(w.equalLength).toBe(false);
  });

  it("is immature from today minus 6 for a 7-day click window ending 3 days ago", () => {
    const s = snap({}, {}, { since: "2026-11-01", until: "2026-11-14", prevSince: "2026-10-18", prevUntil: "2026-10-31" });
    const w = windowsOf(s, TODAY);
    expect(w.maturity.immature).toBe(true);
    // daysBetween(2026-11-11, 2026-11-17) = 6 < 7; daysBetween(2026-11-10, ...) = 7, not < 7.
    expect(w.maturity.immatureFrom).toBe("2026-11-11");
    expect(w.maturity.reason).toBe("Meta can still add conversions to the last 7 days (7-day click attribution)");
  });

  it("uses a 1-day lag for 1d_click only", () => {
    const yesterday = snap({}, {}, { since: "2026-11-01", until: "2026-11-16", windows: ["1d_click"], prevSince: "2026-10-16", prevUntil: "2026-10-31" });
    expect(windowsOf(yesterday, TODAY).maturity.immature).toBe(false);
    const todayEnd = snap({}, {}, { since: "2026-11-01", until: "2026-11-17", windows: ["1d_click"], prevSince: "2026-10-15", prevUntil: "2026-10-31" });
    const w = windowsOf(todayEnd, TODAY);
    expect(w.maturity.immature).toBe(true);
    expect(w.maturity.immatureFrom).toBe("2026-11-17");
    expect(w.maturity.reason).toBe("Meta can still add conversions to the last 1 days (1-day click attribution)");
  });

  it("clamps immatureFrom to the window start", () => {
    const s = snap({}, {}, { since: "2026-11-15", until: "2026-11-16", prevSince: "2026-11-13", prevUntil: "2026-11-14" });
    const w = windowsOf(s, TODAY);
    expect(w.maturity.immature).toBe(true);
    expect(w.maturity.immatureFrom).toBe("2026-11-15");
  });

  it("defaults to 7 days when no click window is named", () => {
    const s = snap({}, {}, { since: "2026-11-01", until: "2026-11-14", windows: [], prevSince: "2026-10-18", prevUntil: "2026-10-31" });
    expect(windowsOf(s, TODAY).maturity.immatureFrom).toBe("2026-11-11");
  });
});

describe("kpiRows", () => {
  const eq = () => windowsOf(snap({}, {}), TODAY);

  it("marks a lower cost per lead as Improved", () => {
    const s = snap({ results: 100, costPerResultCents: 3600, leads: 100, spendCents: 360_000 }, { results: 100, costPerResultCents: 4000, leads: 100, spendCents: 400_000 });
    const rows = kpiRows(s, eq(), "leadgen", []);
    const cpl = row(rows, "Cost per lead");
    expect(cpl.current).toBe(3600);
    expect(cpl.previous).toBe(4000);
    expect(cpl.deltaPct).toBeCloseTo(-10);
    expect(cpl.status).toBe("Improved");
    expect(cpl.higherIsBetter).toBe(false);
    expect(row(rows, "Cost per result").status).toBe("Improved");
  });

  it("calls a 3.3% ROAS dip Stable", () => {
    const s = snap({ roas: 2.9, purchases: 100, purchaseValueCents: 290_000 }, { roas: 3.0, purchases: 100, purchaseValueCents: 300_000 });
    const r = row(kpiRows(s, eq(), "ecom", []), "ROAS");
    expect(r.deltaPct).toBeCloseTo(-3.33, 1);
    expect(r.status).toBe("Stable");
  });

  it("flags low volume when each window has only 12 purchases, despite a 20% CPA rise", () => {
    const s = snap({ purchases: 12, spendCents: 120_000 }, { purchases: 12, spendCents: 100_000 });
    const r = row(kpiRows(s, eq(), "ecom", []), "Cost per purchase");
    expect(r.deltaPct).toBeCloseTo(20);
    expect(r.status).toBe("Low volume");
    expect(r.lowVolume).toBe(true);
  });

  it("uses impressions for rate metrics", () => {
    const s = snap({ impressions: 800, cpmCents: 3000 }, { impressions: 50_000, cpmCents: 2000 });
    const rows = kpiRows(s, eq(), "leadgen", []);
    expect(row(rows, "CPM").lowVolume).toBe(true);
    expect(row(rows, "Impressions").lowVolume).toBe(false);
  });

  it("treats previous spend 0 as Low volume with no percent change", () => {
    const s = snap({}, { spendCents: 0 });
    const rows = kpiRows(s, eq(), "leadgen", []);
    const spend = row(rows, "Spend");
    expect(spend.deltaPct).toBeNull();
    expect(spend.status).toBe("Low volume");
    expect(rows.every((r) => r.status === "Low volume")).toBe(true);
  });

  it("calls every row Low volume when the previous totals did not load", () => {
    const s = snap({ purchases: 50, leads: 50, purchaseValueCents: 500_000 }, null);
    for (const t of ["ecom", "leadgen", "hybrid"] as const) {
      const rows = kpiRows(s, eq(), t, []);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.status, r.metric).toBe("Low volume");
        expect(r.lowVolume, r.metric).toBe(true);
        expect(r.previous, r.metric).toBeNull();
        expect(r.delta, r.metric).toBeNull();
        expect(r.deltaPct, r.metric).toBeNull();
        for (const v of [r.current, r.perDayCurrent, r.perDayPrevious]) {
          expect(v === null || Number.isFinite(v), r.metric).toBe(true);
        }
      }
    }
    const undef = { ...s, previousTotals: undefined } as MetaAuditSnapshot;
    expect(kpiRows(undef, eq(), "leadgen", []).every((r) => r.status === "Low volume")).toBe(true);
  });

  it("calls a row Low volume (not Stable) when only its previous value is missing", () => {
    const s = snap({ landingPageViews: 400, linkClicks: 700 }, { landingPageViews: null });
    const rows = kpiRows(s, eq(), "leadgen", []);
    const lpv = row(rows, "Landing page views");
    expect(lpv.previous).toBeNull();
    expect(lpv.status).toBe("Low volume");
    expect(lpv.lowVolume).toBe(true);
    // A row with both sides present is still judged normally.
    expect(row(rows, "Link clicks").status).toBe("Improved");
  });

  it("fills per-day figures when the windows differ in length", () => {
    const s = snap({ spendCents: 300_000 }, { spendCents: 200_000 }, { prevSince: "2026-09-11", prevUntil: "2026-09-30" });
    const w = windowsOf(s, TODAY);
    expect(w.equalLength).toBe(false);
    const spend = row(kpiRows(s, w, "leadgen", []), "Spend");
    expect(spend.perDayCurrent).toBeCloseTo(10_000);
    expect(spend.perDayPrevious).toBeCloseTo(10_000);
  });

  it("judges a spend rise by what the results did", () => {
    const up40 = snap({ spendCents: 130_000, results: 140 }, { spendCents: 100_000, results: 100 });
    expect(row(kpiRows(up40, eq(), "leadgen", []), "Spend").status).toBe("Improved");
    const up5 = snap({ spendCents: 130_000, results: 105 }, { spendCents: 100_000, results: 100 });
    expect(row(kpiRows(up5, eq(), "leadgen", []), "Spend").status).toBe("Declined");
  });

  it("judges a spend fall by whether results fell by less", () => {
    const less = snap({ spendCents: 80_000, results: 95 }, { spendCents: 100_000, results: 100 });
    expect(row(kpiRows(less, eq(), "leadgen", []), "Spend").status).toBe("Improved");
    const more = snap({ spendCents: 80_000, results: 60 }, { spendCents: 100_000, results: 100 });
    expect(row(kpiRows(more, eq(), "leadgen", []), "Spend").status).toBe("Declined");
    expect(row(kpiRows(more, eq(), "leadgen", []), "Spend").higherIsBetter).toBeNull();
  });

  it("sets measurementBreak on result-defined rows when there is a break", () => {
    const brk: MeasurementBreak[] = [{ date: "2026-10-10", window: "current", what: "attribution changed", objectName: "Ad set A", eventType: "update_ad_set_attribution_spec" }];
    const s = snap(
      { roas: 2.5, purchases: 100, purchaseValueCents: 250_000, leads: 100 },
      { roas: 3.0, purchases: 100, purchaseValueCents: 300_000, leads: 100 },
    );
    const rows = kpiRows(s, eq(), "hybrid", brk);
    for (const m of ["Results", "Cost per result", "ROAS", "Purchase value", "Purchases", "Cost per purchase", "Leads", "Cost per lead", "AOV"]) {
      expect(row(rows, m).measurementBreak, m).toBe(true);
    }
    expect(row(rows, "Spend").measurementBreak).toBe(false);
    expect(row(rows, "CPM").measurementBreak).toBe(false);
    const none = kpiRows(s, eq(), "hybrid", []);
    expect(none.every((r) => !r.measurementBreak)).toBe(true);
  });

  it("derives AOV and cost per purchase from the totals", () => {
    const s = snap({ purchases: 100, purchaseValueCents: 1_000_000, spendCents: 200_000 }, { purchases: 80, purchaseValueCents: 640_000, spendCents: 200_000 });
    const rows = kpiRows(s, eq(), "ecom", []);
    expect(row(rows, "AOV").current).toBe(10_000);
    expect(row(rows, "AOV").previous).toBe(8_000);
    expect(row(rows, "AOV").status).toBe("Improved");
    expect(row(rows, "Cost per purchase").current).toBe(2000);
    expect(row(rows, "Cost per link click").current).toBeCloseTo(200_000 / 600);
  });

  it("includes only the rows for the business type", () => {
    const s = snap({ purchases: 50, leads: 50, purchaseValueCents: 500_000 }, { purchases: 50, leads: 50, purchaseValueCents: 400_000 });
    const names = (t: "ecom" | "leadgen" | "hybrid") => kpiRows(s, eq(), t, []).map((r) => r.metric);
    expect(names("ecom")).toContain("AOV");
    expect(names("ecom")).not.toContain("Leads");
    expect(names("leadgen")).toContain("Cost per lead");
    expect(names("leadgen")).not.toContain("Purchases");
    expect(names("hybrid")).toEqual(expect.arrayContaining(["Purchases", "Leads", "Cost per lead", "Results", "Cost per result"]));
  });

  it("omits rows with no data in either window", () => {
    const s = snap({}, {});
    const names = kpiRows(s, eq(), "ecom", []).map((r) => r.metric);
    expect(names).not.toContain("Purchases");
    expect(names).not.toContain("ROAS");
  });

  it("drops reach and frequency when totals were summed across campaigns", () => {
    const s = snap({ reachSummed: true }, {});
    const names = kpiRows(s, eq(), "leadgen", []).map((r) => r.metric);
    expect(names).not.toContain("Reach");
    expect(names).not.toContain("Frequency");
    expect(names).toContain("Spend");
  });

  it("has null deltaPct when previous is null or zero, keeping the row if the other side exists", () => {
    const s = snap({ landingPageViews: 400 }, { landingPageViews: null });
    const lpv = row(kpiRows(s, eq(), "leadgen", []), "Landing page views");
    expect(lpv.previous).toBeNull();
    expect(lpv.deltaPct).toBeNull();
    expect(lpv.delta).toBeNull();
  });
});
