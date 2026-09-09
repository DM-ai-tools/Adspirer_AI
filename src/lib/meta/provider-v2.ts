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
  UpdateAdSetBudgetInput,
} from "@/lib/adspirer/provider";
import { MetaGraphClient } from "@/lib/meta/graph-client";
import type {
  MetaCustomAudience,
  MetaTargetingOption,
} from "@/lib/adspirer/targeting";
import {
  buildMetaTargeting,
  buildPromotedObject,
  optimizationForObjective,
} from "@/lib/meta/targeting-builder";
import { resolvePromotePageId, formatMissingPageHelp } from "@/lib/meta/resolve-page";

function normalizeAccountId(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

/** Meta v25+ dropped `approximate_count`; use lower/upper bounds instead. */
function audienceApproximateCount(row: Record<string, unknown>): number | null {
  const lower =
    typeof row.approximate_count_lower_bound === "number"
      ? row.approximate_count_lower_bound
      : null;
  const upper =
    typeof row.approximate_count_upper_bound === "number"
      ? row.approximate_count_upper_bound
      : null;
  if (lower != null && lower >= 0) {
    if (upper != null && upper >= 0) {
      return Math.round((lower + upper) / 2);
    }
    return lower;
  }
  if (typeof row.approximate_count === "number" && row.approximate_count >= 0) {
    return row.approximate_count;
  }
  return null;
}

function budgetToMinorUnits(budgetDaily?: number): number | undefined {
  if (typeof budgetDaily !== "number" || !Number.isFinite(budgetDaily)) {
    return undefined;
  }
  return Math.round(budgetDaily * 100);
}

function mergeCampaignExtra(
  input: CreateImageCampaignInput | CreateVideoCampaignInput,
): Record<string, unknown> {
  return {
    ...(input.extra_args ?? {}),
    ...(input.publisher_platforms
      ? { publisher_platforms: input.publisher_platforms }
      : {}),
    ...(input.facebook_page_id
      ? { facebook_page_id: input.facebook_page_id }
      : {}),
    ...(input.pixel_id ? { pixel_id: input.pixel_id } : {}),
    ...(input.pixel_event_name
      ? { pixel_event_name: input.pixel_event_name }
      : {}),
  };
}

export class MetaGraphProviderV2 implements MetaAdsProvider {
  readonly name = "MetaGraphProviderV2";
  private readonly graph: MetaGraphClient;

  constructor(accessToken: string) {
    this.graph = new MetaGraphClient(accessToken);
  }

  private async resolveFacebookPageId(
    accountId: string,
    explicit?: string,
  ): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const pageId = await resolvePromotePageId(this.graph, accountId);
    if (pageId) return pageId;
    throw new Error(formatMissingPageHelp(accountId));
  }

  private async uploadVideoFromUrl(
    accountId: string,
    videoUrl: string,
  ): Promise<string> {
    const res = await this.graph.post<{ id: string }>(
      `${normalizeAccountId(accountId)}/advideos`,
      { file_url: videoUrl },
    );
    const id = String(res.id ?? "");
    if (!id) {
      throw new Error(
        "Meta did not return a video ID after uploading video_url. Check the URL is public HTTPS (MP4/MOV) and try again.",
      );
    }
    return id;
  }

  private rethrowStep(step: string, error: unknown): never {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    throw new Error(`${step}: ${message}`);
  }

  async listCampaigns(accountId: string): Promise<MetaCampaign[]> {
    const id = normalizeAccountId(accountId);
    const rows: Array<Record<string, unknown>> = [];
    let after: string | undefined;

    for (let page = 0; page < 20; page++) {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
        paging?: { cursors?: { after?: string } };
      }>(`${id}/campaigns`, {
        fields:
          "id,name,status,objective,daily_budget,lifetime_budget,updated_time,created_time",
        limit: 100,
        ...(after ? { after } : {}),
      });

      rows.push(...(data.data ?? []));
      after = data.paging?.cursors?.after;
      if (!after || !(data.data?.length)) break;
    }

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      account_id: id,
      name: String(row.name ?? "Campaign"),
      status: String(row.status ?? "PAUSED") as MetaCampaign["status"],
      objective: String(row.objective ?? "OUTCOME_TRAFFIC"),
      daily_budget_cents:
        row.daily_budget != null ? Number(row.daily_budget) : undefined,
      lifetime_budget_cents:
        row.lifetime_budget != null ? Number(row.lifetime_budget) : undefined,
      created_time:
        typeof row.created_time === "string" ? row.created_time : undefined,
      updated_time:
        typeof row.updated_time === "string" ? row.updated_time : undefined,
    }));
  }

  async getCampaignInsights(
    accountId: string,
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${campaignId}/insights`,
      {
        fields:
          "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        level: "campaign",
      },
    );
    const first = data.data?.[0] ?? {};
    return this.mapInsightsRow(accountId, campaignId, "campaign", dateStart, dateStop, first);
  }

  async getAccountInsights(
    accountId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const id = normalizeAccountId(accountId);
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${id}/insights`,
      {
        fields:
          "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        level: "account",
      },
    );
    const first = data.data?.[0] ?? {};
    return this.mapInsightsRow(id, id, "account", dateStart, dateStop, first);
  }

  private mapInsightsRow(
    accountId: string,
    entityId: string,
    entityType: MetaInsights["entity_type"],
    dateStart: string,
    dateStop: string,
    first: Record<string, unknown>,
  ): MetaInsights {
    const actions = Array.isArray(first.actions)
      ? (first.actions as Array<{ action_type?: string; value?: string }>)
      : [];
    const purchase =
      actions.find((a) => /purchase|omni_purchase/i.test(String(a.action_type))) ??
      actions.find((a) => /lead|complete_registration|offsite_conversion/i.test(String(a.action_type)));
    const conversions = purchase?.value != null ? Number(purchase.value) : undefined;
    const cpaRows = Array.isArray(first.cost_per_action_type)
      ? (first.cost_per_action_type as Array<{ action_type?: string; value?: string }>)
      : [];
    const cpaMatch = purchase
      ? cpaRows.find((r) => r.action_type === purchase.action_type)
      : undefined;

    return {
      account_id: normalizeAccountId(accountId),
      entity_id: entityId,
      entity_type: entityType,
      date_start: dateStart,
      date_stop: dateStop,
      spend: Number(first.spend ?? 0),
      impressions: Number(first.impressions ?? 0),
      clicks: Number(first.clicks ?? 0),
      ctr: Number(first.ctr ?? 0),
      cpc: Number(first.cpc ?? 0),
      reach: Number(first.reach ?? 0),
      frequency: Number(first.frequency ?? 0),
      conversions,
      cost_per_conversion:
        cpaMatch?.value != null ? Number(cpaMatch.value) : undefined,
      raw: first,
    };
  }

  async listAdSets(accountId: string, campaignId?: string): Promise<MetaAdSet[]> {
    const path = campaignId
      ? `${campaignId}/adsets`
      : `${normalizeAccountId(accountId)}/adsets`;
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      path,
      {
        fields:
          "id,name,status,campaign_id,daily_budget,optimization_goal,billing_event,targeting",
        limit: 100,
      },
    );
    return (data.data ?? []).map((row) => ({
      id: String(row.id ?? ""),
      campaign_id: String(row.campaign_id ?? campaignId ?? ""),
      account_id: normalizeAccountId(accountId),
      name: String(row.name ?? "Ad Set"),
      status: String(row.status ?? "PAUSED") as MetaAdSet["status"],
      daily_budget_cents: Number(row.daily_budget ?? 0),
      optimization_goal:
        typeof row.optimization_goal === "string"
          ? row.optimization_goal
          : undefined,
      billing_event:
        typeof row.billing_event === "string" ? row.billing_event : undefined,
      targeting_summary:
        row.targeting && typeof row.targeting === "object"
          ? JSON.stringify(row.targeting)
          : undefined,
    }));
  }

  async listAds(accountId: string, adSetId?: string): Promise<MetaAd[]> {
    const path = adSetId
      ? `${adSetId}/ads`
      : `${normalizeAccountId(accountId)}/ads`;
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      path,
      {
        fields: "id,name,status,adset_id,campaign_id,creative",
        limit: 100,
      },
    );
    return (data.data ?? []).map((row) => ({
      id: String(row.id ?? ""),
      adset_id: String(row.adset_id ?? adSetId ?? ""),
      campaign_id: String(row.campaign_id ?? ""),
      account_id: normalizeAccountId(accountId),
      name: String(row.name ?? "Ad"),
      status: String(row.status ?? "PAUSED") as MetaAd["status"],
      creative_summary: row.creative ? "Meta creative attached" : undefined,
    }));
  }

  async analyzeAccount(accountId: string) {
    const overview = await this.getAccountOverview(accountId);
    return {
      overview,
      findings: [
        `Account currency: ${overview.currency}`,
        `Total campaigns: ${overview.total_campaigns ?? overview.active_campaigns + overview.paused_campaigns}`,
        `Active campaigns: ${overview.active_campaigns}`,
        `Paused campaigns: ${overview.paused_campaigns}`,
      ],
      recommended_actions: [
        "Review CPA/ROAS thresholds before scaling",
        "Validate placements against creative format",
      ],
    };
  }

  async getAccountOverview(accountId: string) {
    const id = normalizeAccountId(accountId);
    const account = await this.graph.get<Record<string, unknown>>(id, {
      fields: "id,name,currency,timezone_name",
    });
    const campaigns = await this.listCampaigns(id).catch(() => []);
    const active = campaigns.filter((c) => c.status === "ACTIVE").length;
    const paused = campaigns.filter((c) => c.status === "PAUSED").length;
    const archived = campaigns.filter((c) => c.status === "ARCHIVED").length;
    return {
      account_id: id,
      account_name: String(account.name ?? id),
      currency: String(account.currency ?? "USD"),
      timezone: String(account.timezone_name ?? "UTC"),
      spend_7d: 0,
      spend_30d: 0,
      active_campaigns: active,
      paused_campaigns: paused,
      total_campaigns: campaigns.length,
      archived_campaigns: archived,
      health: "healthy" as const,
      notes: ["V2 direct Meta provider"],
    };
  }

  async updateAdSetBudget(input: UpdateAdSetBudgetInput): Promise<MetaAdSet> {
    await this.graph.post(`${input.adset_id}`, {
      daily_budget: String(input.daily_budget_cents),
    });
    const adsets = await this.listAdSets(input.account_id);
    return (
      adsets.find((a) => a.id === input.adset_id) ?? {
        id: input.adset_id,
        campaign_id: "",
        account_id: normalizeAccountId(input.account_id),
        name: input.adset_id,
        status: "PAUSED",
        daily_budget_cents: input.daily_budget_cents,
      }
    );
  }

  async pauseCampaign(accountId: string, campaignId: string): Promise<MetaCampaign> {
    await this.graph.post(campaignId, { status: "PAUSED" });
    const campaigns = await this.listCampaigns(accountId);
    return campaigns.find((c) => c.id === campaignId) ?? {
      id: campaignId,
      account_id: normalizeAccountId(accountId),
      name: campaignId,
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
    };
  }

  async resumeCampaign(
    accountId: string,
    campaignId: string,
  ): Promise<MetaCampaign> {
    await this.graph.post(campaignId, { status: "ACTIVE" });
    const campaigns = await this.listCampaigns(accountId);
    return campaigns.find((c) => c.id === campaignId) ?? {
      id: campaignId,
      account_id: normalizeAccountId(accountId),
      name: campaignId,
      status: "ACTIVE",
      objective: "OUTCOME_TRAFFIC",
    };
  }

  async createCampaign(input: CreateCampaignInput): Promise<MetaCampaign> {
    const accountId = normalizeAccountId(input.account_id);
    const hasCampaignBudget = typeof input.daily_budget_cents === "number";
    const body: Record<string, string | boolean> = {
      name: input.name,
      objective: input.objective,
      status: input.status ?? "PAUSED",
      special_ad_categories: JSON.stringify(input.special_ad_categories ?? []),
    };
    if (hasCampaignBudget) {
      body.daily_budget = String(input.daily_budget_cents);
    } else {
      // Meta Marketing API v24+: required when budget lives on ad sets (not CBO).
      body.is_adset_budget_sharing_enabled =
        input.is_adset_budget_sharing_enabled ?? false;
    }
    const res = await this.graph.post<{ id: string }>(
      `${accountId}/campaigns`,
      body,
    );
    return {
      id: String(res.id),
      account_id: accountId,
      name: input.name,
      status: (input.status ?? "PAUSED") as MetaCampaign["status"],
      objective: input.objective,
      daily_budget_cents: input.daily_budget_cents,
    };
  }

  async createImageCampaign(input: CreateImageCampaignInput) {
    const extra = mergeCampaignExtra(input);
    const useCbo = Boolean(input.campaign_budget_optimization);
    const facebookPageId = await this.resolveFacebookPageId(
      input.account_id,
      input.facebook_page_id,
    );
    let campaign;
    try {
      campaign = await this.createCampaign({
        account_id: input.account_id,
        name: input.campaign_name,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        status: "PAUSED",
        daily_budget_cents: useCbo
          ? budgetToMinorUnits(input.budget_daily)
          : undefined,
        special_ad_categories: input.special_ad_categories,
      });
    } catch (error) {
      this.rethrowStep("Create campaign", error);
    }
    let adset;
    try {
      adset = await this.createAdSet({
        account_id: input.account_id,
        campaign_id: campaign.id,
        name: input.ad_set_name ?? `${input.campaign_name} - Ad Set`,
        budget_daily: useCbo ? undefined : input.budget_daily,
        ad_type: "image",
        landing_page_url: input.landing_page_url,
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        image_url: input.image_url,
        age_min: input.age_min,
        age_max: input.age_max,
        genders: input.genders,
        locations: input.locations,
        publisher_platforms: input.publisher_platforms,
        objective: input.objective,
        facebook_page_id: facebookPageId,
        pixel_id: input.pixel_id,
        pixel_event_name: input.pixel_event_name,
        campaign_budget_optimization: useCbo,
        extra_args: extra,
      });
    } catch (error) {
      this.rethrowStep("Create ad set", error);
    }
    let ad;
    try {
      ad = await this.createAd({
        account_id: input.account_id,
        ad_set_id: adset.id,
        ad_type: "image",
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        landing_page_url: input.landing_page_url,
        display_link: input.display_link,
        url_tags: input.url_tags,
        image_url: input.image_url,
        existing_image_hash: input.existing_image_hash,
        facebook_page_id: facebookPageId,
        instagram_account_id: input.instagram_account_id,
        name: input.ad_name ?? `${input.campaign_name} - Ad`,
      });
    } catch (error) {
      this.rethrowStep("Create ad", error);
    }
    return { campaign, adset, ad, raw_text: "Created with Meta Graph API" };
  }

  async createVideoCampaign(input: CreateVideoCampaignInput) {
    const extra = mergeCampaignExtra(input);
    const useCbo = Boolean(input.campaign_budget_optimization);
    const facebookPageId = await this.resolveFacebookPageId(
      input.account_id,
      input.facebook_page_id,
    );
    let existingVideoId = input.existing_video_id;
    if (!existingVideoId && input.video_url) {
      try {
        existingVideoId = await this.uploadVideoFromUrl(
          input.account_id,
          input.video_url,
        );
      } catch (error) {
        this.rethrowStep("Upload video", error);
      }
    }
    let campaign;
    try {
      campaign = await this.createCampaign({
        account_id: input.account_id,
        name: input.campaign_name,
        objective: input.objective ?? "OUTCOME_TRAFFIC",
        status: "PAUSED",
        daily_budget_cents: useCbo
          ? budgetToMinorUnits(input.budget_daily)
          : undefined,
        special_ad_categories: input.special_ad_categories,
      });
    } catch (error) {
      this.rethrowStep("Create campaign", error);
    }
    let adset;
    try {
      adset = await this.createAdSet({
        account_id: input.account_id,
        campaign_id: campaign.id,
        name: input.ad_set_name ?? `${input.campaign_name} - Ad Set`,
        budget_daily: useCbo ? undefined : input.budget_daily,
        ad_type: "video",
        landing_page_url: input.landing_page_url,
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        video_url: input.video_url,
        existing_video_id: existingVideoId,
        thumbnail_url: input.thumbnail_url,
        age_min: input.age_min,
        age_max: input.age_max,
        genders: input.genders,
        locations: input.locations,
        publisher_platforms: input.publisher_platforms,
        objective: input.objective,
        facebook_page_id: facebookPageId,
        pixel_id: input.pixel_id,
        pixel_event_name: input.pixel_event_name,
        campaign_budget_optimization: useCbo,
        extra_args: extra,
      });
    } catch (error) {
      this.rethrowStep("Create ad set", error);
    }
    let ad;
    try {
      ad = await this.createAd({
        account_id: input.account_id,
        ad_set_id: adset.id,
        ad_type: "video",
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: input.call_to_action,
        landing_page_url: input.landing_page_url,
        display_link: input.display_link,
        url_tags: input.url_tags,
        video_url: input.video_url,
        existing_video_id: existingVideoId,
        thumbnail_url: input.thumbnail_url,
        facebook_page_id: facebookPageId,
        instagram_account_id: input.instagram_account_id,
        name: input.ad_name ?? `${input.campaign_name} - Video Ad`,
      });
    } catch (error) {
      this.rethrowStep("Create ad", error);
    }
    return { campaign, adset, ad, raw_text: "Created with Meta Graph API" };
  }

  async createAdSet(input: CreateAdSetInput): Promise<MetaAdSet & { raw_text?: string }> {
    const accountId = normalizeAccountId(input.account_id);
    const { optimization_goal, billing_event } = optimizationForObjective(
      input.objective,
      {
        pixel_id: input.pixel_id,
        extra_args: input.extra_args,
      },
    );
    const targeting = buildMetaTargeting({
      age_min: input.age_min,
      age_max: input.age_max,
      genders: input.genders,
      locations: input.locations,
      publisher_platforms: input.publisher_platforms,
      extra_args: input.extra_args,
    });
    const promoted = buildPromotedObject({
      objective: input.objective,
      facebook_page_id: input.facebook_page_id,
      pixel_id: input.pixel_id,
      pixel_event_name: input.pixel_event_name,
      extra_args: input.extra_args,
    });

    const body: Record<string, string | number | boolean | null | undefined> = {
      name: input.name ?? "Ad Set",
      campaign_id: input.campaign_id,
      status: "PAUSED",
      billing_event,
      optimization_goal,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: JSON.stringify(targeting),
    };

    if (!input.campaign_budget_optimization) {
      const budget = input.budget_daily;
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
        throw new Error(
          "Missing daily ad set budget — set budget_daily or daily_budget (e.g. 5 for £5/day) in the approval args.",
        );
      }
      body.daily_budget = String(Math.round(budget * 100));
    }
    if (promoted) {
      body.promoted_object = JSON.stringify(promoted);
    }

    const res = await this.graph.post<{ id: string }>(`${accountId}/adsets`, body);
    return {
      id: String(res.id),
      campaign_id: input.campaign_id,
      account_id: accountId,
      name: input.name ?? "Ad Set",
      status: "PAUSED",
      daily_budget_cents: Math.round((input.budget_daily ?? 0) * 100),
      optimization_goal,
      billing_event,
      targeting_summary: JSON.stringify(targeting),
      raw_text: "Ad set created with Meta Graph API",
    };
  }

  async createAd(input: CreateAdInput): Promise<MetaAd & { raw_text?: string }> {
    const accountId = normalizeAccountId(input.account_id);
    let pageId: string;
    try {
      pageId = await this.resolveFacebookPageId(
        input.account_id,
        input.facebook_page_id,
      );
    } catch (error) {
      this.rethrowStep("Resolve Facebook page", error);
    }

    const isVideo =
      input.ad_type === "video" || input.video_url || input.existing_video_id;
    let videoId = input.existing_video_id;
    if (isVideo && !videoId && input.video_url) {
      try {
        videoId = await this.uploadVideoFromUrl(
          input.account_id,
          input.video_url,
        );
      } catch (error) {
        this.rethrowStep("Upload video", error);
      }
    }
    if (isVideo && !videoId) {
      throw new Error(
        "Video ad requires existing_video_id or a public video_url Meta can fetch.",
      );
    }

    const ctaType = input.call_to_action ?? "LEARN_MORE";
    const linkData: Record<string, unknown> = {
      link: input.landing_page_url,
      message: input.primary_text,
      ...(input.headline ? { name: input.headline } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.display_link ? { caption: input.display_link } : {}),
      ...(input.image_url ? { image_url: input.image_url } : {}),
      ...(input.existing_image_hash
        ? { image_hash: input.existing_image_hash }
        : {}),
      call_to_action: {
        type: ctaType,
        value: { link: input.landing_page_url },
      },
    };

    const storySpec: Record<string, unknown> = {
      page_id: pageId,
      ...(input.instagram_account_id
        ? { instagram_actor_id: input.instagram_account_id }
        : {}),
    };

    if (isVideo) {
      storySpec.video_data = {
        video_id: videoId,
        message: input.primary_text,
        title: input.headline,
        link_description: input.description,
        ...(input.thumbnail_url ? { image_url: input.thumbnail_url } : {}),
        call_to_action: {
          type: ctaType,
          value: { link: input.landing_page_url },
        },
      };
    } else {
      storySpec.link_data = linkData;
    }

    const creativeBody: Record<string, string | number | boolean | null | undefined> = {
      name: input.name ?? "Creative",
      object_story_spec: JSON.stringify(storySpec),
    };
    if (input.url_tags) {
      creativeBody.url_tags = input.url_tags;
    }

    let creative: { id: string };
    try {
      creative = await this.graph.post<{ id: string }>(
        `${accountId}/adcreatives`,
        creativeBody,
      );
    } catch (error) {
      this.rethrowStep("Create ad creative", error);
    }

    let ad: { id: string };
    try {
      ad = await this.graph.post<{ id: string }>(`${accountId}/ads`, {
        name: input.name ?? "Ad",
        adset_id: input.ad_set_id,
        status: "PAUSED",
        creative: JSON.stringify({ creative_id: creative.id }),
      });
    } catch (error) {
      this.rethrowStep("Create ad", error);
    }
    return {
      id: String(ad.id),
      adset_id: input.ad_set_id,
      campaign_id: "unknown",
      account_id: accountId,
      name: input.name ?? "Ad",
      status: "PAUSED",
      creative_summary: input.display_link
        ? `Display: ${input.display_link}`
        : input.landing_page_url,
      raw_text: "Ad created with Meta Graph API",
    };
  }

  async pauseAd(accountId: string, adId: string): Promise<MetaAd> {
    await this.graph.post(adId, { status: "PAUSED" });
    return {
      id: adId,
      adset_id: "unknown",
      campaign_id: "unknown",
      account_id: normalizeAccountId(accountId),
      name: adId,
      status: "PAUSED",
    };
  }

  async listCustomAudiences(accountId: string): Promise<MetaCustomAudience[]> {
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${normalizeAccountId(accountId)}/customaudiences`,
      {
        fields:
          "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status",
        limit: 100,
      },
    );
    return (data.data ?? [])
      .map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        subtype: typeof row.subtype === "string" ? row.subtype : null,
        approximate_count: audienceApproximateCount(row),
        delivery_status:
          typeof row.delivery_status === "string" ? row.delivery_status : null,
      }))
      .filter((a) => a.id && a.name);
  }

  async searchTargeting(
    _accountId: string,
    input: {
      search_type: string;
      query: string;
      limit?: number;
      country_code?: string;
    },
  ): Promise<MetaTargetingOption[]> {
    const type = input.search_type.toLowerCase();
    const isLocation = type === "location";
    const params: Record<string, string | number | boolean | null | undefined> = {
      type: isLocation ? "adgeolocation" : "adinterest",
      q: input.query,
      limit: input.limit ?? 25,
    };
    if (isLocation) {
      params.location_types = JSON.stringify([
        "country",
        "region",
        "city",
        "zip",
      ]);
      if (input.country_code) params.country_code = input.country_code;
    } else if (type === "behavior") {
      params.type = "adTargetingCategory";
      params.class = "behaviors";
    } else if (type === "demographic" || type === "life_event") {
      params.type = "adTargetingCategory";
      params.class = type === "life_event" ? "life_events" : "demographics";
    } else if (type === "interest") {
      params.type = "adinterest";
    }

    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      "search",
      params,
    );
    return (data.data ?? [])
      .map((row) => {
        const key = String(row.key ?? row.id ?? "");
        const locType =
          typeof row.type === "string"
            ? row.type
            : typeof row.location_type === "string"
              ? row.location_type
              : input.search_type;
        return {
          id: key,
          name: String(row.name ?? ""),
          type: isLocation ? locType : input.search_type,
          audience_size:
            typeof row.audience_size === "number"
              ? row.audience_size
              : Array.isArray(row.audience_size_lower_bound)
                ? Number(row.audience_size_lower_bound[0] ?? 0) || null
                : null,
          path: Array.isArray(row.path)
            ? (row.path as string[]).join(" > ")
            : typeof row.path === "string"
              ? row.path
              : null,
          country_code:
            typeof row.country_code === "string" ? row.country_code : null,
          key,
        };
      })
      .filter((o) => o.id && o.name);
  }

  async browseTargeting(
    accountId: string,
    input: { category: string; limit?: number },
  ): Promise<MetaTargetingOption[]> {
    const category = input.category.replace(/s$/, "");
    // Meta browse via targetingcategory — fall back to a seed search
    return this.searchTargeting(accountId, {
      search_type: category === "interest" ? "interest" : category,
      query: category === "behavior" ? "shopping" : "business",
      limit: input.limit ?? 50,
    });
  }

  async optimizeBudget(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    return {
      text: `V2 recommendation for ${normalizeAccountId(accountId)}: rebalance daily budgets toward ad sets with lower CPA and stable frequency.`,
      structured: { accountId, options },
    };
  }

  async optimizePlacements(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    return {
      text: `V2 recommendation for ${normalizeAccountId(accountId)}: keep Advantage+ placements and trim low-performing right-column placements first.`,
      structured: { accountId, options },
    };
  }

  async detectCreativeFatigue(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    return {
      text: `V2 fatigue scan for ${normalizeAccountId(accountId)}: rotate ads where frequency rises and CTR declines.`,
      structured: { accountId, options },
    };
  }

  async getAdCreatives(
    accountId: string,
    options: {
      lookback_days?: number;
      campaign_id?: string;
      ad_set_id?: string;
      limit?: number;
    } = {},
  ): Promise<MetaAdCreative[]> {
    void options;
    const ads = await this.listAds(accountId);
    return ads.map((ad) => ({
      ad_id: ad.id,
      ad_name: ad.name,
      campaign_id: ad.campaign_id,
      adset_id: ad.adset_id,
      headline: ad.creative_summary ?? null,
      primary_text: null,
      landing_page_url: null,
      creative_type: "unknown",
    }));
  }

  async listAccessibleAccounts() {
    const fields = "id,name,currency,timezone_name,business";
    const byId = new Map<
      string,
      {
        meta_account_id: string;
        meta_account_name: string;
        currency?: string;
        timezone?: string;
        business_id?: string;
      }
    >();

    const addRow = (row: Record<string, unknown>) => {
      const rawId = String(row.id ?? "").trim();
      if (!rawId || rawId === "me") return;
      const meta_account_id = rawId.startsWith("act_")
        ? rawId
        : `act_${rawId.replace(/^act_/, "")}`;
      if (byId.has(meta_account_id)) return;
      byId.set(meta_account_id, {
        meta_account_id,
        meta_account_name: String(row.name ?? meta_account_id),
        currency: typeof row.currency === "string" ? row.currency : undefined,
        timezone:
          typeof row.timezone_name === "string" ? row.timezone_name : undefined,
        business_id:
          row.business && typeof row.business === "object"
            ? String((row.business as { id?: unknown }).id ?? "") || undefined
            : undefined,
      });
    };

    const addFromEdge = async (path: string) => {
      let after: string | undefined;
      do {
        const res = await this.graph.get<{
          data?: Array<Record<string, unknown>>;
          paging?: { cursors?: { after?: string } };
        }>(path, {
          fields,
          limit: 100,
          ...(after ? { after } : {}),
        });
        for (const row of res.data ?? []) addRow(row);
        after = res.paging?.cursors?.after;
      } while (after);
    };

    try {
      await addFromEdge("me/adaccounts");
    } catch {
      // User may only have business-scoped access for some accounts.
    }

    try {
      const businesses = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
      }>("me/businesses", { fields: "id,name", limit: 50 });
      for (const biz of businesses.data ?? []) {
        const businessId = String(biz.id ?? "").trim();
        if (!businessId) continue;
        for (const edge of ["owned_ad_accounts", "client_ad_accounts"] as const) {
          try {
            await addFromEdge(`${businessId}/${edge}`);
          } catch {
            // Skip businesses the token cannot read.
          }
        }
      }
    } catch {
      // business_management may be missing on older tokens until reconnect.
    }

    return Array.from(byId.values());
  }
}

