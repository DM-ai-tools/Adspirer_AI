import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";
import { getLiveAdspirerProvider, getProvider } from "@/lib/adspirer/client";

function adsProvider() {
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
    return adsProvider().listCampaigns(args.account_id);
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
    return adsProvider().getCampaignInsights(
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
    return adsProvider().listAdSets(args.account_id, args.campaign_id);
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
    return adsProvider().listAds(args.account_id, args.adset_id);
  },
});

export const analyzeAccountTool = registerTool({
  name: "analyze_account",
  description: "Run a diagnostic analysis of a Meta ad account",
  inputSchema: accountIdSchema,
  async execute(args) {
    return adsProvider().analyzeAccount(args.account_id);
  },
});

export const getAccountOverviewTool = registerTool({
  name: "get_account_overview",
  description: "Get a high-level overview of a Meta ad account",
  inputSchema: accountIdSchema,
  async execute(args) {
    return adsProvider().getAccountOverview(args.account_id);
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
    "Adspirer get_meta_ad_creatives — live Meta headlines, primary text, media URLs, and creative performance for copy grounding / fatigue refresh",
  inputSchema: z.object({
    account_id: z.string().min(1),
    lookback_days: z.number().int().optional(),
    campaign_id: z.string().optional(),
    ad_set_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args) {
    const provider = adsProvider();
    if (!provider.getAdCreatives) {
      throw new Error("get_meta_ad_creatives is not available on this provider");
    }
    return provider.getAdCreatives(args.account_id, {
      lookback_days: args.lookback_days ?? 30,
      campaign_id: args.campaign_id,
      ad_set_id: args.ad_set_id,
      limit: args.limit ?? 20,
    });
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
    const provider = adsProvider();
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
    const provider = adsProvider();
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
    const provider = adsProvider();
    if (!provider.detectCreativeFatigue) {
      throw new Error(
        "detect_meta_creative_fatigue is not available on this provider",
      );
    }
    return provider.detectCreativeFatigue(args.account_id);
  },
});
