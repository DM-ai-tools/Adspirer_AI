import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { AuditAd, AuditCampaign, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { funnelsOf } from "@/lib/comparison/funnel";
import { creativeChanges, entitySplit } from "@/lib/comparison/entities";
import { breakdownShifts } from "@/lib/comparison/shifts";

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
    ...over,
  };
}

function campaign(id: string, current: PeriodPerformance | null, previous: PeriodPerformance | null): AuditCampaign {
  const base = demoMetaAuditSnapshot("act_1", "Demo").campaigns[0];
  return { ...base, id, name: `Camp ${id}`, objective: "OUTCOME_LEADS", performance: current, previousPerformance: previous };
}

function ad(id: string, over: Partial<AuditAd>): AuditAd {
  const base = demoMetaAuditSnapshot("act_1", "Demo").ads?.[0] as AuditAd;
  return { ...base, id, name: `Ad ${id}`, adSetId: "s", campaignId: "c1", frequency7d: null, ...over };
}

function snap(over: Partial<MetaAuditSnapshot>): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Demo");
  return { ...base, ...over } as MetaAuditSnapshot;
}

describe("funnelsOf", () => {
  it("leaves a missing link-click step null with a note and null rates", () => {
    const s = snap({
      totals: perf({ leads: 50 }),
      previousTotals: perf({ leads: 40 }),
    });
    const [funnel] = funnelsOf(s, "leadgen");
    expect(funnel.kind).toBe("leadgen");
    const clicks = funnel.steps.find((x) => x.step === "link clicks")!;
    expect(clicks.current).toBeNull();
    expect(clicks.previous).toBeNull();
    expect(clicks.note).toBe("Not available — Meta returned no link clicks");
    expect(clicks.rateCurrent).toBeNull();
    expect(clicks.ratePrevious).toBeNull();
    const forms = funnel.steps.find((x) => x.step === "form opens")!;
    expect(forms.current).toBeNull();
    expect(forms.note).toBe("Not available — Meta returned no form opens");
    const leads = funnel.steps.find((x) => x.step === "leads")!;
    expect(leads.current).toBe(50);
    expect(leads.rateCurrent).toBeNull(); // form opens missing
  });

  it("computes step rates from the step before and returns both funnels for hybrid", () => {
    const s = snap({
      totals: perf({ linkClicks: 500, landingPageViews: 400, addToCart: 40, initiateCheckout: 20, purchases: 10, leads: 5 }),
      previousTotals: perf({ linkClicks: 400, landingPageViews: 300, addToCart: 30, initiateCheckout: 15, purchases: 6, leads: 4 }),
    });
    const funnels = funnelsOf(s, "hybrid");
    expect(funnels.map((f) => f.kind)).toEqual(["ecom", "leadgen"]);
    const ecom = funnels[0].steps;
    expect(ecom[0].rateCurrent).toBeNull();
    expect(ecom[1].rateCurrent).toBeCloseTo(1, 5);
    expect(ecom[2].rateCurrent).toBeCloseTo(80, 5);
    expect(ecom[5].ratePrevious).toBeCloseTo(40, 5);
    expect(ecom.every((x) => x.note === null)).toBe(true);
  });

  it("keeps previous null when the previous window is missing", () => {
    const s = snap({ totals: perf({ linkClicks: 500 }), previousTotals: null });
    const [f] = funnelsOf(s, "leadgen");
    expect(f.steps[1].current).toBe(500);
    expect(f.steps[1].previous).toBeNull();
    expect(f.steps[1].ratePrevious).toBeNull();
    expect(f.steps[1].note).toBeNull();
  });
});

describe("entitySplit", () => {
  it("puts a previous-only campaign in stopped and a current-only one in added", () => {
    const s = snap({
      totals: perf({ spendCents: 300_000 }),
      previousTotals: perf({ spendCents: 300_000 }),
      campaigns: [
        campaign("a", perf({ spendCents: 200_000 }), perf({ spendCents: 150_000 })),
        campaign("old", null, perf({ spendCents: 150_000 })),
        campaign("new", perf({ spendCents: 100_000 }), null),
      ],
      adSets: [],
    });
    const split = entitySplit(s);
    expect(split.stopped.map((e) => e.id)).toEqual(["old"]);
    expect(split.added.map((e) => e.id)).toEqual(["new"]);
    expect(split.likeForLike.map((e) => e.id)).toEqual(["a"]);
    expect(split.stopped[0].objective).toBe("OUTCOME_LEADS");
  });

  it("like-for-like contributions sum to about 100%", () => {
    const s = snap({
      totals: perf({ spendCents: 500_000, results: 150 }),
      previousTotals: perf({ spendCents: 400_000, results: 100 }),
      campaigns: [
        campaign("a", perf({ spendCents: 300_000, results: 90 }), perf({ spendCents: 250_000, results: 70 })),
        campaign("b", perf({ spendCents: 200_000, results: 60 }), perf({ spendCents: 150_000, results: 30 })),
      ],
      adSets: [],
    });
    const { likeForLike } = entitySplit(s);
    const spendSum = likeForLike.reduce((t, e) => t + (e.spendContributionPct ?? 0), 0);
    const resultSum = likeForLike.reduce((t, e) => t + (e.resultsContributionPct ?? 0), 0);
    expect(spendSum).toBeCloseTo(100, 5);
    expect(resultSum).toBeCloseTo(100, 5);
  });

  it("gives null contributions when the account change is zero or unknown, and never NaN", () => {
    const campaigns = [campaign("a", perf({ spendCents: 100_000 }), perf({ spendCents: 80_000 }))];
    const zero = entitySplit(snap({ totals: perf(), previousTotals: perf(), campaigns, adSets: [] }));
    expect(zero.likeForLike[0].spendContributionPct).toBeNull();
    const unknown = entitySplit(snap({ totals: perf(), previousTotals: null, campaigns, adSets: [] }));
    expect(unknown.likeForLike[0].spendContributionPct).toBeNull();
    expect(unknown.likeForLike[0].resultsContributionPct).toBeNull();
  });

  it("flags low volume by spend share or results and caps each level at 25", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      campaign(`c${i}`, perf({ spendCents: 10_000 + i }), perf({ spendCents: 9_000 })),
    );
    const split = entitySplit(snap({ totals: perf({ spendCents: 400_000 }), previousTotals: perf({ spendCents: 300_000 }), campaigns: many, adSets: [] }));
    expect(split.likeForLike).toHaveLength(25);
    // sorted by |spend delta| desc
    expect(split.likeForLike[0].id).toBe("c29");
    const s = snap({
      totals: perf({ spendCents: 1_000_000 }),
      previousTotals: perf({ spendCents: 1_000_000 }),
      campaigns: [
        campaign("tiny", perf({ spendCents: 10_000, results: 100 }), perf({ spendCents: 10_000, results: 100 })),
        campaign("big", perf({ spendCents: 500_000, results: 100 }), perf({ spendCents: 500_000, results: 100 })),
        campaign("fewres", perf({ spendCents: 500_000, results: 10 }), perf({ spendCents: 500_000, results: 100 })),
      ],
      adSets: [],
    });
    const byId = Object.fromEntries(entitySplit(s).likeForLike.map((e) => [e.id, e.lowVolume]));
    expect(byId).toEqual({ tiny: true, big: false, fewres: true });
  });
});

