export interface MetaCampaign {
  id: string;
  account_id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
  objective: string;
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  created_time?: string;
  updated_time?: string;
}

export interface MetaAdSet {
  id: string;
  campaign_id: string;
  account_id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
  daily_budget_cents: number;
  optimization_goal?: string;
  billing_event?: string;
  targeting_summary?: string;
}

export interface MetaAd {
  id: string;
  adset_id: string;
  campaign_id: string;
  account_id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
  creative_summary?: string;
}

/** Live creative + performance row from Adspirer `get_meta_ad_creatives`. */
export interface MetaAdCreative {
  ad_id: string;
  ad_name?: string;
  campaign_id?: string;
  adset_id?: string;
  headline?: string | null;
  primary_text?: string | null;
  description?: string | null;
  call_to_action_type?: string | null;
  landing_page_url?: string | null;
  image_url?: string | null;
  creative_type?: string | null;
  spend?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  frequency?: number;
}

export interface MetaInsights {
  account_id: string;
  entity_id: string;
  entity_type: "account" | "campaign" | "adset" | "ad";
  date_start: string;
  date_stop: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  reach?: number;
  frequency?: number;
  conversions?: number;
  cost_per_conversion?: number;
  raw?: Record<string, unknown>;
}

export interface MetaAccountOverview {
  account_id: string;
  account_name: string;
  currency: string;
  timezone: string;
  spend_7d: number;
  spend_30d: number;
  active_campaigns: number;
  paused_campaigns: number;
  health: "healthy" | "attention" | "critical";
  notes: string[];
}

export interface CreateCampaignInput {
  account_id: string;
  name: string;
  objective: string;
  status?: "ACTIVE" | "PAUSED";
  daily_budget_cents?: number;
  special_ad_categories?: string[];
}

export interface CreateImageCampaignInput {
  account_id: string;
  campaign_name: string;
  objective?: string;
  budget_daily?: number;
  /** Total spend over the campaign duration; requires end_time. */
  budget_lifetime?: number;
  /** ISO end date; required with budget_lifetime, optional otherwise. */
  end_time?: string;
  primary_text: string;
  headline: string;
  description?: string;
  /** Meta CTA enum, e.g. LEARN_MORE, SHOP_NOW, SIGN_UP. */
  call_to_action?: string;
  landing_page_url: string;
  /** Display URL shown on the ad instead of the full landing URL. */
  display_link?: string;
  /** UTM query string appended on click, e.g. "utm_source=meta". */
  url_tags?: string;
  image_url?: string;
  existing_image_hash?: string;
  /** Names for the child entities; Adspirer derives them from campaign_name when omitted. */
  ad_set_name?: string;
  ad_name?: string;
  age_min?: number;
  age_max?: number;
  /** ["male"] / ["female"]; omit for all. */
  genders?: string[];
  /** Country codes or search_meta_targeting location objects. Default US. */
  locations?: unknown[];
  publisher_platforms?: string[];
  special_ad_categories?: string[];
  campaign_budget_optimization?: boolean;
  pixel_id?: string;
  pixel_event_name?: string;
  instagram_account_id?: string;
  facebook_page_id?: string;
  /**
   * Any other field from Adspirer's create_meta_image_campaign schema
   * (interests, custom_audiences, primary_texts, placements, DSA fields, …)
   * forwarded verbatim.
   */
  extra_args?: Record<string, unknown>;
}

/**
 * Adspirer create_meta_video_campaign — same campaign/ad-set/ad stack as image,
 * but the creative is a video (`video_url` or `existing_video_id`).
 */
export interface CreateVideoCampaignInput {
  account_id: string;
  campaign_name: string;
  objective?: string;
  budget_daily?: number;
  budget_lifetime?: number;
  end_time?: string;
  primary_text: string;
  /** Optional for video ads (required for image). */
  headline?: string;
  description?: string;
  call_to_action?: string;
  landing_page_url: string;
  display_link?: string;
  url_tags?: string;
  /** Public MP4/MOV URL; mutually exclusive with existing_video_id. */
  video_url?: string;
  /** Reuse a video already in the Meta ad account. */
  existing_video_id?: string;
  /** Optional custom thumbnail; Meta auto-generates if omitted. */
  thumbnail_url?: string;
  ad_set_name?: string;
  ad_name?: string;
  age_min?: number;
  age_max?: number;
  genders?: string[];
  locations?: unknown[];
  publisher_platforms?: string[];
  special_ad_categories?: string[];
  campaign_budget_optimization?: boolean;
  pixel_id?: string;
  pixel_event_name?: string;
  instagram_account_id?: string;
  facebook_page_id?: string;
  extra_args?: Record<string, unknown>;
}

