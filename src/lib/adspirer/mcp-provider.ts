import { AdspirerApiClient, newIdempotencyKey } from "./api-client";
import { getConfig } from "@/lib/config";
import { ProviderUnavailableError } from "@/lib/errors";
import type {
  CreateAdInput,
  CreateAdSetInput,
  CreateCampaignInput,
  CreateImageCampaignInput,
  CreateVideoCampaignInput,
  MetaAd,
  MetaAdCreative,
  MetaAdSet,
  MetaAdsProvider,
  MetaCampaign,
  MetaInsights,
  MetaAccountOverview,
  UpdateAdSetBudgetInput,
} from "./provider";
import type {
  MetaCustomAudience,
  MetaTargetingOption,
  MetaTargetingSearchType,
} from "./targeting";
import { parseCustomAudiences, parseTargetingOptions } from "./targeting";

type ConnectedAccount = {
  meta_account_id: string;
  meta_account_name: string;
  currency?: string;
  timezone?: string;
  business_id?: string;
  status?: string;
};

/**
 * Live Adspirer-backed Meta provider.
 * Uses Adspirer REST tool API (same surface as MCP) with API key auth.
 * Meta-only mapping — other platforms are ignored by this provider.
 */
export class AdspirerMCPProvider implements MetaAdsProvider {
  readonly name = "AdspirerMCPProvider";
  private client: AdspirerApiClient | null = null;

  private getClient(): AdspirerApiClient {
    if (this.client) return this.client;
    const config = getConfig();
    if (!config.ADSPIRER_API_KEY && !config.ADSPIRER_MCP_URL) {
      throw new ProviderUnavailableError(
        "Adspirer is not configured. Set ADSPIRER_API_KEY (from https://adspirer.ai/keys) and optionally ADSPIRER_MCP_URL.",
        { provider: this.name },
      );
    }
    if (!config.ADSPIRER_API_KEY) {
      throw new ProviderUnavailableError(
        "ADSPIRER_API_KEY is required for server-side Adspirer calls. Generate one at https://adspirer.ai/keys",
        { provider: this.name },
      );
    }
    this.client = AdspirerApiClient.fromConfig();
    return this.client;
  }

  private async call(
    tool: string,
    args: Record<string, unknown> = {},
    idempotent = false,
  ) {
    return this.getClient().executeTool(
      tool,
      args,
      idempotent ? { idempotencyKey: newIdempotencyKey() } : undefined,
    );
  }

  async listAccessibleAccounts(): Promise<ConnectedAccount[]> {
    // Prefer connection-status payloads (often include display names like
    // "TR Internal Marketing") and merge with list_connected_accounts.
    const [listed, status] = await Promise.all([
      this.call("list_connected_accounts", { platform: "meta_ads" }).catch(
        () => ({ text: "", structured: null }),
      ),
      this.call("get_connections_status", {}).catch(() => ({
        text: "",
        structured: null,
      })),
    ]);
    return mergeConnectedAccounts([
      ...parseConnectedMetaAccounts(listed),
      ...parseConnectedMetaAccounts(status),
    ]);
  }

  async listCampaigns(accountId: string): Promise<MetaCampaign[]> {
    // Prefer Meta-native list tool — discover_existing_assets can route to Google Ads.
    try {
      const data = await this.call("list_meta_campaigns", {
        ad_account_id: accountId,
        limit: 100,
      });
      return parseCampaigns(accountId, data);
    } catch {
      const data = await this.call("discover_existing_assets", {
        ad_account_id: accountId,
        platform: "meta_ads",
        asset_type: "campaigns",
      });
      return parseCampaigns(accountId, data);
    }
  }

  async getCampaignInsights(
    accountId: string,
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const data = await this.call("get_meta_campaign_performance", {
      ad_account_id: accountId,
      campaign_id: campaignId,
      date_start: dateStart,
      date_stop: dateStop,
    });
    return parseInsights(accountId, campaignId, dateStart, dateStop, data);
  }

  async listAdSets(accountId: string, campaignId?: string): Promise<MetaAdSet[]> {
    try {
      const data = await this.call("list_meta_ad_sets", {
        ad_account_id: accountId,
        campaign_id: campaignId,
        limit: 100,
      });
      return parseAdSets(accountId, campaignId, data);
    } catch {
      const data = await this.call("discover_existing_assets", {
        ad_account_id: accountId,
        platform: "meta_ads",
        asset_type: "adsets",
        campaign_id: campaignId,
      });
      return parseAdSets(accountId, campaignId, data);
    }
  }

