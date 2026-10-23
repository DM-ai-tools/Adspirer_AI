import { afterEach, describe, expect, it, vi } from "vitest";
import { parseComparisonRanges } from "@/lib/agent/natural-dates";
import { resolveAuditBrief } from "@/lib/agent/audit-brief";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import {
  demoMetaAuditSnapshot,
  fetchMetaAuditSnapshot,
  scopeAuditSnapshot,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { renderAdSetEvidence } from "@/lib/audit/render";
import { createMockMetaAdsProvider } from "@/lib/adspirer/mock-provider";

const NOW = new Date("2026-10-20T08:00:00Z");

const pair = (text: string) => {
  const r = parseComparisonRanges(text, NOW);
  return r
    ? `${r.current.dateStart}..${r.current.dateStop} vs ${r.comparison.dateStart}..${r.comparison.dateStop}`
    : null;
};

describe("parseComparisonRanges", () => {
  it.each([
    ["compare Oct 19-20 vs Oct 17-18", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    ["audit the account for Oct 19-20 vs Oct 17-18", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    ["19 Oct to 20 Oct compared to 17 Oct to 18 Oct", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    ["19 Oct to 20 Oct compared with 17 Oct to 18 Oct", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    ["Oct 19-20 versus Oct 17-18", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    ["compare Oct 19-20 with Oct 17-18", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
    // Monday 19 Oct 2026 → today; last week is the full calendar week before.
    ["this week vs last week", "2026-10-19..2026-10-20 vs 2026-10-12..2026-10-18"],
    ["last 7 days vs the 7 days before", "2026-10-14..2026-10-20 vs 2026-10-07..2026-10-13"],
    ["last 7 days vs previous 7 days", "2026-10-14..2026-10-20 vs 2026-10-07..2026-10-13"],
    ["last 14 days vs the previous period", "2026-10-07..2026-10-20 vs 2026-09-23..2026-10-06"],
    // The later range is the current one; 16–31 Oct is clamped to today.
    ["1–15 Oct vs 16–31 Oct", "2026-10-16..2026-10-20 vs 2026-10-01..2026-10-15"],
    ["October vs September", "2026-10-01..2026-10-20 vs 2026-09-01..2026-09-30"],
    ["2026-10-19 to 2026-10-20 vs 2026-10-17 to 2026-10-18", "2026-10-19..2026-10-20 vs 2026-10-17..2026-10-18"],
  ])("%s → %s", (text, expected) => {
    expect(pair(text)).toBe(expected);
  });

  it("needs two ranges", () => {
    expect(pair("audit the account for Oct 19-20")).toBeNull();
    expect(pair("compare campaign A vs campaign B")).toBeNull();
    expect(pair("audit the account for last 7 days")).toBeNull();
  });

  it("labels both ranges with their dates", () => {
    const r = parseComparisonRanges("Oct 19-20 vs Oct 17-18", NOW)!;
    expect(r.current.dateLabel).toBe("19 Oct 2026 – 20 Oct 2026");
    expect(r.comparison.dateLabel).toBe("17 Oct 2026 – 18 Oct 2026");
  });
});

describe("audit brief with a named comparison", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps both ranges", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const brief = resolveAuditBrief("audit the account comparing Oct 19-20 vs Oct 17-18");
    expect(brief).toMatchObject({
      scope: "account",
      dateStart: "2026-10-19",
      dateStop: "2026-10-20",
      compareStart: "2026-10-17",
      compareStop: "2026-10-18",
      ready: true,
    });
  });

  it("does not read the comparison as a campaign name", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const brief = resolveAuditBrief("audit campaign TR Lead Gen for this week vs last week");
    expect(brief.campaignHints).toEqual(["TR Lead Gen"]);
    expect(brief.compareStart).toBe("2026-10-12");
  });

  it("defaults to no named comparison when one range is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const brief = resolveAuditBrief("audit the account for Oct 19-20");
    expect(brief.dateStart).toBe("2026-10-19");
    expect(brief.compareStart).toBeNull();
    expect(brief.compareStop).toBeNull();
  });

  it("a later single range replaces an earlier comparison", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const brief = resolveAuditBrief("now do 16th to 17th october", [
      { role: "user", content: "audit the account Oct 19-20 vs Oct 17-18" },
    ]);
    expect(brief.dateStart).toBe("2026-10-16");
    expect(brief.compareStart).toBeNull();
  });
});

// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;

function fakeGraph(options: { failAdSetComparison?: boolean } = {}) {
  const calls: Array<{ path: string; params: Params }> = [];
  const insight = (key: string, id: string, spend: string, leads: string) => ({
    [key]: id,
    spend,
    impressions: "1000",
    reach: "800",
    frequency: "1.25",
    inline_link_click_ctr: "1.1",
    inline_link_clicks: "11",
    cpm: "10",
    results: [{ indicator: "actions:onsite_conversion.lead_grouped", values: [{ value: leads }] }],
  });
  const graph = {
    get: async <T,>(path: string, params: Params = {}): Promise<T> => {
      calls.push({ path, params });
      const range = String(params.time_range ?? "");
      const comparison = range.includes("2026-10-17");
      if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "Australia/Sydney", account_status: 1 } as T;
      if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "TR | Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/adsets") return { data: [{ id: "a1", name: "Broad", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/insights" && params.level === "campaign") {
        return { data: [comparison ? insight("campaign_id", "c1", "100", "2") : insight("campaign_id", "c1", "120", "6")] } as T;
      }
      if (path === "act_1/insights" && params.level === "adset" && params.time_range) {
        if (comparison && options.failAdSetComparison) throw new Error("Please reduce the amount of data");
        return { data: [comparison ? insight("adset_id", "a1", "100", "2") : insight("adset_id", "a1", "120", "6")] } as T;
      }
      if (path === "act_1/insights" && params.level === "account" && !params.breakdowns) {
        return { data: [comparison ? insight("account_id", "act_1", "100", "2") : insight("account_id", "act_1", "120", "6")] } as T;
      }
      return { data: [] } as T;
    },
  };
  return { graph, calls };
}

describe("named comparison fetch", () => {
  it("asks Meta for the named comparison range", async () => {
    const { graph, calls } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", {
      since: "2026-10-19",
      until: "2026-10-20",
      compareSince: "2026-10-17",
      compareUntil: "2026-10-18",
    });
    expect(snap.previousPeriod).toEqual({ since: "2026-10-17", until: "2026-10-18" });
    expect(snap.comparisonNamed).toBe(true);
    const ranges = calls.map((c) => String(c.params.time_range ?? ""));
    expect(ranges).toContain(JSON.stringify({ since: "2026-10-17", until: "2026-10-18" }));
    expect(snap.previousTotals?.impressions).toBe(1000);
    expect(snap.previousTotals?.reach).toBe(800);
    expect(snap.campaigns[0]!.previousPerformance?.spendCents).toBe(10_000);
  });

  it("names the comparison part that failed, and the evidence says it failed to load", async () => {
    const { graph } = fakeGraph({ failAdSetComparison: true });
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", {
      since: "2026-10-19",
      until: "2026-10-20",
      compareSince: "2026-10-17",
      compareUntil: "2026-10-18",
    });
    expect(snap.warnings.join(" ")).toMatch(/Comparison period \(2026-10-17 → 2026-10-18\) ad set performance/);
    // Campaigns and totals still compare.
    expect(snap.previousTotals?.spendCents).toBe(10_000);
    const text = renderAdSetEvidence(snap);
    expect(text).toMatch(/Broad[\s\S]*vs comparison period: failed to load/);
    expect(text).not.toMatch(/Broad[\s\S]*no delivery in the comparison period/);
  });

  it("the mock provider uses the named comparison range", async () => {
    const provider = createMockMetaAdsProvider();
    const snap = await provider.getAuditSnapshot("act_400500600", {
      since: "2026-10-19",
      until: "2026-10-20",
      compareSince: "2026-10-17",
      compareUntil: "2026-10-18",
    });
    expect(snap.period).toMatchObject({ since: "2026-10-19", until: "2026-10-20", days: 2 });
    expect(snap.previousPeriod).toEqual({ since: "2026-10-17", until: "2026-10-18" });
    expect(snap.comparisonNamed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const perf = (over: Partial<PeriodPerformance>): PeriodPerformance => ({
  spendCents: 100_000,
  impressions: 50_000,
  reach: 20_000,
  frequency: 2.5,
  linkCtr: 1.2,
  cpmCents: 2_000,
  results: 40,
  resultLabel: "Purchases",
  costPerResultCents: 2_500,
  roas: 2,
  linkClicks: 600,
  landingPageViews: 450,
  ...over,
});

function snapWith(over: Partial<MetaAuditSnapshot>): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Demo", 2);
  return {
    ...base,
    period: { days: 2, since: "2026-10-19", until: "2026-10-20" },
    previousPeriod: { since: "2026-10-17", until: "2026-10-18" },
    comparisonNamed: true,
    ...over,
  };
}

describe("comparison evidence", () => {
  it("lists every metric before → after with the change", () => {
    const snap = snapWith({
      totals: perf({ spendCents: 120_000, impressions: 60_000, reach: 24_000, frequency: 2.5, cpmCents: 2_000, linkClicks: 720, linkCtr: 1.2, results: 48, costPerResultCents: 2_500, roas: 2.5, landingPageViews: 540 }),
      previousTotals: perf({}),
    });
    const text = renderAdSetEvidence(snap);
    const totalsLine = text.split("\n").find((l) => l.startsWith("Totals vs comparison period"))!;
    expect(totalsLine).toContain("(2026-10-17 → 2026-10-18)");
    expect(totalsLine).toContain("spend $1,000 → $1,200 (+20%)");
    expect(totalsLine).toContain("impressions 50,000 → 60,000 (+20%)");
    expect(totalsLine).toContain("reach 20,000 → 24,000 (+20%)");
    expect(totalsLine).toContain("frequency 2.50 → 2.50 (no change)");
    expect(totalsLine).toContain("CPM $20.00 → $20.00 (no change)");
    expect(totalsLine).toContain("link clicks 600 → 720 (+20%)");
    expect(totalsLine).toContain("link CTR 1.20% → 1.20% (no change)");
    expect(totalsLine).toContain("Purchases 40 → 48 (+20%)");
    expect(totalsLine).toContain("cost per result $25.00 → $25.00 (no change)");
    expect(totalsLine).toContain("ROAS 2.00× → 2.50× (+25%)");
    expect(totalsLine).toContain("purchase value $2,000 → $3,000 (+50%)");
    expect(totalsLine).toContain("landing page views 450 → 540 (+20%)");
  });

  it("states both ranges exactly", () => {
    const text = renderAdSetEvidence(snapWith({ totals: perf({}), previousTotals: perf({}) }));
    expect(text).toContain("Current: 2026-10-19 → 2026-10-20 (2 days); Comparison: 2026-10-17 → 2026-10-18 (2 days)");
    expect(text).not.toMatch(/not like-for-like/);
  });

  it("flags different lengths and compares daily averages", () => {
    const text = renderAdSetEvidence(
      snapWith({
        previousPeriod: { since: "2026-10-12", until: "2026-10-18" },
        totals: perf({ spendCents: 40_000 }),
        previousTotals: perf({ spendCents: 140_000 }),
      }),
    );
    expect(text).toContain("Comparison: 2026-10-12 → 2026-10-18 (7 days)");
    expect(text).toMatch(/not like-for-like/);
    // $400 over 2 days vs $1,400 over 7 days → $200/day both.
    expect(text).toMatch(/Daily averages[^\n]*spend\/day \$200\.00 → \$200\.00 \(no change\)/);
  });

  it("keeps the previous-period wording when no comparison was named", () => {
    const text = renderAdSetEvidence(
      snapWith({ comparisonNamed: undefined, previousPeriod: { since: "2026-10-17", until: "2026-10-18" }, totals: perf({}), previousTotals: perf({}) }),
    );
    expect(text).toContain("Totals vs previous period (2026-10-17 → 2026-10-18)");
    expect(text).toContain("Comparison: 2026-10-17 → 2026-10-18 (2 days) — the same number of days immediately before");
  });
});

describe("summed totals for a campaign scope", () => {
  it("does not sum reach across campaigns", () => {
    const scoped = scopeAuditSnapshot(demoMetaAuditSnapshot("act_1", "Demo", 4), ["demo_campaign_1", "demo_campaign_3"]);
    expect(scoped.totals?.reachSummed).toBe(true);
    expect(scoped.previousTotals?.reachSummed).toBe(true);
    const text = renderAdSetEvidence(scoped);
    const totalsLine = text.split("\n").find((l) => l.startsWith("Totals vs previous period"))!;
    expect(totalsLine).toMatch(/reach: not summable across campaigns/);
    expect(totalsLine).toContain("impressions");
  });

  it("uses the account-level figures when the scope covers every delivering campaign", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 4);
    const scoped = scopeAuditSnapshot(snap, ["demo_campaign_1", "demo_campaign_2", "demo_campaign_3"]);
    expect(scoped.totals).toEqual(snap.totals);
    expect(scoped.previousTotals).toEqual(snap.previousTotals);
  });
});

describe("writer instructions", () => {
  it("uses the evidence dates and never 'not available' for loaded metrics", () => {
    expect(META_AUDIT_FRAMEWORK).toMatch(/exactly the Current and Comparison dates/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/never write "not available" for a metric that is in a comparison line/i);
    expect(META_AUDIT_FRAMEWORK).toMatch(/failed to load/);
    expect(META_AUDIT_FRAMEWORK).toMatch(/daily averages/);
  });
});
