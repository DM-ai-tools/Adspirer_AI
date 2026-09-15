import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";
import {
  getLiveAdspirerProvider,
  getProvider,
  resolveProvider,
} from "@/lib/adspirer/client";
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";

/**
 * Workspace V2 uses meta_direct (OAuth Graph). Never prefer Adspirer MCP here —
 * MCP lookback/active filters miss paused-campaign Website URLs.
 */
async function adsProvider(): Promise<MetaAdsProvider> {
  const backend = getWorkspaceContext()?.backend ?? null;
  if (backend === "meta_direct") {
    return resolveProvider("meta_direct");
  }
  return getLiveAdspirerProvider() ?? getProvider();
}

const accountIdSchema = z.object({
  account_id: z.string().min(1),
});

export const listCampaignsTool = registerTool({
  name: "list_campaigns",
  description: "List Meta campaigns for an ad account",
  inputSchema: accountIdSchema,
  async execute(args) {
    return (await adsProvider()).listCampaigns(args.account_id);
  },
});

export const getCampaignInsightsTool = registerTool({
  name: "get_campaign_insights",
  description: "Get spend/performance insights for a campaign",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_id: z.string().min(1),
    date_start: z.string().min(1),
    date_stop: z.string().min(1),
  }),
  async execute(args) {
    return (await adsProvider()).getCampaignInsights(
      args.account_id,
      args.campaign_id,
      args.date_start,
      args.date_stop,
    );
  },
});

export const listAdsetsTool = registerTool({
  name: "list_adsets",
  description: "List ad sets for an account, optionally filtered by campaign",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_id: z.string().optional(),
  }),
  async execute(args) {
    return (await adsProvider()).listAdSets(args.account_id, args.campaign_id);
  },
});

export const listAdsTool = registerTool({
  name: "list_ads",
  description: "List ads for an account, optionally filtered by ad set",
  inputSchema: z.object({
    account_id: z.string().min(1),
    adset_id: z.string().optional(),
  }),
  async execute(args) {
    return (await adsProvider()).listAds(args.account_id, args.adset_id);
  },
});

export const analyzeAccountTool = registerTool({
  name: "analyze_account",
  description: "Run a diagnostic analysis of a Meta ad account",
  inputSchema: accountIdSchema,
  async execute(args) {
    return (await adsProvider()).analyzeAccount(args.account_id);
  },
});

export const getAccountOverviewTool = registerTool({
  name: "get_account_overview",
  description: "Get a high-level overview of a Meta ad account",
  inputSchema: accountIdSchema,
  async execute(args) {
    return (await adsProvider()).getAccountOverview(args.account_id);
  },
});

export const scrapeWebsiteServicesTool = registerTool({
  name: "scrape_website_services",
  description:
    "Scrape a website (Firecrawl when configured) and extract services/offerings for ad grouping",
  inputSchema: z.object({
    url: z.string().url(),
  }),
  async execute(args) {
    const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
    return scrapeWebsiteServices(args.url);
  },
});

export const generateAdCopiesTool = registerTool({
  name: "generate_ad_copies",
  description:
    "Write Meta ad copy via Adspirer's Ad Copy Writing Room skill (platform limits, distinct angles, policy scrub). Grounds in live creatives from Adspirer get_meta_ad_creatives when account_id is set. Apply via create_ad / create_meta_image_campaign / create_meta_video_campaign Approvals (PAUSED).",
  inputSchema: z.object({
    client_name: z.string().min(1),
    brand_voice: z.string().optional(),
    industry: z.string().optional(),
    value_proposition: z.string().optional(),
    offer: z.string().min(1),
    audience: z.string().min(1),
    landing_page_url: z.string().url().optional(),
    tone: z.string().optional(),
    proof_points: z.array(z.string()).optional(),
    must_include: z.array(z.string()).optional(),
    must_avoid: z.array(z.string()).optional(),
    objective: z.string().optional(),
    variants: z.number().int().min(1).max(5).optional(),
    account_id: z.string().optional(),
    refresh: z.boolean().optional(),
  }),
  async execute(args) {
    const { generateMetaAdCopies } = await import("@/lib/ads/ad-copy");
    return generateMetaAdCopies({
      clientName: args.client_name,
      brandVoice: args.brand_voice,
      industry: args.industry,
      valueProposition: args.value_proposition,
      accountId: args.account_id,
      brief: {
        offer: args.offer,
        audience: args.audience,
        landing_page_url: args.landing_page_url,
        tone: args.tone,
        proof_points: args.proof_points,
        must_include: args.must_include,
        must_avoid: args.must_avoid,
        objective: args.objective,
        variants: args.variants,
        refresh: args.refresh,
      },
    });
  },
});

