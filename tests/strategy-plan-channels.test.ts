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
    currencyMismatch: null,
    googleUnmatchedSpendCents: 0,
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
    expect(p.assumptions).toContain(p.channelNote);
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
    // Meta 210,000 + Google 116,667 spend against GA4's 700,000 for the category.
    expect(bar).toMatchObject({ tier: "promising", observedSpendCents: 326_667, observedRoas: 2.14 });
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
    // GA4 ROAS 2.14 is under the 2.5 break-even of a 40% margin.
    expect(p.allocations[0]).toMatchObject({ categoryId: "svc_ct_bar_stools", tier: "hold", dailyBudgetCents: 13_300 });
    const split = p.allocations[0].channelSplit!;
    expect(split.metaCents + split.googleCents).toBe(13_300);
    expect(p.projection.dailySpendCents).toBe(13_300);
    expect(p.scope).toEqual({ categoryIds: ["svc_ct_bar_stools"], names: ["Bar stools"] });
    expect(p.assumptions).toContain("Bar stools is below break-even; funded because the plan was asked for it.");
  });
});

describe("buildStrategyPlan revenue basis and tiers", () => {
  it("tiers on GA4 revenue: Meta says 5×, GA4 says 3×, so promising not proven", () => {
    const snapshot = snap([ad("Shoes", 20_000, 5)]);
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
    expect(p.benchmark.references.find((r) => r.metric === "Account ROAS")?.value).toBe("3×");
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
        row("shoes", { meta: { spend: 20_000, revenue: 100_000 }, ga4Total: 60_000 }),
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
  const snapshot = snap([ad("Shoes", 20_000, 5)]);
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
    const mismatch = "Meta reports in AUD, GA4 in USD: figures are shown per channel and not combined.";
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
    expect(p.channelNote).toContain(mismatch);
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

  it("plans the whole account when none of the named categories is loaded", () => {
    const p = plan({ snapshot, categories, scopeCategoryIds: ["nope"] });
    const whole = plan({ snapshot, categories });
    expect(p.scope).toBeNull();
    expect(p.allocations).toEqual(whole.allocations);
    expect(p.assumptions).toContain("None of the named categories are loaded; planned the whole account.");
  });
});
