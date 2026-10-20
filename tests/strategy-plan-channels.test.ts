import { describe, expect, it } from "vitest";
import {
  DEMO_CLICKTRENDS_META_ACCOUNT_ID,
  demoMetaAuditSnapshot,
  type AuditAd,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";
import { getDemoStore } from "@/lib/demo/store";
import { loadChannelSnapshot } from "@/lib/google/snapshot";
import type { AdsPerformance } from "@/lib/google/types";
import { categoriesFromServices, type StrategyCategory } from "@/lib/strategy/categories";
import { attributeSpendToCategories } from "@/lib/strategy/category-attribution";
import {
  buildChannelPerformance,
  type CategoryChannels,
  type ChannelFigures,
  type ChannelPerformance,
} from "@/lib/strategy/channels";
import { detectGoogleCapabilities } from "@/lib/strategy/google-capabilities";
import { buildStrategyPlan, PLAN_CONSTANTS, type StrategyBrief, type StrategyPlan } from "@/lib/strategy/plan";

const NO_ADS_NOTE = "No Google Ads account mapped: Google wasn't considered.";
const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

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

/** A Meta ad whose name matches the category of the same name. */
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

type Side = { spend?: number; revenue?: number; ga4?: number | null };

/** Channel figures computed the way buildChannelPerformance does. */
function figures({ spend = 0, revenue = 0, ga4 = null }: Side): ChannelFigures {
  const basis = ga4 != null ? "ga4" : spend > 0 ? "platform" : "none";
  const value = basis === "ga4" ? ga4! : revenue;
  return {
    spendCents: spend,
    platformRevenueCents: revenue,
    ga4RevenueCents: ga4,
    roas: spend > 0 && basis !== "none" ? round2(value / spend) : null,
    basis,
  };
}

function row(
  categoryId: string,
  over: { meta?: Side; google?: Side; ga4Total?: number | null; impressions?: number } = {},
): CategoryChannels {
  return {
    categoryId,
    meta: figures(over.meta ?? {}),
    google: figures(over.google ?? {}),
    ga4TotalRevenueCents: over.ga4Total ?? null,
    searchImpressions: over.impressions ?? 0,
    searchClicks: 0,
    topQueries: [],
  };
}

function adsPerf(over: Partial<AdsPerformance> = {}): AdsPerformance {
  return {
    customerId: "1",
    currency: "USD",
    merchantCenterLinked: true,
    campaigns: [],
    landingPages: [],
    assetGroups: [],
    shoppingCategories: [],
    ...over,
  };
}

function channelPerf(byCategory: CategoryChannels[], over: Partial<ChannelPerformance> = {}): ChannelPerformance {
  return {
    byCategory,
    ga4Method: "none",
    ga4Available: false,
    googleAdsMapped: true,
    googleAdsLoaded: true,
    currencyMismatch: null,
    googleUnmatchedSpendCents: 0,
    ga4UnmatchedRevenueCents: 0,
    metaVsGa4: null,
    ads: adsPerf(),
    warnings: [],
    ...over,
  };
}

function plan(input: {
  snapshot: MetaAuditSnapshot;
  categories: StrategyCategory[];
  brief?: Partial<StrategyBrief>;
  goals?: GoalsProfile;
  channels?: ChannelPerformance;
  scopeCategoryIds?: string[];
}): StrategyPlan {
  return buildStrategyPlan({
    snapshot: input.snapshot,
    scorecard: { score: 62, grade: "C" },
    categories: input.categories,
    goals: resolveGoals({ goals_profile: { business_model: "ecommerce", ...input.goals } }),
    brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [], ...input.brief },
    channels: input.channels,
    scopeCategoryIds: input.scopeCategoryIds,
  });
}

const byId = (p: StrategyPlan) => Object.fromEntries(p.allocations.map((a) => [a.categoryId, a]));

