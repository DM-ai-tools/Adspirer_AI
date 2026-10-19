import { describe, expect, it } from "vitest";
import { DEMO_CLICKTRENDS_META_ACCOUNT_ID, demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { getDemoStore } from "@/lib/demo/store";
import { loadChannelSnapshot } from "@/lib/google/snapshot";
import type { AdsPerformance, ChannelSnapshot, Ga4CategoryRevenue, SearchDemand } from "@/lib/google/types";
import { categoriesFromServices, type StrategyCategory } from "@/lib/strategy/categories";
import { attributeSpendToCategories, type CategoryAttribution } from "@/lib/strategy/category-attribution";
import { buildChannelPerformance } from "@/lib/strategy/channels";

const SITE = "https://clicktrends.example";
const SCALED = "Google figures from different sources overlap; the category split of Google spend is approximate.";

function cat(over: Partial<StrategyCategory> & { id: string; name: string }): StrategyCategory {
  return {
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

const bar = cat({ id: "bar", name: "Bar stools", landingPageUrl: `${SITE}/collections/bar-stools`, keywords: ["bar stools"] });
const sofas = cat({ id: "sofas", name: "Sofas", landingPageUrl: `${SITE}/collections/sofas` });
const categories = [bar, sofas];

/** Meta attribution from [spend, value] per category id. */
function meta(figures: Record<string, [number, number]>): CategoryAttribution {
  return {
    byCategory: categories.map((c) => {
      const [spend, value] = figures[c.id] ?? [0, 0];
      return {
        categoryId: c.id,
        spendCents: spend,
        purchaseValueCents: value,
        roas: spend > 0 ? Math.round((value / spend) * 100) / 100 : null,
        results: 0,
        adIds: [],
        matchedBy: "url" as const,
      };
    }),
    unmatched: { spendCents: 0, adIds: [] },
    coveragePct: 100,
  };
}

function ads(over: Partial<AdsPerformance> = {}): AdsPerformance {
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

function campaign(id: string, name: string, type: string, costCents: number, conversionValueCents = 0) {
  return { id, name, type, status: "ENABLED", costCents, conversions: 1, conversionValueCents };
}

function snapshot(over: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
  return {
    mapped: { ga4: over.ga4 != null, ads: over.ads != null, gsc: over.gsc != null },
    ga4: null,
    ads: null,
    gsc: null,
    warnings: [],
    ...over,
  };
}

function build(snap: ChannelSnapshot, metaAttribution = meta({}), metaCurrency = "USD") {
  return buildChannelPerformance({ categories, metaAttribution, metaCurrency, snapshot: snap });
}

const byId = (perf: ReturnType<typeof build>, id: string) => perf.byCategory.find((c) => c.categoryId === id)!;

describe("buildChannelPerformance — Google spend", () => {
  it("adds bar stools' landing-page spend to its Shopping product type without double-counting", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [
            campaign("1", "Search | Generic", "SEARCH", 50_000, 150_000),
            campaign("2", "Shopping | All products", "SHOPPING", 40_000, 120_000),
          ],
          landingPages: [{ url: `${SITE}/collections/bar-stools?utm_source=google`, costCents: 50_000, conversionValueCents: 150_000 }],
          shoppingCategories: [{ productType: "Bar Stools", costCents: 40_000, conversionValueCents: 120_000 }],
        }),
      }),
    );
    expect(byId(perf, "bar").google.spendCents).toBe(90_000);
    expect(byId(perf, "bar").google.platformRevenueCents).toBe(270_000);
    expect(byId(perf, "bar").google.roas).toBe(3);
    expect(byId(perf, "bar").google.basis).toBe("platform");
    expect(byId(perf, "sofas").google.spendCents).toBe(0);
    expect(perf.googleUnmatchedSpendCents).toBe(0);
    expect(perf.warnings).toEqual([]);
  });

  it("never counts a Shopping campaign twice when its name matches as well as its product type", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [campaign("1", "Shopping | Bar stools", "SHOPPING", 40_000)],
          shoppingCategories: [{ productType: "Bar Stools", costCents: 40_000, conversionValueCents: 0 }],
        }),
      }),
    );
    expect(byId(perf, "bar").google.spendCents).toBe(40_000);
    expect(perf.googleUnmatchedSpendCents).toBe(0);
  });

  it("matches Performance Max asset groups by name, falling back to the campaign name", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [
            campaign("1", "PMax | All", "PERFORMANCE_MAX", 100_000),
            campaign("2", "PMax | Bar stools", "PERFORMANCE_MAX", 20_000),
          ],
          assetGroups: [
            { name: "Sofas", campaignId: "1", costCents: 70_000, conversionValueCents: 140_000 },
            { name: "Misc", campaignId: "1", costCents: 30_000, conversionValueCents: 0 },
            { name: "Asset group 1", campaignId: "2", costCents: 20_000, conversionValueCents: 0 },
          ],
        }),
      }),
    );
    expect(byId(perf, "sofas").google.spendCents).toBe(70_000);
    expect(byId(perf, "sofas").google.platformRevenueCents).toBe(140_000);
    expect(byId(perf, "bar").google.spendCents).toBe(20_000);
    expect(perf.googleUnmatchedSpendCents).toBe(30_000);
  });

  it("adds an unmatched campaign to googleUnmatchedSpendCents", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [
            campaign("1", "Brand | ClickTrends", "SEARCH", 20_000),
            campaign("2", "Search | Sofas", "SEARCH", 10_000),
          ],
        }),
      }),
    );
    expect(byId(perf, "sofas").google.spendCents).toBe(10_000);
    expect(perf.googleUnmatchedSpendCents).toBe(20_000);
    expect(perf.googleAdsMapped).toBe(true);
  });

  it("scales overlapping figures to the campaign total, exactly, and warns", async () => {
    const snap = await loadChannelSnapshot("client_clicktrends", { since: "2026-09-19", until: "2026-10-18" });
    const demoCategories = categoriesFromServices(
      getDemoStore().clientServices.filter((s) => s.client_id === "client_clicktrends"),
    );
    const metaSnap = demoMetaAuditSnapshot(DEMO_CLICKTRENDS_META_ACCOUNT_ID, "ClickTrends Performance", 30);
    const perf = buildChannelPerformance({
      categories: demoCategories,
      metaAttribution: attributeSpendToCategories(metaSnap, demoCategories),
      metaCurrency: "USD",
      snapshot: snap,
    });
    const google = perf.byCategory.map((c) => c.google.spendCents);
    const campaignTotal = snap.ads!.campaigns.reduce((sum, c) => sum + c.costCents, 0);
    expect(google.reduce((a, b) => a + b, 0) + perf.googleUnmatchedSpendCents).toBe(campaignTotal);
    // Shopping 60,000 + Search 85,000 split 2:1 by landing page. The "Bar Stools" asset group
    // isn't credited on top of the product type, so the 80,000 PMax remainder stays unmatched.
    expect(byId(perf, "svc_ct_bar_stools").google.spendCents).toBe(60_000 + 56_667);
    expect(byId(perf, "svc_ct_sofas").google.spendCents).toBe(28_333);
    expect(perf.googleUnmatchedSpendCents).toBe(80_000);
    expect(perf.warnings).toContain(SCALED);
    expect(perf.ads).toBe(snap.ads);
    expect(byId(perf, "svc_ct_bar_stools").meta.spendCents).toBeGreaterThan(0);
  });

  it("doesn't credit a Search campaign's name on top of its category's landing page", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [
            campaign("1", "Search | Bar stools", "SEARCH", 20_000),
            campaign("2", "Brand", "SEARCH", 30_000),
            campaign("3", "Search | Sofas", "SEARCH", 10_000),
          ],
          landingPages: [
            { url: `${SITE}/collections/bar-stools`, costCents: 15_000, conversionValueCents: 0 },
            { url: `${SITE}/`, costCents: 35_000, conversionValueCents: 0 },
          ],
        }),
      }),
    );
    expect(byId(perf, "bar").google.spendCents).toBe(15_000);
    // Sofas has no landing-page credit, so its campaign name still counts.
    expect(byId(perf, "sofas").google.spendCents).toBe(10_000);
    expect(perf.googleUnmatchedSpendCents).toBe(35_000);
    expect(15_000 + 10_000 + perf.googleUnmatchedSpendCents).toBe(60_000);
    expect(perf.warnings).toEqual([]);
  });

  it("doesn't credit a Shopping campaign's name on top of its category's product type", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [
            campaign("1", "Shopping | Bar stools", "SHOPPING", 40_000),
            campaign("2", "Shopping | All", "SHOPPING", 50_000),
          ],
          shoppingCategories: [
            { productType: "Bar Stools", costCents: 30_000, conversionValueCents: 0 },
            { productType: "Misc", costCents: 60_000, conversionValueCents: 0 },
          ],
        }),
      }),
    );
    expect(byId(perf, "bar").google.spendCents).toBe(30_000);
    expect(byId(perf, "sofas").google.spendCents).toBe(0);
    expect(perf.googleUnmatchedSpendCents).toBe(60_000);
  });

  it("rounds a scaled split by largest remainder so the parts sum exactly to the cap", () => {
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [campaign("1", "Generic", "SEARCH", 10_000, 10_001)],
          landingPages: [
            { url: `${SITE}/collections/bar-stools`, costCents: 7_001, conversionValueCents: 7_003 },
            { url: `${SITE}/collections/bar-stools/oak`, costCents: 5_003, conversionValueCents: 5_001 },
            { url: `${SITE}/collections/bar-stools/teak`, costCents: 3_007, conversionValueCents: 3_011 },
            { url: `${SITE}/collections/sofas`, costCents: 2_999, conversionValueCents: 2_997 },
          ],
        }),
      }),
    );
    // Exact shares 3887.28 / 2777.90 / 1669.63 / 1665.19: the two largest remainders take the 2 leftover cents.
    expect(byId(perf, "bar").google.spendCents).toBe(3_887 + 2_778 + 1_670);
    expect(byId(perf, "sofas").google.spendCents).toBe(1_665);
    expect(byId(perf, "bar").google.spendCents + byId(perf, "sofas").google.spendCents).toBe(10_000);
    expect(perf.googleUnmatchedSpendCents).toBe(0);
    expect(perf.warnings).toEqual([SCALED]);
  });

  it("stays exact for amounts too large for floating-point products", () => {
    const cap = 6_000_000_000_000_001;
    const perf = build(
      snapshot({
        ads: ads({
          campaigns: [campaign("1", "Generic", "SEARCH", cap)],
          landingPages: [
            { url: `${SITE}/collections/bar-stools`, costCents: 4_000_000_000_000_003, conversionValueCents: 0 },
            { url: `${SITE}/collections/sofas`, costCents: 5_000_000_000_000_007, conversionValueCents: 0 },
          ],
        }),
      }),
    );
    const parts = perf.byCategory.map((c) => c.google.spendCents);
    expect(parts.every(Number.isSafeInteger)).toBe(true);
    expect(parts[0] + parts[1] + perf.googleUnmatchedSpendCents).toBe(cap);
    expect(perf.googleUnmatchedSpendCents).toBe(0);
  });

  it("reports nothing for Google Ads when it isn't mapped", () => {
    const perf = build(snapshot());
    expect(perf.googleAdsMapped).toBe(false);
    expect(perf.ads).toBeNull();
    expect(perf.googleUnmatchedSpendCents).toBe(0);
    expect(byId(perf, "bar").google).toEqual({
      spendCents: 0, platformRevenueCents: 0, ga4RevenueCents: null, roas: null, basis: "none",
    });
  });
});