  async listAds(accountId: string, adSetId?: string): Promise<MetaAd[]> {
    const data = await this.call("list_meta_ads", {
      ad_account_id: accountId,
      adset_id: adSetId,
    });
    return parseAds(accountId, adSetId, data);
  }

  async analyzeAccount(accountId: string): Promise<{
    overview: MetaAccountOverview;
    findings: string[];
    recommended_actions: string[];
  }> {
    const overview = await this.getAccountOverview(accountId);

    try {
      const data = await this.call("analyze_meta_account", {
        ad_account_id: accountId,
      });
      const text = data.text ?? "";
      return {
        overview,
        findings: extractBulletLines(text).slice(0, 12),
        recommended_actions: extractBulletLines(
          text,
          /recommend|next step|action/i,
        ).slice(0, 8),
      };
    } catch {
      // Some Adspirer plans/tools don't expose analyze_meta_account — fall back.
      const campaigns = await this.listCampaigns(accountId).catch(() => []);
      const active = campaigns.filter((c) => c.status === "ACTIVE");
      const paused = campaigns.filter((c) => c.status === "PAUSED");
      return {
        overview: {
          ...overview,
          active_campaigns: active.length || overview.active_campaigns,
          paused_campaigns: paused.length || overview.paused_campaigns,
        },
        findings: [
          `Account ${overview.account_name} (${accountId}) is connected via Adspirer.`,
          `Discovered ${campaigns.length} campaign(s)` +
            (campaigns.length
              ? `: ${campaigns
                  .slice(0, 5)
                  .map((c) => c.name)
                  .join(", ")}${campaigns.length > 5 ? "…" : ""}`
              : "."),
          active.length
            ? `${active.length} campaign(s) look active.`
            : "No clearly active campaigns detected from asset discovery.",
          ...(overview.notes ?? []).slice(0, 2),
        ],
        recommended_actions: [
          "Pull campaign insights for the last 7 days on top spenders.",
          "Review under-delivering ad sets before proposing budget changes.",
          "Queue any execute change through Approvals — nothing applies automatically.",
        ],
      };
    }
  }

  async getAccountOverview(accountId: string): Promise<MetaAccountOverview> {
    const data = await this.call("get_connections_status", {});
    const accounts = parseConnectedMetaAccounts(data);
    const match =
      accounts.find((a) => a.meta_account_id === accountId) ?? accounts[0];
    return {
      account_id: accountId,
      account_name: match?.meta_account_name ?? accountId,
      currency: match?.currency ?? "USD",
      timezone: match?.timezone ?? "UTC",
      spend_7d: 0,
      spend_30d: 0,
      active_campaigns: 0,
      paused_campaigns: 0,
      health: "attention",
      notes: [
        "Overview hydrated from Adspirer connection status. Run campaign performance tools for spend metrics.",
        data.text?.slice(0, 500) ?? "",
      ].filter(Boolean),
    };
  }

  async updateAdSetBudget(input: UpdateAdSetBudgetInput): Promise<MetaAdSet> {
    await this.call(
      "update_meta_ad_set",
      {
        ad_account_id: input.account_id,
        adset_id: input.adset_id,
        daily_budget: input.daily_budget_cents / 100,
      },
      true,
    );
    return {
      id: input.adset_id,
      campaign_id: "unknown",
      account_id: input.account_id,
      name: input.adset_id,
      status: "ACTIVE",
      daily_budget_cents: input.daily_budget_cents,
    };
  }

  async pauseCampaign(
    accountId: string,
    campaignId: string,
  ): Promise<MetaCampaign> {
    await this.call(
      "pause_meta_campaign",
      { ad_account_id: accountId, campaign_id: campaignId },
      true,
    );
    return {
      id: campaignId,
      account_id: accountId,
      name: campaignId,
      status: "PAUSED",
      objective: "UNKNOWN",
    };
  }

  async resumeCampaign(
    accountId: string,
    campaignId: string,
  ): Promise<MetaCampaign> {
    await this.call(
      "resume_meta_campaign",
      { ad_account_id: accountId, campaign_id: campaignId },
      true,
    );
    return {
      id: campaignId,
      account_id: accountId,
      name: campaignId,
      status: "ACTIVE",
      objective: "UNKNOWN",
    };
  }