/** ClickTrends from the demo store and mock Google provider (USD everywhere, GA4 by item). */
async function clickTrends(opts: { margins: boolean }) {
  const services = getDemoStore().clientServices.filter((s) => s.client_id === "client_clicktrends");
  const categories = categoriesFromServices(services).map((c) => (opts.margins ? c : { ...c, grossMarginPct: null }));
  const snapshot = demoMetaAuditSnapshot(DEMO_CLICKTRENDS_META_ACCOUNT_ID, "ClickTrends Performance", 30);
  const channels = buildChannelPerformance({
    categories,
    metaAttribution: attributeSpendToCategories(snapshot, categories),
    metaCurrency: snapshot.account.currency,
    snapshot: await loadChannelSnapshot("client_clicktrends", { since: "2026-09-19", until: "2026-10-18" }),
  });
  return { categories, snapshot, channels };
}

describe("PLAN_CONSTANTS", () => {
  it("holds the minimum test share for a channel with no spend", () => {
    expect(PLAN_CONSTANTS.minChannelTestShare).toBe(0.2);
  });
});

describe("buildStrategyPlan without channels", () => {
  it("keeps the Meta-only plan and says Google wasn't used", () => {
    const p = plan({ snapshot: snap([ad("Shoes", 20_000, 5)]), categories: [cat("Shoes"), cat("Socks")] });
    expect(p.revenueBasis).toBe("platform");
    expect(p.channelTotals).toBeNull();
    expect(p.scope).toBeNull();
    expect(p.googleCapabilities).toBeNull();
    expect(p.channelNote).toMatch(/Google/);
    // The assumptions are exactly the Meta-only ones: no basis, split or Google lines.
    expect(p.assumptions.filter((a) => /Google|GA4|Revenue is/.test(a))).toEqual([]);
    expect(p.assumptions).toHaveLength(11);
    for (const a of p.allocations) {
      expect(a.channelSplit).toBeNull();
      expect(a.googleCampaignTypes).toEqual([]);
    }
    expect(byId(p).shoes).toMatchObject({ tier: "proven", dailyBudgetCents: 7_000, projectedDailyRevenueCents: 29_750 });
  });
});

