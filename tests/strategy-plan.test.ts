import { describe, expect, it } from "vitest";
import { buildStrategyPlan, PLAN_CONSTANTS, type StrategyBrief } from "@/lib/strategy/plan";
import type { StrategyCategory } from "@/lib/strategy/categories";
import { detectCapabilityGaps } from "@/lib/strategy/meta-capabilities";
import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";
import {
  demoMetaAuditSnapshot,
  type AuditAd,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";

const PLAYBOOK = "Internal paid-social playbook (generic, not industry-specific)";

function cat(name: string, over: Partial<StrategyCategory> = {}): StrategyCategory {
  return {
    id: name.toLowerCase(),
    name,
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

function perf(spendCents: number, roas: number | null): PeriodPerformance {
  return {
    spendCents,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: null,
    results: 1,
    resultLabel: "Purchases",
    costPerResultCents: null,
    roas,
  };
}

/** An ad whose name matches the category of the same name. */
function ad(name: string, spendCents: number, roas: number | null): AuditAd {
  return {
    id: `ad_${name.toLowerCase()}`,
    name: `${name} ad`,
    adSetId: "as_1",
    campaignId: "demo_campaign_1",
    status: "ACTIVE",
    createdTime: null,
    format: null,
    issue: null,
    performance: perf(spendCents, roas),
  };
}

function snap(ads: AuditAd[], totals: PeriodPerformance | null = perf(100_000, 2)): MetaAuditSnapshot {
  return { ...demoMetaAuditSnapshot("act_1", "Demo", 30), totals, ads };
}

function plan(input: {
  snapshot: MetaAuditSnapshot;
  categories: StrategyCategory[];
  brief: Partial<StrategyBrief>;
  goals?: GoalsProfile;
}) {
  return buildStrategyPlan({
    snapshot: input.snapshot,
    scorecard: { score: 62, grade: "C" },
    categories: input.categories,
    goals: resolveGoals({ goals_profile: { business_model: "ecommerce", ...input.goals } }),
    brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [], ...input.brief },
  });
}

const byId = (p: ReturnType<typeof plan>) => Object.fromEntries(p.allocations.map((a) => [a.categoryId, a]));
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

// Target 4, no margins: Shoes proven, Bags promising, Hats hold, Belts (too little spend) and Socks (none) test.
const fiveCategories = [cat("Shoes"), cat("Bags"), cat("Hats"), cat("Belts"), cat("Socks")];
const fiveAds = [ad("Shoes", 20_000, 5), ad("Bags", 20_000, 3), ad("Hats", 20_000, 1), ad("Belts", 1_000, 6)];

describe("PLAN_CONSTANTS", () => {
  it("holds the values the plan rules use", () => {
    expect(PLAN_CONSTANTS).toEqual({
      split: { proven: 0.7, promising: 0.2, test: 0.1 },
      minTestDailyCents: 2000,
      scaleDecay: 0.85,
      testDiscount: 0.7,
      minSpendForVerdictCents: 5000,
    });
  });
});

describe("buildStrategyPlan tiering", () => {
  it("hits all four tiers and funds each by its bucket", () => {
    const p = plan({ snapshot: snap(fiveAds), categories: fiveCategories, brief: {} });
    const a = byId(p);
    expect(p.allocations.map((x) => x.categoryId)).toEqual(["shoes", "bags", "hats", "belts", "socks"]);
    expect(a.shoes).toMatchObject({ tier: "proven", targetRoas: 4, targetBasis: "account_target", observedRoas: 5, observedSpendCents: 20_000, dailyBudgetCents: 7_000 });
    expect(a.bags).toMatchObject({ tier: "promising", observedRoas: 3, dailyBudgetCents: 2_000 });
    expect(a.hats).toMatchObject({ tier: "hold", observedRoas: 1, dailyBudgetCents: 0, projectedDailyRevenueCents: 0, structure: [] });
    expect(a.belts).toMatchObject({ tier: "test", observedRoas: 6, observedSpendCents: 1_000 });
    expect(a.socks).toMatchObject({ tier: "test", observedRoas: null, observedSpendCents: 0 });
  });

  it("gives each tier its structure template, filtered to the business model", () => {
    const ecommerce = byId(plan({ snapshot: snap(fiveAds), categories: fiveCategories, brief: {} }));
    expect(ecommerce.shoes.structure).toEqual(["advantage_plus_sales", "catalog_ads", "website_retargeting", "cost_or_roas_controls"]);
    expect(ecommerce.bags.structure).toEqual(["cost_or_roas_controls", "video_creative", "website_retargeting"]);
    expect(ecommerce.belts.structure).toEqual(["broad_advantage_audience", "automatic_placements", "dynamic_creative"]);
    expect(ecommerce.hats.structure).toEqual([]);

    const leadGen = byId(
      plan({ snapshot: snap(fiveAds), categories: fiveCategories, brief: {}, goals: { business_model: "lead_gen" } }),
    );
    expect(leadGen.shoes.structure).toEqual(["website_retargeting", "cost_or_roas_controls"]);
  });

  it("uses break-even ROAS for promising when the margin is known, and margin-adjusted targets", () => {
    const p = plan({
      snapshot: snap([ad("Alpha", 20_000, 2.6), ad("Beta", 20_000, 2.4), ad("Gamma", 20_000, 2.4)]),
      categories: [cat("Alpha", { grossMarginPct: 40 }), cat("Beta", { grossMarginPct: 40 }), cat("Gamma", { grossMarginPct: 80 })],
      brief: { targetRoas: 4 },
      goals: { gross_margin_pct: 40 },
    });
    const a = byId(p);
    // Target 4 x 40 / 40 = 4, break-even 2.5: 2.6 is promising, 2.4 is hold (though above half the target).
    expect(a.alpha).toMatchObject({ tier: "promising", targetRoas: 4, targetBasis: "margin_adjusted" });
    expect(a.beta).toMatchObject({ tier: "hold", targetRoas: 4 });
    // Target 4 x 40 / 80 = 2: the same 2.4 is proven for the high-margin category.
    expect(a.gamma).toMatchObject({ tier: "proven", targetRoas: 2, targetBasis: "margin_adjusted" });
  });

  it("treats a category with enough spend but no observed ROAS as a test, and says so", () => {
    // Lead-gen style ads: spend but no ROAS reported.
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, null), ad("Bags", 20_000, 5)]),
      categories: [cat("Shoes"), cat("Bags")],
      brief: {},
    });
    expect(byId(p).shoes).toMatchObject({ tier: "test", observedRoas: null, observedSpendCents: 20_000 });
    expect(byId(p).bags.tier).toBe("proven");
    expect(p.assumptions.some((line) => line.includes("Shoes") && /ROAS was unavailable/.test(line))).toBe(true);
    expect(p.assumptions.some((line) => line.includes("Bags") && /ROAS was unavailable/.test(line))).toBe(false);
  });

  it("does not hold the demo lead-gen account's spending categories for lack of ROAS", () => {
    const p = buildStrategyPlan({
      snapshot: demoMetaAuditSnapshot("act_1", "Demo", 30),
      scorecard: { score: 62, grade: "C" },
      categories: [cat("Implants"), cat("Veneers")],
      goals: resolveGoals({ goals_profile: { business_model: "local_service" } }),
      brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [] },
    });
    expect(p.allocations.map((a) => [a.categoryId, a.tier, a.observedRoas])).toEqual([
      ["implants", "test", null],
      ["veneers", "test", null],
    ]);
    expect(p.projection.dailySpendCents).toBe(10_000);
  });
});

