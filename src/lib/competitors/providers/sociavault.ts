import type { AdCreativeInsight, AdIntelligenceProvider } from "./types";
import {
  fetchMetaCompanyAds,
  inferAdThemes,
  normalizeMetaAd,
  searchMetaCompanies,
} from "@/lib/sociavault/facebook-ad-library";
import { logger } from "@/lib/observability/logger";

export class SociaVaultAdIntelligenceProvider implements AdIntelligenceProvider {
  readonly name = "SociaVaultAdIntelligenceProvider";

  async searchAds(query: {
    domain?: string;
    brandName?: string;
    keywords?: string[];
    limit?: number;
  }): Promise<AdCreativeInsight[]> {
    const limit = query.limit ?? 10;
    const searchTerm =
      query.brandName ??
      query.keywords?.[0] ??
      query.domain?.replace(/^www\./, "").split(".")[0];

    if (!searchTerm) return [];

    try {
      let pageId: string | undefined;
      const companies = await searchMetaCompanies(searchTerm);
      if (companies.length) {
        pageId = companies[0]!.page_id;
      }

      const { ads } = await fetchMetaCompanyAds({
        pageId,
        companyName: query.brandName ?? searchTerm,
        limit,
      });

      return ads.map((ad) => {
        const normalized = normalizeMetaAd(ad);
        const copy = [normalized.headline, normalized.body]
          .filter(Boolean)
          .join(" ");
        return {
          platform: "meta",
          ad_library_id: normalized.ad_archive_id,
          headline: normalized.headline,
          body: normalized.body,
          cta: normalized.cta,
          media_type: normalized.media_type,
          landing_url: normalized.landing_url,
          first_seen_at: normalized.start_date,
          last_seen_at: normalized.end_date,
          themes: inferAdThemes(copy),
          raw: normalized.raw,
        };
      });
    } catch (error) {
      logger.warn("SociaVault ad search failed", {
        brand: query.brandName,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

export async function fetchMetaCompetitorIntel(input: {
  name: string;
  keywords?: string[];
  adLimit?: number;
}) {
  const companies = await searchMetaCompanies(input.name);
  const match =
    companies.find(
      (c) =>
        c.name.toLowerCase() === input.name.toLowerCase() ||
        c.page_alias?.toLowerCase() === input.name.toLowerCase().replace(/\s+/g, ""),
    ) ?? companies[0];

  if (!match) {
    const keyword = input.keywords?.[0] ?? input.name;
    const keywordCompanies = await searchMetaCompanies(keyword);
    const fallback = keywordCompanies[0];
    if (!fallback) {
      return {
        company: null,
        ads: [],
        totalAdCount: 0,
      };
    }
    const { ads, totalCount } = await fetchMetaCompanyAds({
      pageId: fallback.page_id,
      companyName: fallback.name,
      limit: input.adLimit ?? 12,
    });
    return {
      company: fallback,
      ads: ads.map(normalizeMetaAd),
      totalAdCount: totalCount,
    };
  }

  const { ads, totalCount } = await fetchMetaCompanyAds({
    pageId: match.page_id,
    companyName: match.name,
    limit: input.adLimit ?? 12,
  });

  return {
    company: match,
    ads: ads.map(normalizeMetaAd),
    totalAdCount: totalCount,
  };
}