  async createCampaign(input: CreateCampaignInput): Promise<MetaCampaign> {
    // Prefer modern image-campaign create when possible; fall back to shell campaign.
    try {
      const data = await this.call(
        "create_meta_image_campaign",
        {
          ad_account_id: input.account_id,
          campaign_name: input.name,
          objective: input.objective || "OUTCOME_TRAFFIC",
          budget_daily: input.daily_budget_cents
            ? input.daily_budget_cents / 100
            : 10,
          primary_text: `${input.name} — created via Adspirer AI (paused).`,
          headline: input.name.slice(0, 40),
          landing_page_url: "https://example.com",
          status: "PAUSED",
        },
        true,
      );
      const id =
        extractFirstId(data.text) ??
        (typeof data.structured?.campaign_id === "string"
          ? data.structured.campaign_id
          : `camp_${Date.now()}`);
      return {
        id,
        account_id: input.account_id,
        name: input.name,
        status: "PAUSED",
        objective: input.objective,
        daily_budget_cents: input.daily_budget_cents,
      };
    } catch {
      const data = await this.call(
        "create_meta_campaign",
        {
          ad_account_id: input.account_id,
          name: input.name,
          objective: input.objective,
          status: "PAUSED",
          daily_budget: input.daily_budget_cents
            ? input.daily_budget_cents / 100
            : undefined,
          special_ad_categories: input.special_ad_categories,
        },
        true,
      );
      const id =
        extractFirstId(data.text) ??
        (typeof data.structured?.campaign_id === "string"
          ? data.structured.campaign_id
          : `camp_${Date.now()}`);
      return {
        id,
        account_id: input.account_id,
        name: input.name,
        status: "PAUSED",
        objective: input.objective,
        daily_budget_cents: input.daily_budget_cents,
      };
    }
  }

  async createImageCampaign(input: CreateImageCampaignInput) {
    const data = await this.call(
      "create_meta_image_campaign",
      compactArgs({
        ...(input.extra_args ?? {}),
        ad_account_id: input.account_id,
        campaign_name: input.campaign_name,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        // budget_daily is skipped when a lifetime budget is given — Adspirer
        // treats them as mutually exclusive.
        budget_daily: input.budget_lifetime
          ? undefined
          : (input.budget_daily ?? 10),
        budget_lifetime: input.budget_lifetime,
        end_time: input.end_time,
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        landing_page_url: input.landing_page_url,
        display_link: input.display_link,
        url_tags: input.url_tags,
        image_url: input.image_url,
        existing_image_hash: input.existing_image_hash,
        ad_set_name: input.ad_set_name,
        ad_name: input.ad_name,
        age_min: input.age_min,
        age_max: input.age_max,
        genders: input.genders,
        locations: input.locations,
        publisher_platforms: input.publisher_platforms,
        special_ad_categories: input.special_ad_categories,
        campaign_budget_optimization: input.campaign_budget_optimization,
        pixel_id: input.pixel_id,
        pixel_event_name: input.pixel_event_name,
        instagram_account_id: input.instagram_account_id,
        facebook_page_id: input.facebook_page_id,
      }),
      true,
    );
    const campaignId =
      (typeof data.structured?.campaign_id === "string"
        ? data.structured.campaign_id
        : null) ??
      extractIdByLabel(data.text, /campaign[_\s-]?id/i) ??
      extractFirstId(data.text) ??
      `camp_${Date.now()}`;
    const adsetId =
      (typeof data.structured?.ad_set_id === "string"
        ? data.structured.ad_set_id
        : typeof data.structured?.adset_id === "string"
          ? data.structured.adset_id
          : null) ?? extractIdByLabel(data.text, /ad[_\s-]?set[_\s-]?id/i);
    const adId =
      (typeof data.structured?.ad_id === "string"
        ? data.structured.ad_id
        : null) ?? extractIdByLabel(data.text, /\bad[_\s-]?id\b/i);

    return {
      campaign: {
        id: campaignId,
        account_id: input.account_id,
        name: input.campaign_name,
        status: "PAUSED" as const,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
      },
      adset: adsetId
        ? {
            id: adsetId,
            campaign_id: campaignId,
            account_id: input.account_id,
            name: input.ad_set_name ?? `${input.campaign_name} Ad Set`,
            status: "PAUSED" as const,
            daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
          }
        : undefined,
      ad: adId
        ? {
            id: adId,
            adset_id: adsetId ?? "unknown",
            campaign_id: campaignId,
            account_id: input.account_id,
            name: input.ad_name ?? `${input.campaign_name} Ad`,
            status: "PAUSED" as const,
          }
        : undefined,
      raw_text: data.text,
    };
  }