describe("buildStrategyPlan budget split", () => {
  it("allocates exactly the daily budget, in whole cents", () => {
    const p = plan({
      snapshot: snap([
        ad("P1", 10_000, 3),
        ad("P2", 10_000, 3),
        ad("P3", 10_000, 3),
        ad("Pr1", 10_000, 1.5),
        ad("Pr2", 10_000, 1.2),
      ]),
      categories: [cat("P1"), cat("P2"), cat("P3"), cat("Pr1"), cat("Pr2"), cat("T1"), cat("T2"), cat("T3")],
      brief: { dailyBudgetCents: 10_001, targetRoas: 2 },
    });
    const budgets = p.allocations.map((x) => x.dailyBudgetCents);
    expect(budgets.every(Number.isInteger)).toBe(true);
    expect(sum(budgets)).toBe(10_001);
    expect(p.projection.dailySpendCents).toBe(10_001);
    const tierSum = (tier: string) => sum(p.allocations.filter((x) => x.tier === tier).map((x) => x.dailyBudgetCents));
    expect(tierSum("proven")).toBe(7_001);
    expect(tierSum("promising")).toBe(2_000);
    expect(tierSum("test")).toBe(1_000);
    // Promising splits by purchase value, 15,000 : 12,000.
    const a = byId(p);
    expect([a.pr1.dailyBudgetCents, a.pr2.dailyBudgetCents]).toEqual([1_111, 889]);
  });

  it("gives promising 90% and test 10% when nothing is proven", () => {
    const p = plan({
      snapshot: snap([ad("Bags", 20_000, 6)]),
      categories: [cat("Bags"), cat("Socks")],
      brief: { targetRoas: 10 },
    });
    const a = byId(p);
    expect(a.bags).toMatchObject({ tier: "promising", dailyBudgetCents: 9_000 });
    expect(a.socks).toMatchObject({ tier: "test", dailyBudgetCents: 1_000 });
  });

  it("moves the test share to the first non-empty tier when there are no test categories", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 5), ad("Bags", 20_000, 3)]),
      categories: [cat("Shoes"), cat("Bags")],
      brief: { targetRoas: 4 },
    });
    const a = byId(p);
    expect(a.shoes.dailyBudgetCents).toBe(8_000);
    expect(a.bags.dailyBudgetCents).toBe(2_000);
  });

  it("splits proven by purchase value", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 30_000, 5), ad("Boots", 10_000, 5)]),
      categories: [cat("Shoes"), cat("Boots")],
      brief: { targetRoas: 4 },
    });
    const a = byId(p);
    expect(a.shoes.dailyBudgetCents).toBe(7_500);
    expect(a.boots.dailyBudgetCents).toBe(2_500);
  });

  it("funds the top 5 test categories by priority, then name, from a $100/day test bucket", () => {
    const categories = [
      cat("Hats", { priority: 2 }),
      cat("Forks", { priority: 2 }),
      cat("Engines", { priority: 2 }),
      cat("Cups", { priority: 3 }),
      cat("Aprons", { priority: 3 }),
      cat("Gloves", { priority: 4 }),
      cat("Bags", { priority: 5 }),
    ];
    const p = plan({ snapshot: snap([]), categories, brief: { dailyBudgetCents: 10_000 } });
    const a = byId(p);
    for (const id of ["bags", "gloves", "aprons", "cups", "engines"]) {
      expect(a[id]).toMatchObject({ tier: "test", dailyBudgetCents: 2_000 });
    }
    expect(a.forks).toMatchObject({ tier: "test", dailyBudgetCents: 0, projectedDailyRevenueCents: 0 });
    expect(a.hats).toMatchObject({ tier: "test", dailyBudgetCents: 0 });
  });

  it("gives the whole test budget to the top test category when it is below the minimum", () => {
    const p = plan({ snapshot: snap(fiveAds), categories: fiveCategories, brief: {} });
    const a = byId(p);
    // Test bucket is $10, under the $20 minimum; Belts beats Socks on name at equal priority.
    expect(a.belts.dailyBudgetCents).toBe(1_000);
    expect(a.socks.dailyBudgetCents).toBe(0);
    expect(p.assumptions).toContain(
      "Test categories are funded at $20.00/day each, highest priority first, as far as the test budget allows; a test budget under $20.00 goes entirely to the top test category.",
    );
  });

  it("funds every test category equally when the budget covers more than there are", () => {
    const p = plan({
      snapshot: snap([]),
      categories: [cat("A"), cat("B"), cat("C")],
      brief: { dailyBudgetCents: 100_000 },
    });
    expect(p.allocations.map((x) => x.dailyBudgetCents)).toEqual([33_334, 33_333, 33_333]);
  });
});