function ga4(over: Partial<Ga4CategoryRevenue>): Ga4CategoryRevenue {
  return { method: "item", currency: "USD", rows: [], byChannel: [], ...over };
}

describe("buildChannelPerformance — GA4", () => {
  it("item method sets ga4TotalRevenueCents and splits by byChannel shares", () => {
    const perf = build(
      snapshot({
        ga4: ga4({
          rows: [{ key: "Furniture > Bar Stools", revenueCents: 100_000, purchases: 10 }],
          byChannel: [
            { landingPage: "/collections/bar-stools", channel: "paid_social", revenueCents: 30_000 },
            { landingPage: "/collections/bar-stools/", channel: "paid_search", revenueCents: 10_000 },
            { landingPage: "/collections/bar-stools", channel: "other", revenueCents: 10_000 },
          ],
        }),
      }),
      meta({ bar: [20_000, 50_000] }),
    );
    const b = byId(perf, "bar");
    expect(perf.ga4Available).toBe(true);
    expect(perf.ga4Method).toBe("item");
    expect(b.ga4TotalRevenueCents).toBe(100_000);
    expect(b.meta).toEqual({ spendCents: 20_000, platformRevenueCents: 50_000, ga4RevenueCents: 60_000, roas: 3, basis: "ga4" });
    expect(b.google.ga4RevenueCents).toBe(20_000);
    expect(b.google.roas).toBeNull(); // no Google spend
    // Sofas: GA4 is there, but no byChannel data for it.
    expect(byId(perf, "sofas").ga4TotalRevenueCents).toBe(0);
    expect(byId(perf, "sofas").meta.ga4RevenueCents).toBeNull();
    expect(byId(perf, "sofas").google.ga4RevenueCents).toBeNull();
  });

  it("landing-page method matches paths the same way", () => {
    const perf = build(
      snapshot({
        ga4: ga4({
          method: "landing_page",
          rows: [
            { key: "/collections/sofas", revenueCents: 50_000, purchases: 5 },
            { key: "/collections/sofas/velvet-sofa", revenueCents: 10_000, purchases: 1 },
            { key: "/about", revenueCents: 5_000, purchases: 1 },
          ],
          byChannel: [
            { landingPage: "/collections/sofas", channel: "paid_social", revenueCents: 25_000 },
            { landingPage: "/collections/sofas", channel: "paid_search", revenueCents: 25_000 },
          ],
        }),
      }),
      meta({ sofas: [10_000, 20_000] }),
    );
    const s = byId(perf, "sofas");
    expect(s.ga4TotalRevenueCents).toBe(60_000);
    expect(s.meta.ga4RevenueCents).toBe(30_000);
    expect(s.meta.roas).toBe(3);
    expect(s.google.ga4RevenueCents).toBe(30_000);
    expect(byId(perf, "bar").ga4TotalRevenueCents).toBe(0);
  });

  it("method none means GA4 isn't available and ROAS uses platform figures", () => {
    const perf = build(snapshot({ ga4: ga4({ method: "none" }) }), meta({ bar: [20_000, 50_000] }));
    expect(perf.ga4Available).toBe(false);
    expect(perf.ga4Method).toBe("none");
    expect(perf.metaVsGa4).toBeNull();
    const b = byId(perf, "bar");
    expect(b.ga4TotalRevenueCents).toBeNull();
    expect(b.meta).toEqual({ spendCents: 20_000, platformRevenueCents: 50_000, ga4RevenueCents: null, roas: 2.5, basis: "platform" });
  });

  it("no GA4 at all reports method none", () => {
    const perf = build(snapshot(), meta({ bar: [20_000, 50_000] }));
    expect(perf.ga4Available).toBe(false);
    expect(perf.ga4Method).toBe("none");
    expect(byId(perf, "bar").meta.basis).toBe("platform");
  });

  it("computes metaVsGa4 when GA4 is available", () => {
    const perf = build(
      snapshot({
        ga4: ga4({
          rows: [
            { key: "Bar Stools", revenueCents: 100_000, purchases: 10 },
            { key: "Sofas", revenueCents: 40_000, purchases: 2 },
          ],
          byChannel: [
            { landingPage: "/collections/bar-stools", channel: "paid_social", revenueCents: 50_000 },
            { landingPage: "/collections/bar-stools", channel: "paid_search", revenueCents: 50_000 },
            { landingPage: "/collections/sofas", channel: "paid_social", revenueCents: 10_000 },
            { landingPage: "/collections/sofas", channel: "other", revenueCents: 30_000 },
          ],
        }),
      }),
      meta({ bar: [20_000, 70_000], sofas: [5_000, 15_000] }),
    );
    expect(perf.metaVsGa4).toEqual({ metaReportedCents: 85_000, ga4PaidSocialCents: 50_000 + 10_000 });
  });
});