describe("creativeChanges", () => {
  it("flags an ad whose CTR fell 1.2 to 0.9 at frequency 3.4 as fatigued", () => {
    const s = snap({
      totals: perf({ spendCents: 300_000 }),
      previousTotals: perf({ spendCents: 200_000 }),
      ads: [
        ad("tired", { performance: perf({ spendCents: 100_000, linkCtr: 0.9 }), previousPerformance: perf({ spendCents: 100_000, linkCtr: 1.2 }), frequency7d: 3.4 }),
        ad("lowfreq", { performance: perf({ spendCents: 100_000, linkCtr: 0.9 }), previousPerformance: perf({ spendCents: 100_000, linkCtr: 1.2 }), frequency7d: 2.0 }),
        ad("small-drop", { performance: perf({ spendCents: 100_000, linkCtr: 1.1 }), previousPerformance: perf({ spendCents: 100_000, linkCtr: 1.2 }), frequency7d: 4 }),
        ad("fresh", { performance: perf({ spendCents: 100_000, linkCtr: 0.5 }), previousPerformance: null, frequency7d: 5 }),
      ],
    });
    const r = creativeChanges(s);
    expect(r.fatigue).toEqual([{ adId: "tired", name: "Ad tired", frequency7d: 3.4, ctrCurrent: 0.9, ctrPrevious: 1.2 }]);
    expect(r.newAdsSpendSharePct).toBeCloseTo(25, 5);
    expect(r.ads).toHaveLength(4);
  });

  it("returns null new-ad share when there is no ad spend", () => {
    const s = snap({ totals: perf(), previousTotals: perf(), ads: [ad("x", { performance: perf({ spendCents: 0 }), previousPerformance: perf({ spendCents: 0 }) })] });
    expect(creativeChanges(s).newAdsSpendSharePct).toBeNull();
  });
});

describe("breakdownShifts", () => {
  it("lists a dimension with a null previous in failed and computes shares for the rest", () => {
    const s = snap({
      comparisonBreakdowns: [
        { dimension: "placement", current: [{ key: "feed", performance: perf({ spendCents: 75_000, results: 50 }) }, { key: "reels", performance: perf({ spendCents: 25_000, results: 0 }) }], previous: [{ key: "feed", performance: perf({ spendCents: 50_000, results: 50 }) }, { key: "stories", performance: perf({ spendCents: 50_000, results: 40 }) }] },
        { dimension: "country", current: [{ key: "AU", performance: perf() }], previous: null },
      ],
    });
    const r = breakdownShifts(s);
    expect(r.failed).toEqual(["country"]);
    expect(r.shifts.every((x) => x.dimension === "placement")).toBe(true);
    const feed = r.shifts.find((x) => x.key === "feed")!;
    expect(feed.spendShareCurrentPct).toBeCloseTo(75, 5);
    expect(feed.spendSharePreviousPct).toBeCloseTo(50, 5);
    expect(feed.costPerResultCurrent).toBeCloseTo(1500, 5);
    const reels = r.shifts.find((x) => x.key === "reels")!;
    expect(reels.costPerResultCurrent).toBeNull(); // 0 results
    expect(reels.spendSharePreviousPct).toBe(0);
    expect(reels.costPerResultPrevious).toBeNull();
    const stories = r.shifts.find((x) => x.key === "stories")!;
    expect(stories.spendShareCurrentPct).toBe(0);
    expect(stories.costPerResultCurrent).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });

  it("keeps the top 8 keys by current spend", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, performance: perf({ spendCents: 1000 * (i + 1) }) }));
    const r = breakdownShifts(snap({ comparisonBreakdowns: [{ dimension: "device", current: rows, previous: rows }] }));
    expect(r.shifts).toHaveLength(8);
    expect(r.shifts[0].key).toBe("k11");
  });
});