  async createVideoCampaign(input: CreateVideoCampaignInput) {
    if (!input.video_url && !input.existing_video_id) {
      throw new Error(
        "create_meta_video_campaign requires video_url or existing_video_id",
      );
    }
    const data = await this.call(
      "create_meta_video_campaign",
      compactArgs({
        ...(input.extra_args ?? {}),
        ad_account_id: input.account_id,
        campaign_name: input.campaign_name,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        budget_daily: input.budget_lifetime
          ? undefined
          : (input.budget_daily ?? 10),
        budget_lifetime: input.budget_lifetime,
        end_time: input.end_time,
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        landing_page_url: input.landing_page_url,
        display_link: input.display_link,
        url_tags: input.url_tags,
        video_url: input.video_url,
        existing_video_id: input.existing_video_id,
        thumbnail_url: input.thumbnail_url,
        ad_set_name: input.ad_set_name,
        ad_name: input.ad_name,
        age_min: input.age_min,
        age_max: input.age_max,
        genders: input.genders,
        locations: input.locations,
        publisher_platforms: input.publisher_platforms,
        special_ad_categories: input.special_ad_categories,
        campaign_budget_optimization: input.campaign_budget_optimization,
        pixel_id: input.pixel_id,
        pixel_event_name: input.pixel_event_name,
        instagram_account_id: input.instagram_account_id,
        facebook_page_id: input.facebook_page_id,
      }),
      true,
    );
    const campaignId =
      (typeof data.structured?.campaign_id === "string"
        ? data.structured.campaign_id
        : null) ??
      extractIdByLabel(data.text, /campaign[_\s-]?id/i) ??
      extractFirstId(data.text) ??
      `camp_${Date.now()}`;
    const adsetId =
      (typeof data.structured?.ad_set_id === "string"
        ? data.structured.ad_set_id
        : typeof data.structured?.adset_id === "string"
          ? data.structured.adset_id
          : null) ?? extractIdByLabel(data.text, /ad[_\s-]?set[_\s-]?id/i);
    const adId =
      (typeof data.structured?.ad_id === "string"
        ? data.structured.ad_id
        : null) ?? extractIdByLabel(data.text, /\bad[_\s-]?id\b/i);

    return {
      campaign: {
        id: campaignId,
        account_id: input.account_id,
        name: input.campaign_name,
        status: "PAUSED" as const,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
      },
      adset: adsetId
        ? {
            id: adsetId,
            campaign_id: campaignId,
            account_id: input.account_id,
            name: input.ad_set_name ?? `${input.campaign_name} Ad Set`,
            status: "PAUSED" as const,
            daily_budget_cents: Math.round((input.budget_daily ?? 10) * 100),
          }
        : undefined,
      ad: adId
        ? {
            id: adId,
            adset_id: adsetId ?? "unknown",
            campaign_id: campaignId,
            account_id: input.account_id,
            name: input.ad_name ?? `${input.campaign_name} Ad`,
            status: "PAUSED" as const,
          }
        : undefined,
      raw_text: data.text,
    };
  }

  async createAdSet(input: CreateAdSetInput) {
    const name = input.name?.trim() || "Ad Set";
    const adType = input.ad_type ?? "image";
    const primaryText =
      input.primary_text?.trim() ||
      `${name} — Learn more. Created via Adspirer AI (paused).`;
    const landingPageUrl = input.landing_page_url?.trim();
    if (!landingPageUrl || !/^https?:\/\//i.test(landingPageUrl)) {
      throw new Error(
        "landing_page_url is required for create_adset (https://…). Edit the approval to add it, then approve again.",
      );
    }

    const data = await this.call(
      "add_meta_ad_set",
      compactArgs({
        ...(input.extra_args ?? {}),
        ad_account_id: input.account_id,
        campaign_id: input.campaign_id,
        name,
        budget_daily: input.budget_daily,
        ad_type: adType,
        landing_page_url: landingPageUrl,
        primary_text: primaryText,
        headline: input.headline ?? name.slice(0, 40),
        description: input.description,
        call_to_action: input.call_to_action,
        image_url: input.image_url,
        video_url: input.video_url,
        existing_video_id: input.existing_video_id,
        thumbnail_url: input.thumbnail_url,
        age_min: input.age_min,
        age_max: input.age_max,
        genders: input.genders,
        locations: input.locations,
        status: "PAUSED",
      }),
      true,
    );
    const id =
      (typeof data.structured?.ad_set_id === "string"
        ? data.structured.ad_set_id
        : typeof data.structured?.adset_id === "string"
          ? data.structured.adset_id
          : null) ??
      extractIdByLabel(data.text, /ad[_\s-]?set[_\s-]?id/i) ??
      extractFirstId(data.text) ??
      `adset_${Date.now()}`;
    return {
      id,
      campaign_id: input.campaign_id,
      account_id: input.account_id,
      name,
      status: "PAUSED" as const,
      daily_budget_cents: Math.round((input.budget_daily ?? 0) * 100),
      raw_text: data.text,
      proof: {
        ad_set_id: id,
        status: "PAUSED",
        ad_type: adType,
        landing_page_url: landingPageUrl,
      },
    };
  }

