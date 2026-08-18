import type {
  CreateAdInput,
  CreateAdSetInput,
  CreateCampaignInput,
  CreateImageCampaignInput,
  CreateVideoCampaignInput,
  MetaAd,
  MetaAdSet,
  MetaAdsProvider,
  MetaCampaign,
  MetaInsights,
  MetaAccountOverview,
  UpdateAdSetBudgetInput,
} from "./provider";

const MDC_ACCOUNT = "act_100200300";
const TR_ACCOUNT = "act_400500600";
const CT_ACCOUNT = "act_700800900";

type MutableState = {
  campaigns: MetaCampaign[];
  adsets: MetaAdSet[];
  ads: MetaAd[];
};

function seedState(): MutableState {
  return {
    campaigns: [
      {
        id: "camp_mdc_npl",
        account_id: MDC_ACCOUNT,
        name: "New Patient Leads — Search Intent",
        status: "ACTIVE",
        objective: "OUTCOME_LEADS",
        daily_budget_cents: 8000,
        created_time: "2026-01-12T10:00:00.000Z",
        updated_time: "2026-03-01T10:00:00.000Z",
      },
      {
        id: "camp_mdc_cosmetic",
        account_id: MDC_ACCOUNT,
        name: "Cosmetic Consults — Advantage+",
        status: "ACTIVE",
        objective: "OUTCOME_LEADS",
        daily_budget_cents: 5000,
        created_time: "2026-02-01T10:00:00.000Z",
        updated_time: "2026-03-01T10:00:00.000Z",
      },
      {
        id: "camp_mdc_retarget",
        account_id: MDC_ACCOUNT,
        name: "Website Retargeting",
        status: "PAUSED",
        objective: "OUTCOME_TRAFFIC",
        daily_budget_cents: 2000,
        created_time: "2025-11-01T10:00:00.000Z",
        updated_time: "2026-02-15T10:00:00.000Z",
      },
      {
        id: "camp_tr_prospecting",
        account_id: TR_ACCOUNT,
        name: "Agency Prospecting — US",
        status: "ACTIVE",
        objective: "OUTCOME_LEADS",
        daily_budget_cents: 15000,
      },
      {
        id: "camp_ct_catalog",
        account_id: CT_ACCOUNT,
        name: "Catalog Sales — Asc",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
        daily_budget_cents: 20000,
      },
    ],
    adsets: [
      {
        id: "adset_mdc_npl_1",
        campaign_id: "camp_mdc_npl",
        account_id: MDC_ACCOUNT,
        name: "New Patient Leads — Broad 25-54",
        status: "ACTIVE",
        daily_budget_cents: 4000,
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        targeting_summary: "US · 25-54 · interest: dentistry + lookalikes",
      },
      {
        id: "adset_mdc_npl_2",
        campaign_id: "camp_mdc_npl",
        account_id: MDC_ACCOUNT,
        name: "New Patient Leads — Zip Radius",
        status: "ACTIVE",
        daily_budget_cents: 4000,
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        targeting_summary: "10-mile radius around clinic",
      },
      {
        id: "adset_mdc_cosmetic_1",
        campaign_id: "camp_mdc_cosmetic",
        account_id: MDC_ACCOUNT,
        name: "Cosmetic — Advantage+ Audience",
        status: "ACTIVE",
        daily_budget_cents: 5000,
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        targeting_summary: "Advantage+ · conversion optimized",
      },
    ],
    ads: [
      {
        id: "ad_mdc_npl_a",
        adset_id: "adset_mdc_npl_1",
        campaign_id: "camp_mdc_npl",
        account_id: MDC_ACCOUNT,
        name: "NPL — Comfort First",
        status: "ACTIVE",
        creative_summary: "Image · calm office · CTA Book Appointment",
      },
      {
        id: "ad_mdc_npl_b",
        adset_id: "adset_mdc_npl_1",
        campaign_id: "camp_mdc_npl",
        account_id: MDC_ACCOUNT,
        name: "NPL — Same Week Availability",
        status: "ACTIVE",
        creative_summary: "Video 15s · front desk · CTA Get Started",
      },
      {
        id: "ad_mdc_cosmetic_a",
        adset_id: "adset_mdc_cosmetic_1",
        campaign_id: "camp_mdc_cosmetic",
        account_id: MDC_ACCOUNT,
        name: "Cosmetic — Smile Makeover",
        status: "ACTIVE",
        creative_summary: "Carousel before/after · CTA Learn More",
      },
      {
        id: "ad_mdc_retarget_a",
        adset_id: "adset_mdc_npl_2",
        campaign_id: "camp_mdc_retarget",
        account_id: MDC_ACCOUNT,
        name: "Retarget — Form Abandoners",
        status: "PAUSED",
        creative_summary: "Static · reminder · CTA Finish Booking",
      },
    ],
  };
}

