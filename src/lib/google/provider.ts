import { getConfig } from "@/lib/config";
import { fetchAdsPerformance } from "./ads";
import { fetchGa4CategoryRevenue, fetchGa4LandingPages, type Ga4CategoryRevenueOptions } from "./ga4";
import { fetchSearchDemand } from "./gsc";
import { getMockGoogleDataProvider } from "./mock-provider";
import type { AdsPerformance, DateRange, Ga4CategoryRevenue, Ga4LandingPages, SearchDemand } from "./types";

/** Read-only Google data, live or mock; nothing here changes Google. */
export interface GoogleDataProvider {
  ga4CategoryRevenue(propertyId: string, range: DateRange, opts?: Ga4CategoryRevenueOptions): Promise<Ga4CategoryRevenue>;
  ga4LandingPages(propertyId: string, range: DateRange): Promise<Ga4LandingPages>;
  adsPerformance(customerId: string, loginCustomerId: string | null, range: DateRange): Promise<AdsPerformance>;
  searchDemand(siteUrl: string, range: DateRange): Promise<SearchDemand>;
}

const liveProvider: GoogleDataProvider = {
  ga4CategoryRevenue: fetchGa4CategoryRevenue,
  ga4LandingPages: fetchGa4LandingPages,
  adsPerformance: fetchAdsPerformance,
  searchDemand: fetchSearchDemand,
};

/** Mock in DEMO_MODE or without Supabase (same rule as the rest of the app); live otherwise. */
export function getGoogleDataProvider(): GoogleDataProvider {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase ? getMockGoogleDataProvider() : liveProvider;
}
