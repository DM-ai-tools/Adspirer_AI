import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import type { ClientService } from "@/types";
import {
  discoverCategoryCandidates,
  fetchCategorySitemapUrls,
  mapSiteUrls,
  matchServicePages,
  type CategoryCandidate,
} from "@/lib/scraping/site-map";

export type ScanUnavailableReason = "not_configured" | "no_website" | "scan_failed";

export type SiteScanResult =
  | { candidates: CategoryCandidate[]; source: "firecrawl"; reason?: undefined }
  | { candidates: CategoryCandidate[]; source: "unavailable"; reason: ScanUnavailableReason };

const unavailable = (reason: ScanUnavailableReason): SiteScanResult => ({
  candidates: [],
  source: "unavailable",
  reason,
});

/**
 * The category pages on a client's website: the store's own sitemap plus the
 * Firecrawl map, then the service-name fallback for sites with no shop-style
 * category paths. Never throws: a missing key, missing website or crawl error
 * comes back "unavailable" with the reason.
 */
export async function scanSiteCandidates(input: {
  siteUrl: string | null | undefined;
  existing: ClientService[];
  /** For log lines only. */
  clientId?: string;
}): Promise<SiteScanResult> {
  const { siteUrl, existing, clientId } = input;
  if (!getConfig().hasFirecrawl) return unavailable("not_configured");
  if (!siteUrl) return unavailable("no_website");

  // The store's own sitemap lists its collections even when the crawl map
  // fills up with product pages first; it never throws.
  const sitemapUrls = await fetchCategorySitemapUrls(siteUrl);
  try {
    let mapped: string[] = [];
    try {
      mapped = await mapSiteUrls(siteUrl);
    } catch (error) {
      if (!sitemapUrls.length) throw error;
      logger.warn("Category scan: site map failed; using the sitemap only", {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const urls = [...sitemapUrls, ...mapped];
    let candidates = discoverCategoryCandidates(urls, siteUrl, existing);
    // No shop-style category pages (agencies, clinics): read the service
    // names from the site and match each to its own page in the map.
    if (!candidates.length) {
      const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
      const scraped = await scrapeWebsiteServices(siteUrl);
      candidates = matchServicePages(
        scraped.services.map((s) => s.name),
        urls,
        siteUrl,
        existing,
      );
    }
    return { candidates, source: "firecrawl" };
  } catch (error) {
    logger.warn("Category scan: site map failed", {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailable("scan_failed");
  }
}