type GlobalMock = typeof globalThis & {
  __adspirerMockMetaState?: MutableState;
};

function getState(): MutableState {
  const g = globalThis as GlobalMock;
  if (!g.__adspirerMockMetaState) {
    g.__adspirerMockMetaState = seedState();
  }
  return g.__adspirerMockMetaState;
}

export class MockMetaAdsProvider implements MetaAdsProvider {
  readonly name = "MockMetaAdsProvider";

  async listCampaigns(accountId: string): Promise<MetaCampaign[]> {
    return getState().campaigns.filter((c) => c.account_id === accountId);
  }

  async getCampaignInsights(
    accountId: string,
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const base =
      campaignId === "camp_mdc_npl"
        ? { spend: 412.2, impressions: 32_400, clicks: 780, conversions: 28 }
        : campaignId === "camp_mdc_cosmetic"
          ? { spend: 200.2, impressions: 15_800, clicks: 360, conversions: 10 }
          : { spend: 80, impressions: 6_000, clicks: 90, conversions: 2 };

    const ctr = base.impressions ? (base.clicks / base.impressions) * 100 : 0;
    const cpc = base.clicks ? base.spend / base.clicks : 0;
    const cost_per_conversion = base.conversions
      ? base.spend / base.conversions
      : 0;

    return {
      account_id: accountId,
      entity_id: campaignId,
      entity_type: "campaign",
      date_start: dateStart,
      date_stop: dateStop,
      spend: base.spend,
      impressions: base.impressions,
      clicks: base.clicks,
      ctr: Number(ctr.toFixed(2)),
      cpc: Number(cpc.toFixed(2)),
      reach: Math.round(base.impressions * 0.55),
      frequency: 1.8,
      conversions: base.conversions,
      cost_per_conversion: Number(cost_per_conversion.toFixed(2)),
      raw: { demo: true, source: "MockMetaAdsProvider" },
    };
  }

  async listAdSets(accountId: string, campaignId?: string): Promise<MetaAdSet[]> {
    return getState().adsets.filter(
      (a) =>
        a.account_id === accountId &&
        (campaignId ? a.campaign_id === campaignId : true),
    );
  }

  async listAds(accountId: string, adSetId?: string): Promise<MetaAd[]> {
    return getState().ads.filter(
      (a) =>
        a.account_id === accountId && (adSetId ? a.adset_id === adSetId : true),
    );
  }

  async analyzeAccount(accountId: string) {
    const overview = await this.getAccountOverview(accountId);
    if (accountId === MDC_ACCOUNT) {
      return {
        overview,
        findings: [
          "New Patient Leads ad set is delivery-constrained at $40/day.",
          "CPL up ~18% WoW versus prior period (demo).",
          "Retargeting campaign remains paused — missed remarketing coverage.",
          "Creative diversity: 3 active ads — consider adding UGC-style variant.",
        ],
        recommended_actions: [
          "Increase adset_mdc_npl_1 daily budget to $55 (within ceiling).",
          "Resume Website Retargeting at modest budget after creative refresh.",
          "Test financing mention in cosmetic primary text.",
        ],
      };
    }
    return {
      overview,
      findings: ["Account appears stable (demo)."],
      recommended_actions: ["Continue monitoring weekly CPL and frequency."],
    };
  }