  async createAd(input: CreateAdInput) {
    const data = await this.call(
      "add_meta_ad",
      {
        ad_account_id: input.account_id,
        ad_set_id: input.ad_set_id,
        ad_type: input.ad_type ?? "image",
        primary_text: input.primary_text,
        landing_page_url: input.landing_page_url,
        headline: input.headline,
        image_url: input.image_url,
        existing_image_hash: input.existing_image_hash,
        video_url: input.video_url,
        existing_video_id: input.existing_video_id,
        thumbnail_url: input.thumbnail_url,
        name: input.name,
      },
      true,
    );
    const id =
      (typeof data.structured?.ad_id === "string"
        ? data.structured.ad_id
        : null) ??
      extractIdByLabel(data.text, /\bad[_\s-]?id\b/i) ??
      extractFirstId(data.text) ??
      `ad_${Date.now()}`;
    return {
      id,
      adset_id: input.ad_set_id,
      campaign_id: "unknown",
      account_id: input.account_id,
      name: input.name ?? id,
      status: "PAUSED" as const,
      creative_summary: input.headline ?? input.primary_text.slice(0, 80),
      raw_text: data.text,
    };
  }

  async pauseAd(accountId: string, adId: string): Promise<MetaAd> {
    await this.call(
      "update_meta_ad",
      { ad_account_id: accountId, ad_id: adId, status: "PAUSED" },
      true,
    );
    return {
      id: adId,
      adset_id: "unknown",
      campaign_id: "unknown",
      account_id: accountId,
      name: adId,
      status: "PAUSED",
    };
  }

  async listCustomAudiences(accountId: string): Promise<MetaCustomAudience[]> {
    const data = await this.call("list_meta_custom_audiences", {
      ad_account_id: accountId,
    });
    return parseCustomAudiences(data);
  }

  async searchTargeting(
    accountId: string,
    input: {
      search_type: MetaTargetingSearchType | string;
      query: string;
      limit?: number;
      country_code?: string;
    },
  ): Promise<MetaTargetingOption[]> {
    const data = await this.call("search_meta_targeting", {
      ad_account_id: accountId,
      search_type: input.search_type,
      query: input.query,
      limit: input.limit ?? 25,
      ...(input.country_code ? { country_code: input.country_code } : {}),
    });
    return parseTargetingOptions(data, input.search_type);
  }

  async browseTargeting(
    accountId: string,
    input: { category: string; limit?: number },
  ): Promise<MetaTargetingOption[]> {
    const data = await this.call("browse_meta_targeting", {
      ad_account_id: accountId,
      category: input.category,
      limit: input.limit ?? 50,
    });
    // Category names are plural ("behaviors"); option types are singular.
    return parseTargetingOptions(data, input.category.replace(/s$/, ""));
  }

  async optimizeBudget(
    accountId: string,
    options: Record<string, unknown> = {},
  ) {
    return this.call("optimize_meta_budget", {
      ad_account_id: accountId,
      lookback_days: 30,
      ...options,
    });
  }

  async optimizePlacements(
    accountId: string,
    options: Record<string, unknown> = {},
  ) {
    return this.call("optimize_meta_placements", {
      ad_account_id: accountId,
      lookback_days: 30,
      ...options,
    });
  }

  async detectCreativeFatigue(
    accountId: string,
    options: Record<string, unknown> = {},
  ) {
    return this.call("detect_meta_creative_fatigue", {
      ad_account_id: accountId,
      ...options,
    });
  }

  async getAdCreatives(
    accountId: string,
    options: {
      lookback_days?: number;
      campaign_id?: string;
      ad_set_id?: string;
      limit?: number;
    } = {},
  ) {
    const data = await this.call("get_meta_ad_creatives", {
      ad_account_id: accountId,
      lookback_days: options.lookback_days ?? 30,
      campaign_id: options.campaign_id,
      ad_set_id: options.ad_set_id,
      limit: options.limit ?? 20,
    });
    return parseAdCreatives(accountId, data);
  }
}