describe("buildChannelPerformance — currency", () => {
  it("flags AUD Meta against USD GA4 and doesn't split GA4 across channels", () => {
    const perf = build(
      snapshot({
        ga4: ga4({
          rows: [{ key: "Bar Stools", revenueCents: 100_000, purchases: 10 }],
          byChannel: [{ landingPage: "/collections/bar-stools", channel: "paid_social", revenueCents: 100_000 }],
        }),
      }),
      meta({ bar: [20_000, 50_000] }),
      "AUD",
    );
    expect(perf.currencyMismatch).toBe("Meta reports in AUD, GA4 in USD: figures are shown per channel and not combined.");
    const b = byId(perf, "bar");
    expect(b.ga4TotalRevenueCents).toBe(100_000);
    expect(b.meta.ga4RevenueCents).toBeNull();
    expect(b.meta.basis).toBe("platform");
    expect(perf.metaVsGa4).toBeNull();
  });

  it("names Google Ads too, and ignores an unknown GA4 currency", () => {
    const perf = build(
      snapshot({ ga4: ga4({ currency: "" }), ads: ads({ currency: "NZD" }) }),
      meta({}),
      "AUD",
    );
    expect(perf.currencyMismatch).toBe("Meta reports in AUD, Google Ads in NZD: figures are shown per channel and not combined.");
    expect(build(snapshot({ ga4: ga4({ currency: "" }), ads: ads({ currency: "AUD" }) }), meta({}), "AUD").currencyMismatch).toBeNull();
  });
});

