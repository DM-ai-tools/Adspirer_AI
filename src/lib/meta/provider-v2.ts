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
import { logger } from "@/lib/observability/logger";
import { centsToMetaMinor, metaMinorToCents } from "@/lib/meta/currency";

export {
  centsToMetaMinor,
  metaCurrencyOffset,
  metaMinorToCents,
} from "@/lib/meta/currency";

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

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function budgetToMinorUnits(budgetDaily?: number): number | undefined {
  if (typeof budgetDaily !== "number" || !Number.isFinite(budgetDaily)) {
    return undefined;
  }
  return Math.round(budgetDaily * 100);
}

function lookbackWindow(days: number): { dateStart: string; dateStop: string } {
  const stop = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - Math.max(1, days));
  return {
    dateStart: start.toISOString().slice(0, 10),
    dateStop: stop.toISOString().slice(0, 10),
  };
}

function extractConversionMetrics(row: Record<string, unknown>): {
  conversions: number;
  cpa: number | null;
} {
  const actions = Array.isArray(row.actions)
    ? (row.actions as Array<{ action_type?: string; value?: string }>)
    : [];
  const purchase =
    actions.find((a) =>
      /purchase|omni_purchase/i.test(String(a.action_type ?? "")),
    ) ??
    actions.find((a) =>
      /lead|complete_registration|offsite_conversion/i.test(
        String(a.action_type ?? ""),
      ),
    );
  const conversions =
    purchase?.value != null ? Number(purchase.value) : 0;
  const cpaRows = Array.isArray(row.cost_per_action_type)
    ? (row.cost_per_action_type as Array<{
        action_type?: string;
        value?: string;
      }>)
    : [];
  const cpaMatch = purchase
    ? cpaRows.find((r) => r.action_type === purchase.action_type)
    : undefined;
  const cpa =
    cpaMatch?.value != null
      ? Number(cpaMatch.value)
      : conversions > 0 && Number(row.spend ?? 0) > 0
        ? Number(row.spend) / conversions
        : null;
  return {
    conversions: Number.isFinite(conversions) ? conversions : 0,
    cpa: cpa != null && Number.isFinite(cpa) ? cpa : null,
  };
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

  /** Per-request caches: a provider instance lives for one API call / turn. */
  private readonly currencyByAccount = new Map<string, Promise<string>>();
  private readonly campaignsByAccount = new Map<string, Promise<MetaCampaign[]>>();

  constructor(accessToken: string) {
    this.graph = new MetaGraphClient(accessToken);
  }

  /** Account currency (cached); budgets are converted with its offset. */
  async accountCurrency(accountId: string): Promise<string> {
    const id = normalizeAccountId(accountId);
    let pending = this.currencyByAccount.get(id);
    if (!pending) {
      pending = this.graph
        .get<{ currency?: string }>(id, { fields: "currency" })
        .then((row) => String(row.currency ?? "USD"))
        .catch(() => "USD");
      this.currencyByAccount.set(id, pending);
    }
    return pending;
  }

  private invalidateCampaigns(accountId: string): void {
    this.campaignsByAccount.delete(normalizeAccountId(accountId));
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
    // The overview and the audit both list campaigns; share one fetch.
    let pending = this.campaignsByAccount.get(id);
    if (!pending) {
      pending = this.fetchCampaigns(id);
      this.campaignsByAccount.set(id, pending);
      pending.catch(() => this.campaignsByAccount.delete(id));
    }
    return pending;
  }

  private async fetchCampaigns(id: string): Promise<MetaCampaign[]> {
    const currencyPromise = this.accountCurrency(id);
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

    const currency = await currencyPromise;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      account_id: id,
      name: String(row.name ?? "Campaign"),
      status: String(row.status ?? "PAUSED") as MetaCampaign["status"],
      objective: String(row.objective ?? "OUTCOME_TRAFFIC"),
      daily_budget_cents:
        row.daily_budget != null
          ? metaMinorToCents(Number(row.daily_budget), currency)
          : undefined,
      lifetime_budget_cents:
        row.lifetime_budget != null
          ? metaMinorToCents(Number(row.lifetime_budget), currency)
          : undefined,
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
    const currencyPromise = this.accountCurrency(accountId);
    // Follow paging — accounts with >100 ad sets were silently truncated.
    const rows: Array<Record<string, unknown>> = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(path, {
        fields:
          "id,name,status,campaign_id,daily_budget,optimization_goal,billing_event,targeting",
        limit: 100,
        ...(after ? { after } : {}),
      });
      rows.push(...(data.data ?? []));
      after = data.paging?.next ? data.paging?.cursors?.after : undefined;
      if (!after) break;
    }
    const currency = await currencyPromise;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      campaign_id: String(row.campaign_id ?? campaignId ?? ""),
      account_id: normalizeAccountId(accountId),
      name: String(row.name ?? "Ad Set"),
      status: String(row.status ?? "PAUSED") as MetaAdSet["status"],
      daily_budget_cents: metaMinorToCents(Number(row.daily_budget ?? 0), currency),
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
    const currency = await this.accountCurrency(input.account_id);
    await this.graph.post(`${input.adset_id}`, {
      daily_budget: String(centsToMetaMinor(input.daily_budget_cents, currency)),
    });
    // The change has already succeeded on Meta; a failed re-read must not
    // turn it into a reported failure (and a duplicate on retry).
    const adsets = await this.listAdSets(input.account_id).catch(
      () => [] as MetaAdSet[],
    );
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
    this.invalidateCampaigns(accountId);
    const campaigns = await this.listCampaigns(accountId).catch(
      () => [] as MetaCampaign[],
    );
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
    this.invalidateCampaigns(accountId);
    const campaigns = await this.listCampaigns(accountId).catch(
      () => [] as MetaCampaign[],
    );
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
      const currency = await this.accountCurrency(accountId);
      body.daily_budget = String(
        centsToMetaMinor(input.daily_budget_cents!, currency),
      );
    } else {
      // Meta Marketing API v24+: required when budget lives on ad sets (not CBO).
      body.is_adset_budget_sharing_enabled =
        input.is_adset_budget_sharing_enabled ?? false;
    }
    const res = await this.graph.post<{ id: string }>(
      `${accountId}/campaigns`,
      body,
    );
    this.invalidateCampaigns(accountId);
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
      const currency = await this.accountCurrency(accountId);
      body.daily_budget = String(
        centsToMetaMinor(Math.round(budget * 100), currency),
      );
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
    const id = normalizeAccountId(accountId);
    const lookbackDays = Math.min(
      90,
      Math.max(3, Number(options.lookback_days ?? 7) || 7),
    );
    const { dateStart, dateStop } = lookbackWindow(lookbackDays);
    const [adsets, currency] = await Promise.all([
      this.listAdSets(id),
      this.accountCurrency(id),
    ]);
    const money = (cents: number) => formatMoney(cents, currency);
    let insightsError: string | null = null;
    const budgeted = adsets.filter((a) => a.daily_budget_cents > 0);
    const pool =
      budgeted.filter((a) => a.status === "ACTIVE").length > 0
        ? budgeted.filter((a) => a.status === "ACTIVE")
        : budgeted;

    type Ranked = {
      adset_id: string;
      name: string;
      status: string;
      daily_budget_cents: number;
      spend: number;
      clicks: number;
      ctr: number;
      conversions: number;
      cpa: number | null;
      score: number;
    };

    const byId = new Map<string, Ranked>();
    for (const a of pool) {
      byId.set(a.id, {
        adset_id: a.id,
        name: a.name,
        status: a.status,
        daily_budget_cents: a.daily_budget_cents,
        spend: 0,
        clicks: 0,
        ctr: 0,
        conversions: 0,
        cpa: null,
        score: 0,
      });
    }

    try {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
      }>(`${id}/insights`, {
        fields:
          "adset_id,adset_name,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type,frequency",
        level: "adset",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        limit: 100,
      });
      for (const row of data.data ?? []) {
        const adsetId = String(row.adset_id ?? "");
        if (!adsetId) continue;
        const existing =
          byId.get(adsetId) ??
          ({
            adset_id: adsetId,
            name: String(row.adset_name ?? adsetId),
            status: "UNKNOWN",
            daily_budget_cents:
              pool.find((a) => a.id === adsetId)?.daily_budget_cents ?? 0,
            spend: 0,
            clicks: 0,
            ctr: 0,
            conversions: 0,
            cpa: null,
            score: 0,
          } satisfies Ranked);
        const spend = Number(row.spend ?? 0);
        const clicks = Number(row.clicks ?? 0);
        const ctr = Number(row.ctr ?? 0);
        const { conversions, cpa } = extractConversionMetrics(row);
        existing.spend = spend;
        existing.clicks = clicks;
        existing.ctr = ctr;
        existing.conversions = conversions;
        existing.cpa = cpa;
        if (!byId.has(adsetId) && existing.daily_budget_cents > 0) {
          byId.set(adsetId, existing);
        } else if (byId.has(adsetId)) {
          byId.set(adsetId, existing);
        }
      }
    } catch (error) {
      // Without performance data we can still show budgets, but must not
      // recommend moving money (that would be a guess dressed up as analysis).
      insightsError = error instanceof Error ? error.message : String(error);
    }

    const ranked = [...byId.values()].map((row) => {
      let score = row.ctr;
      if (row.conversions > 0 && row.cpa != null && row.cpa > 0) {
        score = 1_000_000 / row.cpa + row.conversions * 10;
      } else if (row.spend > 0 && row.conversions === 0) {
        score = row.ctr - Math.min(50, row.spend);
      }
      return { ...row, score };
    });
    ranked.sort((a, b) => b.score - a.score);

    const proposals: Array<{
      tool: string;
      args: Record<string, unknown>;
      rationale: string;
    }> = [];
    const lines: string[] = [
      `### Budget optimize (${id}) · ${dateStart} → ${dateStop}`,
    ];

    if (insightsError) {
      lines.push(
        `- Performance data could not be loaded (${insightsError}). No budget changes are proposed until it can be read — try again shortly.`,
      );
      return {
        text: lines.join("\n"),
        structured: {
          accountId: id,
          lookback_days: lookbackDays,
          proposals: [],
          insights_error: insightsError,
        },
      };
    }

    if (!ranked.length) {
      lines.push("- No ad sets with a daily budget found to rebalance.");
      return {
        text: lines.join("\n"),
        structured: { accountId: id, lookback_days: lookbackDays, proposals: [] },
      };
    }

    const withSpend = ranked.filter((r) => r.spend > 0);
    const winners = (withSpend.length ? withSpend : ranked).slice(0, 2);
    const losers = [...(withSpend.length ? withSpend : ranked)]
      .reverse()
      .filter((r) => !winners.some((w) => w.adset_id === r.adset_id))
      .slice(0, 2);

    for (const w of winners) {
      if (w.daily_budget_cents <= 0) continue;
      const next = Math.max(
        w.daily_budget_cents + 100,
        Math.round(w.daily_budget_cents * 1.2),
      );
      if (next === w.daily_budget_cents) continue;
      const rationale = w.conversions
        ? `Scale ${w.name}: ${w.conversions} conv · CPA ${
            w.cpa != null ? money(Math.round(w.cpa * 100)) : "n/a"
          } · +20% daily budget.`
        : `Scale ${w.name}: stronger relative CTR/delivery · +20% daily budget.`;
      proposals.push({
        tool: "update_adset_budget",
        args: {
          account_id: id,
          adset_id: w.adset_id,
          daily_budget_cents: next,
          previous_daily_budget_cents: w.daily_budget_cents,
        },
        rationale,
      });
      lines.push(
        `- SCALE ${w.name} (${w.adset_id}): ${money(w.daily_budget_cents)} → ${money(next)}/day`,
      );
    }

    for (const l of losers) {
      if (l.daily_budget_cents <= 0) continue;
      const wasted =
        l.spend >= Math.max(10, l.daily_budget_cents / 100) &&
        l.conversions === 0;
      if (wasted && l.daily_budget_cents >= 500) {
        const next = Math.max(
          100,
          Math.round(l.daily_budget_cents * 0.8),
        );
        if (next >= l.daily_budget_cents) continue;
        const rationale = `Trim ${l.name}: ${money(Math.round(l.spend * 100))} spend with 0 conversions in window · −20% daily budget.`;
        proposals.push({
          tool: "update_adset_budget",
          args: {
            account_id: id,
            adset_id: l.adset_id,
            daily_budget_cents: next,
            previous_daily_budget_cents: l.daily_budget_cents,
          },
          rationale,
        });
        lines.push(
          `- TRIM ${l.name} (${l.adset_id}): ${money(l.daily_budget_cents)} → ${money(next)}/day`,
        );
      }
    }

    if (!proposals.length) {
      // Always surface at least one concrete mutate when budgets exist.
      const primary = winners[0] ?? ranked[0];
      if (primary?.daily_budget_cents > 0) {
        const next = Math.max(
          primary.daily_budget_cents + 100,
          Math.round(primary.daily_budget_cents * 1.15),
        );
        proposals.push({
          tool: "update_adset_budget",
          args: {
            account_id: id,
            adset_id: primary.adset_id,
            daily_budget_cents: next,
            previous_daily_budget_cents: primary.daily_budget_cents,
          },
          rationale: `Rebalance toward ${primary.name} (+15% daily budget) pending operator approval.`,
        });
        lines.push(
          `- PROPOSE ${primary.name} (${primary.adset_id}): ${money(primary.daily_budget_cents)} → ${money(next)}/day`,
        );
      }
    }

    lines.push(
      "",
      "These are proposals only. Queue `update_adset_budget` execute tools for Approvals — Meta is not changed until approved.",
    );

    return {
      text: lines.join("\n"),
      structured: {
        accountId: id,
        lookback_days: lookbackDays,
        date_start: dateStart,
        date_stop: dateStop,
        rankings: ranked.slice(0, 20),
        proposals,
      },
    };
  }

  async optimizePlacements(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    const id = normalizeAccountId(accountId);
    void options;
    return {
      text: [
        `### Placement optimize (${id})`,
        "- Prefer Feed + Reels / Stories; review Audience Network and right-hand column if CTR is weak.",
        "- Placement edits are advisory in V2 until a dedicated placement execute tool is queued; budget/pause changes cover most immediate wins.",
      ].join("\n"),
      structured: { accountId: id, proposals: [] },
    };
  }

  async detectCreativeFatigue(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    const id = normalizeAccountId(accountId);
    const lookbackDays = Math.min(
      90,
      Math.max(3, Number(options.lookback_days ?? 14) || 14),
    );
    const { dateStart, dateStop } = lookbackWindow(lookbackDays);
    const ads = await this.listAds(id);
    const activeAds = ads.filter((a) => a.status === "ACTIVE");

    const proposals: Array<{
      tool: string;
      args: Record<string, unknown>;
      rationale: string;
    }> = [];
    const lines: string[] = [
      `### Creative fatigue (${id}) · ${dateStart} → ${dateStop}`,
    ];

    try {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
      }>(`${id}/insights`, {
        fields:
          "ad_id,ad_name,spend,impressions,clicks,ctr,frequency,actions",
        level: "ad",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        limit: 50,
      });
      const rows = (data.data ?? [])
        .map((row) => {
          const adId = String(row.ad_id ?? "");
          const frequency = Number(row.frequency ?? 0);
          const ctr = Number(row.ctr ?? 0);
          const spend = Number(row.spend ?? 0);
          const impressions = Number(row.impressions ?? 0);
          return {
            ad_id: adId,
            name: String(row.ad_name ?? adId),
            frequency,
            ctr,
            spend,
            impressions,
            fatigued:
              frequency >= 3.5 && ctr < 0.8 && impressions >= 1000 && spend > 0,
          };
        })
        .filter((r) => r.ad_id);

      const fatigued = rows.filter((r) => r.fatigued).slice(0, 3);
      if (!fatigued.length) {
        lines.push(
          "- No clear fatigue signals (freq ≥ 3.5 with weak CTR) in the lookback window.",
        );
      }
      for (const f of fatigued) {
        const live = activeAds.find((a) => a.id === f.ad_id);
        if (!live) {
          lines.push(
            `- ${f.name} (${f.ad_id}): freq ${f.frequency.toFixed(2)} · CTR ${f.ctr.toFixed(2)}% — already not ACTIVE.`,
          );
          continue;
        }
        const rationale = `Pause fatigued ad ${f.name}: frequency ${f.frequency.toFixed(2)}, CTR ${f.ctr.toFixed(2)}%.`;
        proposals.push({
          tool: "pause_ad",
          args: { account_id: id, ad_id: f.ad_id },
          rationale,
        });
        lines.push(
          `- PAUSE ${f.name} (${f.ad_id}): freq ${f.frequency.toFixed(2)} · CTR ${f.ctr.toFixed(2)}%`,
        );
      }
    } catch {
      lines.push(
        `- Could not load ad-level insights. Active ads on file: ${activeAds.length}.`,
      );
    }

    lines.push(
      "",
      "Pause proposals require Approvals. Refresh creative separately via image generation if needed.",
    );

    return {
      text: lines.join("\n"),
      structured: {
        accountId: id,
        lookback_days: lookbackDays,
        date_start: dateStart,
        date_stop: dateStop,
        proposals,
      },
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
    const id = normalizeAccountId(accountId);
    const limit = Math.min(50, Math.max(1, options.limit ?? 30));
    const path = options.ad_set_id
      ? `${options.ad_set_id}/ads`
      : options.campaign_id
        ? `${options.campaign_id}/ads`
        : `${id}/ads`;

    const creativeFields =
      "id,name,title,body,call_to_action_type,call_to_action,link_url,object_url,object_story_spec,asset_feed_spec,thumbnail_url,image_url,url_tags,effective_object_story_id,object_story_id";

    const { extractCreativeDestination } = await import(
      "@/lib/meta/extract-creative-destination"
    );

    const pagePostCache = new Map<string, Record<string, unknown> | null>();

    const loadPagePost = async (
      storyId: string | null,
    ): Promise<Record<string, unknown> | null> => {
      if (!storyId) return null;
      if (pagePostCache.has(storyId)) return pagePostCache.get(storyId) ?? null;
      try {
        const post = await this.graph.get<Record<string, unknown>>(storyId, {
          fields:
            "id,call_to_action,link,message,attachments{unshimmed_url,url,title,description,target}",
        });
        pagePostCache.set(storyId, post);
        return post;
      } catch {
        pagePostCache.set(storyId, null);
        return null;
      }
    };

    const creativeIdOf = (row: Record<string, unknown>): string | null => {
      const nested =
        row.creative && typeof row.creative === "object"
          ? (row.creative as Record<string, unknown>)
          : null;
      return (
        (nested && typeof nested.id === "string" && nested.id) ||
        (typeof row.creative === "string" ? row.creative : null)
      );
    };

    const mapRows = async (
      rows: Array<Record<string, unknown>>,
    ): Promise<MetaAdCreative[]> => {
      // Always hydrate creatives by id — the nested expand is often
      // incomplete — but in one batched request instead of one per ad.
      let hydrated: Record<string, Record<string, unknown>> = {};
      try {
        hydrated = await this.graph.getByIds<Record<string, unknown>>(
          rows.map(creativeIdOf).filter((id): id is string => Boolean(id)),
          { fields: creativeFields },
        );
      } catch {
        // keep nested expands
      }

      const results: MetaAdCreative[] = [];
      for (const row of rows) {
        const creativeId = creativeIdOf(row);
        const creative: Record<string, unknown> | null =
          (creativeId ? hydrated[creativeId] : undefined) ??
          (row.creative && typeof row.creative === "object"
            ? (row.creative as Record<string, unknown>)
            : null);

        // The creative's own Website URL wins. Only consult the linked page post
        // when the creative carries no destination at all (post links can be stale).
        let extracted = extractCreativeDestination(creative);
        if (!extracted.landing_page_url) {
          const storyIdRaw =
            (typeof creative?.effective_object_story_id === "string" &&
              creative.effective_object_story_id) ||
            (typeof creative?.object_story_id === "string" &&
              creative.object_story_id) ||
            null;
          const pagePost = await loadPagePost(storyIdRaw);
          if (pagePost) {
            extracted = extractCreativeDestination(creative, pagePost);
          }
          if (!extracted.landing_page_url) {
            // Surface the shape Meta actually returned instead of silently
            // reporting "no destination" for an ad that has one in Ads Manager.
            logger.warn("meta.creative_destination_missing", {
              ad_id: String(row.id ?? ""),
              creative_id: creativeId,
              story_id: storyIdRaw,
              creative_keys: creative ? Object.keys(creative) : [],
              story_spec_keys: Object.keys(
                (creative?.object_story_spec as Record<string, unknown>) ?? {},
              ),
            });
          }
        }

        results.push({
          ad_id: String(row.id ?? ""),
          ad_name: String(row.name ?? "Ad"),
          campaign_id: String(row.campaign_id ?? options.campaign_id ?? ""),
          adset_id: String(row.adset_id ?? options.ad_set_id ?? ""),
          headline: extracted.headline,
          primary_text: extracted.primary_text,
          call_to_action_type: extracted.call_to_action_type,
          landing_page_url: extracted.landing_page_url,
          image_url:
            typeof creative?.image_url === "string"
              ? creative.image_url
              : typeof creative?.thumbnail_url === "string"
                ? creative.thumbnail_url
                : null,
          creative_type: extracted.creative_type,
          destination_source: extracted.destination_source,
          destination_candidates: extracted.destination_candidates,
          ad_status: typeof row.status === "string" ? row.status : null,
          effective_status:
            typeof row.effective_status === "string"
              ? row.effective_status
              : null,
        });
      }
      return results;
    };

    const fetchAds = async (withStatusFilter: boolean) => {
      const params: Record<string, string | number | boolean> = {
        fields: `id,name,status,effective_status,campaign_id,adset_id,creative{${creativeFields}}`,
        limit,
      };
      if (withStatusFilter) {
        // Include paused — Website URL is creative config, not delivery.
        params.filtering = JSON.stringify([
          {
            field: "effective_status",
            operator: "IN",
            value: [
              "ACTIVE",
              "PAUSED",
              "CAMPAIGN_PAUSED",
              "ADSET_PAUSED",
              "PENDING_REVIEW",
              "DISAPPROVED",
              "PREAPPROVED",
              "PENDING_BILLING_INFO",
              "IN_PROCESS",
              "WITH_ISSUES",
            ],
          },
        ]);
      }
      return this.graph.get<{ data?: Array<Record<string, unknown>> }>(
        path,
        params,
      );
    };

    try {
      let data: { data?: Array<Record<string, unknown>> };
      try {
        data = await fetchAds(true);
      } catch {
        data = await fetchAds(false);
      }
      let results = await mapRows(data.data ?? []);

      // If filtered call returned nothing, retry unfiltered (paused ads).
      if (!results.length) {
        data = await fetchAds(false);
        results = await mapRows(data.data ?? []);
      }

      return results;
    } catch {
      // Last resort: list ads then hydrate each creative by id
      try {
        const ads = await this.listAds(
          accountId,
          options.ad_set_id,
        );
        const scoped = options.campaign_id
          ? ads.filter((a) => a.campaign_id === options.campaign_id)
          : ads;
        const hydrated: MetaAdCreative[] = [];
        for (const ad of scoped.slice(0, limit)) {
          try {
            const fullAd = await this.graph.get<Record<string, unknown>>(ad.id, {
              fields: `id,name,status,effective_status,campaign_id,adset_id,creative{${creativeFields}}`,
            });
            const mapped = await mapRows([fullAd]);
            if (mapped[0]) hydrated.push(mapped[0]);
          } catch {
            hydrated.push({
              ad_id: ad.id,
              ad_name: ad.name,
              campaign_id: ad.campaign_id,
              adset_id: ad.adset_id,
              headline: null,
              primary_text: null,
              landing_page_url: null,
              creative_type: "unknown",
              ad_status: ad.status,
              effective_status: null,
            });
          }
        }
        return hydrated;
      } catch {
        return [];
      }
    }
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