describe("buildStrategyPlan projection", () => {
  it("projects revenue from known numbers exactly", () => {
    // Proven 70% (promising empty, so its 20% moves to test): Shoes $70, Socks $30.
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 4)]),
      categories: [cat("Shoes"), cat("Socks")],
      brief: { targetRoas: 2.5 },
    });
    const a = byId(p);
    expect(a.shoes).toMatchObject({ dailyBudgetCents: 7_000, projectedDailyRevenueCents: 23_800 }); // 7000 x 4 x 0.85
    expect(a.socks).toMatchObject({ dailyBudgetCents: 3_000, projectedDailyRevenueCents: 4_200 }); // 3000 x 2 x 0.7
    expect(p.projection).toEqual({ dailySpendCents: 10_000, dailyRevenueCents: 28_000, blendedRoas: 2.8, meetsTarget: true });
  });

  it("uses the prospecting benchmark for tests when the account has no ROAS", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 4)], null),
      categories: [cat("Shoes"), cat("Socks")],
      brief: { targetRoas: 2.5 },
    });
    expect(byId(p).socks.projectedDailyRevenueCents).toBe(3_150); // 3000 x 1.5 x 0.7
    expect(p.benchmark.references.map((r) => r.metric)).not.toContain("Account ROAS");
    expect(p.baseline).toMatchObject({ spendCents: 0, roas: null });
  });
});