describe("buildStrategyPlan with ClickTrends channels", () => {
  it("splits bar stools across Meta and Google on GA4 revenue, to the cent", async () => {
    const { categories, snapshot, channels } = await clickTrends({ margins: false });
    const p = plan({ snapshot, categories, channels, brief: { dailyBudgetCents: 20_000, targetRoas: 3 } });
    expect(p.revenueBasis).toBe("ga4");
    expect(p.channelNote).toBeNull();

    const bar = byId(p).svc_ct_bar_stools;
    // Meta 210,000 + Google 116,667 spend against GA4's paid social 403,030 + paid search 233,333
    // (of the category's 700,000 on all channels).
    expect(bar).toMatchObject({ tier: "promising", observedSpendCents: 326_667, observedRoas: 1.95 });
    const split = bar.channelSplit!;
    expect(split.basis).toBe("ga4");
    expect(split.metaCents).toBeGreaterThan(0);
    expect(split.googleCents).toBeGreaterThan(0);
    expect(split.metaCents + split.googleCents).toBe(bar.dailyBudgetCents);
    expect(bar.projectedDailyRevenueCents).toBe(split.metaProjectedCents + split.googleProjectedCents);
    expect(bar.googleCampaignTypes).toEqual(["google_shopping", "google_search"]);

    expect(p.channelTotals).toEqual({
      metaCents: sum(p.allocations.map((a) => a.channelSplit?.metaCents ?? 0)),
      googleCents: sum(p.allocations.map((a) => a.channelSplit?.googleCents ?? 0)),
    });
    expect(p.channelTotals!.metaCents + p.channelTotals!.googleCents).toBe(20_000);
    expect(p.projection.dailyRevenueCents).toBe(
      sum(p.allocations.map((a) => (a.channelSplit?.metaProjectedCents ?? 0) + (a.channelSplit?.googleProjectedCents ?? 0))),
    );
    expect(p.googleCapabilities).toEqual(detectGoogleCapabilities(channels.ads));
    expect(p.assumptions.some((a) => /GA4/.test(a))).toBe(true);
    expect(p.assumptions.some((a) => a.includes("20%") && /Google/.test(a))).toBe(true);
  });

  it("scoped to bar stools at $133/day funds one held category with all of it", async () => {
    const { categories, snapshot, channels } = await clickTrends({ margins: true });
    const p = plan({
      snapshot,
      categories,
      channels,
      brief: { dailyBudgetCents: 13_300, targetRoas: 2 },
      scopeCategoryIds: ["svc_ct_bar_stools"],
    });
    expect(p.allocations).toHaveLength(1);
    // GA4 paid ROAS 1.95 is under the 2.5 break-even of a 40% margin.
    expect(p.allocations[0]).toMatchObject({ categoryId: "svc_ct_bar_stools", tier: "hold", dailyBudgetCents: 13_300 });
    const split = p.allocations[0].channelSplit!;
    expect(split.metaCents + split.googleCents).toBe(13_300);
    expect(split.googleCents).toBeGreaterThan(0);
    // Funded though held, so it is set up like a test on both channels.
    expect(p.allocations[0].structure).toEqual(["broad_advantage_audience", "automatic_placements", "dynamic_creative"]);
    expect(p.allocations[0].googleCampaignTypes).toEqual(["google_shopping", "google_search"]);
    expect(p.projection.dailySpendCents).toBe(13_300);
    expect(p.scope).toEqual({ categoryIds: ["svc_ct_bar_stools"], names: ["Bar stools"] });
    expect(p.assumptions).toContain("Bar stools is below break-even; funded because the plan was asked for it.");
    // The next test is the scoped category, though it is held.
    expect(p.nextTest).toEqual({ categoryId: "svc_ct_bar_stools", name: "Bar stools", dailyBudgetCents: 13_300, durationDays: 14 });
    expect(p.assumptions).toContain("The next test is the named category with the biggest budget, run for 14 days at its planned daily budget.");
  });
});

describe("buildStrategyPlan revenue basis and tiers", () => {
  it("tiers on GA4 revenue: Meta says 5×, GA4 says 3×, so promising not proven", () => {
    const snapshot = snap([ad("Shoes", 20_000, 5)], perf(20_000, 5));
    const categories = [cat("Shoes")];
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 60_000 }, ga4Total: 60_000 })],
      { ga4Available: true, ga4Method: "item" },
    );
    expect(plan({ snapshot, categories }).allocations[0].tier).toBe("proven");
    const p = plan({ snapshot, categories, channels });
    expect(p.revenueBasis).toBe("ga4");
    expect(p.allocations[0]).toMatchObject({ tier: "promising", observedRoas: 3, observedSpendCents: 20_000 });
    // The account ROAS in the reality check is the combined one too.
    expect(p.benchmark.references.find((r) => r.metric === "Account ROAS")).toEqual({
      metric: "Account ROAS",
      value: "3×",
      source: "Meta + Google spend, GA4 paid social + paid search revenue on matched categories, last 30 days",
    });
  });

  it("treats Meta spend without a Meta ROAS as unknown revenue, whatever Google reports", () => {
    const channels = channelPerf([
      row("shoes", { meta: { spend: 20_000, revenue: 0 }, google: { spend: 20_000, revenue: 200_000 } }),
    ]);
    const p = plan({ snapshot: snap([ad("Shoes", 20_000, null)]), categories: [cat("Shoes")], channels });
    expect(p.allocations[0]).toMatchObject({ tier: "test", observedRoas: null, observedSpendCents: 40_000 });
    expect(p.assumptions).toContain("ROAS was unavailable for Shoes, so it is treated as a test.");
  });

  it("projects a test category at the test rate on every channel, however high its own ROAS", () => {
    // $10 of Meta spend at 20×; the account (all $1,000 of Meta spend) returns 2×.
    const channels = channelPerf([row("belts", { meta: { spend: 1_000, revenue: 20_000 } })]);
    const p = plan({ snapshot: snap([ad("Belts", 1_000, 20)], perf(100_000, 2)), categories: [cat("Belts")], channels });
    expect(p.allocations[0]).toMatchObject({ tier: "test", observedRoas: 20, dailyBudgetCents: 10_000 });
    // 10,000 × 2 × 0.7, not 10,000 × 20 × 0.85.
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 10_000, metaProjectedCents: 14_000, googleProjectedCents: 0 });
    expect(p.allocations[0].projectedDailyRevenueCents).toBe(14_000);
  });
});