export interface CreateAdSetInput {
  account_id: string;
  campaign_id: string;
  name?: string;
  budget_daily?: number;
  /** Required by Adspirer AddMetaAdSetInput */
  ad_type?: "image" | "video" | "carousel";
  landing_page_url: string;
  primary_text: string;
  image_url?: string;
  video_url?: string;
  existing_video_id?: string;
  thumbnail_url?: string;
  headline?: string;
  description?: string;
  call_to_action?: string;
  age_min?: number;
  age_max?: number;
  genders?: string[];
  locations?: unknown[];
  /** Any other field from Adspirer's add_meta_ad_set schema, forwarded verbatim. */
  extra_args?: Record<string, unknown>;
}

export interface CreateAdInput {
  account_id: string;
  ad_set_id: string;
  ad_type?: "image" | "video" | "carousel";
  primary_text: string;
  landing_page_url: string;
  headline?: string;
  image_url?: string;
  existing_image_hash?: string;
  video_url?: string;
  existing_video_id?: string;
  thumbnail_url?: string;
  name?: string;
}

export interface UpdateAdSetBudgetInput {
  account_id: string;
  adset_id: string;
  daily_budget_cents: number;
}

/**
 * Domain-oriented Meta Ads provider.
 * Implementations: MockMetaAdsProvider, AdspirerMCPProvider.
 */
export interface MetaAdsProvider {
  readonly name: string;

  listCampaigns(accountId: string): Promise<MetaCampaign[]>;
  getCampaignInsights(
    accountId: string,
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights>;
  listAdSets(accountId: string, campaignId?: string): Promise<MetaAdSet[]>;
  listAds(accountId: string, adSetId?: string): Promise<MetaAd[]>;
  analyzeAccount(accountId: string): Promise<{
    overview: MetaAccountOverview;
    findings: string[];
    recommended_actions: string[];
  }>;
  getAccountOverview(accountId: string): Promise<MetaAccountOverview>;

  updateAdSetBudget(input: UpdateAdSetBudgetInput): Promise<MetaAdSet>;
  pauseCampaign(accountId: string, campaignId: string): Promise<MetaCampaign>;
  resumeCampaign(accountId: string, campaignId: string): Promise<MetaCampaign>;
  createCampaign(input: CreateCampaignInput): Promise<MetaCampaign>;
  createImageCampaign(input: CreateImageCampaignInput): Promise<{
    campaign: MetaCampaign;
    adset?: MetaAdSet;
    ad?: MetaAd;
    raw_text?: string;
  }>;
  createVideoCampaign(input: CreateVideoCampaignInput): Promise<{
    campaign: MetaCampaign;
    adset?: MetaAdSet;
    ad?: MetaAd;
    raw_text?: string;
  }>;
  createAdSet(input: CreateAdSetInput): Promise<MetaAdSet & { raw_text?: string }>;
  createAd(input: CreateAdInput): Promise<MetaAd & { raw_text?: string }>;
  pauseAd(accountId: string, adId: string): Promise<MetaAd>;

  /** Adspirer list_meta_custom_audiences — for picker UIs (names, not raw ID entry). */
  listCustomAudiences?(accountId: string): Promise<
    import("./targeting").MetaCustomAudience[]
  >;

  /** Adspirer search_meta_targeting — searchable interests/behaviors/locations/…. */
  searchTargeting?(
    accountId: string,
    input: {
      search_type: import("./targeting").MetaTargetingSearchType | string;
      query: string;
      limit?: number;
      country_code?: string;
    },
  ): Promise<import("./targeting").MetaTargetingOption[]>;

  /** Adspirer browse_meta_targeting — category listing when there is no query yet. */
  browseTargeting?(
    accountId: string,
    input: { category: string; limit?: number },
  ): Promise<import("./targeting").MetaTargetingOption[]>;

  /** Adspirer optimize / fatigue diagnose helpers (read recommendations). */
  optimizeBudget?(
    accountId: string,
    options?: Record<string, unknown>,
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }>;
  optimizePlacements?(
    accountId: string,
    options?: Record<string, unknown>,
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }>;
  detectCreativeFatigue?(
    accountId: string,
    options?: Record<string, unknown>,
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }>;

  /**
   * Adspirer get_meta_ad_creatives — live headlines / primary text / media for
   * grounding copy refreshes (Adspirer Ad Copy Writing Room skill).
   */
  getAdCreatives?(
    accountId: string,
    options?: {
      lookback_days?: number;
      campaign_id?: string;
      ad_set_id?: string;
      limit?: number;
    },
  ): Promise<MetaAdCreative[]>;

  listAccessibleAccounts(): Promise<
    Array<{
      meta_account_id: string;
      meta_account_name: string;
      currency?: string;
      timezone?: string;
      business_id?: string;
    }>
  >;
}