describe("buildStrategyPlan reality check", () => {
  it("calls target 10 against an account ROAS of 2 unrealistic", () => {
    const p = plan({ snapshot: snap([], perf(100_000, 2)), categories: [], brief: { targetRoas: 10 } });
    expect(p.benchmark.realityCheck).toEqual({ targetRoas: 10, referenceRoas: 3, multiple: 3.33, verdict: "unrealistic" });
    expect(p.benchmark.references).toEqual([
      { metric: "Prospecting ROAS", value: "1.5×", source: PLAYBOOK },
      { metric: "Retargeting ROAS", value: "3×", source: PLAYBOOK },
      { metric: "Account ROAS", value: "2×", source: "This account, last 30 days" },
    ]);
  });

  it("uses the account ROAS as reference when it beats the benchmark", () => {
    const within = plan({ snapshot: snap([], perf(100_000, 2)), categories: [], brief: { targetRoas: 3.6 } });
    expect(within.benchmark.realityCheck).toMatchObject({ referenceRoas: 3, multiple: 1.2, verdict: "within" });
    const stretch = plan({ snapshot: snap([], perf(100_000, 4)), categories: [], brief: { targetRoas: 10 } });
    expect(stretch.benchmark.realityCheck).toMatchObject({ referenceRoas: 4, multiple: 2.5, verdict: "stretch" });
  });

  it("still allocates the full budget when the target is unrealistic", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 5)]),
      categories: [cat("Shoes", { grossMarginPct: 50 }), cat("Socks", { grossMarginPct: 50 })],
      brief: { dailyBudgetCents: 12_345, targetRoas: 50 },
      goals: { gross_margin_pct: 50 },
    });
    expect(p.benchmark.realityCheck.verdict).toBe("unrealistic");
    expect(sum(p.allocations.map((x) => x.dailyBudgetCents))).toBe(12_345);
    expect(p.projection.dailySpendCents).toBe(12_345);
    expect(p.projection.meetsTarget).toBe(false);
  });
});