describe("buildStrategyPlan GA4 basis: paid revenue and coverage", () => {
  const snapshot = snap([ad("Shoes", 20_000, 5)], perf(20_000, 5));

  it("judges a category on its GA4 paid social + paid search revenue, not all-channel revenue", () => {
    const channels = channelPerf(
      [
        row("shoes", {
          meta: { spend: 20_000, revenue: 100_000, ga4: 30_000 },
          google: { spend: 10_000, revenue: 20_000, ga4: 15_000 },
          ga4Total: 200_000,
        }),
      ],
      { ga4Available: true, ga4Method: "item" },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    expect(p.revenueBasis).toBe("ga4");
    // (30,000 + 15,000) ÷ 30,000, not 200,000 ÷ 30,000.
    expect(p.allocations[0]).toMatchObject({ observedRoas: 1.5, observedSpendCents: 30_000 });
    expect(p.benchmark.references.find((r) => r.metric === "Account ROAS")?.value).toBe("1.5×");
    expect(
      p.assumptions.some(
        (a) => a.includes("GA4's revenue from paid social + paid search sessions") && a.includes("all channels is shown for reference"),
      ),
    ).toBe(true);
  });

  it("falls back to platform revenue when GA4 has neither paid share for the category", () => {
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000 }, ga4Total: 200_000 })],
      { ga4Available: true, ga4Method: "item" },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    expect(p.allocations[0].observedRoas).toBe(5);
    expect(p.assumptions.some((a) => /^1 category has no GA4/.test(a))).toBe(true);
  });

  it("uses platform revenue when GA4 matched under half its revenue to categories", () => {
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 30_000 }, ga4Total: 60_000 })],
      { ga4Available: true, ga4Method: "item", ga4UnmatchedRevenueCents: 90_000 },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    expect(p.revenueBasis).toBe("platform");
    expect(p.allocations[0].observedRoas).toBe(5);
    expect(p.assumptions).toContain(
      "GA4 matched only 40% of revenue to categories, so the plan uses platform-reported revenue.",
    );
    // At exactly half, GA4 is still used.
    const half = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 30_000 }, ga4Total: 60_000 })],
      { ga4Available: true, ga4Method: "item", ga4UnmatchedRevenueCents: 60_000 },
    );
    expect(plan({ snapshot, categories: [cat("Shoes")], channels: half }).revenueBasis).toBe("ga4");
  });
});

