import { describe, expect, it } from "vitest";
import {
  demoHealthSnapshot,
  evaluateHealth,
  healthWindow,
  type HealthSnapshot,
  type PeriodMetrics,
} from "@/lib/monitoring/health";

function period(over: Partial<PeriodMetrics> = {}): PeriodMetrics {
  return {
    spendCents: 70_000,
    impressions: 60_000,
    linkClicks: 600,
    linkCtr: 1,
    cpmCents: 1_100,
    frequency: 1.8,
    results: 20,
    resultLabel: "Leads",
    costPerResultCents: 3_500,
    ...over,
  };
}

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    account: {
      id: "act_1",
      name: "Test account",
      currency: "AUD",
      timezone: "Australia/Sydney",
      statusLabel: "Active",
      statusProblem: false,
      disableReason: null,
      amountSpentCents: 100_000,
      spendCapCents: null,
    },
    window: healthWindow("2026-10-09", 7),
    current: period(),
    previous: period(),
    dailyAllottedCents: 10_000,
    activeCampaigns: 1,
    campaigns: [],
    adIssues: [],
    warnings: [],
    fetchedAt: "2026-10-09T00:00:00Z",
    ...over,
  };
}

const codes = (s: HealthSnapshot) => evaluateHealth(s).findings.map((f) => f.code);

describe("healthWindow", () => {
  it("uses the last full days (today excluded) and the same-length period before", () => {
    expect(healthWindow("2026-10-09", 7)).toEqual({
      days: 7,
      current: { since: "2026-10-02", until: "2026-10-08" },
      previous: { since: "2026-09-25", until: "2026-10-01" },
    });
  });
});

describe("evaluateHealth", () => {
  it("scores a steady account as healthy with no findings", () => {
    const h = evaluateHealth(snapshot());
    expect(h.findings).toEqual([]);
    expect(h.score).toBe(100);
    expect(h.status).toBe("healthy");
    expect(h.kpis.map((k) => k.key)).toEqual(["spend", "results", "cpr", "linkCtr", "cpm", "frequency"]);
  });

  it("flags falling results and rising cost per result", () => {
    const s = snapshot({
      current: period({ results: 8, costPerResultCents: 8_750 }),
      previous: period({ results: 20, costPerResultCents: 3_500 }),
    });
    const h = evaluateHealth(s);
    expect(codes(s)).toEqual(expect.arrayContaining(["RESULTS_DOWN", "CPR_UP"]));
    expect(h.status).toBe("at_risk");
    expect(h.findings[0]!.severity).toBe("critical");
    expect(h.findings.find((f) => f.code === "CPR_UP")!.title).toBe("Cost per lead up +150%");
  });

  it("flags a campaign spending with zero results and links an agent prompt", () => {
    const s = snapshot({
      campaigns: [
        {
          id: "c1",
          name: "TR | Lead Gen | Sep 2026",
          delivering: true,
          dailyBudgetCents: 3_000,
          startTime: "2026-09-01T00:00:00+0000",
          current: period({ spendCents: 45_000, results: 0, resultLabel: "Registrations", costPerResultCents: null }),
          previous: period(),
        },
      ],
    });
    const f = evaluateHealth(s).findings.find((x) => x.code === "SPEND_NO_RESULTS")!;
    expect(f.severity).toBe("critical");
    expect(f.title).toBe("Spending with 0 registrations");
    expect(f.ask).toContain("TR | Lead Gen | Sep 2026");
    expect(f.campaignId).toBe("c1");
  });

  it("flags active campaigns that are not spending, unless just launched", () => {
    const base = {
      id: "c2",
      name: "New launch",
      delivering: true,
      dailyBudgetCents: 5_000,
      current: period({ spendCents: 0, results: null }),
      previous: period({ spendCents: 0, results: null }),
    };
    expect(codes(snapshot({ campaigns: [{ ...base, startTime: "2026-08-01T00:00:00+0000" }] }))).toContain(
      "CAMPAIGN_NOT_SPENDING",
    );
    expect(codes(snapshot({ campaigns: [{ ...base, startTime: "2026-10-08T03:00:00+0000" }] }))).not.toContain(
      "CAMPAIGN_NOT_SPENDING",
    );
  });

  it("warns before the account spending limit stops all ads", () => {
    const s = snapshot({
      account: { ...snapshot().account, amountSpentCents: 960_000, spendCapCents: 1_000_000 },
    });
    const f = evaluateHealth(s).findings.find((x) => x.code === "SPEND_CAP")!;
    expect(f.severity).toBe("critical");
    expect(f.detail).toMatch(/about 4 days/);
  });

  it("treats a disabled account and no delivery as critical", () => {
    const disabled = snapshot({
      account: { ...snapshot().account, statusProblem: true, statusLabel: "Disabled", disableReason: "Risk payment" },
    });
    expect(codes(disabled)).toContain("ACCOUNT_STATUS");
    expect(codes(snapshot({ current: period({ spendCents: 0, results: 0 }) }))).toContain("NO_DELIVERY");
  });

  it("does not compare against an empty baseline", () => {
    const s = snapshot({ previous: period({ spendCents: 0, results: 0, impressions: 0, costPerResultCents: null, cpmCents: null }) });
    expect(codes(s)).not.toEqual(expect.arrayContaining(["RESULTS_DOWN", "CPR_UP", "SPEND_SPIKE"]));
  });

  it("produces a believable demo with mixed findings", () => {
    const h = evaluateHealth(demoHealthSnapshot("act_demo", "Demo", 7));
    expect(h.demo).toBe(true);
    expect(h.findings.length).toBeGreaterThan(2);
    expect(["watch", "at_risk"]).toContain(h.status);
  });
});