  async getAccountOverview(accountId: string): Promise<MetaAccountOverview> {
    const campaigns = await this.listCampaigns(accountId);
    const names: Record<string, string> = {
      [MDC_ACCOUNT]: "Modern Dental Centre — Main",
      [TR_ACCOUNT]: "TrafficRadius Agency Ad Account",
      [CT_ACCOUNT]: "ClickTrends Performance",
    };

    return {
      account_id: accountId,
      account_name: names[accountId] ?? `Account ${accountId}`,
      currency: "USD",
      timezone:
        accountId === TR_ACCOUNT
          ? "America/Chicago"
          : accountId === CT_ACCOUNT
            ? "America/Los_Angeles"
            : "America/New_York",
      spend_7d: accountId === MDC_ACCOUNT ? 612.4 : 1_240,
      spend_30d: accountId === MDC_ACCOUNT ? 2_480 : 5_100,
      active_campaigns: campaigns.filter((c) => c.status === "ACTIVE").length,
      paused_campaigns: campaigns.filter((c) => c.status === "PAUSED").length,
      health: accountId === MDC_ACCOUNT ? "attention" : "healthy",
      notes:
        accountId === MDC_ACCOUNT
          ? ["DEMO DATA", "Primary demo account for agent audit flow"]
          : ["DEMO DATA"],
    };
  }

  async updateAdSetBudget(input: UpdateAdSetBudgetInput): Promise<MetaAdSet> {
    const state = getState();
    const adset = state.adsets.find(
      (a) => a.id === input.adset_id && a.account_id === input.account_id,
    );
    if (!adset) {
      throw new Error(`Ad set not found: ${input.adset_id}`);
    }
    adset.daily_budget_cents = input.daily_budget_cents;
    return { ...adset };
  }

  async pauseCampaign(accountId: string, campaignId: string): Promise<MetaCampaign> {
    const campaign = getState().campaigns.find(
      (c) => c.id === campaignId && c.account_id === accountId,
    );
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    campaign.status = "PAUSED";
    campaign.updated_time = new Date().toISOString();
    return { ...campaign };
  }

  async resumeCampaign(accountId: string, campaignId: string): Promise<MetaCampaign> {
    const campaign = getState().campaigns.find(
      (c) => c.id === campaignId && c.account_id === accountId,
    );
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    campaign.status = "ACTIVE";
    campaign.updated_time = new Date().toISOString();
    return { ...campaign };
  }

  async createCampaign(input: CreateCampaignInput): Promise<MetaCampaign> {
    const campaign: MetaCampaign = {
      id: `camp_${Date.now()}`,
      account_id: input.account_id,
      name: input.name,
      status: input.status ?? "PAUSED",
      objective: input.objective,
      daily_budget_cents: input.daily_budget_cents,
      created_time: new Date().toISOString(),
      updated_time: new Date().toISOString(),
    };
    getState().campaigns.push(campaign);
    return { ...campaign };
  }

  async createImageCampaign(input: CreateImageCampaignInput) {
    const campaign = await this.createCampaign({
      account_id: input.account_id,
      name: input.campaign_name,
      objective: input.objective ?? "OUTCOME_TRAFFIC",
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
    });
    const adset: MetaAdSet = {
      id: `adset_${Date.now()}`,
      campaign_id: campaign.id,
      account_id: input.account_id,
      name: input.ad_set_name ?? `${input.campaign_name} Ad Set`,
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
    };
    getState().adsets.push(adset);
    const ad: MetaAd = {
      id: `ad_${Date.now()}`,
      adset_id: adset.id,
      campaign_id: campaign.id,
      account_id: input.account_id,
      name: input.ad_name ?? `${input.campaign_name} Ad`,
      status: "PAUSED",
      creative_summary: input.headline,
    };
    getState().ads.push(ad);
    return {
      campaign,
      adset,
      ad,
      raw_text: `DEMO created campaign=${campaign.id} adset=${adset.id} ad=${ad.id}`,
    };
  }