describe("buildStrategyPlan scenarios", () => {
  it("re-runs the plan for each stretch target above the main one, ascending and de-duplicated", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 11)]),
      categories: [cat("Shoes"), cat("Socks")],
      brief: { targetRoas: 10, stretchTargets: [15, 12, 10, 12] },
    });
    expect(p.scenarios.map((s) => s.targetRoas)).toEqual([12, 15]);
    expect(p.projection.dailyRevenueCents).toBe(65_450 + 4_200);
    // At 12, Shoes (11x) drops to promising, which takes 90%; Socks gets the 10% test share.
    expect(p.scenarios[0].tierCounts).toEqual({ proven: 0, promising: 1, test: 1, hold: 0 });
    expect(p.scenarios[0].projection).toMatchObject({ dailySpendCents: 10_000, dailyRevenueCents: 84_150 + 1_400, meetsTarget: false });
  });
});

describe("buildStrategyPlan baseline, gaps and assumptions", () => {
  it("fills the baseline from the scorecard, account totals and attribution", () => {
    const p = plan({ snapshot: snap(fiveAds, perf(61_000, 2.2)), categories: fiveCategories, brief: {} });
    expect(p.baseline).toEqual({
      score: 62,
      grade: "C",
      periodDays: 30,
      spendCents: 61_000,
      roas: 2.2,
      categoriesTotal: 5,
      categoriesWithSpend: 4,
      coveragePct: 100,
    });
    expect(p.brief).toEqual({ dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [] });
  });

  it("lists untouched categories and the capability gaps for the business model", () => {
    const snapshot = snap(fiveAds);
    const p = plan({ snapshot, categories: fiveCategories, brief: {} });
    expect(p.gaps.untouchedCategoryIds).toEqual(["socks"]);
    expect(p.gaps.capabilities).toEqual(detectCapabilityGaps(snapshot, "ecommerce"));
  });

  it("states every constant it used", () => {
    const p = plan({ snapshot: snap(fiveAds), categories: fiveCategories, brief: {} });
    expect(p.assumptions).toContain("Scaled budgets assumed to return 85% of current ROAS.");
    const text = p.assumptions.join("\n");
    expect(text).toMatch(/70% proven, 20% promising, 10% test/);
    expect(text).toMatch(/70% of the account ROAS \(2×\)/);
    expect(text).toContain("$20.00");
    expect(text).toContain("$50.00");
    expect(text).toContain("1.2×");
    expect(text).toContain("2.5×");
    expect(text).toContain("internal paid-social playbook (generic, not industry-specific)");
  });
});

describe("buildStrategyPlan with no categories", () => {
  it("returns an empty plan with the baseline from account totals", () => {
    const p = plan({
      snapshot: snap([], perf(388_000, 1.8)),
      categories: [],
      brief: { dailyBudgetCents: 5_000, targetRoas: 3, stretchTargets: [4] },
    });
    expect(p.allocations).toEqual([]);
    expect(p.projection).toEqual({ dailySpendCents: 0, dailyRevenueCents: 0, blendedRoas: null, meetsTarget: false });
    expect(p.baseline).toEqual({
      score: 62,
      grade: "C",
      periodDays: 30,
      spendCents: 388_000,
      roas: 1.8,
      categoriesTotal: 0,
      categoriesWithSpend: 0,
      coveragePct: 0,
    });
    expect(p.gaps.untouchedCategoryIds).toEqual([]);
    expect(p.scenarios).toEqual([
      {
        targetRoas: 4,
        projection: { dailySpendCents: 0, dailyRevenueCents: 0, blendedRoas: null, meetsTarget: false },
        tierCounts: { proven: 0, promising: 0, test: 0, hold: 0 },
      },
    ]);
  });
});