describe("buildChannelPerformance — Search Console and warnings", () => {
  it("sums Search Console clicks and impressions per category and merges top queries", () => {
    const gsc: SearchDemand = {
      siteUrl: `${SITE}/`,
      rows: [
        { page: `${SITE}/collections/bar-stools`, clicks: 100, impressions: 2_000, position: 5, topQueries: ["bar stools", "swivel bar stools", "counter stools"] },
        { page: `${SITE}/collections/bar-stools/oak-stool`, clicks: 300, impressions: 4_000, position: 7, topQueries: ["oak bar stool", "bar stools", "wooden stool", "tall stool"] },
        { page: `${SITE}/about`, clicks: 50, impressions: 900, position: 3, topQueries: ["clicktrends"] },
      ],
    };
    const perf = build(snapshot({ gsc }));
    const b = byId(perf, "bar");
    expect(b.searchClicks).toBe(400);
    expect(b.searchImpressions).toBe(6_000);
    expect(b.topQueries).toEqual(["oak bar stool", "bar stools", "wooden stool", "tall stool", "swivel bar stools"]);
    expect(byId(perf, "sofas").searchImpressions).toBe(0);
    expect(byId(perf, "sofas").topQueries).toEqual([]);
  });

  it("keeps the snapshot's warnings", () => {
    const perf = build(snapshot({ warnings: ["Google Ads: quota exceeded"] }));
    expect(perf.warnings).toEqual(["Google Ads: quota exceeded"]);
  });
});