function looksLikeAccountId(value: string | null | undefined): boolean {
  if (!value) return true;
  const n = value.trim();
  return (
    !n ||
    /^act_\d+$/i.test(n) ||
    /^\d{8,}$/.test(n) ||
    n.toLowerCase() === "unknown"
  );
}

function normalizeMetaAccountId(raw: string): string | null {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  const digits = cleaned.replace(/^act_/i, "");
  if (!/^\d{5,}$/.test(digits)) return null;
  return `act_${digits}`;
}

function pickBetterName(current: string, candidate: string): string {
  const next = candidate?.trim() ?? "";
  if (!next) return current;
  if (looksLikeAccountId(current) && !looksLikeAccountId(next)) return next;
  if (!looksLikeAccountId(current) && looksLikeAccountId(next)) return current;
  return next || current;
}

function mergeConnectedAccounts(
  accounts: ConnectedAccount[],
): ConnectedAccount[] {
  const byId = new Map<string, ConnectedAccount>();
  for (const account of accounts) {
    const id = normalizeMetaAccountId(account.meta_account_id);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        ...account,
        meta_account_id: id,
        meta_account_name: looksLikeAccountId(account.meta_account_name)
          ? id
          : account.meta_account_name.trim(),
      });
      continue;
    }
    existing.meta_account_name = pickBetterName(
      existing.meta_account_name,
      account.meta_account_name,
    );
    existing.currency = account.currency ?? existing.currency;
    existing.timezone = account.timezone ?? existing.timezone;
    existing.business_id = account.business_id ?? existing.business_id;
    existing.status = account.status ?? existing.status;
  }
  return [...byId.values()];
}

function parseConnectedMetaAccounts(
  data: { text: string; structured?: Record<string, unknown> | null },
): ConnectedAccount[] {
  const fromStructured = extractAccountsDeep(data.structured);
  const fromText = extractAccountsFromText(data.text ?? "");
  // Also parse JSON blobs embedded in text responses.
  const jsonBlob = tryParseJsonObject(data.text ?? "");
  const fromEmbedded = extractAccountsDeep(jsonBlob);
  return mergeConnectedAccounts([
    ...fromStructured,
    ...fromEmbedded,
    ...fromText,
  ]);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return { accounts: parsed };
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractAccountsFromText(text: string): ConnectedAccount[] {
  const accounts: ConnectedAccount[] = [];

  const push = (rawId: string, name?: string) => {
    const id = normalizeMetaAccountId(rawId);
    if (!id) return;
    const existing = accounts.find((a) => a.meta_account_id === id);
    const resolvedName =
      name && !looksLikeAccountId(name) ? name.trim() : id;
    if (existing) {
      existing.meta_account_name = pickBetterName(
        existing.meta_account_name,
        resolvedName,
      );
    } else {
      accounts.push({
        meta_account_id: id,
        meta_account_name: resolvedName,
        status: "connected",
      });
    }
  };

  // ID-only mentions
  for (const match of text.matchAll(
    /(?:ad[_ ]?account(?:_id)?|account[_ ]?id|act_)["'=\s:]*?(act_\d+|\d{5,})/gi,
  )) {
    push(match[1]);
  }

  // - Name (ad_account_id="act_123")
  for (const match of text.matchAll(
    /[-*]\s*([^\n(]+?)\s*\((?:ad_account_id|account_id)=["']?(act_\d+|\d+)["']?\)/gi,
  )) {
    push(match[2], match[1]);
  }

  // Name\nID: 3946...   or   Name · ID: 3946...
  for (const match of text.matchAll(
    /([A-Za-z][^\n]{1,80}?)\s*(?:\n|\s+[·|]\s+|\s+)(?:ID|Ad Account ID|Account ID)\s*[:=]\s*(act_\d+|\d{5,})/gi,
  )) {
    push(match[2], match[1]);
  }

  // "account_name":"TR Internal Marketing" near an id in the same object-ish chunk
  for (const match of text.matchAll(
    /"(?:account_name|name|display_name|title|label)"\s*:\s*"([^"]+)"[\s\S]{0,120}?"(?:account_id|ad_account_id|id)"\s*:\s*"(act_\d+|\d{5,})"/gi,
  )) {
    push(match[2], match[1]);
  }
  for (const match of text.matchAll(
    /"(?:account_id|ad_account_id|id)"\s*:\s*"(act_\d+|\d{5,})"[\s\S]{0,120}?"(?:account_name|name|display_name|title|label)"\s*:\s*"([^"]+)"/gi,
  )) {
    push(match[1], match[2]);
  }

  return accounts;
}

function extractAccountsDeep(
  value: unknown,
  depth = 0,
): ConnectedAccount[] {
  if (value == null || depth > 6) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractAccountsDeep(item, depth + 1));
  }
  if (typeof value !== "object") return [];

  const row = value as Record<string, unknown>;
  const accounts: ConnectedAccount[] = [];

  const platform = String(
    row.platform ?? row.platform_name ?? row.provider ?? "",
  ).toLowerCase();
  const platformOk =
    !platform ||
    platform.includes("meta") ||
    platform.includes("facebook") ||
    platform === "fb";

  const rawId = String(
    row.account_id ??
      row.ad_account_id ??
      row.meta_account_id ??
      row.external_account_id ??
      row.adAccountId ??
      row.accountId ??
      (typeof row.id === "string" || typeof row.id === "number" ? row.id : ""),
  );
  const id = platformOk ? normalizeMetaAccountId(rawId) : null;
  if (id) {
    const name = String(
      row.account_name ??
        row.accountName ??
        row.display_name ??
        row.displayName ??
        row.name ??
        row.title ??
        row.label ??
        row.business_name ??
        id,
    );
    accounts.push({
      meta_account_id: id,
      meta_account_name: looksLikeAccountId(name) ? id : name.trim(),
      currency: typeof row.currency === "string" ? row.currency : undefined,
      timezone: typeof row.timezone === "string" ? row.timezone : undefined,
      business_id:
        typeof row.business_id === "string"
          ? row.business_id
          : typeof row.businessId === "string"
            ? row.businessId
            : undefined,
      status:
        typeof row.status === "string"
          ? row.status
          : typeof row.connection_status === "string"
            ? row.connection_status
            : "connected",
    });
  }

  for (const nested of Object.values(row)) {
    if (nested && typeof nested === "object") {
      accounts.push(...extractAccountsDeep(nested, depth + 1));
    }
  }
  return accounts;
}