describe("buildStrategyPlan combined account ROAS", () => {
  const campaign = (id: string, costCents: number, conversionValueCents: number) => ({
    id,
    name: `Campaign ${id}`,
    type: "SEARCH",
    status: "ENABLED",
    costCents,
    conversions: 1,
    conversionValueCents,
  });
  // Meta $400 at 3× ($200 matched to Shoes); Google $200 costing 80,000 value ($100 matched, $100 not).
  const snapshot = snap([ad("Shoes", 20_000, 3)], perf(40_000, 3));
  const ads = adsPerf({ campaigns: [campaign("1", 10_000, 50_000), campaign("2", 10_000, 30_000)] });
  const accountRoas = (p: StrategyPlan) => p.benchmark.references.find((r) => r.metric === "Account ROAS");

  it("on platform revenue: all platform revenue over all spend, matched or not", () => {
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 60_000 }, google: { spend: 10_000, revenue: 50_000 } })],
      { googleUnmatchedSpendCents: 10_000, ads },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    // (120,000 Meta + 80,000 Google) ÷ (30,000 matched + 10,000 Google + 20,000 Meta unmatched).
    expect(accountRoas(p)).toEqual({
      metric: "Account ROAS",
      value: "3.33×",
      source: "Meta + Google spend, platform-reported revenue, last 30 days",
    });
    expect(p.benchmark.realityCheck.referenceRoas).toBe(3.33);
  });

  it("on GA4 revenue: matched categories' GA4 paid revenue over all spend", () => {
    const channels = channelPerf(
      [
        row("shoes", {
          meta: { spend: 20_000, revenue: 60_000, ga4: 50_000 },
          google: { spend: 10_000, revenue: 50_000, ga4: 30_000 },
          ga4Total: 120_000,
        }),
      ],
      { googleUnmatchedSpendCents: 10_000, ads, ga4Available: true, ga4Method: "item" },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    // GA4 paid revenue (50,000 + 30,000) ÷ 60,000; the 120,000 all-channel total isn't a return on ad spend.
    expect(accountRoas(p)).toEqual({
      metric: "Account ROAS",
      value: "1.33×",
      source: "Meta + Google spend, GA4 paid social + paid search revenue on matched categories, last 30 days",
    });
  });

  it("falls back to the Meta account ROAS, labelled Meta only, when no category has a ROAS", () => {
    const channels = channelPerf([row("socks", { impressions: 300 })]);
    const p = plan({ snapshot: snap([], perf(100_000, 2)), categories: [cat("Socks")], channels });
    expect(accountRoas(p)).toEqual({ metric: "Account ROAS", value: "2×", source: "Meta only, last 30 days" });
  });

  it("calls a category with only Google spend and strong ROAS proven", () => {
    const channels = channelPerf([row("shoes", { google: { spend: 20_000, revenue: 120_000 } })]);
    const p = plan({ snapshot: snap([]), categories: [cat("Shoes")], channels });
    expect(p.revenueBasis).toBe("platform");
    expect(p.allocations[0]).toMatchObject({ tier: "proven", observedRoas: 6, observedSpendCents: 20_000, dailyBudgetCents: 10_000 });
    // No landing page, so Meta shows no demand and Google takes it all.
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 0, googleCents: 10_000, basis: "platform" });
  });

  it("gives Meta the 20% test share when a Google-only category has a landing page", () => {
    const channels = channelPerf([row("shoes", { google: { spend: 20_000, revenue: 120_000 } })]);
    const p = plan({
      snapshot: snap([]),
      categories: [cat("Shoes", { landingPageUrl: "https://shop.example/shoes" })],
      channels,
    });
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 2_000, googleCents: 8_000 });
  });

  it("falls back to platform revenue for a category GA4 has no figure for, and counts it", () => {
    const channels = channelPerf(
      [
        row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 60_000 }, ga4Total: 60_000 }),
        row("bags", { meta: { spend: 20_000, revenue: 100_000 }, ga4Total: null }),
      ],
      { ga4Available: true, ga4Method: "landing_page" },
    );
    const p = plan({ snapshot: snap([ad("Shoes", 20_000, 5), ad("Bags", 20_000, 5)]), categories: [cat("Shoes"), cat("Bags")], channels });
    expect(byId(p).shoes.observedRoas).toBe(3);
    expect(byId(p).bags.observedRoas).toBe(5);
    expect(p.assumptions.some((a) => /^1 category/.test(a) && /platform|Meta/.test(a))).toBe(true);
  });
});

