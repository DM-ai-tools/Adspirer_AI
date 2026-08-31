import { sociavaultGet } from "./client";

export type SociaVaultCompanySearchResult = {
  page_id: string;
  name: string;
  category?: string | null;
  image_uri?: string | null;
  likes?: number | null;
  verification?: string | null;
  ig_username?: string | null;
  ig_followers?: number | null;
  page_alias?: string | null;
};

export type SociaVaultMetaAd = {
  ad_archive_id: string;
  page_id?: string;
  page_name?: string;
  is_active?: boolean;
  publisher_platform?: string[];
  start_date_string?: string | null;
  end_date_string?: string | null;
  snapshot?: {
    title?: string | null;
    body?: { text?: string | null } | string | null;
    cta_text?: string | null;
    link_url?: string | null;
    display_format?: string | null;
    cards?: Array<{
      title?: string | null;
      body?: string | null;
      cta_text?: string | null;
      link_url?: string | null;
      original_image_url?: string | null;
      video_hd_url?: string | null;
      video_sd_url?: string | null;
    }>;
    images?: Array<{ original_image_url?: string | null }>;
    videos?: Array<{ video_hd_url?: string | null; video_sd_url?: string | null }>;
  };
};

type CompanySearchPayload = {
  success?: boolean;
  searchResults?: Record<string, SociaVaultCompanySearchResult>;
};

type CompanyAdsPayload = {
  success?: boolean;
  results?: Record<string, SociaVaultMetaAd>;
  searchResultsCount?: number;
  cursor?: string | null;
};

/** Search Meta Ad Library for companies by name. Docs: search-companies */
export async function searchMetaCompanies(
  query: string,
): Promise<SociaVaultCompanySearchResult[]> {
  const res = await sociavaultGet<CompanySearchPayload>(
    "/v1/scrape/facebook-ad-library/search-companies",
    { query },
  );
  const results = res.data?.searchResults ?? {};
  return Object.values(results).filter((r) => r?.page_id && r?.name);
}

/** Fetch ads for a company page. Docs: company-ads */
export async function fetchMetaCompanyAds(input: {
  pageId?: string;
  companyName?: string;
  country?: string;
  status?: "ALL" | "ACTIVE" | "INACTIVE";
  limit?: number;
  cursor?: string | null;
}): Promise<{ ads: SociaVaultMetaAd[]; totalCount: number }> {
  const res = await sociavaultGet<CompanyAdsPayload>(
    "/v1/scrape/facebook-ad-library/company-ads",
    {
      pageId: input.pageId,
      companyName: input.companyName,
      country: input.country ?? "ALL",
      status: input.status ?? "ACTIVE",
      trim: true,
      cursor: input.cursor ?? undefined,
    },
  );

  const results = res.data?.results ?? {};
  const ads = Object.values(results).filter((a) => a?.ad_archive_id);
  const limit = input.limit ?? 12;
  return {
    ads: ads.slice(0, limit),
    totalCount: res.data?.searchResultsCount ?? ads.length,
  };
}

export async function fetchMetaCompanyAdsPage(input: {
  pageId?: string;
  companyName?: string;
  country?: string;
  status?: "ALL" | "ACTIVE" | "INACTIVE";
  cursor?: string | null;
}): Promise<{ ads: SociaVaultMetaAd[]; totalCount: number; cursor: string | null }> {
  const res = await sociavaultGet<CompanyAdsPayload>(
    "/v1/scrape/facebook-ad-library/company-ads",
    {
      pageId: input.pageId,
      companyName: input.companyName,
      country: input.country ?? "ALL",
      status: input.status ?? "ACTIVE",
      trim: true,
      cursor: input.cursor ?? undefined,
    },
  );
  const results = res.data?.results ?? {};
  const ads = Object.values(results).filter((a) => a?.ad_archive_id);
  return {
    ads,
    totalCount: res.data?.searchResultsCount ?? ads.length,
    cursor: res.data?.cursor ?? null,
  };
}

export function findNormalizedAdById(
  ads: SociaVaultMetaAd[],
  adArchiveId: string,
) {
  const found = ads.find((ad) => ad.ad_archive_id === adArchiveId);
  return found ? normalizeMetaAd(found) : null;
}

export function normalizeMetaAd(ad: SociaVaultMetaAd) {
  const snap = ad.snapshot;
  const card = snap?.cards?.[0];
  const image =
    card?.original_image_url ??
    snap?.images?.[0]?.original_image_url ??
    null;
  const video =
    card?.video_hd_url ??
    card?.video_sd_url ??
    snap?.videos?.[0]?.video_hd_url ??
    snap?.videos?.[0]?.video_sd_url ??
    null;

  const bodyText =
    typeof snap?.body === "string"
      ? snap.body
      : snap?.body?.text ??
        card?.body ??
        null;

  const headline = snap?.title ?? card?.title ?? null;
  const cta = snap?.cta_text ?? card?.cta_text ?? null;
  const landing = snap?.link_url ?? card?.link_url ?? null;

  let mediaType = "unknown";
  if (video) mediaType = "video";
  else if (image) mediaType = "image";
  else if (snap?.display_format) mediaType = String(snap.display_format).toLowerCase();

  return {
    ad_archive_id: ad.ad_archive_id,
    page_name: ad.page_name ?? null,
    is_active: ad.is_active ?? false,
    headline,
    body: bodyText,
    cta,
    image_url: image,
    video_url: video,
    landing_url: landing,
    publisher_platform: ad.publisher_platform ?? null,
    start_date: ad.start_date_string ?? null,
    end_date: ad.end_date_string ?? null,
    media_type: mediaType,
    raw: ad as Record<string, unknown>,
  };
}

export function inferAdThemes(text: string): string[] {
  const themes: string[] = [];
  const lower = text.toLowerCase();
  if (/\b(free|book now|limited|today only|hurry)\b/.test(lower)) {
    themes.push("urgency");
  }
  if (/\b(financ|payment plan|0%|afford)\b/.test(lower)) {
    themes.push("financing");
  }
  if (/\b(trust|award|certified|years of experience)\b/.test(lower)) {
    themes.push("trust");
  }
  if (/\b(new patient|consult|appointment|book)\b/.test(lower)) {
    themes.push("lead_gen");
  }
  return themes;
}