function parseCampaigns(
  accountId: string,
  data: { text: string; structured?: Record<string, unknown> | null },
): MetaCampaign[] {
  const structured = data.structured;
  if (structured && Array.isArray(structured.campaigns)) {
    return (structured.campaigns as Record<string, unknown>[]).map((c, i) => ({
      id: String(c.id ?? c.campaign_id ?? `campaign_${i}`),
      account_id: accountId,
      name: String(c.name ?? "Campaign"),
      status: normalizeStatus(c.status),
      objective: String(c.objective ?? "UNKNOWN"),
      daily_budget_cents:
        typeof c.daily_budget_cents === "number"
          ? c.daily_budget_cents
          : typeof c.daily_budget === "number"
            ? Math.round(Number(c.daily_budget) * 100)
            : undefined,
    }));
  }
  return [];
}

function parseAdSets(
  accountId: string,
  campaignId: string | undefined,
  data: { text: string; structured?: Record<string, unknown> | null },
): MetaAdSet[] {
  const structured = data.structured;
  if (structured && Array.isArray(structured.adsets)) {
    return (structured.adsets as Record<string, unknown>[]).map((a, i) => ({
      id: String(a.id ?? a.adset_id ?? `adset_${i}`),
      campaign_id: String(a.campaign_id ?? campaignId ?? "unknown"),
      account_id: accountId,
      name: String(a.name ?? "Ad set"),
      status: normalizeStatus(a.status),
      daily_budget_cents:
        typeof a.daily_budget_cents === "number"
          ? a.daily_budget_cents
          : typeof a.daily_budget === "number"
            ? Math.round(Number(a.daily_budget) * 100)
            : 0,
    }));
  }
  return [];
}

function parseAds(
  accountId: string,
  adSetId: string | undefined,
  data: { text: string; structured?: Record<string, unknown> | null },
): MetaAd[] {
  const structured = data.structured;
  if (structured && Array.isArray(structured.ads)) {
    return (structured.ads as Record<string, unknown>[]).map((a, i) => ({
      id: String(a.id ?? a.ad_id ?? `ad_${i}`),
      adset_id: String(a.adset_id ?? adSetId ?? "unknown"),
      campaign_id: String(a.campaign_id ?? "unknown"),
      account_id: accountId,
      name: String(a.name ?? "Ad"),
      status: normalizeStatus(a.status),
      creative_summary:
        typeof a.creative_summary === "string" ? a.creative_summary : undefined,
    }));
  }
  return [];
}

