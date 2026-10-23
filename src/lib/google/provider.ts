import { getConfig } from "@/lib/config";
import { fetchAdsPerformance } from "./ads";
import { fetchGa4CategoryRevenue, fetchGa4ItemCategories, fetchGa4LandingPages, runGa4Report, type Ga4CategoryRevenueOptions } from "./ga4";
import { fetchSearchDemand, querySearchAnalytics } from "./gsc";
import { getMockGoogleDataProvider } from "./mock-provider";
import type {
  AdsPerformance,
  DateRange,
  Ga4CategoryRevenue,
  Ga4LandingPages,
  Ga4ReportRequest,
  Ga4ReportResult,
  SearchAnalyticsRequest,
  SearchAnalyticsResult,
  SearchDemand,
} from "./types";

/** Read-only Google data, live or mock; nothing here changes Google. */
export interface GoogleDataProvider {
  ga4CategoryRevenue(propertyId: string, range: DateRange, opts?: Ga4CategoryRevenueOptions): Promise<Ga4CategoryRevenue>;
  ga4LandingPages(propertyId: string, range: DateRange): Promise<Ga4LandingPages>;
  /** GA4 item category by catalog product (variant) id. */
  ga4ItemCategories(propertyId: string, range: DateRange): Promise<Map<string, string>>;
  /** A free-form GA4 report (the workspace's ga4_report tool). */
  ga4Report(propertyId: string, request: Ga4ReportRequest): Promise<Ga4ReportResult>;
  adsPerformance(customerId: string, loginCustomerId: string | null, range: DateRange): Promise<AdsPerformance>;
  searchDemand(siteUrl: string, range: DateRange): Promise<SearchDemand>;
  /** A free-form Search Analytics query (the workspace's search_console_query tool). */
  searchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResult>;
}

const liveProvider: GoogleDataProvider = {
  ga4CategoryRevenue: fetchGa4CategoryRevenue,
  ga4LandingPages: fetchGa4LandingPages,
  ga4ItemCategories: fetchGa4ItemCategories,
  ga4Report: runGa4Report,
  adsPerformance: fetchAdsPerformance,
  searchDemand: fetchSearchDemand,
  searchAnalytics: querySearchAnalytics,
};

/** Mock in DEMO_MODE or without Supabase (same rule as the rest of the app); live otherwise. */
export function getGoogleDataProvider(): GoogleDataProvider {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase ? getMockGoogleDataProvider() : liveProvider;
}