describe("buildStrategyPlan channel split", () => {
  // One proven category with Meta 5× and no Google spend gets the whole $100.
  const snapshot = snap([ad("Shoes", 20_000, 5)], perf(20_000, 5));
  const shoesRow = (impressions: number) =>
    row("shoes", { meta: { spend: 20_000, revenue: 100_000 }, impressions });

  it("gives Google 20% when it has no spend but search demand, and projects each channel", () => {
    const p = plan({
      snapshot,
      categories: [cat("Shoes")],
      channels: channelPerf([shoesRow(500)]),
      brief: { stretchTargets: [4.5] },
    });
    const shoes = p.allocations[0];
    // Meta 8,000 × 5 × 0.85; Google 2,000 × 5 (combined account ROAS) × 0.7.
    expect(shoes.channelSplit).toEqual({
      metaCents: 8_000,
      googleCents: 2_000,
      metaProjectedCents: 34_000,
      googleProjectedCents: 7_000,
      basis: "platform",
    });
    expect(shoes.projectedDailyRevenueCents).toBe(41_000);
    expect(p.projection).toEqual({ dailySpendCents: 10_000, dailyRevenueCents: 41_000, blendedRoas: 4.1, meetsTarget: true });
    expect(p.channelTotals).toEqual({ metaCents: 8_000, googleCents: 2_000 });
    // At 4.5 Shoes is still proven, so the scenario's projection is the same per-channel one.
    expect(p.scenarios[0].projection.dailyRevenueCents).toBe(41_000);
  });

  it("gives Google its 20% from search impressions alone when neither channel has spend", () => {
    const channels = channelPerf([row("socks", { impressions: 300 })]);
    const p = plan({ snapshot: snap([]), categories: [cat("Socks")], channels });
    expect(p.allocations[0]).toMatchObject({ tier: "test", dailyBudgetCents: 10_000 });
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 8_000, googleCents: 2_000 });
    expect(p.allocations[0].googleCampaignTypes).toEqual(["google_shopping", "google_search"]);
  });

  it("keeps Meta at 100% when Google has neither spend nor demand", () => {
    const p = plan({ snapshot, categories: [cat("Shoes")], channels: channelPerf([shoesRow(0)]) });
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 10_000, googleCents: 0 });
    expect(p.allocations[0].googleCampaignTypes).toEqual([]);
  });

  it("puts everything on Meta, with a note, when no Google Ads account is mapped", () => {
    const channels = channelPerf([shoesRow(500)], { googleAdsMapped: false, ads: null });
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 10_000, googleCents: 0 });
    expect(p.allocations[0].googleCampaignTypes).toEqual([]);
    expect(p.channelNote).toBe(NO_ADS_NOTE);
    expect(p.assumptions).toContain(NO_ADS_NOTE);
    expect(p.googleCapabilities).toBeNull();
  });

  it("leaves Google out, with a note, when Google Ads is mapped but didn't load", () => {
    const note = "Google Ads is mapped but its data didn't load this time; Google wasn't considered.";
    const channels = channelPerf([shoesRow(500)], { googleAdsLoaded: false, ads: null });
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    // Search impressions alone would give Google 20% if it had loaded; not now.
    expect(p.allocations[0].channelSplit).toMatchObject({ metaCents: 10_000, googleCents: 0 });
    expect(p.allocations[0].googleCampaignTypes).toEqual([]);
    expect(p.channelNote).toBe(note);
    expect(p.assumptions).toContain(note);
    expect(p.assumptions.some((a) => a.startsWith("Within each funded"))).toBe(false);
    // Its campaign types are still listed, as unknown.
    expect(p.googleCapabilities?.every((c) => c.state === "unknown")).toBe(true);
  });

  it("judges a category on Meta's own figures when Google Ads didn't load, not GA4's all-channel total", () => {
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 60_000 }, ga4Total: 200_000 })],
      { googleAdsLoaded: false, ads: null, ga4Available: true, ga4Method: "item" },
    );
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    // GA4's paid-social 60,000 over Meta's 20,000, not the 200,000 total.
    expect(p.allocations[0].observedRoas).toBe(3);
    expect(p.revenueBasis).toBe("ga4");
    expect(p.assumptions.some((a) => /GA4's paid-social revenue/.test(a))).toBe(true);
  });

  it("leaves held and unfunded categories without a split", () => {
    const channels = channelPerf([
      row("shoes", { meta: { spend: 20_000, revenue: 100_000 } }),
      row("hats", { meta: { spend: 20_000, revenue: 20_000 } }),
    ]);
    const p = plan({ snapshot: snap([ad("Shoes", 20_000, 5), ad("Hats", 20_000, 1)]), categories: [cat("Shoes"), cat("Hats")], channels });
    expect(byId(p).hats).toMatchObject({ tier: "hold", dailyBudgetCents: 0, channelSplit: null, googleCampaignTypes: [] });
  });

  it("recommends Performance Max then Search for a proven category with the feed linked", () => {
    const channels = channelPerf([
      row("shoes", { meta: { spend: 20_000, revenue: 60_000 }, google: { spend: 20_000, revenue: 140_000 }, impressions: 900 }),
    ]);
    const p = plan({ snapshot, categories: [cat("Shoes")], channels });
    const shoes = p.allocations[0];
    expect(shoes.tier).toBe("proven");
    // Weights 3 : 7 by channel ROAS.
    expect(shoes.channelSplit).toMatchObject({ metaCents: 3_000, googleCents: 7_000 });
    expect(shoes.googleCampaignTypes).toEqual(["google_pmax", "google_search"]);
    expect(p.googleCapabilities).toEqual(detectGoogleCapabilities(channels.ads));
  });
});

