import { describe, expect, it } from "vitest";
import { detectGoogleCapabilities, recommendGoogleCampaignTypes } from "@/lib/strategy/google-capabilities";
import type { AdsPerformance } from "@/lib/google/types";

function ads(campaigns: Array<{ type: string; costCents: number; status?: string }>, merchantCenterLinked = true): AdsPerformance {
  return {
    customerId: "1", currency: "USD", merchantCenterLinked,
    campaigns: campaigns.map((c, i) => ({
      id: String(i), name: `c${i}`, type: c.type, status: c.status ?? "ENABLED",
      costCents: c.costCents, conversions: 0, conversionValueCents: 0,
    })),
    landingPages: [], assetGroups: [], shoppingCategories: [],
  } as AdsPerformance;
}

const stateOf = (list: ReturnType<typeof detectGoogleCapabilities>, id: string) => list.find((c) => c.id === id)?.state;

describe("detectGoogleCapabilities", () => {
  it("is unknown for every capability without Google Ads data", () => {
    const list = detectGoogleCapabilities(null);
    expect(list.map((c) => c.id)).toEqual(["google_search", "google_shopping", "google_pmax", "google_demand_gen"]);
    expect(list.every((c) => c.state === "unknown")).toBe(true);
    expect(list.every((c) => c.label.length > 0 && c.why.length > 0)).toBe(true);
  });

  it("marks types with spend in use, regardless of status", () => {
    const list = detectGoogleCapabilities(ads([
      { type: "SEARCH", costCents: 500 },
      { type: "SHOPPING", costCents: 100, status: "PAUSED" },
    ]));
    expect(stateOf(list, "google_search")).toBe("in_use");
    expect(stateOf(list, "google_shopping")).toBe("in_use");
    expect(stateOf(list, "google_pmax")).toBe("not_used");
    expect(stateOf(list, "google_demand_gen")).toBe("not_used");
  });

  it("does not count a campaign with zero spend", () => {
    expect(stateOf(detectGoogleCapabilities(ads([{ type: "DEMAND_GEN", costCents: 0 }])), "google_demand_gen")).toBe("not_used");
  });

  it("needs a feed for Shopping and Performance Max when Merchant Center is not linked", () => {
    const list = detectGoogleCapabilities(ads([{ type: "SEARCH", costCents: 100 }], false));
    expect(stateOf(list, "google_shopping")).toBe("needs_feed");
    expect(stateOf(list, "google_pmax")).toBe("needs_feed");
    expect(stateOf(list, "google_search")).toBe("in_use");
  });

  it("keeps in_use over needs_feed", () => {
    const list = detectGoogleCapabilities(ads([{ type: "PERFORMANCE_MAX", costCents: 100 }], false));
    expect(stateOf(list, "google_pmax")).toBe("in_use");
  });
});

describe("recommendGoogleCampaignTypes", () => {
  const r = (tier: "proven" | "promising" | "test" | "hold", merchantCenterLinked: boolean, searchImpressions: number) =>
    recommendGoogleCampaignTypes({ tier, merchantCenterLinked, searchImpressions });

  it("recommends nothing on hold", () => {
    expect(r("hold", true, 1000)).toEqual([]);
  });
  it("feed linked: Performance Max for proven, Shopping otherwise", () => {
    expect(r("proven", true, 0)).toEqual(["google_pmax"]);
    expect(r("promising", true, 0)).toEqual(["google_shopping"]);
    expect(r("test", true, 0)).toEqual(["google_shopping"]);
  });
  it("adds search after the feed type when there is demand", () => {
    expect(r("proven", true, 10)).toEqual(["google_pmax", "google_search"]);
    expect(r("test", true, 10)).toEqual(["google_shopping", "google_search"]);
  });
  it("no feed: search only when there is demand", () => {
    expect(r("proven", false, 10)).toEqual(["google_search"]);
    expect(r("proven", false, 0)).toEqual([]);
  });
});
