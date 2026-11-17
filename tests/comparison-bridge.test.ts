import { describe, expect, it } from "vitest";
import type { PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { bridgesOf } from "@/lib/comparison/bridge";

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 100_000,
    impressions: 100_000,
    reach: 60_000,
    frequency: 1.6,
    linkCtr: 1,
    cpmCents: 1000,
    results: 50,
    resultLabel: "Leads",
    costPerResultCents: 2000,
    roas: null,
    linkClicks: 1000,
    ...over,
  };
}

// previous: CPM 10 (1000c), CTR 1%, CVR 5% (50/1000). current: CPM 12, CTR 1%, CVR 4%.
const prev = perf();
const cur = perf({ spendCents: 120_000, results: 40 });

describe("bridgesOf", () => {
  it("cost per result effects sum to the change; CPM and CVR both push cost up", () => {
    const bridges = bridgesOf(cur, prev, "leadgen");
    const b = bridges[0];
    if (!("effects" in b)) throw new Error("expected a bridge");
    expect(b.metric).toBe("cost per result");
    expect(b.previous).toBeCloseTo(2000, 6);
    expect(b.current).toBeCloseTo(3000, 6);
    const sum = b.effects.reduce((s, e) => s + e.value, 0);
    expect(Math.abs(sum - (b.current - b.previous))).toBeLessThan(0.01);
    const byDriver = Object.fromEntries(b.effects.map((e) => [e.driver, e]));
    expect(byDriver.CPM.value).toBeGreaterThan(0);
    expect(byDriver.CVR.value).toBeGreaterThan(0);
    expect(byDriver.CTR.value).toBeCloseTo(0, 6);
    const shares = b.effects.reduce((s, e) => s + e.shareOfChangePct, 0);
    expect(shares).toBeCloseTo(100, 6);
  });

  it("results bridge uses Volume, CPM, CTR, CVR and sums exactly", () => {
    const b = bridgesOf(cur, prev, "leadgen")[1];
    if (!("effects" in b)) throw new Error("expected a bridge");
    expect(b.metric).toBe("results");
    expect(b.effects.map((e) => e.driver)).toEqual(["Volume", "CPM", "CTR", "CVR"]);
    const sum = b.effects.reduce((s, e) => s + e.value, 0);
    expect(Math.abs(sum - (b.current - b.previous))).toBeLessThan(0.01);
    expect(b.effects[0].value).toBeGreaterThan(0); // more spend
    expect(b.effects[1].value).toBeLessThan(0); // dearer impressions
  });

  it("zero link clicks in the previous period is unavailable and names the input", () => {
    const bridges = bridgesOf(cur, perf({ linkClicks: 0 }), "leadgen");
    for (const b of bridges) {
      expect("unavailable" in b).toBe(true);
      if ("unavailable" in b) expect(b.unavailable).toMatch(/link clicks/);
    }
    const first = bridges[0];
    if ("unavailable" in first) expect(first.unavailable).toMatch(/previous/);
  });

  it("missing link clicks in the current period is unavailable", () => {
    const b = bridgesOf(perf({ linkClicks: undefined }), prev, "leadgen")[0];
    expect("unavailable" in b && b.unavailable).toMatch(/link clicks \(current period\)/);
  });

  it("leadgen gets no purchase value bridge", () => {
    const bridges = bridgesOf(cur, prev, "leadgen");
    expect(bridges.map((b) => b.metric)).toEqual(["cost per result", "results"]);
  });

  it("ecom and hybrid get a purchase value bridge with Volume and AOV", () => {
    const p = perf({ purchases: 50, purchaseValueCents: 500_000 });
    const c = perf({ spendCents: 120_000, results: 40, purchases: 60, purchaseValueCents: 780_000 });
    for (const type of ["ecom", "hybrid"] as const) {
      const bridges = bridgesOf(c, p, type);
      expect(bridges.map((b) => b.metric)).toEqual(["cost per result", "results", "purchase value"]);
      const b = bridges[2];
      if (!("effects" in b)) throw new Error("expected a bridge");
      expect(b.effects.map((e) => e.driver)).toEqual(["Volume", "AOV"]);
      expect(b.change).toBeCloseTo(280_000, 6);
      const sum = b.effects.reduce((s, e) => s + e.value, 0);
      expect(Math.abs(sum - b.change)).toBeLessThan(0.01);
    }
  });

  it("purchase value is unavailable when purchases are missing", () => {
    const b = bridgesOf(cur, prev, "ecom")[2];
    expect("unavailable" in b && b.unavailable).toMatch(/purchases/);
  });

  it("an unchanged metric gives zero effects and zero shares, no NaN", () => {
    const b = bridgesOf(perf(), perf(), "leadgen")[0];
    if (!("effects" in b)) throw new Error("expected a bridge");
    expect(b.change).toBe(0);
    for (const e of b.effects) {
      expect(e.value).toBe(0);
      expect(e.shareOfChangePct).toBe(0);
    }
  });
});