  async createVideoCampaign(input: CreateVideoCampaignInput) {
    if (!input.video_url && !input.existing_video_id) {
      throw new Error(
        "create_meta_video_campaign requires video_url or existing_video_id",
      );
    }
    const campaign = await this.createCampaign({
      account_id: input.account_id,
      name: input.campaign_name,
      objective: input.objective ?? "OUTCOME_TRAFFIC",
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
    });
    const adset: MetaAdSet = {
      id: `adset_${Date.now()}`,
      campaign_id: campaign.id,
      account_id: input.account_id,
      name: input.ad_set_name ?? `${input.campaign_name} Ad Set`,
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
    };
    getState().adsets.push(adset);
    const ad: MetaAd = {
      id: `ad_${Date.now()}`,
      adset_id: adset.id,
      campaign_id: campaign.id,
      account_id: input.account_id,
      name: input.ad_name ?? `${input.campaign_name} Ad`,
      status: "PAUSED",
      creative_summary: input.headline ?? "Video ad",
    };
    getState().ads.push(ad);
    return {
      campaign,
      adset,
      ad,
      raw_text: `DEMO created video campaign=${campaign.id} adset=${adset.id} ad=${ad.id}`,
    };
  }

  async createAdSet(input: CreateAdSetInput) {
    const name = input.name ?? `Ad Set ${Date.now()}`;
    const adset: MetaAdSet = {
      id: `adset_${Date.now()}`,
      campaign_id: input.campaign_id,
      account_id: input.account_id,
      name,
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
    };
    getState().adsets.push(adset);
    return {
      ...adset,
      raw_text: `DEMO created adset=${adset.id}`,
      proof: {
        ad_set_id: adset.id,
        status: "PAUSED",
        ad_type: input.ad_type ?? "image",
        landing_page_url: input.landing_page_url,
      },
    };
  }

  async createAd(input: CreateAdInput) {
    const ad: MetaAd = {
      id: `ad_${Date.now()}`,
      adset_id: input.ad_set_id,
      campaign_id: "unknown",
      account_id: input.account_id,
      name: input.name ?? `Ad ${Date.now()}`,
      status: "PAUSED",
      creative_summary: input.headline ?? input.primary_text.slice(0, 80),
    };
    getState().ads.push(ad);
    return { ...ad, raw_text: `DEMO created ad=${ad.id}` };
  }

  async pauseAd(accountId: string, adId: string): Promise<MetaAd> {
    const ad = getState().ads.find(
      (a) => a.id === adId && a.account_id === accountId,
    );
    if (!ad) throw new Error(`Ad not found: ${adId}`);
    ad.status = "PAUSED";
    return { ...ad };
  }

  async listCustomAudiences(accountId: string) {
    void accountId;
    return [
      {
        id: "120330000000001",
        name: "Website visitors — 180d",
        subtype: "WEBSITE",
        approximate_count: 18400,
        delivery_status: "active",
      },
      {
        id: "120330000000002",
        name: "Purchase lookalike 1%",
        subtype: "LOOKALIKE",
        approximate_count: 920000,
        delivery_status: "active",
      },
      {
        id: "120330000000003",
        name: "Engaged IG 90d",
        subtype: "ENGAGEMENT",
        approximate_count: 6200,
        delivery_status: "active",
      },
      {
        id: "120330000000004",
        name: "CRM customers — hashed",
        subtype: "CUSTOM",
        approximate_count: 4100,
        delivery_status: "active",
      },
    ];
  }

  async searchTargeting(
    accountId: string,
    input: {
      search_type: string;
      query: string;
      limit?: number;
      country_code?: string;
    },
  ) {
    void accountId;
    void input.country_code;
    const q = input.query.trim().toLowerCase();
    const pool =
      input.search_type === "behavior"
        ? [
            { id: "6002714895372", name: "Engaged shoppers", type: "behavior", audience_size: 2_400_000 },
            { id: "6004386044600", name: "Frequent travelers", type: "behavior", audience_size: 1_100_000 },
            { id: "6002714898572", name: "Online spenders", type: "behavior", audience_size: 3_200_000 },
          ]
        : input.search_type === "location"
          ? [
              { id: "AU", name: "Australia", type: "location", key: "AU", country_code: "AU", audience_size: null },
              { id: "2421836", name: "Sydney", type: "location", key: "2421836", country_code: "AU", audience_size: null },
              { id: "2421835", name: "Melbourne", type: "location", key: "2421835", country_code: "AU", audience_size: null },
            ]
          : [
              { id: "6003139266461", name: "Digital marketing", type: "interest", audience_size: 48_000_000 },
              { id: "6003397425735", name: "Google Ads", type: "interest", audience_size: 1_200_000 },
              { id: "6003020834693", name: "Small business", type: "interest", audience_size: 120_000_000 },
              { id: "6003107902433", name: "Online advertising", type: "interest", audience_size: 22_000_000 },
              { id: "6003348644580", name: "Marketing automation", type: "interest", audience_size: 4_500_000 },
            ];
    const filtered = q
      ? pool.filter((p) => p.name.toLowerCase().includes(q))
      : pool;
    return filtered.slice(0, input.limit ?? 25);
  }