export const getMetaAdCreativesTool = registerTool({
  name: "get_meta_ad_creatives",
  description:
    "Fetch Meta ads + creatives including Ads Manager Destination Website URL (landing_page_url), CTA type, headline, and primary text. Includes PAUSED / CAMPAIGN_PAUSED / ADSET_PAUSED ads — destination URLs are creative configuration, NOT delivery metrics, and do NOT require the campaign to be active or to have spend in a date window. Use during audits before analyze_landing_pages. Prefer landing_page_url; never invent destinations.",
  inputSchema: z.object({
    account_id: z.string().min(1),
    lookback_days: z.number().int().optional(),
    campaign_id: z.string().optional(),
    ad_set_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args) {
    const provider = await adsProvider();
    if (!provider.getAdCreatives) {
      throw new Error("get_meta_ad_creatives is not available on this provider");
    }
    return provider.getAdCreatives(args.account_id, {
      lookback_days: args.lookback_days ?? 30,
      campaign_id: args.campaign_id,
      ad_set_id: args.ad_set_id,
      limit: args.limit ?? 40,
    });
  },
});

export const getAccountInsightsTool = registerTool({
  name: "get_account_insights",
  description:
    "Get account-level spend/performance insights for a date range (YYYY-MM-DD).",
  inputSchema: z.object({
    account_id: z.string().min(1),
    date_start: z.string().min(1),
    date_stop: z.string().min(1),
  }),
  async execute(args) {
    const provider = await adsProvider();
    if (!provider.getAccountInsights) {
      throw new Error("get_account_insights is not available on this provider");
    }
    return provider.getAccountInsights(
      args.account_id,
      args.date_start,
      args.date_stop,
    );
  },
});

export const analyzeLandingPagesTool = registerTool({
  name: "analyze_landing_pages",
  description:
    "Scrape and score landing page URLs for a Meta audit. Pass own destinations from get_meta_ad_creatives.landing_page_url (Ads Manager Website URL) and optional competitor URLs. Do not pass Facebook CDN, display links, or invented URLs.",
  inputSchema: z.object({
    pages: z
      .array(
        z.object({
          url: z.string().url(),
          role: z.enum(["own", "competitor"]),
          ad_context: z.string().optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  async execute(args) {
    const { analyzeLandingPages } = await import("@/lib/landing/analyze-page");
    return analyzeLandingPages(
      args.pages.map((p) => ({
        url: p.url,
        role: p.role,
        adContext: p.ad_context ?? null,
      })),
    );
  },
});

export const analyzeBrandUrlTool = registerTool({
  name: "analyze_brand_url",
  description:
    "Scrape a landing URL and extract brand colours, logo cues, and creative direction for Meta ads",
  inputSchema: z.object({ url: z.string().url() }),
  async execute(args) {
    const { analyzeBrandFromUrl } = await import("@/lib/brand/analyze-url");
    return analyzeBrandFromUrl(args.url);
  },
});

export const optimizeMetaBudgetTool = registerTool({
  name: "optimize_meta_budget",
  description:
    "Adspirer optimize_meta_budget — budget reallocation recommendations from account performance",
  inputSchema: z.object({
    account_id: z.string().min(1),
    lookback_days: z.number().int().optional(),
    objective: z.string().optional(),
  }),
  async execute(args) {
    const provider = await adsProvider();
    if (!provider.optimizeBudget) {
      throw new Error("optimize_meta_budget is not available on this provider");
    }
    return provider.optimizeBudget(args.account_id, {
      lookback_days: args.lookback_days ?? 30,
      objective: args.objective,
    });
  },
});

export const optimizeMetaPlacementsTool = registerTool({
  name: "optimize_meta_placements",
  description:
    "Adspirer optimize_meta_placements — Feed/Stories/Reels placement recommendations",
  inputSchema: z.object({
    account_id: z.string().min(1),
    lookback_days: z.number().int().optional(),
    objective: z.string().optional(),
  }),
  async execute(args) {
    const provider = await adsProvider();
    if (!provider.optimizePlacements) {
      throw new Error(
        "optimize_meta_placements is not available on this provider",
      );
    }
    return provider.optimizePlacements(args.account_id, {
      lookback_days: args.lookback_days ?? 30,
      objective: args.objective,
    });
  },
});

export const detectMetaCreativeFatigueTool = registerTool({
  name: "detect_meta_creative_fatigue",
  description:
    "Adspirer detect_meta_creative_fatigue — find ads losing effectiveness that need creative refresh",
  inputSchema: z.object({
    account_id: z.string().min(1),
  }),
  async execute(args) {
    const provider = await adsProvider();
    if (!provider.detectCreativeFatigue) {
      throw new Error(
        "detect_meta_creative_fatigue is not available on this provider",
      );
    }
    return provider.detectCreativeFatigue(args.account_id);
  },
});

export const listCompetitorAdsV2Tool = registerTool({
  name: "list_competitor_ads_v2",
  description:
    "Fetch competitor ads from Sociavault (via V2 intel pipeline) and return AI-rankable candidates for creation/optimization inspiration.",
  inputSchema: z.object({
    client_id: z.string().min(1),
    service_id: z.string().optional(),
    competitor_name: z.string().optional(),
  }),
  async execute(args) {
    const { fetchClientMetaCompetitorAds } = await import(
      "@/lib/competitors/service"
    );
    const rows = await fetchClientMetaCompetitorAds({
      clientId: args.client_id,
      serviceId: args.service_id,
    });
    const filtered = args.competitor_name
      ? rows.filter((r) =>
          r.competitor_name
            .toLowerCase()
            .includes(args.competitor_name!.toLowerCase()),
        )
      : rows;
    return filtered.flatMap((r) =>
      r.ads.map((ad) => ({
        competitor_name: r.competitor_name,
        ad_archive_id: ad.ad_archive_id,
        headline: ad.headline,
        body: ad.body,
        media_type: ad.media_type,
        cta: ad.cta,
        landing_url: ad.landing_url,
        score:
          (ad.is_active ? 30 : 0) +
          (ad.media_type === "video" ? 15 : 10) +
          (ad.cta ? 10 : 0) +
          (ad.landing_url ? 10 : 0),
      })),
    );
  },
});