describe("buildStrategyPlan currency mismatch", () => {
  it("makes no split, uses no combined figures and says why", () => {
    const mismatch = "Meta reports in AUD, GA4 in USD: Google and GA4 figures are left out so currencies aren't mixed; the plan uses Meta figures only.";
    const snapshot = snap([ad("Shoes", 20_000, 5)]);
    // Figures that would change every tier if they were read.
    const channels = channelPerf(
      [row("shoes", { meta: { spend: 20_000, revenue: 100_000, ga4: 1 }, google: { spend: 90_000, revenue: 1 }, ga4Total: 1, impressions: 900 })],
      { ga4Available: true, ga4Method: "item", currencyMismatch: mismatch },
    );
    const p = plan({ snapshot, categories: [cat("Shoes"), cat("Socks")], channels });
    const metaOnly = plan({ snapshot, categories: [cat("Shoes"), cat("Socks")] });
    expect(p.revenueBasis).toBe("platform");
    expect(p.channelTotals).toBeNull();
    expect(p.googleCapabilities).toBeNull();
    expect(p.channelNote).toBe(`${mismatch} There is no Meta and Google split.`);
    expect(p.assumptions).toContain(p.channelNote);
    expect(p.allocations).toEqual(metaOnly.allocations);
    expect(p.projection).toEqual(metaOnly.projection);
    expect(p.benchmark).toEqual(metaOnly.benchmark);
    for (const a of p.allocations) expect(a.channelSplit).toBeNull();
  });
});