function parseAdCreatives(
  _accountId: string,
  data: { text: string; structured?: Record<string, unknown> | null },
): MetaAdCreative[] {
  const rows = collectCreativeRows(data.structured);
  if (!rows.length) {
    const embedded = tryParseJsonObject(data.text ?? "");
    rows.push(...collectCreativeRows(embedded));
  }

  const creatives: MetaAdCreative[] = [];
  for (const [i, row] of rows.entries()) {
    const adId = String(row.ad_id ?? row.id ?? "").trim();
    if (!adId) continue;
    const num = (key: string) =>
      typeof row[key] === "number" ? (row[key] as number) : undefined;
    creatives.push({
      ad_id: adId,
      ad_name: optionalString(row.ad_name ?? row.name) ?? `Ad ${i + 1}`,
      campaign_id: optionalString(row.campaign_id) ?? undefined,
      adset_id: optionalString(row.adset_id ?? row.ad_set_id) ?? undefined,
      headline: optionalString(row.headline),
      primary_text: optionalString(row.primary_text ?? row.body),
      description: optionalString(row.description),
      call_to_action_type: optionalString(
        row.call_to_action_type ?? row.cta ?? row.call_to_action,
      ),
      landing_page_url: optionalString(
        row.landing_page_url ?? row.link_url ?? row.url,
      ),
      image_url: optionalString(row.image_url ?? row.thumbnail_url),
      creative_type: optionalString(row.creative_type),
      spend: num("spend"),
      impressions: num("impressions"),
      clicks: num("clicks"),
      ctr: num("ctr"),
      frequency: num("frequency"),
    });
  }
  return creatives;
}

function collectCreativeRows(
  structured: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] {
  if (!structured) return [];
  const candidates = [
    structured.ads,
    structured.creatives,
    structured.results,
    structured.data,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object",
      );
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (Array.isArray(nested.ads)) {
        return nested.ads.filter(
          (row): row is Record<string, unknown> =>
            Boolean(row) && typeof row === "object",
        );
      }
      if (Array.isArray(nested.creatives)) {
        return nested.creatives.filter(
          (row): row is Record<string, unknown> =>
            Boolean(row) && typeof row === "object",
        );
      }
    }
  }
  return [];
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseInsights(
  accountId: string,
  campaignId: string,
  dateStart: string,
  dateStop: string,
  data: { text: string; structured?: Record<string, unknown> | null },
): MetaInsights {
  const s = data.structured ?? {};
  const num = (key: string) =>
    typeof s[key] === "number" ? (s[key] as number) : 0;
  return {
    account_id: accountId,
    entity_id: campaignId,
    entity_type: "campaign",
    date_start: dateStart,
    date_stop: dateStop,
    spend: num("spend"),
    impressions: num("impressions"),
    clicks: num("clicks"),
    ctr: num("ctr"),
    cpc: num("cpc"),
    reach: num("reach") || undefined,
    frequency: num("frequency") || undefined,
    conversions: num("conversions") || undefined,
    cost_per_conversion: num("cost_per_conversion") || undefined,
    raw: { text: data.text, structured: data.structured },
  };
}

function normalizeStatus(
  value: unknown,
): "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED" {
  const s = String(value ?? "PAUSED").toUpperCase();
  if (s.includes("ACTIVE")) return "ACTIVE";
  if (s.includes("ARCHIVE")) return "ARCHIVED";
  if (s.includes("DELETE")) return "DELETED";
  return "PAUSED";
}

function extractBulletLines(text: string, filter?: RegExp): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]/.test(l) || /^\d+\./.test(l))
    .map((l) => l.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, ""));
  if (!filter) return lines;
  return lines.filter((l) => filter.test(l));
}

/** Drop undefined/null values so optional fields never reach the Adspirer API. */
function compactArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

function extractFirstId(text: string): string | null {
  const match = text.match(/\b(camp(?:aign)?_[a-zA-Z0-9]+|act_\d+|\d{5,})\b/);
  return match?.[1] ?? null;
}

function extractIdByLabel(text: string, label: RegExp): string | null {
  const lineMatch = text.match(
    new RegExp(`${label.source}[:\\s]+([A-Za-z0-9_]+)`, "i"),
  );
  if (lineMatch?.[1]) return lineMatch[1];
  return extractFirstId(text);
}
