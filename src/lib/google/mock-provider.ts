import { getDemoStore } from "@/lib/demo/store";
import type { GoogleDataProvider } from "./provider";
import type { AdsPerformance, Ga4CategoryRevenue, Ga4LandingPages, SearchDemand } from "./types";

/**
 * Demo Google data for ClickTrends (Bar stools and Sofas). Sized against the
 * demo Meta snapshot (about $2,100 on bar stools at ROAS 3.1 and $1,200 on
 * sofas at ROAS 1.6 over 30 days): GA4 is last-click, so its totals sit near
 * Meta's own plus Google's share.
 */

const BAR = "https://clicktrends.example/collections/bar-stools";
const SOFAS = "https://clicktrends.example/collections/sofas";
const BAR_PATH = "/collections/bar-stools";
const SOFAS_PATH = "/collections/sofas";

/** The mapped asset's currency, so the mock always matches the demo client. */
function assetCurrency(externalId: string): string {
  const asset = getDemoStore().googleAssets.find((a) => a.external_id === externalId);
  return asset?.currency ?? "USD";
}

const ga4: Omit<Ga4CategoryRevenue, "currency"> = {
  method: "item",
  rows: [
    { key: "Bar Stools", revenueCents: 700_000, purchases: 92 },
    { key: "Sofas", revenueCents: 310_000, purchases: 21 },
  ],
  byChannel: [
    { landingPage: BAR_PATH, channel: "paid_social", revenueCents: 380_000 },
    { landingPage: BAR_PATH, channel: "paid_search", revenueCents: 220_000 },
    { landingPage: BAR_PATH, channel: "other", revenueCents: 60_000 },
    { landingPage: SOFAS_PATH, channel: "paid_social", revenueCents: 150_000 },
    { landingPage: SOFAS_PATH, channel: "paid_search", revenueCents: 105_000 },
    { landingPage: SOFAS_PATH, channel: "other", revenueCents: 30_000 },
  ],
  // By order: each category's item revenue in the same channel shares as its landing pages
  // above, so the demo figures are the same either way.
  byItemChannel: [
    { itemCategory: "Bar Stools", channel: "paid_social", revenueCents: 403_030 },
    { itemCategory: "Bar Stools", channel: "paid_search", revenueCents: 233_333 },
    { itemCategory: "Bar Stools", channel: "other", revenueCents: 63_637 },
    { itemCategory: "Sofas", channel: "paid_social", revenueCents: 163_158 },
    { itemCategory: "Sofas", channel: "paid_search", revenueCents: 114_211 },
    { itemCategory: "Sofas", channel: "other", revenueCents: 32_631 },
  ],
};

/** Session landing pages: the byChannel totals per page; the product page counts toward its collection. */
const landing: Omit<Ga4LandingPages, "currency"> = {
  rows: [
    { path: BAR_PATH, revenueCents: 620_000, purchases: 82 },
    { path: `${BAR_PATH}/products/oak-counter-stool`, revenueCents: 40_000, purchases: 5 },
    { path: SOFAS_PATH, revenueCents: 285_000, purchases: 19 },
    { path: "/", revenueCents: 45_000, purchases: 4 },
  ],
};

const ads: Omit<AdsPerformance, "currency"> = {
  customerId: "1112223334",
  merchantCenterLinked: true,
  campaigns: [
    { id: "9001", name: "Search | Bar stools", type: "SEARCH", status: "ENABLED", costCents: 85_000, conversions: 22, conversionValueCents: 240_000 },
    { id: "9002", name: "PMax | Furniture", type: "PERFORMANCE_MAX", status: "ENABLED", costCents: 140_000, conversions: 31, conversionValueCents: 410_000 },
  ],
  landingPages: [
    { url: BAR, costCents: 150_000, conversionValueCents: 430_000 },
    { url: SOFAS, costCents: 75_000, conversionValueCents: 220_000 },
  ],
  assetGroups: [{ name: "Bar Stools", campaignId: "9002", costCents: 90_000, conversionValueCents: 280_000 }],
  shoppingCategories: [{ productType: "Bar Stools", costCents: 60_000, conversionValueCents: 190_000 }],
};

const gsc: Omit<SearchDemand, "siteUrl"> = {
  rows: [
    {
      page: BAR, clicks: 1_240, impressions: 31_500, position: 8.4,
      topQueries: ["bar stools", "counter height bar stools", "swivel bar stools", "backless bar stools"],
    },
    {
      page: SOFAS, clicks: 610, impressions: 22_800, position: 11.7,
      topQueries: ["sofas", "modern sofa", "3 seater sofa"],
    },
  ],
};

export function getMockGoogleDataProvider(): GoogleDataProvider {
  return {
    ga4CategoryRevenue: async (propertyId, _range, opts) => {
      const { byItemChannel, ...rest } = ga4;
      return structuredClone({
        ...rest,
        ...(opts?.byItemChannel === false ? {} : { byItemChannel }),
        currency: assetCurrency(propertyId),
      });
    },
    ga4LandingPages: async (propertyId) => structuredClone({ ...landing, currency: assetCurrency(propertyId) }),
    adsPerformance: async (customerId) =>
      structuredClone({ ...ads, customerId, currency: assetCurrency(customerId) }),
    searchDemand: async (siteUrl) => structuredClone({ ...gsc, siteUrl }),
  };
}