describe("buildStrategyPlan scoped plans", () => {
  const categories = [cat("Shoes"), cat("Bags"), cat("Socks"), cat("Hats")];
  const snapshot = snap([ad("Shoes", 20_000, 5), ad("Bags", 20_000, 3), ad("Socks", 1_000, 2)]);

  it("splits the whole budget across the named categories by revenue, without tiers", () => {
    const p = plan({ snapshot, categories, scopeCategoryIds: ["shoes", "socks"] });
    expect(p.allocations.map((a) => a.categoryId)).toEqual(["shoes", "socks"]);
    // Revenue 100,000 : 2,000, not 70/20/10.
    expect(byId(p).shoes).toMatchObject({ tier: "proven", dailyBudgetCents: 9_804 });
    expect(byId(p).socks).toMatchObject({ tier: "test", dailyBudgetCents: 196 });
    expect(p.scope).toEqual({ categoryIds: ["shoes", "socks"], names: ["Shoes", "Socks"] });
    // Hats has no spend anywhere in the account, scope or not.
    expect(p.gaps.untouchedCategoryIds).toEqual(["hats"]);
    expect(p.assumptions.some((a) => a.includes("Shoes") && a.includes("Socks") && /only/i.test(a))).toBe(true);
  });

  it("splits equally when no named category has revenue", () => {
    const p = plan({ snapshot, categories, scopeCategoryIds: ["hats"], brief: { dailyBudgetCents: 13_300 } });
    expect(p.allocations).toHaveLength(1);
    expect(p.allocations[0]).toMatchObject({ categoryId: "hats", tier: "test", dailyBudgetCents: 13_300 });
  });

  it("splits two zero-revenue named categories equally", () => {
    const p = plan({
      snapshot,
      categories: [...categories, cat("Caps")],
      scopeCategoryIds: ["hats", "caps"],
      brief: { dailyBudgetCents: 10_001 },
    });
    expect(p.allocations.map((a) => [a.categoryId, a.dailyBudgetCents])).toEqual([
      ["hats", 5_001],
      ["caps", 5_000],
    ]);
  });

  it("says how many named categories weren't found when some were", () => {
    const p = plan({ snapshot, categories, scopeCategoryIds: ["shoes", "nope", "gone"] });
    expect(p.scope).toEqual({ categoryIds: ["shoes"], names: ["Shoes"] });
    expect(p.assumptions).toContain("2 named categories weren't found; the plan covers only the ones that were.");
  });

  it("only says a held category was funded when it got budget", () => {
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 5), ad("Hats", 20_000, 0)]),
      categories,
      scopeCategoryIds: ["shoes", "hats"],
    });
    expect(byId(p).hats).toMatchObject({ tier: "hold", dailyBudgetCents: 0, structure: [] });
    expect(p.assumptions.some((a) => /funded because the plan was asked for it/.test(a))).toBe(false);
  });

  it("splits a scoped plan with channels by revenue, then each category by channel", () => {
    const channels = channelPerf([
      row("shoes", { meta: { spend: 20_000, revenue: 100_000 }, google: { spend: 10_000, revenue: 50_000 }, impressions: 100 }),
      row("bags", { google: { spend: 20_000, revenue: 40_000 } }),
      row("socks", { meta: { spend: 20_000, revenue: 100_000 } }),
    ]);
    const p = plan({
      snapshot: snap([ad("Shoes", 20_000, 5), ad("Socks", 20_000, 5)], perf(40_000, 5)),
      categories: [cat("Shoes"), cat("Bags", { landingPageUrl: "https://shop.example/bags" }), cat("Socks")],
      channels,
      scopeCategoryIds: ["shoes", "bags"],
      brief: { dailyBudgetCents: 19_000 },
    });
    // Revenue 150,000 : 40,000.
    expect(p.allocations.map((a) => [a.categoryId, a.tier, a.dailyBudgetCents])).toEqual([
      ["shoes", "proven", 15_000],
      ["bags", "promising", 4_000],
    ]);
    // Shoes by ROAS 5 : 5; Bags has only Google spend and a landing page, so Meta gets 20%.
    expect(byId(p).shoes.channelSplit).toMatchObject({ metaCents: 7_500, googleCents: 7_500 });
    expect(byId(p).bags.channelSplit).toMatchObject({ metaCents: 800, googleCents: 3_200 });
    expect(byId(p).shoes.googleCampaignTypes).toEqual(["google_pmax", "google_search"]);
    expect(byId(p).bags.googleCampaignTypes).toEqual(["google_shopping"]);
    expect(p.channelTotals).toEqual({ metaCents: 8_300, googleCents: 10_700 });
    expect(p.scope).toEqual({ categoryIds: ["shoes", "bags"], names: ["Shoes", "Bags"] });
  });

  it("plans the whole account when none of the named categories is loaded", () => {
    const p = plan({ snapshot, categories, scopeCategoryIds: ["nope"] });
    const whole = plan({ snapshot, categories });
    expect(p.scope).toBeNull();
    expect(p.allocations).toEqual(whole.allocations);
    expect(p.assumptions).toContain("None of the named categories are loaded; planned the whole account.");
  });
});