  async browseTargeting(
    accountId: string,
    input: { category: string; limit?: number },
  ) {
    return this.searchTargeting(accountId, {
      search_type: input.category.replace(/s$/, ""),
      query: "",
      limit: input.limit ?? 50,
    });
  }

  async optimizeBudget(accountId: string) {
    return {
      text: [
        `### Budget optimization (demo) for ${accountId}`,
        "- Shift +15% daily budget toward top ROAS ad set.",
        "- Cap under-delivering prospecting at current spend.",
        "DEMO DATA — connect live Adspirer for real optimize_meta_budget.",
      ].join("\n"),
      structured: { demo: true, tool: "optimize_meta_budget" },
    };
  }

  async optimizePlacements(accountId: string) {
    return {
      text: [
        `### Placement optimization (demo) for ${accountId}`,
        "- Prefer Feed + Reels; reduce Audience Network share.",
        "DEMO DATA — connect live Adspirer for real optimize_meta_placements.",
      ].join("\n"),
      structured: { demo: true, tool: "optimize_meta_placements" },
    };
  }

  async detectCreativeFatigue(accountId: string) {
    const ads = getState().ads.filter((a) => a.account_id === accountId);
    return {
      text: [
        `### Creative fatigue (demo) for ${accountId}`,
        ...ads.slice(0, 5).map(
          (a) =>
            `- ${a.name} (${a.id}): CTR declining — refresh creative recommended`,
        ),
        "DEMO DATA — connect live Adspirer for detect_meta_creative_fatigue.",
      ].join("\n"),
      structured: {
        demo: true,
        ads: ads.map((a) => ({ id: a.id, name: a.name })),
      },
    };
  }

  async getAdCreatives(accountId: string) {
    const ads = getState().ads.filter((a) => a.account_id === accountId);
    return ads.slice(0, 10).map((a) => ({
      ad_id: a.id,
      ad_name: a.name,
      campaign_id: a.campaign_id,
      adset_id: a.adset_id,
      headline: a.creative_summary?.slice(0, 40) ?? a.name.slice(0, 40),
      primary_text:
        a.creative_summary ??
        `Demo primary text for ${a.name}. Connect live Adspirer for real creatives.`,
      description: "Demo desc",
      call_to_action_type: "LEARN_MORE",
      creative_type: "image",
      spend: 120,
      impressions: 8000,
      clicks: 140,
      ctr: 1.75,
      frequency: 2.1,
    }));
  }

  async listAccessibleAccounts() {
    return [
      {
        meta_account_id: MDC_ACCOUNT,
        meta_account_name: "Modern Dental Centre — Main",
        currency: "USD",
        timezone: "America/New_York",
        business_id: "bm_9001",
      },
      {
        meta_account_id: TR_ACCOUNT,
        meta_account_name: "TrafficRadius Agency Ad Account",
        currency: "USD",
        timezone: "America/Chicago",
        business_id: "bm_9002",
      },
      {
        meta_account_id: CT_ACCOUNT,
        meta_account_name: "ClickTrends Performance",
        currency: "USD",
        timezone: "America/Los_Angeles",
        business_id: "bm_9003",
      },
    ];
  }
}

export function createMockMetaAdsProvider(): MockMetaAdsProvider {
  return new MockMetaAdsProvider();
}
